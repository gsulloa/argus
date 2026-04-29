use std::time::{Duration, Instant};

use deadpool_postgres::Object as PgObject;
use tauri::State;
use tokio::time::error::Elapsed;
use tokio::time::timeout;
use tokio_postgres::NoTls;
use tokio_postgres_rustls::MakeRustlsConnect;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::postgres::params::SslMode;
use crate::modules::postgres::pool::PgPoolRegistry;
use crate::modules::postgres::schema;
use crate::modules::postgres::schema_types::{
    ExtensionInfo, FunctionInfo, FunctionSignature, IndexInfo, KindFailure, RelationsResult,
    SchemaSummary, StructureResult, TableExtrasResult, TriggerInfo, TypeInfo,
};
use crate::modules::postgres::tls::client_config_for;

/// Total timeout for `postgres_list_relations`. The single underlying query is
/// cheap (`pg_class` JOIN `pg_namespace`, filtered by relkind), so 10s is a
/// generous safety net for pathological catalog states.
pub const RELATIONS_TIMEOUT: Duration = Duration::from_secs(10);

/// Total timeout wrapping the inner `tokio::join!` of multi-query commands
/// (`postgres_list_structure`, `postgres_list_table_extras`). Sized slightly
/// above `PER_QUERY_TIMEOUT` to leave margin for pipeline + decode overhead.
pub const TOTAL_TIMEOUT: Duration = Duration::from_secs(10);

/// Per-query timeout inside multi-query commands. When a sub-query exceeds
/// this, its slot becomes a `KindFailure` with code `"57014"` while the other
/// sub-queries continue to surface their results.
pub const PER_QUERY_TIMEOUT: Duration = Duration::from_secs(8);

/// Total timeout for `postgres_get_function_signature`. The query is a single
/// catalog lookup by OID — should always be sub-second.
pub const FUNCTION_SIG_TIMEOUT: Duration = Duration::from_secs(5);

fn parse_id(id: &str) -> AppResult<Uuid> {
    Uuid::parse_str(id).map_err(|e| AppError::Validation(format!("bad uuid: {e}")))
}

