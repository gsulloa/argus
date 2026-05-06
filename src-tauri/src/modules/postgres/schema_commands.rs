use std::time::{Duration, Instant};

use deadpool_postgres::Object as PgObject;
use tauri::{AppHandle, State};
use tokio::time::error::Elapsed;
use tokio::time::timeout;
use tokio_postgres::NoTls;
use tokio_postgres_rustls::MakeRustlsConnect;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::postgres::params::SslMode;
use crate::modules::postgres::pool::PgPoolRegistry;
use crate::modules::postgres::schema;
use crate::modules::postgres::ddl;
use crate::modules::postgres::schema_types::{
    CheckConstraintInfo, ColumnDetail, ExtensionInfo, ForeignKeyInfo, FunctionInfo,
    FunctionSignature, IndexInfo, KindFailure, PrimaryKeyInfo, RelationsResult, Relkind,
    SchemaSummary, StructureResult, TableExtrasResult, TableStructureResult, TriggerInfo, TypeInfo,
    UniqueConstraintInfo,
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
    app: AppHandle,
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
    let duration_ms = ms as u64;
    let builder = ActivityLogEntryBuilder::new(ActivityKind::ListSchemas, Origin::Auto, duration_ms)
        .connection(parsed);
    match &result {
        Ok(rows) => {
            tracing::info!(
                "postgres_list_schemas ok: id={parsed} schemas={} elapsed={ms}ms",
                rows.len()
            );
            emit_activity(
                &app,
                builder.ok(Some(Metric::Items {
                    value: rows.len() as u32,
                })),
            );
        }
        Err(e) => {
            tracing::error!("postgres_list_schemas err: id={parsed} elapsed={ms}ms err={e:?}");
            emit_activity(&app, builder.err(e));
        }
    }
    result
}

#[tauri::command]
pub async fn postgres_list_relations(
    app: AppHandle,
    pools: State<'_, PgPoolRegistry>,
    id: String,
    schema_name: String,
) -> AppResult<RelationsResult> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    tracing::info!("postgres_list_relations: id={parsed} schema={schema_name}");

    let result: AppResult<RelationsResult> = async {
        let sslmode = pools.sslmode_for(&parsed).await?;
        let client = pools.acquire(&parsed).await?;
        let cancel_token = client.cancel_token();

        match timeout(
            RELATIONS_TIMEOUT,
            schema::list_relations(&client, &schema_name),
        )
        .await
        {
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
        }
    }
    .await;

    let ms = started.elapsed().as_millis();
    let duration_ms = ms as u64;
    let builder = ActivityLogEntryBuilder::new(
        ActivityKind::ListRelations,
        Origin::Auto,
        duration_ms,
    )
    .connection(parsed);
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
            let total = r.tables.len() + r.views.len() + r.materialized_views.len();
            emit_activity(
                &app,
                builder.ok(Some(Metric::Items {
                    value: total as u32,
                })),
            );
        }
        Err(e) => {
            tracing::error!(
                "postgres_list_relations err: id={parsed} schema={schema_name} elapsed={ms}ms err={e:?}"
            );
            emit_activity(&app, builder.err(e));
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
    app: AppHandle,
    pools: State<'_, PgPoolRegistry>,
    id: String,
    schema_name: String,
) -> AppResult<StructureResult> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    tracing::info!("postgres_list_structure: id={parsed} schema={schema_name}");

    let inner_result: AppResult<StructureResult> = async {
        let sslmode = pools.sslmode_for(&parsed).await?;
        let client = pools.acquire(&parsed).await?;
        let cancel_token = client.cancel_token();

        // Wrap the inner join in the outer total timeout. In practice the inner
        // per-query timeouts (8s) resolve everything before the outer (10s)
        // ever fires; the outer is a defensive net.
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

        Ok(StructureResult {
            schema: schema_name.clone(),
            functions,
            types,
            extensions,
            failures,
        })
    }
    .await;

    let ms = started.elapsed().as_millis();
    let duration_ms = ms as u64;
    let builder =
        ActivityLogEntryBuilder::new(ActivityKind::ListStructure, Origin::Auto, duration_ms)
            .connection(parsed);
    match &inner_result {
        Ok(result) => {
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
            let total: u32 = result.functions.as_ref().map(|v| v.len() as u32).unwrap_or(0)
                + result.types.as_ref().map(|v| v.len() as u32).unwrap_or(0)
                + result.extensions.as_ref().map(|v| v.len() as u32).unwrap_or(0);
            emit_activity(&app, builder.ok(Some(Metric::Items { value: total })));
        }
        Err(e) => {
            tracing::error!(
                "postgres_list_structure err: id={parsed} schema={schema_name} elapsed={ms}ms err={e:?}"
            );
            emit_activity(&app, builder.err(e));
        }
    }
    inner_result
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
    app: AppHandle,
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

    let inner_result: AppResult<TableExtrasResult> = async {
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

        Ok(TableExtrasResult {
            schema: schema_name.clone(),
            relation: relation.clone(),
            indexes,
            triggers,
            failures,
        })
    }
    .await;

    let ms = started.elapsed().as_millis();
    let duration_ms = ms as u64;
    let builder =
        ActivityLogEntryBuilder::new(ActivityKind::ListTableExtras, Origin::Auto, duration_ms)
            .connection(parsed);
    match &inner_result {
        Ok(result) => {
            tracing::info!(
                "postgres_list_table_extras ok: id={parsed} schema={schema_name} relation={relation} \
                 indexes={} triggers={} failures={} elapsed={ms}ms",
                result.indexes.as_ref().map(|v| v.len() as i64).unwrap_or(-1),
                result.triggers.as_ref().map(|v| v.len() as i64).unwrap_or(-1),
                result.failures.len(),
            );
            let total: u32 = result.indexes.as_ref().map(|v| v.len() as u32).unwrap_or(0)
                + result.triggers.as_ref().map(|v| v.len() as u32).unwrap_or(0);
            emit_activity(&app, builder.ok(Some(Metric::Items { value: total })));
        }
        Err(e) => {
            tracing::error!(
                "postgres_list_table_extras err: id={parsed} schema={schema_name} relation={relation} elapsed={ms}ms err={e:?}"
            );
            emit_activity(&app, builder.err(e));
        }
    }
    inner_result
}

