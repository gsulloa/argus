pub mod config;
pub mod error;
pub mod modules;
pub mod platform;

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tracing::error;
use tracing_subscriber::EnvFilter;

use crate::modules::ai::commands::{
    ai_chat_cancel, ai_chat_close, ai_chat_history, ai_chat_send, ai_delete_api_key,
    ai_generate_sql, ai_get_settings, ai_inspect_models, ai_list_providers, ai_set_api_key,
    ai_set_settings, ai_validate_provider,
};
use crate::modules::athena::commands::{
    athena_connect, athena_disconnect, athena_disconnect_all, athena_list_active,
    athena_test_connection,
};
use crate::modules::athena::named_queries::{
    athena_create_named_query, athena_delete_named_query, athena_get_named_query,
    athena_list_named_queries, athena_update_named_query,
};
use crate::modules::athena::pool::AthenaClientRegistry;
use crate::modules::athena::s3::{athena_list_s3_buckets, athena_list_s3_prefixes};
use crate::modules::athena::schema_commands::{
    athena_list_columns, athena_list_databases, athena_list_relations,
};
use crate::modules::athena::sql::{athena_cancel_query, athena_run_sql, athena_run_sql_many};
use crate::modules::cloudwatch::client::CloudwatchClientRegistry;
use crate::modules::cloudwatch::commands::{
    cloudwatch_connect, cloudwatch_disconnect, cloudwatch_disconnect_all, cloudwatch_list_active,
    cloudwatch_test_connection,
};
use crate::modules::cloudwatch::groups::{
    cloudwatch_get_log_events, cloudwatch_list_log_groups, cloudwatch_list_log_streams,
};
use crate::modules::cloudwatch::insights::{cloudwatch_cancel_insights, cloudwatch_run_insights};
use crate::modules::context::commands::{
    context_ai_payload, context_create_folder, context_delete_model, context_get_object,
    context_get_project_source, context_get_query, context_link_folder, context_list_known_folders,
    context_list_models, context_list_objects, context_list_queries, context_reveal_path,
    context_save_model, context_set_project_source, context_sync_schema, context_unlink,
};
use crate::modules::context::registry::{ContextRegistry, TauriEmitter};
use crate::modules::dynamo::client::DynamoClientRegistry;
use crate::modules::dynamo::commands::{
    dynamo_connect, dynamo_disconnect, dynamo_list_active, dynamo_list_aws_profiles,
    dynamo_test_connection, dynamo_update_credentials,
};
use crate::modules::dynamo::edit::{dynamo_delete_item, dynamo_put_item, dynamo_update_item};
use crate::modules::dynamo::items::{dynamo_count_items, dynamo_query, dynamo_scan};
use crate::modules::dynamo::partiql::{dynamo_run_partiql, dynamo_run_partiql_many};
use crate::modules::dynamo::tables::commands::{dynamo_describe_table, dynamo_list_tables};
use crate::modules::mssql::{
    mssql_apply_table_edits, mssql_connect, mssql_count_table, mssql_disconnect,
    mssql_disconnect_all, mssql_get_object_definition, mssql_get_routine_signature,
    mssql_list_active, mssql_list_columns_bulk, mssql_list_databases, mssql_list_relations,
    mssql_list_schemas, mssql_list_structure, mssql_list_table_extras, mssql_parse_url,
    mssql_query_table, mssql_run_sql, mssql_run_sql_batch, mssql_run_sql_many, mssql_table_ddl,
    mssql_table_primary_key, mssql_table_structure, mssql_test_connection, MssqlPoolRegistry,
};
use crate::modules::mysql::{
    mysql_apply_table_edits, mysql_connect, mysql_count_table, mysql_disconnect,
    mysql_disconnect_all, mysql_get_routine_signature, mysql_list_active, mysql_list_columns_bulk,
    mysql_list_relations, mysql_list_schemas, mysql_list_structure, mysql_list_table_extras,
    mysql_parse_url, mysql_query_table, mysql_run_sql, mysql_run_sql_many, mysql_table_ddl,
    mysql_table_primary_key, mysql_table_structure, mysql_test_connection, MysqlPoolRegistry,
};
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
use crate::modules::saved_queries::commands::{
    saved_queries_create, saved_queries_delete, saved_queries_duplicate,
    saved_queries_folder_create, saved_queries_folder_delete, saved_queries_folder_move,
    saved_queries_folder_update, saved_queries_list, saved_queries_move, saved_queries_update,
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
    open_connections::{
        connections_open_list, disconnect_all_connections, ensure_manager_window,
        ensure_workspace_window, workspace_open_connection, OpenConnectionsRegistry,
    },
    settings::{self, settings_get, settings_set},
    storage,
    updater::commands::{
        log_updater_event, updater_check_and_download, updater_install_and_restart,
        updater_logs_reveal, updater_logs_tail,
    },
    DbState,
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
            .with_target(true)
            .try_init();
    } else if let Ok(log_dir) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&log_dir);
        // migration-sensitive: log file stem; see config::app_identity::LOG_FILE_STEM.
        let appender =
            tracing_appender::rolling::daily(log_dir, crate::config::app_identity::LOG_FILE_STEM);
        let _ = tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_writer(appender)
            .with_target(true)
            .with_ansi(false)
            .try_init();
    }
}