/// Send a `pg_cancel_backend` to Postgres for the given client. Opens a fresh
/// short-lived connection that matches the original sslmode. Best-effort —
/// failures are warned but never block the timeout error from reaching the UI.
pub(super) async fn fire_cancel(cancel_token: tokio_postgres::CancelToken, sslmode: SslMode) {
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

/// Build a `KindFailure` from any `AppError`. Extracts SQLSTATE from
/// `AppError::Postgres` so the frontend can detect 57014/timeout consistently.
/// Permission-denied (42501) MUST be intercepted upstream by `try_kind` and
/// degraded to `Ok(Vec::new())` — it never reaches `map_failure`.
pub(super) fn map_failure(kind: &str, err: AppError) -> KindFailure {
    let (code, message) = match err {
        AppError::Postgres(body) => (body.code, body.message),
        other => (None, other.to_string()),
    };
    KindFailure {
        kind: kind.to_string(),
        code,
        message,
    }
}

/// Aggregate one sub-query's `Result<AppResult<Vec<T>>, Elapsed>` into either
/// `Some(payload)` (success or permission-denied → empty) or `None`, pushing a
/// `KindFailure` to `failures` in the failure case.
pub(super) fn aggregate_one<T>(
    result: Result<AppResult<Vec<T>>, Elapsed>,
    kind: &str,
    failures: &mut Vec<KindFailure>,
) -> Option<Vec<T>> {
    match result {
        Ok(Ok(v)) => Some(v),
        Ok(Err(e)) => {
            tracing::warn!("schema browser: {kind} sub-query failed: {e:?}");
            failures.push(map_failure(kind, e));
            None
        }
        Err(_elapsed) => {
            tracing::warn!(
                "schema browser: {kind} sub-query timed out ({}s)",
                PER_QUERY_TIMEOUT.as_secs()
            );
            failures.push(KindFailure {
                kind: kind.to_string(),
                code: Some("57014".to_string()),
                message: format!(
                    "{kind} query timed out ({}s)",
                    PER_QUERY_TIMEOUT.as_secs()
                ),
            });
            None
        }
    }
}

/// Produce a fully-failed `failures` vector when an outer total timeout fires.
/// Each `kind` becomes a 57014 entry — partial results are not preserved,
/// because the inner `tokio::join!` is dropped wholesale on outer cancel.
fn all_failed_57014(kinds: &[&str]) -> Vec<KindFailure> {
    kinds
        .iter()
        .map(|k| KindFailure {
            kind: (*k).to_string(),
            code: Some("57014".to_string()),
            message: format!(
                "{k} query cancelled by total timeout ({}s)",
                TOTAL_TIMEOUT.as_secs()
            ),
        })
        .collect()
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
pub async fn postgres_list_relations(
    pools: State<'_, PgPoolRegistry>,
    id: String,
    schema_name: String,
) -> AppResult<RelationsResult> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    tracing::info!("postgres_list_relations: id={parsed} schema={schema_name}");

    let sslmode = pools.sslmode_for(&parsed).await?;
    let client = pools.acquire(&parsed).await?;
    let cancel_token = client.cancel_token();

    let outcome = timeout(
        RELATIONS_TIMEOUT,
        schema::list_relations(&client, &schema_name),
    )
    .await;

    let result: AppResult<RelationsResult> = match outcome {
        Ok(Ok((tables, views, materialized_views))) => Ok(RelationsResult {
            schema: schema_name.clone(),
            tables,
            views,
            materialized_views,
        }),
        Ok(Err(e)) => Err(e),
        Err(_) => {
            fire_cancel(cancel_token, sslmode).await;
            drop(client);
            Err(AppError::postgres_with_code(
                "57014",
                format!(
                    "schema relations load timed out ({}s)",
                    RELATIONS_TIMEOUT.as_secs()
                ),
            ))
        }
    };

    let ms = started.elapsed().as_millis();
    match &result {
        Ok(r) => {
            tracing::info!(
                "postgres_list_relations ok: id={parsed} schema={} \
                 tables={} views={} matviews={} elapsed={ms}ms",
                r.schema,
                r.tables.len(),
                r.views.len(),
                r.materialized_views.len(),
            );
        }
        Err(e) => {
            tracing::error!(
                "postgres_list_relations err: id={parsed} schema={schema_name} elapsed={ms}ms err={e:?}"
            );
        }
    }
    result
}

/// Run the inner three sub-queries with per-query timeouts.
async fn list_structure_inner<'a>(
    client: &'a PgObject,
    schema_name: &'a str,
) -> (
    Result<AppResult<Vec<FunctionInfo>>, Elapsed>,
    Result<AppResult<Vec<TypeInfo>>, Elapsed>,
    Result<AppResult<Vec<ExtensionInfo>>, Elapsed>,
) {
    tokio::join!(
        timeout(PER_QUERY_TIMEOUT, schema::try_kind("functions", schema_name, || {
            schema::list_functions(client, schema_name)
        })),
        timeout(PER_QUERY_TIMEOUT, schema::try_kind("types", schema_name, || {
            schema::list_types(client, schema_name)
        })),
        timeout(PER_QUERY_TIMEOUT, schema::try_kind("extensions", schema_name, || {
            schema::list_extensions(client, schema_name)
        })),
    )
}

#[tauri::command]
pub async fn postgres_list_structure(
    pools: State<'_, PgPoolRegistry>,
    id: String,
    schema_name: String,
) -> AppResult<StructureResult> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    tracing::info!("postgres_list_structure: id={parsed} schema={schema_name}");

    let sslmode = pools.sslmode_for(&parsed).await?;
    let client = pools.acquire(&parsed).await?;
    let cancel_token = client.cancel_token();

    // Wrap the inner join in the outer total timeout. In practice the inner
    // per-query timeouts (8s) resolve everything before the outer (10s) ever
    // fires; the outer is a defensive net for cases where cancellation doesn't
    // propagate through the pipeline.
    let outcome = timeout(TOTAL_TIMEOUT, list_structure_inner(&client, &schema_name)).await;

    let (functions, types, extensions, failures) = match outcome {
        Ok((fr, tr, er)) => {
            let mut failures = Vec::new();
            let functions = aggregate_one(fr, "functions", &mut failures);
            let types = aggregate_one(tr, "types", &mut failures);
            let extensions = aggregate_one(er, "extensions", &mut failures);
            (functions, types, extensions, failures)
        }
        Err(_) => {
            fire_cancel(cancel_token, sslmode).await;
            (
                None,
                None,
                None,
                all_failed_57014(&["functions", "types", "extensions"]),
            )
        }
    };

    drop(client);

    for f in &failures {
        tracing::warn!(
            "postgres_list_structure failure: schema={schema_name} kind={} code={:?} message={}",
            f.kind,
            f.code,
            f.message
        );
    }

    let result = StructureResult {
        schema: schema_name.clone(),
        functions,
        types,
        extensions,
        failures,
    };

    let ms = started.elapsed().as_millis();
    tracing::info!(
        "postgres_list_structure ok: id={parsed} schema={schema_name} \
         functions={} types={} extensions={} failures={} elapsed={ms}ms",
        result
            .functions
            .as_ref()
            .map(|v| v.len() as i64)
            .unwrap_or(-1),
        result.types.as_ref().map(|v| v.len() as i64).unwrap_or(-1),
        result
            .extensions
            .as_ref()
            .map(|v| v.len() as i64)
            .unwrap_or(-1),
        result.failures.len(),
    );
    Ok(result)
}

