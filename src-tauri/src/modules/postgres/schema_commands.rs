use std::time::{Duration, Instant};

use tauri::State;
use tokio::time::timeout;
use tokio_postgres::NoTls;
use tokio_postgres_rustls::MakeRustlsConnect;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::postgres::params::SslMode;
use crate::modules::postgres::pool::PgPoolRegistry;
use crate::modules::postgres::schema;
use crate::modules::postgres::schema_types::{SchemaObjects, SchemaSummary};
use crate::modules::postgres::tls::client_config_for;

/// Hard cap on a single `postgres_list_objects` call. After this, we send a
/// `pg_cancel_backend`-style cancellation to the server and surface the
/// timeout to the user.
const LIST_OBJECTS_TIMEOUT: Duration = Duration::from_secs(15);

fn parse_id(id: &str) -> AppResult<Uuid> {
    Uuid::parse_str(id).map_err(|e| AppError::Validation(format!("bad uuid: {e}")))
}

/// Send a `pg_cancel_backend` to Postgres for the given client. Opens a fresh
/// short-lived connection that matches the original sslmode. Best-effort —
/// failures are warned but never block the timeout error from reaching the UI.
async fn fire_cancel(cancel_token: tokio_postgres::CancelToken, sslmode: SslMode) {
    let outcome = match client_config_for(sslmode) {
        Ok(Some(cfg)) => {
            let connector = MakeRustlsConnect::new((*cfg).clone());
            cancel_token.cancel_query(connector).await
        }
        Ok(None) => cancel_token.cancel_query(NoTls).await,
        Err(e) => {
            tracing::warn!("schema browser: could not build TLS for cancel: {e:?}");
            return;
        }
    };
    if let Err(e) = outcome {
        tracing::warn!("schema browser: pg_cancel_backend failed: {e}");
    }
}

#[tauri::command]
pub async fn postgres_list_schemas(
    pools: State<'_, PgPoolRegistry>,
    id: String,
) -> AppResult<Vec<SchemaSummary>> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    tracing::info!("postgres_list_schemas: id={parsed}");
    let result = schema::with_client(&pools, &parsed, |client| async move {
        schema::list_schemas(&client).await
    })
    .await;
    let ms = started.elapsed().as_millis();
    match &result {
        Ok(rows) => {
            tracing::info!(
                "postgres_list_schemas ok: id={parsed} schemas={} elapsed={ms}ms",
                rows.len()
            );
        }
        Err(e) => {
            tracing::error!("postgres_list_schemas err: id={parsed} elapsed={ms}ms err={e:?}");
        }
    }
    result
}

#[tauri::command]
pub async fn postgres_list_objects(
    pools: State<'_, PgPoolRegistry>,
    id: String,
    schema_name: String,
) -> AppResult<SchemaObjects> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    tracing::info!("postgres_list_objects: id={parsed} schema={schema_name}");

    // Resolve the connection's SSL mode up front so the timeout path can
    // build a matching TLS connector for `cancel_query` without going back
    // through a state lookup in the panic-y branch.
    let sslmode = pools.sslmode_for(&parsed).await?;
    let client = pools.acquire(&parsed).await?;
    // Capture the cancel token BEFORE handing the client to the future so
    // we still have it when the timeout fires (the future drops the client
    // on cancel, but the token is independent of that).
    let cancel_token = client.cancel_token();

    let outcome = timeout(
        LIST_OBJECTS_TIMEOUT,
        schema::list_objects(&client, &schema_name),
    )
    .await;

    let result: AppResult<SchemaObjects> = match outcome {
        Ok(r) => r,
        Err(_elapsed) => {
            // Best-effort cancel — runs even if the cancel itself fails.
            fire_cancel(cancel_token, sslmode).await;
            // Drop the client explicitly; deadpool reclaims the slot. The
            // server-side cancel should leave the connection clean.
            drop(client);
            Err(AppError::postgres_with_code(
                "57014",
                format!(
                    "schema load timed out ({}s)",
                    LIST_OBJECTS_TIMEOUT.as_secs()
                ),
            ))
        }
    };

    let ms = started.elapsed().as_millis();
    match &result {
        Ok(o) => {
            tracing::info!(
                "postgres_list_objects ok: id={parsed} schema={} \
                 tables={} views={} matviews={} functions={} \
                 types={} extensions={} indexes={} triggers={} elapsed={ms}ms",
                o.schema,
                o.tables.len(),
                o.views.len(),
                o.materialized_views.len(),
                o.functions.len(),
                o.types.len(),
                o.extensions.len(),
                o.indexes.len(),
                o.triggers.len(),
            );
        }
        Err(e) => {
            tracing::error!(
                "postgres_list_objects err: id={parsed} schema={schema_name} elapsed={ms}ms err={e:?}"
            );
        }
    }
    result
}