fn fail_startup(app: &AppHandle, message: &str) -> ! {
    error!("startup error: {message}");
    let _ = app
        .dialog()
        .message(message)
        .title(format!(
            "{} failed to start",
            crate::config::app_identity::APP_DISPLAY_NAME
        ))
        .kind(MessageDialogKind::Error)
        .blocking_show();
    std::process::exit(1);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let handle = app.handle().clone();
            init_tracing(&handle);
            crate::modules::ai::path_fix::fix_macos_path();

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
            app.manage(MysqlPoolRegistry::new());
            app.manage(MssqlPoolRegistry::new());
            app.manage(DynamoClientRegistry::new());
            app.manage(AthenaClientRegistry::new());
            app.manage(CloudwatchClientRegistry::new());
            app.manage(OpenConnectionsRegistry::new());
            app.manage(platform::updater::UpdaterState::default());

            // Context registry — shared singleton keyed by canonical folder path.
            let emitter: Arc<dyn crate::modules::context::registry::EventEmitter> =
                Arc::new(TauriEmitter(app.handle().clone()));
            let context_registry = ContextRegistry::new(emitter);
            app.manage(context_registry.clone());

            // Re-subscribe every connection that has a linked context folder, so
            // documentation and Dynamo model docs are detected on app start
            // (the registry is in-memory; without this nothing is subscribed
            // until the user re-links a folder). Missing/invalid folders fail
            // gracefully — subscribe records them as unavailable.
            if let Some(db) = app.try_state::<DbState>() {
                let conns = {
                    let lock = db.0.lock().expect("db poisoned");
                    crate::platform::connections::list(&lock)
                };
                match conns {
                    Ok(conns) => {
                        for c in conns {
                            if let Some(path) = c.context_path.as_deref() {
                                if let Some(engine) =
                                    crate::modules::context::engine::EngineKind::from_connection_kind(
                                        &c.kind,
                                    )
                                {
                                    let _ = context_registry.subscribe(
                                        c.id,
                                        std::path::Path::new(path),
                                        engine,
                                    );
                                }
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!("context re-subscribe on startup failed to list connections: {e}");
                    }
                }
            }

            // AI validation cache.
            app.manage(crate::modules::ai::validation_cache::ValidationCache::new());

            // AI chat session registry.
            app.manage(crate::modules::ai::chat_session::ChatSessionRegistry::new());

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
            connections_open_list,
            disconnect_all_connections,
            ensure_workspace_window,
            ensure_manager_window,
            workspace_open_connection,
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
            // MS SQL Server commands
            mssql_test_connection,
            mssql_connect,
            mssql_disconnect,
            mssql_disconnect_all,
            mssql_list_active,
            mssql_parse_url,
            mssql_list_schemas,
            mssql_list_databases,
            mssql_list_relations,
            mssql_list_structure,
            mssql_list_table_extras,
            mssql_get_routine_signature,
            mssql_get_object_definition,
            mssql_query_table,
            mssql_count_table,
            mssql_table_primary_key,
            mssql_apply_table_edits,
            mssql_run_sql,
            mssql_run_sql_many,
            mssql_run_sql_batch,
            mssql_table_structure,
            mssql_table_ddl,
            mssql_list_columns_bulk,
            // MySQL commands
            mysql_test_connection,
            mysql_connect,
            mysql_disconnect,
            mysql_disconnect_all,
            mysql_list_active,
            mysql_parse_url,
            mysql_list_schemas,
            mysql_list_relations,
            mysql_list_structure,
            mysql_list_table_extras,
            mysql_get_routine_signature,
            mysql_query_table,
            mysql_count_table,
            mysql_table_primary_key,
            mysql_apply_table_edits,
            mysql_run_sql,
            mysql_run_sql_many,
            mysql_table_structure,
            mysql_table_ddl,
            mysql_list_columns_bulk,
            query_history_list,
            query_history_delete,
            query_history_clear,
            query_history_distinct_connections,
            saved_queries_list,
            saved_queries_folder_create,
            saved_queries_folder_update,
            saved_queries_folder_move,
            saved_queries_folder_delete,
            saved_queries_create,
            saved_queries_update,
            saved_queries_move,
            saved_queries_delete,
            saved_queries_duplicate,
            // Athena commands
            athena_test_connection,
            athena_connect,
            athena_disconnect,
            athena_disconnect_all,
            athena_list_active,
            athena_list_databases,
            athena_list_relations,
            athena_list_columns,
            athena_list_named_queries,
            athena_get_named_query,
            athena_create_named_query,
            athena_update_named_query,
            athena_delete_named_query,
            athena_run_sql,
            athena_run_sql_many,
            athena_cancel_query,
            athena_list_s3_buckets,
            athena_list_s3_prefixes,
            // DynamoDB commands
            dynamo_list_aws_profiles,
            dynamo_test_connection,
            dynamo_connect,
            dynamo_disconnect,
            dynamo_list_active,
            dynamo_update_credentials,
            dynamo_list_tables,
            dynamo_describe_table,
            dynamo_scan,
            dynamo_query,
            dynamo_count_items,
            dynamo_put_item,
            dynamo_update_item,
            dynamo_delete_item,
            dynamo_run_partiql,
            dynamo_run_partiql_many,
            // CloudWatch Logs commands
            cloudwatch_test_connection,
            cloudwatch_connect,
            cloudwatch_disconnect,
            cloudwatch_disconnect_all,
            cloudwatch_list_active,
            cloudwatch_list_log_groups,
            cloudwatch_list_log_streams,
            cloudwatch_get_log_events,
            cloudwatch_run_insights,
            cloudwatch_cancel_insights,
            // Updater commands
            updater_check_and_download,
            updater_install_and_restart,
            log_updater_event,
            updater_logs_tail,
            updater_logs_reveal,
            // Context folder commands
            context_create_folder,
            context_list_known_folders,
            context_link_folder,
            context_unlink,
            context_list_objects,
            context_get_object,
            context_list_models,
            context_list_queries,
            context_get_query,
            context_sync_schema,
            context_ai_payload,
            context_reveal_path,
            context_save_model,
            context_delete_model,
            context_get_project_source,
            context_set_project_source,
            // AI provider commands
            ai_list_providers,
            ai_validate_provider,
            ai_get_settings,
            ai_set_settings,
            ai_set_api_key,
            ai_delete_api_key,
            // TODO: deprecate after add-ai-chat-panel UI ships and confirms no remaining callers.
            ai_generate_sql,
            // AI chat commands
            ai_chat_send,
            ai_chat_cancel,
            ai_chat_close,
            ai_chat_history,
            ai_inspect_models,
        ])
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|app_handle, event| {
            match event {
                // ---------------------------------------------------------------
                // Phase 6: Window lifecycle rules
                //
                // Manager closes:
                //   - Workspace exists  → allow Manager to close; Workspace keeps running.
                //   - No Workspace      → on Windows/Linux quit; on macOS let the process
                //     stay alive (the dock icon will call Reopen to recreate the Manager).
                //
                // Workspace closes:
                //   - Allow the close; the frontend has already invoked ensure_manager_window
                //     (via the onCloseRequested handler in WorkspaceShell) before we get here.
                //     Connections remain open because pools live in the shared Rust backend.
                // ---------------------------------------------------------------
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::CloseRequested { .. },
                    ..
                } if label == "manager" => {
                    // Manager close-requested: check whether a Workspace exists.
                    let workspace_exists = app_handle.get_webview_window("workspace").is_some();
                    if !workspace_exists {
                        // No Workspace — quit on Windows/Linux; on macOS keep alive.
                        #[cfg(not(target_os = "macos"))]
                        app_handle.exit(0);
                        // macOS: do nothing — process stays alive; Reopen recreates Manager.
                    }
                    // Workspace exists: let the Manager close normally (no special action).
                }

                // ---------------------------------------------------------------
                // Phase 6 (macOS): Dock icon activated with no visible windows.
                // Recreate the Manager so the user can get back in.
                // ---------------------------------------------------------------
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen {
                    has_visible_windows: false,
                    ..
                } => {
                    let app = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = platform::open_connections::ensure_manager_window(app).await;
                    });
                }

                // ---------------------------------------------------------------
                // Existing: updater exit-requested guard (unchanged).
                // ---------------------------------------------------------------
                tauri::RunEvent::ExitRequested { api, .. } => {
                    let state = app_handle.state::<platform::updater::UpdaterState>();
                    // If a user-triggered install just called app.restart(), let Tauri's
                    // relaunch sequence proceed — do NOT prevent_exit and do NOT block.
                    if state.relaunching.load(std::sync::atomic::Ordering::Acquire) {
                        tracing::info!(target: "updater", "relaunch_allowed_by_exit_handler");
                        let _ = api;
                        return;
                    }
                    let installing = state.installing.load(std::sync::atomic::Ordering::Acquire);
                    let has_pending =
                        tauri::async_runtime::block_on(async { state.pending.lock().await.is_some() });

                    if has_pending && !installing {
                        api.prevent_exit();
                        let app_clone = app_handle.clone();
                        tauri::async_runtime::block_on(async {
                            platform::updater::commands::apply_pending_on_exit(&app_clone).await;
                        });
                        app_handle.exit(0);
                    } else if installing {
                        api.prevent_exit();
                        // Wait up to 10 s for the in-flight install to settle.
                        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                        while state.installing.load(std::sync::atomic::Ordering::Acquire)
                            && std::time::Instant::now() < deadline
                        {
                            std::thread::sleep(std::time::Duration::from_millis(100));
                        }
                        app_handle.exit(0);
                    }
                    // else: no pending update → fall through, default exit proceeds
                }

                _ => {}
            }
        });
}