/// Inner aggregator for `postgres_table_structure`. Runs every per-kind
/// sub-query under `PER_QUERY_TIMEOUT` in parallel, plus the relkind +
/// view-definition lookups required for DDL reconstruction.
#[allow(clippy::type_complexity)]
async fn list_table_structure_inner<'a>(
    client: &'a PgObject,
    schema_name: &'a str,
    relation: &'a str,
) -> (
    Result<AppResult<Vec<ColumnDetail>>, Elapsed>,
    Result<AppResult<Vec<PrimaryKeyInfo>>, Elapsed>,
    Result<AppResult<Vec<ForeignKeyInfo>>, Elapsed>,
    Result<AppResult<Vec<UniqueConstraintInfo>>, Elapsed>,
    Result<AppResult<Vec<CheckConstraintInfo>>, Elapsed>,
    Result<AppResult<Vec<(IndexInfo, String)>>, Elapsed>,
    Result<AppResult<Vec<TriggerInfo>>, Elapsed>,
    Result<AppResult<(Relkind, bool, bool)>, Elapsed>,
) {
    tokio::join!(
        timeout(
            PER_QUERY_TIMEOUT,
            schema::try_kind("columns", schema_name, || {
                schema::list_table_columns_detailed(client, schema_name, relation)
            }),
        ),
        // PK is wrapped in a `Vec` (0 or 1 entries) so it shares the same
        // aggregator path as every other kind. We collapse back to Option
        // before composing the response.
        timeout(PER_QUERY_TIMEOUT, async {
            schema::try_kind("primary_key", schema_name, || async {
                let pk = schema::get_primary_key(client, schema_name, relation).await?;
                Ok(pk.into_iter().collect::<Vec<_>>())
            })
            .await
        }),
        timeout(
            PER_QUERY_TIMEOUT,
            schema::try_kind("foreign_keys", schema_name, || {
                schema::list_foreign_keys(client, schema_name, relation)
            }),
        ),
        timeout(
            PER_QUERY_TIMEOUT,
            schema::try_kind("unique_constraints", schema_name, || {
                schema::list_unique_constraints(client, schema_name, relation)
            }),
        ),
        timeout(
            PER_QUERY_TIMEOUT,
            schema::try_kind("check_constraints", schema_name, || {
                schema::list_check_constraints(client, schema_name, relation)
            }),
        ),
        timeout(
            PER_QUERY_TIMEOUT,
            schema::try_kind("indexes", schema_name, || {
                schema::list_table_indexes_with_def(client, schema_name, relation)
            }),
        ),
        timeout(
            PER_QUERY_TIMEOUT,
            schema::try_kind("triggers", schema_name, || {
                schema::list_table_triggers(client, schema_name, relation)
            }),
        ),
        timeout(
            PER_QUERY_TIMEOUT,
            schema::get_relkind(client, schema_name, relation),
        ),
    )
}

