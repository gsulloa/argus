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
    postgres_get_function_signature, postgres_list_active, postgres_list_columns_bulk,
    postgres_list_relations, postgres_list_schemas, postgres_list_structure,
    postgres_list_table_extras, postgres_parse_url, postgres_query_table, postgres_run_sql,
    postgres_run_sql_many, postgres_table_primary_key, postgres_test_connection, PgPoolRegistry,
};
use crate::platform::{
    connections::{
        connections_create, connections_delete, connections_get_secret, connections_list,
        connections_update,
    },
    settings::{settings_get, settings_set},
    storage, DbState,
};

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
                Ok(conn) => {
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
            connections_get_secret,
            settings_get,
            settings_set,
            postgres_test_connection,
            postgres_connect,
            postgres_disconnect,
            postgres_list_active,
            postgres_parse_url,
            postgres_list_schemas,
            postgres_list_relations,
            postgres_list_structure,
            postgres_list_table_extras,
            postgres_get_function_signature,
            postgres_query_table,
            postgres_count_table,
            postgres_table_primary_key,
            postgres_apply_table_edits,
            postgres_run_sql,
            postgres_run_sql_many,
            postgres_list_columns_bulk,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