async fn list_table_extras_inner<'a>(
    client: &'a PgObject,
    schema_name: &'a str,
    relation: &'a str,
) -> (
    Result<AppResult<Vec<IndexInfo>>, Elapsed>,
    Result<AppResult<Vec<TriggerInfo>>, Elapsed>,
) {
    tokio::join!(
        timeout(PER_QUERY_TIMEOUT, schema::try_kind("indexes", schema_name, || {
            schema::list_table_indexes(client, schema_name, relation)
        })),
        timeout(PER_QUERY_TIMEOUT, schema::try_kind("triggers", schema_name, || {
            schema::list_table_triggers(client, schema_name, relation)
        })),
    )
}

#[tauri::command]
pub async fn postgres_list_table_extras(
    pools: State<'_, PgPoolRegistry>,
    id: String,
    schema_name: String,
    relation: String,
) -> AppResult<TableExtrasResult> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    tracing::info!(
        "postgres_list_table_extras: id={parsed} schema={schema_name} relation={relation}"
    );

    let sslmode = pools.sslmode_for(&parsed).await?;
    let client = pools.acquire(&parsed).await?;
    let cancel_token = client.cancel_token();

    let outcome = timeout(
        TOTAL_TIMEOUT,
        list_table_extras_inner(&client, &schema_name, &relation),
    )
    .await;

    let (indexes, triggers, failures) = match outcome {
        Ok((ir, tr)) => {
            let mut failures = Vec::new();
            let indexes = aggregate_one(ir, "indexes", &mut failures);
            let triggers = aggregate_one(tr, "triggers", &mut failures);
            (indexes, triggers, failures)
        }
        Err(_) => {
            fire_cancel(cancel_token, sslmode).await;
            (None, None, all_failed_57014(&["indexes", "triggers"]))
        }
    };

    drop(client);

    for f in &failures {
        tracing::warn!(
            "postgres_list_table_extras failure: schema={schema_name} relation={relation} \
             kind={} code={:?} message={}",
            f.kind,
            f.code,
            f.message
        );
    }

    let result = TableExtrasResult {
        schema: schema_name.clone(),
        relation: relation.clone(),
        indexes,
        triggers,
        failures,
    };

    let ms = started.elapsed().as_millis();
    tracing::info!(
        "postgres_list_table_extras ok: id={parsed} schema={schema_name} relation={relation} \
         indexes={} triggers={} failures={} elapsed={ms}ms",
        result.indexes.as_ref().map(|v| v.len() as i64).unwrap_or(-1),
        result.triggers.as_ref().map(|v| v.len() as i64).unwrap_or(-1),
        result.failures.len(),
    );
    Ok(result)
}