#[tauri::command]
pub async fn postgres_table_structure(
    app: AppHandle,
    pools: State<'_, PgPoolRegistry>,
    id: String,
    schema_name: String,
    relation: String,
    origin: Option<Origin>,
) -> AppResult<TableStructureResult> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    let activity_origin = origin.unwrap_or_default();
    tracing::info!(
        "postgres_table_structure: id={parsed} schema={schema_name} relation={relation} origin={activity_origin:?}"
    );

    let inner_result: AppResult<TableStructureResult> = async {
        let sslmode = pools.sslmode_for(&parsed).await?;
        let client = pools.acquire(&parsed).await?;
        let cancel_token = client.cancel_token();

        let outcome = timeout(
            TOTAL_TIMEOUT,
            list_table_structure_inner(&client, &schema_name, &relation),
        )
        .await;

        let (
            columns_r,
            pk_r,
            fk_r,
            unique_r,
            check_r,
            indexes_r,
            triggers_r,
            relkind_r,
        ) = match outcome {
            Ok(tuple) => tuple,
            Err(_) => {
                fire_cancel(cancel_token, sslmode).await;
                drop(client);
                return Err(AppError::postgres_with_code(
                    "57014",
                    format!(
                        "table structure load timed out ({}s)",
                        TOTAL_TIMEOUT.as_secs()
                    ),
                ));
            }
        };

        let mut failures: Vec<KindFailure> = Vec::new();

        // Columns: required. Failure here returns a hard error rather than a
        // partial response — the Structure subtab cannot render anything
        // without the column list.
        let columns = match columns_r {
            Ok(Ok(cols)) => cols,
            Ok(Err(e)) => return Err(e),
            Err(_) => {
                return Err(AppError::postgres_with_code(
                    "57014",
                    format!(
                        "columns query timed out ({}s)",
                        PER_QUERY_TIMEOUT.as_secs()
                    ),
                ))
            }
        };

        let pk_vec = aggregate_one(pk_r, "primary_key", &mut failures);
        let foreign_keys = aggregate_one(fk_r, "foreign_keys", &mut failures);
        let unique_constraints = aggregate_one(unique_r, "unique_constraints", &mut failures);
        let check_constraints = aggregate_one(check_r, "check_constraints", &mut failures);
        let indexes_with_def = aggregate_one(indexes_r, "indexes", &mut failures);
        let triggers = aggregate_one(triggers_r, "triggers", &mut failures);

        // Relkind: required. Failure → hard error (we can't pick a DDL path).
        let (relkind, is_populated, is_best_effort) = match relkind_r {
            Ok(Ok(t)) => t,
            Ok(Err(e)) => return Err(e),
            Err(_) => {
                return Err(AppError::postgres_with_code(
                    "57014",
                    format!(
                        "relkind lookup timed out ({}s)",
                        PER_QUERY_TIMEOUT.as_secs()
                    ),
                ))
            }
        };

        let primary_key = pk_vec.and_then(|mut v| v.pop());

        // Split indexes into the response payload (IndexInfo only) and the
        // DDL strings used to reconstruct CREATE INDEX lines (skipping the
        // PK index, which is implicit in the PK clause).
        let (indexes, index_defs) = match &indexes_with_def {
            Some(rows) => {
                let pk_name = primary_key.as_ref().map(|p| p.name.as_str());
                let mut info = Vec::with_capacity(rows.len());
                let mut defs = Vec::with_capacity(rows.len());
                for (ix, def) in rows {
                    if Some(ix.name.as_str()) == pk_name {
                        info.push(ix.clone());
                        continue;
                    }
                    info.push(ix.clone());
                    defs.push(def.clone());
                }
                (Some(info), defs)
            }
            None => (None, Vec::new()),
        };

        let ddl = match relkind {
            Relkind::Table => ddl::reconstruct_table(
                &schema_name,
                &relation,
                &columns,
                primary_key.as_ref(),
                foreign_keys.as_deref().unwrap_or(&[]),
                unique_constraints.as_deref().unwrap_or(&[]),
                check_constraints.as_deref().unwrap_or(&[]),
                &index_defs,
            ),
            Relkind::View => {
                let body = schema::get_view_definition(&client, &schema_name, &relation).await?;
                ddl::reconstruct_view(&schema_name, &relation, &body)
            }
            Relkind::MaterializedView => {
                let body = schema::get_view_definition(&client, &schema_name, &relation).await?;
                ddl::reconstruct_matview(&schema_name, &relation, &body, is_populated)
            }
        };

        drop(client);

        for f in &failures {
            tracing::warn!(
                "postgres_table_structure failure: schema={schema_name} relation={relation} \
                 kind={} code={:?} message={}",
                f.kind,
                f.code,
                f.message
            );
        }

        Ok(TableStructureResult {
            schema: schema_name.clone(),
            relation: relation.clone(),
            relkind,
            is_best_effort,
            columns,
            primary_key,
            foreign_keys,
            unique_constraints,
            check_constraints,
            indexes,
            triggers,
            ddl,
            failures,
        })
    }
    .await;

    let ms = started.elapsed().as_millis();
    let duration_ms = ms as u64;
    let builder =
        ActivityLogEntryBuilder::new(ActivityKind::TableStructure, activity_origin, duration_ms)
            .connection(parsed);
    match &inner_result {
        Ok(result) => {
            let total: u32 = result.columns.len() as u32
                + result
                    .indexes
                    .as_ref()
                    .map(|v| v.len() as u32)
                    .unwrap_or(0)
                + result
                    .triggers
                    .as_ref()
                    .map(|v| v.len() as u32)
                    .unwrap_or(0)
                + result
                    .foreign_keys
                    .as_ref()
                    .map(|v| v.len() as u32)
                    .unwrap_or(0)
                + result
                    .unique_constraints
                    .as_ref()
                    .map(|v| v.len() as u32)
                    .unwrap_or(0)
                + result
                    .check_constraints
                    .as_ref()
                    .map(|v| v.len() as u32)
                    .unwrap_or(0)
                + if result.primary_key.is_some() { 1 } else { 0 };
            tracing::info!(
                "postgres_table_structure ok: id={parsed} schema={schema_name} relation={relation} \
                 columns={} pk={} fks={:?} uniques={:?} checks={:?} indexes={:?} triggers={:?} \
                 best_effort={} failures={} elapsed={ms}ms",
                result.columns.len(),
                result.primary_key.is_some(),
                result.foreign_keys.as_ref().map(|v| v.len()),
                result.unique_constraints.as_ref().map(|v| v.len()),
                result.check_constraints.as_ref().map(|v| v.len()),
                result.indexes.as_ref().map(|v| v.len()),
                result.triggers.as_ref().map(|v| v.len()),
                result.is_best_effort,
                result.failures.len(),
            );
            emit_activity(&app, builder.ok(Some(Metric::Items { value: total })));
        }
        Err(e) => {
            tracing::error!(
                "postgres_table_structure err: id={parsed} schema={schema_name} \
                 relation={relation} elapsed={ms}ms err={e:?}"
            );
            emit_activity(&app, builder.err(e));
        }
    }
    inner_result
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
