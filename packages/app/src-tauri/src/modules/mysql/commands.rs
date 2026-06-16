use std::time::{Duration, Instant};

use serde::Serialize;
use sqlx::mysql::MySqlConnectOptions;
use sqlx::Connection as _;
use tauri::{AppHandle, Emitter, State};
use tokio::time::timeout;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::mysql::errors::map_sqlx_error;
use crate::modules::mysql::params::MysqlParams;
use crate::modules::mysql::pool::{
    load_connection_input, ActivePoolSummary, ConnectResult, MysqlPoolRegistry,
};
use crate::modules::mysql::tls::apply_to_connect_options;
use crate::modules::mysql::url::parse_mysql_url as do_parse_url;
use crate::platform::DbState;

/// Hard cap on a single test or eager-handshake operation.
const MYSQL_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseUrlResult {
    pub params: MysqlParams,
    pub password: Option<String>,
}

/// Open a single connection (no pool), run `SELECT VERSION()`, close.
/// Returns a JSON value with shape `{ ok: true, latencyMs, serverVersion }` or
/// `{ ok: false, error: AppError }` (errors are not raised back to the IPC layer
/// so the form can render them inline).
#[tauri::command]
pub async fn mysql_test_connection(
    app: AppHandle,
    params: MysqlParams,
    secret: Option<String>,
) -> AppResult<serde_json::Value> {
    if let Err(e) = params.validate() {
        emit_activity(
            &app,
            ActivityLogEntryBuilder::new(ActivityKind::TestConnection, Origin::User, 0).err(&e),
        );
        return Ok(serde_json::json!({ "ok": false, "error": e }));
    }

    let started = Instant::now();
    let outcome = timeout(MYSQL_TIMEOUT, run_test(&params, secret.as_deref())).await;
    let duration_ms = started.elapsed().as_millis() as u64;

    let value = match outcome {
        Ok(Ok(server_version)) => {
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(
                    ActivityKind::TestConnection,
                    Origin::User,
                    duration_ms,
                )
                .ok(Some(Metric::ServerVersion {
                    value: server_version.clone(),
                })),
            );
            serde_json::json!({
                "ok": true,
                "latencyMs": duration_ms,
                "serverVersion": server_version,
            })
        }
        Ok(Err(e)) => {
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(
                    ActivityKind::TestConnection,
                    Origin::User,
                    duration_ms,
                )
                .err(&e),
            );
            serde_json::json!({ "ok": false, "error": e })
        }
        Err(_) => {
            let err = AppError::mysql(format!("test timed out after {}s", MYSQL_TIMEOUT.as_secs()));
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(
                    ActivityKind::TestConnection,
                    Origin::User,
                    duration_ms,
                )
                .err(&err),
            );
            serde_json::json!({ "ok": false, "error": err })
        }
    };
    Ok(value)
}

async fn run_test(params: &MysqlParams, password: Option<&str>) -> AppResult<String> {
    let mut opts = MySqlConnectOptions::new()
        .host(&params.host)
        .port(params.port)
        .username(&params.username)
        .database(&params.database);
    if let Some(p) = password {
        opts = opts.password(p);
    }
    opts = apply_to_connect_options(opts, params.ssl_mode);

    let mut conn = sqlx::MySqlConnection::connect_with(&opts)
        .await
        .map_err(map_sqlx_error)?;
    let row: (String,) = sqlx::query_as("SELECT VERSION()")
        .fetch_one(&mut conn)
        .await
        .map_err(map_sqlx_error)?;
    let server_version = row.0;
    conn.close().await.map_err(map_sqlx_error)?;
    Ok(server_version)
}

#[tauri::command]
pub async fn mysql_connect(
    app: AppHandle,
    db: State<'_, DbState>,
    registry: State<'_, MysqlPoolRegistry>,
    id: String,
) -> AppResult<ConnectResult> {
    let started = Instant::now();
    let parsed = match Uuid::parse_str(&id) {
        Ok(u) => u,
        Err(e) => {
            let err = AppError::Validation(format!("bad uuid: {e}"));
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(
                    ActivityKind::Connect,
                    Origin::User,
                    started.elapsed().as_millis() as u64,
                )
                .err(&err),
            );
            return Err(err);
        }
    };

    let outcome: AppResult<ConnectResult> = async {
        let (params, secret) = load_connection_input(&db.0, parsed)?;
        timeout(MYSQL_TIMEOUT, registry.connect(parsed, params, secret))
            .await
            .map_err(|_| {
                AppError::mysql(format!(
                    "connect timed out after {}s",
                    MYSQL_TIMEOUT.as_secs()
                ))
            })?
    }
    .await;

    let duration_ms = started.elapsed().as_millis() as u64;
    match &outcome {
        Ok(result) => {
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::Connect, Origin::User, duration_ms)
                    .connection(parsed)
                    .ok(Some(Metric::ServerVersion {
                        value: result.server_version.clone(),
                    })),
            );
            let _ = app.emit("mysql:active-changed", ());
        }
        Err(e) => {
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::Connect, Origin::User, duration_ms)
                    .connection(parsed)
                    .err(e),
            );
        }
    }
    outcome
}

#[tauri::command]
pub async fn mysql_disconnect(
    app: AppHandle,
    registry: State<'_, MysqlPoolRegistry>,
    id: String,
) -> AppResult<()> {
    let started = Instant::now();
    let parsed = match Uuid::parse_str(&id) {
        Ok(u) => u,
        Err(e) => {
            let err = AppError::Validation(format!("bad uuid: {e}"));
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(
                    ActivityKind::Disconnect,
                    Origin::User,
                    started.elapsed().as_millis() as u64,
                )
                .err(&err),
            );
            return Err(err);
        }
    };
    registry.disconnect(parsed).await?;
    let _ = app.emit("mysql:active-changed", ());
    emit_activity(
        &app,
        ActivityLogEntryBuilder::new(
            ActivityKind::Disconnect,
            Origin::User,
            started.elapsed().as_millis() as u64,
        )
        .connection(parsed)
        .ok(None),
    );
    Ok(())
}

#[tauri::command]
pub async fn mysql_disconnect_all(
    app: AppHandle,
    registry: State<'_, MysqlPoolRegistry>,
) -> AppResult<u32> {
    let started = Instant::now();
    let dropped = registry.disconnect_all().await;
    let dropped_u32 = u32::try_from(dropped).unwrap_or(u32::MAX);
    if dropped > 0 {
        let _ = app.emit("mysql:active-changed", ());
        emit_activity(
            &app,
            ActivityLogEntryBuilder::new(
                ActivityKind::Disconnect,
                Origin::User,
                started.elapsed().as_millis() as u64,
            )
            .ok(Some(Metric::Items { value: dropped_u32 })),
        );
    }
    Ok(dropped_u32)
}

#[tauri::command]
pub async fn mysql_list_active(
    registry: State<'_, MysqlPoolRegistry>,
) -> AppResult<Vec<ActivePoolSummary>> {
    Ok(registry.list_active().await)
}

#[tauri::command]
pub fn mysql_parse_url(input: String) -> AppResult<ParseUrlResult> {
    let parsed = do_parse_url(&input)?;
    Ok(ParseUrlResult {
        params: parsed.params,
        password: parsed.password,
    })
}
