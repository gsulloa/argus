use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use tokio::time::timeout;
use tokio_postgres::NoTls;
use tokio_postgres_rustls::MakeRustlsConnect;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::postgres::params::PostgresParams;
use crate::modules::postgres::pool::{
    build_pg_config, ActivePoolSummary, ConnectResult, PgPoolRegistry,
};
use crate::modules::postgres::tls::client_config_for;
use crate::modules::postgres::url::parse_postgres_url as do_parse_url;
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
    params: PostgresParams,
    secret: Option<String>,
) -> AppResult<serde_json::Value> {
    if let Err(e) = params.validate() {
        return Ok(json!({ "ok": false, "error": e }));
    }

    let started = Instant::now();
    let outcome = timeout(POSTGRES_TIMEOUT, run_test(&params, secret.as_deref())).await;

    let value = match outcome {
        Ok(Ok(server_version)) => json!({
            "ok": true,
            "latencyMs": started.elapsed().as_millis() as u64,
            "serverVersion": server_version,
        }),
        Ok(Err(e)) => json!({ "ok": false, "error": e }),
        Err(_) => {
            let err = AppError::postgres(format!(
                "test timed out after {}s",
                POSTGRES_TIMEOUT.as_secs()
            ));
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
    id: String,
) -> AppResult<ConnectResult> {
    let id =
        Uuid::parse_str(&id).map_err(|e| AppError::Validation(format!("bad uuid: {e}")))?;

    let (params, secret) = crate::modules::postgres::pool::load_connection_input(&db.0, id)?;

    let result = timeout(POSTGRES_TIMEOUT, pools.connect(params, secret, id))
        .await
        .map_err(|_| {
            AppError::postgres(format!(
                "connect timed out after {}s",
                POSTGRES_TIMEOUT.as_secs()
            ))
        })??;

    let _ = app.emit("postgres:active-changed", ());
    Ok(result)
}

#[tauri::command]
pub async fn postgres_disconnect(
    app: AppHandle,
    pools: State<'_, PgPoolRegistry>,
    id: String,
) -> AppResult<()> {
    let id =
        Uuid::parse_str(&id).map_err(|e| AppError::Validation(format!("bad uuid: {e}")))?;
    let removed = pools.disconnect(&id).await;
    if removed {
        let _ = app.emit("postgres:active-changed", ());
    }
    Ok(())
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