#[tauri::command]
pub async fn postgres_get_function_signature(
    pools: State<'_, PgPoolRegistry>,
    id: String,
    schema_name: String,
    name: String,
    oid: i64,
) -> AppResult<FunctionSignature> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    tracing::info!(
        "postgres_get_function_signature: id={parsed} schema={schema_name} name={name} oid={oid}"
    );

    let sslmode = pools.sslmode_for(&parsed).await?;
    let client = pools.acquire(&parsed).await?;
    let cancel_token = client.cancel_token();

    let outcome = timeout(
        FUNCTION_SIG_TIMEOUT,
        schema::get_function_signature(&client, &schema_name, &name, oid),
    )
    .await;

    let result: AppResult<FunctionSignature> = match outcome {
        Ok(r) => r,
        Err(_) => {
            fire_cancel(cancel_token, sslmode).await;
            drop(client);
            Err(AppError::postgres_with_code(
                "57014",
                format!(
                    "function signature lookup timed out ({}s)",
                    FUNCTION_SIG_TIMEOUT.as_secs()
                ),
            ))
        }
    };

    let ms = started.elapsed().as_millis();
    match &result {
        Ok(_) => {
            tracing::info!(
                "postgres_get_function_signature ok: id={parsed} schema={schema_name} \
                 name={name} oid={oid} elapsed={ms}ms"
            );
        }
        Err(e) => {
            tracing::error!(
                "postgres_get_function_signature err: id={parsed} schema={schema_name} \
                 name={name} oid={oid} elapsed={ms}ms err={e:?}"
            );
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_failure_extracts_postgres_code() {
        let err = AppError::postgres_with_code("57014", "timed out");
        let f = map_failure("functions", err);
        assert_eq!(f.kind, "functions");
        assert_eq!(f.code.as_deref(), Some("57014"));
        assert!(f.message.contains("timed out"));
    }

    #[test]
    fn map_failure_handles_postgres_without_code() {
        let err = AppError::postgres("connection lost");
        let f = map_failure("indexes", err);
        assert_eq!(f.kind, "indexes");
        assert_eq!(f.code, None);
        assert!(f.message.contains("connection lost"));
    }

    #[test]
    fn map_failure_handles_validation() {
        let err = AppError::Validation("bad uuid".into());
        let f = map_failure("triggers", err);
        assert_eq!(f.kind, "triggers");
        assert_eq!(f.code, None);
        assert!(f.message.to_ascii_lowercase().contains("validation"));
    }

    #[test]
    fn map_failure_handles_internal() {
        let err = AppError::Internal("boom".into());
        let f = map_failure("types", err);
        assert_eq!(f.kind, "types");
        assert_eq!(f.code, None);
        assert!(f.message.to_ascii_lowercase().contains("internal"));
    }

    #[test]
    fn aggregate_one_success_returns_some_payload() {
        let mut failures = Vec::new();
        let result: Result<AppResult<Vec<i32>>, Elapsed> = Ok(Ok(vec![1, 2, 3]));
        let out = aggregate_one(result, "k", &mut failures);
        assert_eq!(out, Some(vec![1, 2, 3]));
        assert!(failures.is_empty());
    }

    #[test]
    fn aggregate_one_permission_denied_yields_empty_vec_no_failure() {
        // try_kind already collapses 42501 to Ok(Vec::new()) upstream, so the
        // signal at the aggregator boundary is `Ok(Ok(vec![]))`.
        let mut failures = Vec::new();
        let result: Result<AppResult<Vec<i32>>, Elapsed> = Ok(Ok(Vec::new()));
        let out = aggregate_one(result, "k", &mut failures);
        assert_eq!(out, Some(Vec::<i32>::new()));
        assert!(failures.is_empty());
    }

    #[test]
    fn aggregate_one_apperror_records_failure() {
        let mut failures = Vec::new();
        let result: Result<AppResult<Vec<i32>>, Elapsed> =
            Ok(Err(AppError::postgres_with_code("23505", "dup key")));
        let out = aggregate_one(result, "functions", &mut failures);
        assert_eq!(out, None);
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].kind, "functions");
        assert_eq!(failures[0].code.as_deref(), Some("23505"));
    }

    async fn synth_elapsed() -> Elapsed {
        timeout(
            Duration::from_nanos(1),
            tokio::time::sleep(Duration::from_secs(60)),
        )
        .await
        .unwrap_err()
    }

    #[tokio::test]
    async fn aggregate_one_elapsed_records_57014() {
        let mut failures = Vec::new();
        let elapsed = synth_elapsed().await;
        let result: Result<AppResult<Vec<i32>>, Elapsed> = Err(elapsed);
        let out = aggregate_one(result, "types", &mut failures);
        assert_eq!(out, None);
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].kind, "types");
        assert_eq!(failures[0].code.as_deref(), Some("57014"));
    }

    #[tokio::test]
    async fn aggregate_simulates_partial_degradation() {
        let mut failures = Vec::new();
        // ok-with-data
        let r1: Result<AppResult<Vec<i32>>, Elapsed> = Ok(Ok(vec![10]));
        // permission-denied → already converted upstream to Ok(Ok(vec![]))
        let r2: Result<AppResult<Vec<i32>>, Elapsed> = Ok(Ok(Vec::new()));
        // timeout
        let elapsed = synth_elapsed().await;
        let r3: Result<AppResult<Vec<i32>>, Elapsed> = Err(elapsed);

        let a = aggregate_one(r1, "functions", &mut failures);
        let b = aggregate_one(r2, "types", &mut failures);
        let c = aggregate_one(r3, "extensions", &mut failures);

        assert_eq!(a, Some(vec![10]));
        assert_eq!(b, Some(Vec::<i32>::new()));
        assert_eq!(c, None);
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].kind, "extensions");
        assert_eq!(failures[0].code.as_deref(), Some("57014"));
    }
}
