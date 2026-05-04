pub mod error;
pub mod modules;
pub mod platform;

use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tracing::error;
use tracing_subscriber::EnvFilter;

use crate::modules::postgres::{
    postgres_apply_table_edits, postgres_connect, postgres_count_table, postgres_disconnect,
    postgres_disconnect_all, postgres_get_function_signature, postgres_list_active,
    postgres_list_columns_bulk, postgres_list_relations, postgres_list_schemas,
    postgres_list_structure, postgres_list_table_extras, postgres_parse_url, postgres_query_table,
    postgres_run_sql, postgres_run_sql_many, postgres_table_primary_key, postgres_table_structure,
    postgres_test_connection, PgPoolRegistry,
};
use crate::modules::query_history::{
    self,
    commands::{
        query_history_clear, query_history_delete, query_history_distinct_connections,
        query_history_list,
    },
};
use crate::platform::{
    connection_groups::{
        connection_groups_create, connection_groups_delete, connection_groups_list,
        connection_groups_update,
    },
    connections::{
        connections_create, connections_delete, connections_get_secret, connections_list,
        connections_move, connections_refresh_secret, connections_update,
    },
    settings::{self, settings_get, settings_set},
    storage, DbState,
};

const QUERY_HISTORY_RETENTION_DAYS_KEY: &str = "queryHistory.retentionDays";
const QUERY_HISTORY_RETENTION_MAX_ROWS_KEY: &str = "queryHistory.retentionMaxRows";
const QUERY_HISTORY_DEFAULT_RETENTION_DAYS: u32 = 30;
const QUERY_HISTORY_DEFAULT_MAX_ROWS: u32 = 10_000;

fn read_history_retention(conn: &rusqlite::Connection) -> (u32, u32) {
    let days = settings::get(conn, QUERY_HISTORY_RETENTION_DAYS_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(QUERY_HISTORY_DEFAULT_RETENTION_DAYS);
    let max_rows = settings::get(conn, QUERY_HISTORY_RETENTION_MAX_ROWS_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(QUERY_HISTORY_DEFAULT_MAX_ROWS);
    (days, max_rows)
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn init_tracing(app: &AppHandle) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    if cfg!(debug_assertions) {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_target(false)
            .try_init();
    } else if let Ok(log_dir) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&log_dir);
        let appender = tracing_appender::rolling::daily(log_dir, "argus.log");
        let _ = tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_writer(appender)
            .with_target(false)
            .with_ansi(false)
            .try_init();
    }
}

fn fail_startup(app: &AppHandle, message: &str) -> ! {
    error!("startup error: {message}");
    let _ = app
        .dialog()
        .message(message)
        .title("Argus failed to start")
        .kind(MessageDialogKind::Error)
        .blocking_show();
    std::process::exit(1);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            init_tracing(&handle);

            match storage::open_db(&handle) {
                Ok(mut conn) => {
                    let (days, max_rows) = read_history_retention(&conn);
                    if let Err(e) =
                        query_history::prune_for_retention(&mut conn, days, max_rows, now_unix_ms())
                    {
                        tracing::warn!("query_history retention sweep failed: {e}");
                    }
                    app.manage(DbState(Mutex::new(conn)));
                }
                Err(e) => {
                    fail_startup(&handle, &format!("failed to initialize storage: {e}"));
                }
            }

            app.manage(PgPoolRegistry::new());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connections_list,
            connections_create,
            connections_update,
            connections_delete,
            connections_move,
            connections_get_secret,
            connections_refresh_secret,
            connection_groups_list,
            connection_groups_create,
            connection_groups_update,
            connection_groups_delete,
            settings_get,
            settings_set,
            postgres_test_connection,
            postgres_connect,
            postgres_disconnect,
            postgres_disconnect_all,
            postgres_list_active,
            postgres_parse_url,
            postgres_list_schemas,
            postgres_list_relations,
            postgres_list_structure,
            postgres_list_table_extras,
            postgres_table_structure,
            postgres_get_function_signature,
            postgres_query_table,
            postgres_count_table,
            postgres_table_primary_key,
            postgres_apply_table_edits,
            postgres_run_sql,
            postgres_run_sql_many,
            postgres_list_columns_bulk,
            query_history_list,
            query_history_delete,
            query_history_clear,
            query_history_distinct_connections,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
