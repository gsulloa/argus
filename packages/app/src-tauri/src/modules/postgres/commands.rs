use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use tokio::time::timeout;
use tokio_postgres::NoTls;
use tokio_postgres_rustls::MakeRustlsConnect;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::postgres::params::PostgresParams;
use crate::modules::postgres::pool::{
    build_pg_config, ActivePoolSummary, ConnectResult, PgPoolRegistry,
};
use crate::modules::postgres::tls::client_config_for;
use crate::modules::postgres::url::parse_postgres_url as do_parse_url;
use crate::platform::open_connections::OpenConnectionsRegistry;
use crate::platform::DbState;

/// Hard cap on a single test or eager-handshake operation.
const POSTGRES_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Serialize)]
pub struct ParseUrlResult {
    pub params: PostgresParams,
    pub password: Option<String>,
}

/// Open a single connection (no pool), run `SELECT version()`, close.
/// Returns a JSON value with shape `{ ok: true, latencyMs, serverVersion }` or
/// `{ ok: false, error: AppError }` (errors are not raised back to the IPC layer
/// so the form can render them inline).
#[tauri::command]
pub async fn postgres_test_connection(
    app: AppHandle,
    params: PostgresParams,
    secret: Option<String>,
) -> AppResult<serde_json::Value> {
    if let Err(e) = params.validate() {
        emit_activity(
            &app,
            ActivityLogEntryBuilder::new(ActivityKind::TestConnection, Origin::User, 0).err(&e),
        );
        return Ok(json!({ "ok": false, "error": e }));
    }

    let started = Instant::now();
    let outcome = timeout(POSTGRES_TIMEOUT, run_test(&params, secret.as_deref())).await;
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
            json!({
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
            json!({ "ok": false, "error": e })
        }
        Err(_) => {
            let err = AppError::postgres(format!(
                "test timed out after {}s",
                POSTGRES_TIMEOUT.as_secs()
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
            json!({ "ok": false, "error": err })
        }
    };
    Ok(value)
}

async fn run_test(params: &PostgresParams, password: Option<&str>) -> AppResult<String> {
    let pg_cfg = build_pg_config(params, password);

    let server_version = match client_config_for(params.sslmode)? {
        Some(rustls_cfg) => {
            let connector = MakeRustlsConnect::new((*rustls_cfg).clone());
            let (client, conn) = pg_cfg.connect(connector).await?;
            tokio::spawn(async move {
                if let Err(e) = conn.await {
                    tracing::debug!("test-connection background: {e}");
                }
            });
            let row = client.query_one("SELECT version()", &[]).await?;
            row.get::<_, String>(0)
        }
        None => {
            let (client, conn) = pg_cfg.connect(NoTls).await?;
            tokio::spawn(async move {
                if let Err(e) = conn.await {
                    tracing::debug!("test-connection background: {e}");
                }
            });
            let row = client.query_one("SELECT version()", &[]).await?;
            row.get::<_, String>(0)
        }
    };
    Ok(server_version)
}

#[tauri::command]
pub async fn postgres_connect(
    app: AppHandle,
    db: State<'_, DbState>,
    pools: State<'_, PgPoolRegistry>,
    open_registry: State<'_, OpenConnectionsRegistry>,
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
        let (params, secret) =
            crate::modules::postgres::pool::load_connection_input(&db.0, parsed)?;
        timeout(POSTGRES_TIMEOUT, pools.connect(params, secret, parsed))
            .await
            .map_err(|_| {
                AppError::postgres(format!(
                    "connect timed out after {}s",
                    POSTGRES_TIMEOUT.as_secs()
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
            let _ = app.emit("postgres:active-changed", ());
            open_registry.mark_open(&app, &db, parsed).await;
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
pub async fn postgres_disconnect(
    app: AppHandle,
    pools: State<'_, PgPoolRegistry>,
    open_registry: State<'_, OpenConnectionsRegistry>,
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
    let removed = pools.disconnect(&parsed).await;
    if removed {
        let _ = app.emit("postgres:active-changed", ());
        open_registry.mark_closed(&app, parsed).await;
    }
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
pub async fn postgres_disconnect_all(
    app: AppHandle,
    pools: State<'_, PgPoolRegistry>,
    open_registry: State<'_, OpenConnectionsRegistry>,
) -> AppResult<u32> {
    let started = Instant::now();
    let dropped = pools.disconnect_all().await;
    let dropped_u32 = u32::try_from(dropped).unwrap_or(u32::MAX);
    if dropped > 0 {
        let _ = app.emit("postgres:active-changed", ());
        open_registry.mark_kind_closed(&app, "postgres").await;
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
pub async fn postgres_list_active(
    pools: State<'_, PgPoolRegistry>,
) -> AppResult<Vec<ActivePoolSummary>> {
    Ok(pools.list_active().await)
}

#[tauri::command]
pub fn postgres_parse_url(input: String) -> AppResult<ParseUrlResult> {
    let parsed = do_parse_url(&input)?;
    Ok(ParseUrlResult {
        params: parsed.params,
        password: parsed.password,
    })
}
