//! Tauri commands for MS SQL Server connection management.
//!
//! Mirrors `modules/mysql/commands.rs` with mssql-specific types.

use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, State};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_util::compat::TokioAsyncWriteCompatExt;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::mssql::errors::map_tiberius_error;
use crate::modules::mssql::params::MssqlParams;
use crate::modules::mssql::pool::{load_connection_input, ActivePoolSummary, MssqlPoolRegistry};
use crate::modules::mssql::tls::build_tiberius_config;
use crate::modules::mssql::url::parse_any as do_parse_url;
use crate::modules::mssql::url::ParseUrlResult;
use crate::platform::DbState;

/// Hard cap on a single test or eager-handshake operation.
const MSSQL_TIMEOUT: Duration = Duration::from_secs(8);

// ---------------------------------------------------------------------------
// mssql_test_connection
// ---------------------------------------------------------------------------

/// Open a single connection (no pool), run `SELECT @@VERSION`, close.
///
/// Returns a JSON value with shape `{ ok: true, latencyMs, serverVersion }` or
/// `{ ok: false, error: AppError }` so the connection form can display errors
/// inline without raising to the IPC layer.
#[tauri::command]
pub async fn mssql_test_connection(
    app: AppHandle,
    params: MssqlParams,
    secret: Option<String>,
) -> AppResult<serde_json::Value> {
    if let Err(e) = params.validate() {
        emit_activity(
            &app,
            ActivityLogEntryBuilder::new(ActivityKind::TestConnection, Origin::User, 0).err(&e),
        );
        return Ok(serde_json::json!({ "ok": false, "error": e }));
    }

    let password = secret.unwrap_or_default();
    let started = Instant::now();
    let outcome = timeout(MSSQL_TIMEOUT, run_test_connection(&params, &password)).await;
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
                "latency_ms": duration_ms,
                "server_version": server_version,
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
            let err = AppError::mssql(format!(
                "test timed out after {}s",
                MSSQL_TIMEOUT.as_secs()
            ));
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

/// Inner async fn to open a single tiberius connection and run SELECT @@VERSION.
async fn run_test_connection(params: &MssqlParams, password: &str) -> AppResult<String> {
    let config = build_tiberius_config(params, password);
    let addr = config.get_addr();
    let tcp = TcpStream::connect(addr)
        .await
        .map_err(|e| AppError::mssql(format!("TCP connect failed: {e}")))?;
    tcp.set_nodelay(true)
        .map_err(|e| AppError::mssql(format!("set_nodelay failed: {e}")))?;
    let mut client = tiberius::Client::connect(config, tcp.compat_write())
        .await
        .map_err(map_tiberius_error)?;

    let rows = client
        .simple_query("SELECT @@VERSION")
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let row = rows
        .into_iter()
        .next()
        .ok_or_else(|| AppError::mssql("SELECT @@VERSION returned no rows"))?;
    let version: &str = row
        .get(0)
        .ok_or_else(|| AppError::mssql("SELECT @@VERSION: missing column"))?;

    Ok(version.to_string())
}

// ---------------------------------------------------------------------------
// mssql_connect
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mssql_connect(
    app: AppHandle,
    db: State<'_, DbState>,
    registry: State<'_, MssqlPoolRegistry>,
    id: String,
) -> AppResult<ActivePoolSummary> {
    let started = Instant::now();
    let uuid = match Uuid::parse_str(&id) {
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

    let outcome: AppResult<ActivePoolSummary> = async {
        let (params, password) = load_connection_input(&db.0, uuid)?;
        timeout(MSSQL_TIMEOUT, registry.connect(uuid, params, password))
            .await
            .map_err(|_| {
                AppError::mssql(format!("connect timed out after {}s", MSSQL_TIMEOUT.as_secs()))
            })?
    }
    .await;

    let duration_ms = started.elapsed().as_millis() as u64;
    match &outcome {
        Ok(summary) => {
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::Connect, Origin::User, duration_ms)
                    .connection(uuid)
                    .ok(Some(Metric::ServerVersion {
                        value: summary.server_version.clone(),
                    })),
            );
            let _ = app.emit("mssql:active-changed", ());
        }
        Err(e) => {
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::Connect, Origin::User, duration_ms)
                    .connection(uuid)
                    .err(e),
            );
        }
    }
    outcome
}

// ---------------------------------------------------------------------------
// mssql_disconnect
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mssql_disconnect(
    app: AppHandle,
    registry: State<'_, MssqlPoolRegistry>,
    id: String,
) -> AppResult<bool> {
    let started = Instant::now();
    let uuid = match Uuid::parse_str(&id) {
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
    let removed = registry.disconnect(uuid).await?;
    // Always emit, even for idempotent no-op.
    let _ = app.emit("mssql:active-changed", ());
    emit_activity(
        &app,
        ActivityLogEntryBuilder::new(
            ActivityKind::Disconnect,
            Origin::User,
            started.elapsed().as_millis() as u64,
        )
        .connection(uuid)
        .ok(None),
    );
    Ok(removed)
}

// ---------------------------------------------------------------------------
// mssql_disconnect_all
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mssql_disconnect_all(
    app: AppHandle,
    registry: State<'_, MssqlPoolRegistry>,
) -> AppResult<u32> {
    let started = Instant::now();
    let dropped = registry.disconnect_all().await?;
    let dropped_u32 = u32::try_from(dropped).unwrap_or(u32::MAX);
    if dropped > 0 {
        let _ = app.emit("mssql:active-changed", ());
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

// ---------------------------------------------------------------------------
// mssql_list_active
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mssql_list_active(
    registry: State<'_, MssqlPoolRegistry>,
) -> AppResult<Vec<ActivePoolSummary>> {
    Ok(registry.list_active())
}

// ---------------------------------------------------------------------------
// mssql_parse_url
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn mssql_parse_url(input: String) -> AppResult<ParseUrlResult> {
    do_parse_url(&input)
}
