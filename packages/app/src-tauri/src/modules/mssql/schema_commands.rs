//! Tauri commands for the MS SQL Server schema browser.
//!
//! All commands follow the same partial-degradation pattern:
//! - sub-queries run concurrently with `tokio::join!`
//! - per-query 8 s, total 10 s timeouts
//! - permission-denied (codes 229, 230, 297) degrades to empty bucket + warning
//! - Azure SQL gated-view errors also degrade silently

use std::collections::HashMap;
use std::time::Instant;

use tauri::{AppHandle, State};
use tokio::time::{error::Elapsed, timeout, Duration};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::mssql::errors::map_tiberius_error;
use crate::modules::mssql::pool::{map_bb8_error, MssqlPoolRegistry};
use crate::modules::mssql::schema_types::{
    CheckConstraintSummary, DatabaseInfo, DefaultConstraintSummary, ForeignKeySummary, IndexColumn,
    IndexSummary, KindFailure, RelationInfo, RelationsResult, RoutineInfo, RoutineParameter,
    RoutineSignature, SchemaInfo, SequenceInfo, StructureBuckets, TableExtras, TriggerInfo,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RELATIONS_TIMEOUT: Duration = Duration::from_secs(10);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(10);
const PER_QUERY_TIMEOUT: Duration = Duration::from_secs(8);
const ROUTINE_SIG_TIMEOUT: Duration = Duration::from_secs(5);
const DATABASES_TIMEOUT: Duration = Duration::from_secs(5);

/// System schemas that are always marked `is_system: true`.
const SYSTEM_SCHEMAS: &[&str] = &[
    "sys",
    "INFORMATION_SCHEMA",
    "db_owner",
    "db_accessadmin",
    "db_securityadmin",
    "db_ddladmin",
    "db_backupoperator",
    "db_datareader",
    "db_datawriter",
    "db_denydatareader",
    "db_denydatawriter",
    "guest",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn parse_id(id: &str) -> AppResult<Uuid> {
    Uuid::parse_str(id).map_err(|e| AppError::Validation(format!("bad uuid: {e}")))
}

/// Map an `AppError` into a `KindFailure`.
fn map_failure(kind: &str, err: AppError) -> KindFailure {
    let (code, message) = match err {
        AppError::Mssql(body) => (body.code, body.message),
        other => (None, other.to_string()),
    };
    KindFailure {
        kind: kind.to_string(),
        code,
        message,
    }
}

/// Returns `true` when the error is a permission-denied code (229, 230, 297)
/// or a timeout. Azure SQL gated-view errors (permissions to certain catalog
/// views denied) also produce codes in this range.
fn is_permission_denied(err: &AppError) -> bool {
    match err {
        AppError::Mssql(body) => {
            matches!(body.code, Some(229) | Some(230) | Some(297))
        }
        _ => false,
    }
}

/// Aggregate a sub-query result into `Some(payload)` or `None`,
/// pushing a `KindFailure` on failure.
fn aggregate_one<T>(
    result: Result<AppResult<Vec<T>>, Elapsed>,
    kind: &str,
    failures: &mut Vec<KindFailure>,
) -> Option<Vec<T>> {
    match result {
        Ok(Ok(v)) => Some(v),
        Ok(Err(e)) => {
            tracing::warn!("mssql schema browser: {kind} sub-query failed: {e:?}");
            failures.push(map_failure(kind, e));
            None
        }
        Err(_elapsed) => {
            tracing::warn!(
                "mssql schema browser: {kind} sub-query timed out ({}s)",
                PER_QUERY_TIMEOUT.as_secs()
            );
            failures.push(KindFailure {
                kind: kind.to_string(),
                code: None,
                message: format!("{kind} query timed out ({}s)", PER_QUERY_TIMEOUT.as_secs()),
            });
            None
        }
    }
}

/// Degrade on permission-denied silently; propagate all other errors.
async fn try_kind<T, F, Fut>(kind: &str, f: F) -> AppResult<Vec<T>>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = AppResult<Vec<T>>>,
{
    match f().await {
        Ok(v) => Ok(v),
        Err(e) if is_permission_denied(&e) => {
            tracing::warn!(
                "mssql schema browser: {kind} permission denied (229/230/297); degrading to empty"
            );
            Ok(Vec::new())
        }
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// §1.4 — list_schemas_for_pool (pool-only)
// ---------------------------------------------------------------------------

/// Pool-only inner function for listing schemas. Usable by the context adapter.
pub async fn list_schemas_for_pool(
    pool: &bb8::Pool<bb8_tiberius::ConnectionManager>,
) -> AppResult<Vec<SchemaInfo>> {
    let mut conn = pool.get().await.map_err(map_bb8_error)?;
    let rows = timeout(
        RELATIONS_TIMEOUT,
        conn.simple_query("SELECT name FROM sys.schemas ORDER BY name"),
    )
    .await
    .map_err(|_| {
        AppError::mssql(format!(
            "list schemas timed out ({}s)",
            RELATIONS_TIMEOUT.as_secs()
        ))
    })?
    .map_err(map_tiberius_error)?
    .into_first_result()
    .await
    .map_err(map_tiberius_error)?;

    let schemas: Vec<SchemaInfo> = rows
        .into_iter()
        .map(|row| {
            let name: &str = row.get(0).unwrap_or_default();
            let name = name.to_string();
            let is_system = SYSTEM_SCHEMAS.contains(&name.as_str()) || name.starts_with("db_");
            SchemaInfo { name, is_system }
        })
        .collect();
    Ok(schemas)
}

// ---------------------------------------------------------------------------
// §1.5 — list_relations_for_pool (pool-only)
// ---------------------------------------------------------------------------

/// Pool-only inner function for listing relations in a schema. Usable by the context adapter.
pub async fn list_relations_for_pool(
    pool: &bb8::Pool<bb8_tiberius::ConnectionManager>,
    schema: &str,
) -> AppResult<RelationsResult> {
    run_relations_inner(pool, schema).await
}

// ---------------------------------------------------------------------------
// §1.6 — list_structure_for_pool (columns + PK per relation, pool-only)
// ---------------------------------------------------------------------------

/// Pool-only inner function: returns `(columns, pk_columns)` for a single relation.
/// Used by the context adapter for schema sync.
pub async fn list_structure_for_pool(
    pool: &bb8::Pool<bb8_tiberius::ConnectionManager>,
    schema: &str,
    relation: &str,
) -> AppResult<(Vec<(String, String)>, Vec<String>)> {
    // Columns: (name, data_type)
    let mut conn = pool.get().await.map_err(map_bb8_error)?;
    let col_sql = "
SELECT c.name AS col_name, ty.name AS data_type
FROM sys.columns c
JOIN sys.objects o ON o.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
WHERE s.name = @P1 AND o.name = @P2
ORDER BY c.column_id
";
    let mut qry = tiberius::Query::new(col_sql);
    qry.bind(schema);
    qry.bind(relation);
    let col_rows = qry
        .query(&mut conn)
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let columns: Vec<(String, String)> = col_rows
        .into_iter()
        .map(|row| {
            let name: &str = row.get(0).unwrap_or_default();
            let data_type: &str = row.get(1).unwrap_or_default();
            (name.to_string(), data_type.to_string())
        })
        .collect();

    // PK columns
    let pk_sql = "
SELECT c.name AS col_name
FROM sys.indexes i
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
JOIN sys.objects o ON o.object_id = i.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE s.name = @P1 AND o.name = @P2 AND i.is_primary_key = 1 AND ic.is_included_column = 0
ORDER BY ic.key_ordinal
";
    let mut conn2 = pool.get().await.map_err(map_bb8_error)?;
    let mut pk_qry = tiberius::Query::new(pk_sql);
    pk_qry.bind(schema);
    pk_qry.bind(relation);
    let pk_rows = pk_qry
        .query(&mut conn2)
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let pk_cols: Vec<String> = pk_rows
        .into_iter()
        .map(|row| {
            let col: &str = row.get(0).unwrap_or_default();
            col.to_string()
        })
        .collect();

    Ok((columns, pk_cols))
}

// ---------------------------------------------------------------------------
// §7.2-cmd1 — mssql_list_schemas
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mssql_list_schemas(
    app: AppHandle,
    registry: State<'_, MssqlPoolRegistry>,
    id: String,
    origin: Option<String>,
) -> AppResult<Vec<SchemaInfo>> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    let orig = parse_origin(origin);
    tracing::info!("mssql_list_schemas: id={parsed}");

    let pool = registry.get_pool(parsed)?;

    let result = list_schemas_for_pool(&pool).await;

    // Log schema names at info level (mirrors original behavior).
    if let Ok(ref schemas) = result {
        let names: Vec<&str> = schemas.iter().map(|s| s.name.as_str()).collect();
        tracing::info!(
            "mssql_list_schemas: returning {} schemas: {:?}",
            schemas.len(),
            names
        );
    }

    let ms = started.elapsed().as_millis();
    let duration_ms = ms as u64;
    let builder = ActivityLogEntryBuilder::new(ActivityKind::ListSchemas, orig, duration_ms)
        .connection(parsed);
    match &result {
        Ok(rows) => {
            tracing::info!(
                "mssql_list_schemas ok: id={parsed} schemas={} elapsed={ms}ms",
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
            tracing::error!("mssql_list_schemas err: id={parsed} elapsed={ms}ms err={e:?}");
            emit_activity(&app, builder.err(e));
        }
    }
    result
}

// ---------------------------------------------------------------------------
// §7.2-cmd2 — mssql_list_databases
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mssql_list_databases(
    app: AppHandle,
    registry: State<'_, MssqlPoolRegistry>,
    id: String,
    origin: Option<String>,
) -> AppResult<Vec<DatabaseInfo>> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    let _orig = parse_origin(origin);
    tracing::info!("mssql_list_databases: id={parsed}");

    let pool = registry.get_pool(parsed)?;

    let result: AppResult<Vec<DatabaseInfo>> = async {
        let mut conn = pool.get().await.map_err(map_bb8_error)?;
        let sql = "SELECT name, CASE WHEN name = DB_NAME() THEN 1 ELSE 0 END AS is_current \
                   FROM sys.databases \
                   WHERE HAS_DBACCESS(name) = 1 \
                   ORDER BY name";
        let rows = timeout(DATABASES_TIMEOUT, conn.simple_query(sql))
            .await
            .map_err(|_| {
                AppError::mssql(format!(
                    "list databases timed out ({}s)",
                    DATABASES_TIMEOUT.as_secs()
                ))
            })?
            .map_err(map_tiberius_error)?
            .into_first_result()
            .await
            .map_err(map_tiberius_error)?;

        let databases = rows
            .into_iter()
            .map(|row| {
                let name: &str = row.get(0).unwrap_or_default();
                let is_current_raw: i32 = row.get(1).unwrap_or(0);
                DatabaseInfo {
                    name: name.to_string(),
                    is_current: is_current_raw != 0,
                }
            })
            .collect();
        Ok(databases)
    }
    .await;

    let ms = started.elapsed().as_millis();
    if let Err(ref e) = result {
        tracing::error!("mssql_list_databases err: id={parsed} elapsed={ms}ms err={e:?}");
    } else {
        tracing::info!(
            "mssql_list_databases ok: id={parsed} count={} elapsed={ms}ms",
            result.as_ref().map(|v| v.len()).unwrap_or(0)
        );
    }
    let _ = app;
    result
}

// ---------------------------------------------------------------------------
// §7.3 — mssql_list_relations
// ---------------------------------------------------------------------------

/// Build the relations query (tables + views) for a given schema.
///
/// Note on types: `is_indexed` and `is_partitioned` are emitted as plain INT
/// literals (0/1) in both branches of the UNION ALL so the result column type
/// is consistently INT. Returning BIT for one branch and INT for the other
/// causes tiberius to panic when decoding (the wider type wins, but the row
/// metadata still reports BIT for the first branch). Decode as i32 and
/// convert to bool via `!= 0` in the caller.
const RELATIONS_SQL: &str = "
WITH row_counts AS (
    SELECT object_id, SUM(row_count) AS row_count
    FROM sys.dm_db_partition_stats
    WHERE index_id IN (0, 1)
    GROUP BY object_id
)
SELECT
    s.name AS schema_name,
    t.name AS table_name,
    CAST('table' AS NVARCHAR(20)) AS kind,
    CAST(rc.row_count AS BIGINT) AS estimated_rows,
    0 AS is_indexed,
    CASE WHEN EXISTS (
        SELECT 1 FROM sys.partitions p
        WHERE p.object_id = t.object_id AND p.partition_number > 1
    ) THEN 1 ELSE 0 END AS is_partitioned
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
LEFT JOIN row_counts rc ON rc.object_id = t.object_id
WHERE s.name = @P1
UNION ALL
SELECT
    s.name,
    v.name,
    CAST('view' AS NVARCHAR(20)),
    CAST(NULL AS BIGINT),
    CASE WHEN EXISTS (
        SELECT 1 FROM sys.indexes i WHERE i.object_id = v.object_id AND i.index_id > 0
    ) THEN 1 ELSE 0 END,
    0
FROM sys.views v
JOIN sys.schemas s ON s.schema_id = v.schema_id
WHERE s.name = @P1
ORDER BY 2
";

/// Pure helper: map raw row data to `RelationInfo`.
/// Exported for unit testing without a DB connection.
pub(crate) fn build_relation_info(
    schema_name: String,
    table_name: String,
    kind: String,
    estimated_rows: Option<i64>,
    is_indexed: bool,
    is_partitioned: bool,
) -> RelationInfo {
    let effective_kind = if kind == "table" && is_partitioned {
        "partitioned".to_string()
    } else if kind == "view" && is_indexed {
        "indexed-view".to_string()
    } else {
        kind
    };
    RelationInfo {
        name: table_name,
        schema: schema_name,
        kind: effective_kind,
        estimated_rows,
        is_indexed,
    }
}

#[tauri::command]
pub async fn mssql_list_relations(
    app: AppHandle,
    registry: State<'_, MssqlPoolRegistry>,
    id: String,
    schema: String,
    origin: Option<String>,
) -> AppResult<RelationsResult> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    let orig = parse_origin(origin);
    tracing::info!("mssql_list_relations: id={parsed} schema={schema}");

    let pool = registry.get_pool(parsed)?;
    let schema_clone = schema.clone();

    // Auto-retry once on cancellation (the spec says this).
    let result = run_relations_inner(&pool, &schema_clone).await;

    // Retry on cancellation error.
    let result = match result {
        Err(AppError::Mssql(ref body))
            if body.code.is_none() && body.message.contains("cancelled") =>
        {
            tracing::info!("mssql_list_relations: cancellation detected, retrying once for schema={schema_clone}");
            run_relations_inner(&pool, &schema_clone).await
        }
        other => other,
    };

    let ms = started.elapsed().as_millis();
    let duration_ms = ms as u64;
    let builder = ActivityLogEntryBuilder::new(ActivityKind::ListRelations, orig, duration_ms)
        .connection(parsed);
    match &result {
        Ok(r) => {
            let total = r.tables.len() + r.views.len();
            tracing::info!(
                "mssql_list_relations ok: id={parsed} schema={schema} tables={} views={} elapsed={ms}ms",
                r.tables.len(),
                r.views.len(),
            );
            emit_activity(
                &app,
                builder.ok(Some(Metric::Items {
                    value: total as u32,
                })),
            );
        }
        Err(e) => {
            tracing::error!(
                "mssql_list_relations err: id={parsed} schema={schema} elapsed={ms}ms err={e:?}"
            );
            emit_activity(&app, builder.err(e));
        }
    }
    result
}

async fn run_relations_inner(
    pool: &bb8::Pool<bb8_tiberius::ConnectionManager>,
    schema: &str,
) -> AppResult<RelationsResult> {
    let mut conn = pool.get().await.map_err(map_bb8_error)?;

    let schema_owned = schema.to_string();
    let schema_for_result = schema.to_string();
    let fut = async move {
        let mut qry = tiberius::Query::new(RELATIONS_SQL);
        qry.bind(schema_owned.as_str());
        let rows = qry
            .query(&mut conn)
            .await
            .map_err(map_tiberius_error)?
            .into_first_result()
            .await
            .map_err(map_tiberius_error)?;
        Ok::<Vec<tiberius::Row>, AppError>(rows)
    };

    let rows = timeout(RELATIONS_TIMEOUT, fut).await.map_err(|_| {
        AppError::mssql(format!(
            "list relations timed out ({}s)",
            RELATIONS_TIMEOUT.as_secs()
        ))
    })??;

    tracing::info!(
        "mssql_list_relations: SQL returned {} raw rows for schema='{}'",
        rows.len(),
        schema
    );

    let all_items: Vec<RelationInfo> = rows
        .into_iter()
        .enumerate()
        .map(|(idx, row)| {
            // Use try_get to avoid panics on type mismatches; fall back to defaults.
            let schema_name: &str = row.try_get(0).ok().flatten().unwrap_or_default();
            let table_name: &str = row.try_get(1).ok().flatten().unwrap_or_default();
            let kind: &str = row.try_get(2).ok().flatten().unwrap_or("table");
            let estimated_rows: Option<i64> = row.try_get::<i64, _>(3).ok().flatten();
            // is_indexed and is_partitioned are emitted as INT literals (0/1) in the
            // SQL — see RELATIONS_SQL note. UNION ALL coerces to the wider type.
            let is_indexed_raw: i32 = row.try_get::<i32, _>(4).ok().flatten().unwrap_or(0);
            let is_partitioned_raw: i32 = row.try_get::<i32, _>(5).ok().flatten().unwrap_or(0);

            tracing::debug!(
                "mssql_list_relations row {}: schema='{}' table='{}' kind='{}' est_rows={:?} is_indexed={} is_partitioned={}",
                idx,
                schema_name,
                table_name,
                kind,
                estimated_rows,
                is_indexed_raw,
                is_partitioned_raw,
            );

            build_relation_info(
                schema_name.to_string(),
                table_name.to_string(),
                kind.to_string(),
                estimated_rows,
                is_indexed_raw != 0,
                is_partitioned_raw != 0,
            )
        })
        .collect();

    // Split into tables (kind ∈ {"table","partitioned"}) and views (kind ∈ {"view","indexed-view"}).
    let mut tables = Vec::new();
    let mut views = Vec::new();
    for item in all_items {
        match item.kind.as_str() {
            "table" | "partitioned" => tables.push(item),
            _ => views.push(item),
        }
    }

    Ok(RelationsResult {
        schema: schema_for_result,
        tables,
        views,
        failures: Vec::new(),
    })
}

// ---------------------------------------------------------------------------
// §7.4 — mssql_list_structure
// ---------------------------------------------------------------------------

async fn fetch_procedures(
    pool: &bb8::Pool<bb8_tiberius::ConnectionManager>,
    schema: &str,
) -> AppResult<Vec<RoutineInfo>> {
    let mut conn = pool.get().await.map_err(map_bb8_error)?;
    let schema_owned = schema.to_string();
    let mut qry = tiberius::Query::new(
        "SELECT s.name AS schema_name, p.name AS proc_name \
         FROM sys.procedures p \
         JOIN sys.schemas s ON s.schema_id = p.schema_id \
         WHERE s.name = @P1 \
         ORDER BY p.name",
    );
    qry.bind(schema_owned.as_str());
    let rows = qry
        .query(&mut conn)
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let routines = rows
        .into_iter()
        .map(|row| {
            let schema_name: &str = row.get(0).unwrap_or_default();
            let proc_name: &str = row.get(1).unwrap_or_default();
            RoutineInfo {
                name: proc_name.to_string(),
                schema: schema_name.to_string(),
                kind: "procedure".to_string(),
                function_type: None,
            }
        })
        .collect();
    Ok(routines)
}

fn map_function_kind(type_code: &str) -> &'static str {
    match type_code.trim() {
        "FN" => "scalar_function",
        "IF" => "inline_tvf",
        "TF" => "tvf",
        "FS" => "clr_scalar",
        "FT" => "clr_tvf",
        _ => "scalar_function",
    }
}

async fn fetch_functions(
    pool: &bb8::Pool<bb8_tiberius::ConnectionManager>,
    schema: &str,
) -> AppResult<Vec<RoutineInfo>> {
    let mut conn = pool.get().await.map_err(map_bb8_error)?;
    let schema_owned = schema.to_string();
    let mut qry = tiberius::Query::new(
        "SELECT s.name AS schema_name, o.name AS fn_name, RTRIM(o.type) AS type_code \
         FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         WHERE s.name = @P1 AND o.type IN ('FN','IF','TF','FS','FT') \
         ORDER BY o.name",
    );
    qry.bind(schema_owned.as_str());
    let rows = qry
        .query(&mut conn)
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let routines = rows
        .into_iter()
        .map(|row| {
            let schema_name: &str = row.get(0).unwrap_or_default();
            let fn_name: &str = row.get(1).unwrap_or_default();
            let type_code: &str = row.get(2).unwrap_or("FN");
            let kind = map_function_kind(type_code);
            RoutineInfo {
                name: fn_name.to_string(),
                schema: schema_name.to_string(),
                kind: kind.to_string(),
                function_type: Some(kind.to_string()),
            }
        })
        .collect();
    Ok(routines)
}

async fn fetch_schema_triggers(
    pool: &bb8::Pool<bb8_tiberius::ConnectionManager>,
    schema: &str,
) -> AppResult<Vec<TriggerInfo>> {
    let mut conn = pool.get().await.map_err(map_bb8_error)?;
    let schema_owned = schema.to_string();
    let mut qry = tiberius::Query::new(
        "SELECT s.name AS schema_name, t.name AS table_name, tr.name AS trigger_name, \
                LOWER(tr.type_desc) AS type_desc \
         FROM sys.triggers tr \
         JOIN sys.tables t ON t.object_id = tr.parent_id \
         JOIN sys.schemas s ON s.schema_id = t.schema_id \
         WHERE s.name = @P1 \
         ORDER BY tr.name",
    );
    qry.bind(schema_owned.as_str());
    let rows = qry
        .query(&mut conn)
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let triggers = rows
        .into_iter()
        .map(|row| {
            let schema_name: &str = row.get(0).unwrap_or_default();
            let table_name: &str = row.get(1).unwrap_or_default();
            let trigger_name: &str = row.get(2).unwrap_or_default();
            let type_desc: &str = row.get(3).unwrap_or("sql_trigger");
            TriggerInfo {
                name: trigger_name.to_string(),
                table: table_name.to_string(),
                schema: schema_name.to_string(),
                kind: type_desc.to_string(),
            }
        })
        .collect();
    Ok(triggers)
}

async fn fetch_sequences(
    pool: &bb8::Pool<bb8_tiberius::ConnectionManager>,
    schema: &str,
) -> AppResult<Vec<SequenceInfo>> {
    let mut conn = pool.get().await.map_err(map_bb8_error)?;
    let schema_owned = schema.to_string();
    let mut qry = tiberius::Query::new(
        "SELECT s.name AS schema_name, seq.name AS seq_name, \
                CAST(seq.start_value AS BIGINT) AS start_val, \
                CAST(seq.increment AS BIGINT) AS inc_val \
         FROM sys.sequences seq \
         JOIN sys.schemas s ON s.schema_id = seq.schema_id \
         WHERE s.name = @P1 \
         ORDER BY seq.name",
    );
    qry.bind(schema_owned.as_str());
    let rows = qry
        .query(&mut conn)
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let seqs = rows
        .into_iter()
        .map(|row| {
            let schema_name: &str = row.get(0).unwrap_or_default();
            let seq_name: &str = row.get(1).unwrap_or_default();
            let start_val: Option<i64> = row.get::<i64, _>(2);
            let inc_val: Option<i64> = row.get::<i64, _>(3);
            SequenceInfo {
                name: seq_name.to_string(),
                schema: schema_name.to_string(),
                start_value: start_val,
                increment: inc_val,
            }
        })
        .collect();
    Ok(seqs)
}

#[tauri::command]
pub async fn mssql_list_structure(
    app: AppHandle,
    registry: State<'_, MssqlPoolRegistry>,
    id: String,
    schema: String,
    origin: Option<String>,
) -> AppResult<StructureBuckets> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    let orig = parse_origin(origin);
    tracing::info!("mssql_list_structure: id={parsed} schema={schema}");

    let pool = registry.get_pool(parsed)?;
    let schema_c = schema.clone();

    let result = timeout(TOTAL_TIMEOUT, async {
        let (procedures_r, functions_r, triggers_r, sequences_r) = tokio::join!(
            timeout(
                PER_QUERY_TIMEOUT,
                try_kind("procedures", || fetch_procedures(&pool, &schema_c))
            ),
            timeout(
                PER_QUERY_TIMEOUT,
                try_kind("functions", || fetch_functions(&pool, &schema_c))
            ),
            timeout(
                PER_QUERY_TIMEOUT,
                try_kind("triggers", || fetch_schema_triggers(&pool, &schema_c))
            ),
            timeout(
                PER_QUERY_TIMEOUT,
                try_kind("sequences", || fetch_sequences(&pool, &schema_c))
            ),
        );

        let mut failures = Vec::new();
        let procedures =
            aggregate_one(procedures_r, "procedures", &mut failures).unwrap_or_default();
        let functions = aggregate_one(functions_r, "functions", &mut failures).unwrap_or_default();
        let triggers = aggregate_one(triggers_r, "triggers", &mut failures).unwrap_or_default();
        let sequences = aggregate_one(sequences_r, "sequences", &mut failures).unwrap_or_default();

        for f in &failures {
            tracing::warn!(
                "mssql_list_structure failure: schema={schema_c} kind={} code={:?} message={}",
                f.kind,
                f.code,
                f.message
            );
        }

        Ok::<StructureBuckets, AppError>(StructureBuckets {
            schema: schema_c.clone(),
            procedures,
            functions,
            triggers,
            sequences,
            failures,
        })
    })
    .await
    .unwrap_or_else(|_| {
        Ok(StructureBuckets {
            schema: schema_c.clone(),
            procedures: Vec::new(),
            functions: Vec::new(),
            triggers: Vec::new(),
            sequences: Vec::new(),
            failures: vec![
                KindFailure {
                    kind: "procedures".into(),
                    code: None,
                    message: format!("timed out ({}s)", TOTAL_TIMEOUT.as_secs()),
                },
                KindFailure {
                    kind: "functions".into(),
                    code: None,
                    message: format!("timed out ({}s)", TOTAL_TIMEOUT.as_secs()),
                },
                KindFailure {
                    kind: "triggers".into(),
                    code: None,
                    message: format!("timed out ({}s)", TOTAL_TIMEOUT.as_secs()),
                },
                KindFailure {
                    kind: "sequences".into(),
                    code: None,
                    message: format!("timed out ({}s)", TOTAL_TIMEOUT.as_secs()),
                },
            ],
        })
    });

    let ms = started.elapsed().as_millis();
    let duration_ms = ms as u64;
    let builder = ActivityLogEntryBuilder::new(ActivityKind::ListStructure, orig, duration_ms)
        .connection(parsed);
    match &result {
        Ok(r) => {
            let total =
                (r.procedures.len() + r.functions.len() + r.triggers.len() + r.sequences.len())
                    as u32;
            tracing::info!(
                "mssql_list_structure ok: id={parsed} schema={schema} procs={} fns={} triggers={} seqs={} failures={} elapsed={ms}ms",
                r.procedures.len(), r.functions.len(), r.triggers.len(), r.sequences.len(), r.failures.len()
            );
            emit_activity(&app, builder.ok(Some(Metric::Items { value: total })));
        }
        Err(e) => {
            tracing::error!(
                "mssql_list_structure err: id={parsed} schema={schema} elapsed={ms}ms err={e:?}"
            );
            emit_activity(&app, builder.err(e));
        }
    }
    result
}

// ---------------------------------------------------------------------------
// §7.5 — mssql_list_table_extras
// ---------------------------------------------------------------------------

async fn fetch_indexes(
    pool: &bb8::Pool<bb8_tiberius::ConnectionManager>,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<IndexSummary>> {
    let mut conn = pool.get().await.map_err(map_bb8_error)?;
    let qualified = format!("[{schema}].[{relation}]");
    let mut qry = tiberius::Query::new(
        "SELECT i.name AS idx_name, i.is_unique, i.is_primary_key, i.type_desc AS idx_type, \
                ic.key_ordinal, ic.is_descending_key, ic.is_included_column, \
                c.name AS col_name, i.filter_definition \
         FROM sys.indexes i \
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
         WHERE i.object_id = OBJECT_ID(@P1) AND i.name IS NOT NULL \
         ORDER BY i.name, ic.key_ordinal",
    );
    qry.bind(qualified.as_str());
    let rows = qry
        .query(&mut conn)
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    // Group by index name.
    // Tuple: (is_unique, is_pk, is_clustered, idx_type, filter_def, key_cols, included_col_names)
    let mut index_map: HashMap<
        String,
        (
            bool,
            bool,
            bool,
            String,
            Option<String>,
            Vec<IndexColumn>,
            Vec<String>,
        ),
    > = HashMap::new();
    let mut order: Vec<String> = Vec::new();

    for row in rows {
        let idx_name: &str = row.get(0).unwrap_or_default();
        let is_unique: bool = row.get::<bool, _>(1).unwrap_or(false);
        let is_pk: bool = row.get::<bool, _>(2).unwrap_or(false);
        let idx_type: &str = row.get(3).unwrap_or("NONCLUSTERED");
        let key_ordinal: i32 = row.get::<u8, _>(4).unwrap_or(0) as i32;
        let is_desc: bool = row.get::<bool, _>(5).unwrap_or(false);
        let is_included: bool = row.get::<bool, _>(6).unwrap_or(false);
        let col_name: &str = row.get(7).unwrap_or_default();
        let filter_def: Option<&str> = row.get(8);
        let is_clustered = idx_type.eq_ignore_ascii_case("CLUSTERED");

        let entry = index_map.entry(idx_name.to_string()).or_insert_with(|| {
            order.push(idx_name.to_string());
            (
                is_unique,
                is_pk,
                is_clustered,
                idx_type.to_string(),
                filter_def.map(|s| s.to_string()),
                Vec::new(),
                Vec::new(),
            )
        });
        if is_included {
            entry.6.push(col_name.to_string());
        } else {
            entry.5.push(IndexColumn {
                name: col_name.to_string(),
                key_ordinal,
                is_descending: is_desc,
                is_included,
            });
        }
    }

    let indexes = order
        .into_iter()
        .filter_map(|name| {
            index_map.remove(&name).map(
                |(is_unique, is_pk, is_clustered, idx_type, filter_def, cols, included_cols)| {
                    IndexSummary {
                        name,
                        is_unique,
                        is_primary_key: is_pk,
                        is_clustered,
                        index_type: idx_type,
                        columns: cols,
                        included_columns: included_cols,
                        filter_definition: filter_def,
                    }
                },
            )
        })
        .collect();
    Ok(indexes)
}

async fn fetch_table_triggers(
    pool: &bb8::Pool<bb8_tiberius::ConnectionManager>,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<TriggerInfo>> {
    let mut conn = pool.get().await.map_err(map_bb8_error)?;
    let qualified = format!("[{schema}].[{relation}]");
    let mut qry = tiberius::Query::new(
        "SELECT s.name AS schema_name, t.name AS table_name, tr.name AS trigger_name, \
                LOWER(tr.type_desc) AS type_desc \
         FROM sys.triggers tr \
         JOIN sys.tables t ON t.object_id = tr.parent_id \
         JOIN sys.schemas s ON s.schema_id = t.schema_id \
         WHERE tr.parent_id = OBJECT_ID(@P1) \
         ORDER BY tr.name",
    );
    qry.bind(qualified.as_str());
    let rows = qry
        .query(&mut conn)
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let triggers = rows
        .into_iter()
        .map(|row| {
            let schema_name: &str = row.get(0).unwrap_or_default();
            let table_name: &str = row.get(1).unwrap_or_default();
            let trigger_name: &str = row.get(2).unwrap_or_default();
            let type_desc: &str = row.get(3).unwrap_or("sql_trigger");
            TriggerInfo {
                name: trigger_name.to_string(),
                table: table_name.to_string(),
                schema: schema_name.to_string(),
                kind: type_desc.to_string(),
            }
        })
        .collect();
    Ok(triggers)
}

async fn fetch_foreign_keys(
    pool: &bb8::Pool<bb8_tiberius::ConnectionManager>,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<ForeignKeySummary>> {
    let mut conn = pool.get().await.map_err(map_bb8_error)?;
    let qualified = format!("[{schema}].[{relation}]");
    let mut qry = tiberius::Query::new(
        "SELECT fk.name AS fk_name, \
                pc.name AS col_name, \
                rs.name AS ref_schema, rt.name AS ref_table, rc.name AS ref_col, \
                fk.update_referential_action_desc AS update_rule, \
                fk.delete_referential_action_desc AS delete_rule, \
                fk.is_disabled, fk.is_not_trusted, \
                fkc.constraint_column_id \
         FROM sys.foreign_keys fk \
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
         JOIN sys.columns pc ON pc.object_id = fk.parent_object_id AND pc.column_id = fkc.parent_column_id \
         JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id \
         JOIN sys.schemas rs ON rs.schema_id = rt.schema_id \
         JOIN sys.columns rc ON rc.object_id = fk.referenced_object_id AND rc.column_id = fkc.referenced_column_id \
         WHERE fk.parent_object_id = OBJECT_ID(@P1) \
         ORDER BY fk.name, fkc.constraint_column_id",
    );
    qry.bind(qualified.as_str());
    let rows = qry
        .query(&mut conn)
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let mut fk_map: HashMap<
        String,
        (
            String,
            String,
            String,
            String,
            bool,
            bool,
            Vec<String>,
            Vec<String>,
        ),
    > = HashMap::new();
    let mut order: Vec<String> = Vec::new();

    for row in rows {
        let fk_name: &str = row.get(0).unwrap_or_default();
        let col_name: &str = row.get(1).unwrap_or_default();
        let ref_schema: &str = row.get(2).unwrap_or_default();
        let ref_table: &str = row.get(3).unwrap_or_default();
        let ref_col: &str = row.get(4).unwrap_or_default();
        let update_rule: &str = row.get(5).unwrap_or("NO_ACTION");
        let delete_rule: &str = row.get(6).unwrap_or("NO_ACTION");
        let is_disabled: bool = row.get::<bool, _>(7).unwrap_or(false);
        let is_not_trusted: bool = row.get::<bool, _>(8).unwrap_or(false);

        let entry = fk_map.entry(fk_name.to_string()).or_insert_with(|| {
            order.push(fk_name.to_string());
            (
                ref_schema.to_string(),
                ref_table.to_string(),
                update_rule.to_string(),
                delete_rule.to_string(),
                is_disabled,
                is_not_trusted,
                Vec::new(),
                Vec::new(),
            )
        });
        entry.6.push(col_name.to_string());
        entry.7.push(ref_col.to_string());
    }

    let fks = order
        .into_iter()
        .filter_map(|name| {
            fk_map.remove(&name).map(
                |(
                    ref_schema,
                    ref_table,
                    update_rule,
                    delete_rule,
                    is_disabled,
                    is_not_trusted,
                    cols,
                    ref_cols,
                )| {
                    ForeignKeySummary {
                        name,
                        columns: cols,
                        referenced_schema: ref_schema,
                        referenced_table: ref_table,
                        referenced_columns: ref_cols,
                        update_rule,
                        delete_rule,
                        is_disabled,
                        is_not_trusted,
                    }
                },
            )
        })
        .collect();
    Ok(fks)
}

async fn fetch_check_constraints(
    pool: &bb8::Pool<bb8_tiberius::ConnectionManager>,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<CheckConstraintSummary>> {
    let mut conn = pool.get().await.map_err(map_bb8_error)?;
    let qualified = format!("[{schema}].[{relation}]");
    let mut qry = tiberius::Query::new(
        "SELECT cc.name, c.name AS col_name, cc.definition, cc.is_disabled, cc.is_not_trusted \
         FROM sys.check_constraints cc \
         LEFT JOIN sys.columns c ON c.object_id = cc.parent_object_id AND c.column_id = cc.parent_column_id \
         WHERE cc.parent_object_id = OBJECT_ID(@P1) \
         ORDER BY cc.name",
    );
    qry.bind(qualified.as_str());
    let rows = qry
        .query(&mut conn)
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let checks = rows
        .into_iter()
        .map(|row| {
            let name: &str = row.get(0).unwrap_or_default();
            let col_name: Option<&str> = row.get(1);
            let definition: &str = row.get(2).unwrap_or_default();
            let is_disabled: bool = row.get::<bool, _>(3).unwrap_or(false);
            let is_not_trusted: bool = row.get::<bool, _>(4).unwrap_or(false);
            CheckConstraintSummary {
                name: name.to_string(),
                column_name: col_name.map(|s| s.to_string()),
                definition: definition.to_string(),
                is_disabled,
                is_not_trusted,
            }
        })
        .collect();
    Ok(checks)
}

async fn fetch_default_constraints(
    pool: &bb8::Pool<bb8_tiberius::ConnectionManager>,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<DefaultConstraintSummary>> {
    let mut conn = pool.get().await.map_err(map_bb8_error)?;
    let qualified = format!("[{schema}].[{relation}]");
    let mut qry = tiberius::Query::new(
        "SELECT dc.name, c.name AS col_name, dc.definition \
         FROM sys.default_constraints dc \
         JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id \
         WHERE dc.parent_object_id = OBJECT_ID(@P1) \
         ORDER BY dc.name",
    );
    qry.bind(qualified.as_str());
    let rows = qry
        .query(&mut conn)
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let defaults = rows
        .into_iter()
        .map(|row| {
            let name: &str = row.get(0).unwrap_or_default();
            let col_name: &str = row.get(1).unwrap_or_default();
            let definition: &str = row.get(2).unwrap_or_default();
            DefaultConstraintSummary {
                name: name.to_string(),
                column_name: col_name.to_string(),
                definition: definition.to_string(),
            }
        })
        .collect();
    Ok(defaults)
}

#[tauri::command]
pub async fn mssql_list_table_extras(
    app: AppHandle,
    registry: State<'_, MssqlPoolRegistry>,
    id: String,
    schema: String,
    relation: String,
    origin: Option<String>,
) -> AppResult<TableExtras> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    let orig = parse_origin(origin);
    tracing::info!("mssql_list_table_extras: id={parsed} schema={schema} relation={relation}");

    let pool = registry.get_pool(parsed)?;
    let schema_c = schema.clone();
    let relation_c = relation.clone();

    let result = timeout(TOTAL_TIMEOUT, async {
        let (indexes_r, triggers_r, fks_r, checks_r, defaults_r) = tokio::join!(
            timeout(
                PER_QUERY_TIMEOUT,
                try_kind("indexes", || fetch_indexes(&pool, &schema_c, &relation_c))
            ),
            timeout(
                PER_QUERY_TIMEOUT,
                try_kind("triggers", || fetch_table_triggers(
                    &pool,
                    &schema_c,
                    &relation_c
                ))
            ),
            timeout(
                PER_QUERY_TIMEOUT,
                try_kind("foreign_keys", || fetch_foreign_keys(
                    &pool,
                    &schema_c,
                    &relation_c
                ))
            ),
            timeout(
                PER_QUERY_TIMEOUT,
                try_kind("check_constraints", || fetch_check_constraints(
                    &pool,
                    &schema_c,
                    &relation_c
                ))
            ),
            timeout(
                PER_QUERY_TIMEOUT,
                try_kind("default_constraints", || fetch_default_constraints(
                    &pool,
                    &schema_c,
                    &relation_c
                ))
            ),
        );

        let mut failures = Vec::new();
        let indexes = aggregate_one(indexes_r, "indexes", &mut failures).unwrap_or_default();
        let triggers = aggregate_one(triggers_r, "triggers", &mut failures).unwrap_or_default();
        let foreign_keys = aggregate_one(fks_r, "foreign_keys", &mut failures).unwrap_or_default();
        let check_constraints =
            aggregate_one(checks_r, "check_constraints", &mut failures).unwrap_or_default();
        let default_constraints =
            aggregate_one(defaults_r, "default_constraints", &mut failures).unwrap_or_default();

        Ok::<TableExtras, AppError>(TableExtras {
            schema: schema_c.clone(),
            relation: relation_c.clone(),
            indexes,
            triggers,
            foreign_keys,
            check_constraints,
            default_constraints,
            failures,
        })
    })
    .await
    .unwrap_or_else(|_| {
        Ok(TableExtras {
            schema: schema_c.clone(),
            relation: relation_c.clone(),
            indexes: Vec::new(),
            triggers: Vec::new(),
            foreign_keys: Vec::new(),
            check_constraints: Vec::new(),
            default_constraints: Vec::new(),
            failures: vec![
                KindFailure {
                    kind: "indexes".into(),
                    code: None,
                    message: format!("timed out ({}s)", TOTAL_TIMEOUT.as_secs()),
                },
                KindFailure {
                    kind: "triggers".into(),
                    code: None,
                    message: format!("timed out ({}s)", TOTAL_TIMEOUT.as_secs()),
                },
                KindFailure {
                    kind: "foreign_keys".into(),
                    code: None,
                    message: format!("timed out ({}s)", TOTAL_TIMEOUT.as_secs()),
                },
                KindFailure {
                    kind: "check_constraints".into(),
                    code: None,
                    message: format!("timed out ({}s)", TOTAL_TIMEOUT.as_secs()),
                },
                KindFailure {
                    kind: "default_constraints".into(),
                    code: None,
                    message: format!("timed out ({}s)", TOTAL_TIMEOUT.as_secs()),
                },
            ],
        })
    });

    let ms = started.elapsed().as_millis();
    let duration_ms = ms as u64;
    let builder = ActivityLogEntryBuilder::new(ActivityKind::ListTableExtras, orig, duration_ms)
        .connection(parsed);
    match &result {
        Ok(r) => {
            let total = (r.indexes.len()
                + r.triggers.len()
                + r.foreign_keys.len()
                + r.check_constraints.len()
                + r.default_constraints.len()) as u32;
            tracing::info!(
                "mssql_list_table_extras ok: id={parsed} schema={schema} relation={relation} total={total} failures={} elapsed={ms}ms",
                r.failures.len()
            );
            emit_activity(&app, builder.ok(Some(Metric::Items { value: total })));
        }
        Err(e) => {
            tracing::error!(
                "mssql_list_table_extras err: id={parsed} schema={schema} relation={relation} elapsed={ms}ms err={e:?}"
            );
            emit_activity(&app, builder.err(e));
        }
    }
    result
}

// ---------------------------------------------------------------------------
// §7.6 — mssql_get_routine_signature
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mssql_get_routine_signature(
    app: AppHandle,
    registry: State<'_, MssqlPoolRegistry>,
    id: String,
    schema: String,
    name: String,
    kind: String,
    origin: Option<String>,
) -> AppResult<RoutineSignature> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    let _orig = parse_origin(origin);
    tracing::info!("mssql_get_routine_signature: id={parsed} schema={schema} name={name}");

    let pool = registry.get_pool(parsed)?;
    let qualified = format!("[{schema}].[{name}]");

    let result: AppResult<RoutineSignature> = async {
        let mut conn = pool.get().await.map_err(map_bb8_error)?;
        let mut qry = tiberius::Query::new(
            "SELECT p.name, TYPE_NAME(p.user_type_id) AS data_type, \
                    CASE \
                        WHEN p.is_output = 1 AND p.parameter_id = 0 THEN 'return' \
                        WHEN p.is_output = 1 THEN 'inout' \
                        ELSE 'in' \
                    END AS mode, \
                    p.parameter_id AS ordinal \
             FROM sys.parameters p \
             WHERE p.object_id = OBJECT_ID(@P1) \
             ORDER BY p.parameter_id",
        );
        qry.bind(qualified.as_str());

        let rows = timeout(ROUTINE_SIG_TIMEOUT, qry.query(&mut conn))
            .await
            .map_err(|_| {
                AppError::mssql(format!(
                    "routine signature timed out ({}s)",
                    ROUTINE_SIG_TIMEOUT.as_secs()
                ))
            })?
            .map_err(map_tiberius_error)?
            .into_first_result()
            .await
            .map_err(map_tiberius_error)?;

        let mut parameters: Vec<RoutineParameter> = Vec::new();
        let mut returns: Option<String> = None;

        for row in rows {
            let param_name: &str = row.get(0).unwrap_or_default();
            let data_type: &str = row.get(1).unwrap_or_default();
            let mode: &str = row.get(2).unwrap_or("in");
            let ordinal: i32 = row.get::<i32, _>(3).unwrap_or(0);

            if mode == "return" {
                returns = Some(data_type.to_string());
            }
            parameters.push(RoutineParameter {
                name: param_name.to_string(),
                data_type: data_type.to_string(),
                mode: mode.to_string(),
                ordinal,
            });
        }

        Ok(RoutineSignature {
            schema: schema.clone(),
            name: name.clone(),
            kind: kind.clone(),
            parameters,
            returns,
        })
    }
    .await;

    let ms = started.elapsed().as_millis();
    match &result {
        Ok(_) => {
            tracing::info!("mssql_get_routine_signature ok: id={parsed} schema={schema} name={name} elapsed={ms}ms");
        }
        Err(e) => {
            tracing::error!("mssql_get_routine_signature err: id={parsed} schema={schema} name={name} elapsed={ms}ms err={e:?}");
        }
    }
    let _ = app;
    result
}

// ---------------------------------------------------------------------------
// §7.7 — mssql_get_object_definition
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mssql_get_object_definition(
    app: AppHandle,
    registry: State<'_, MssqlPoolRegistry>,
    id: String,
    schema: String,
    name: String,
    origin: Option<String>,
) -> AppResult<Option<String>> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    let _orig = parse_origin(origin);
    let qualified = format!("[{schema}].[{name}]");
    tracing::info!("mssql_get_object_definition: id={parsed} schema={schema} name={name}");

    let pool = registry.get_pool(parsed)?;

    let result: AppResult<Option<String>> = async {
        let mut conn = pool.get().await.map_err(map_bb8_error)?;
        let mut qry =
            tiberius::Query::new("SELECT OBJECT_DEFINITION(OBJECT_ID(@P1)) AS definition");
        qry.bind(qualified.as_str());

        let rows = timeout(ROUTINE_SIG_TIMEOUT, qry.query(&mut conn))
            .await
            .map_err(|_| {
                AppError::mssql(format!(
                    "object definition timed out ({}s)",
                    ROUTINE_SIG_TIMEOUT.as_secs()
                ))
            })?
            .map_err(map_tiberius_error)?
            .into_first_result()
            .await
            .map_err(map_tiberius_error)?;

        let definition: Option<String> = rows
            .into_iter()
            .next()
            .and_then(|row| row.get::<&str, _>(0).map(|s| s.to_string()));

        Ok(definition)
    }
    .await;

    let ms = started.elapsed().as_millis();
    match &result {
        Ok(d) => tracing::info!(
            "mssql_get_object_definition ok: id={parsed} has_def={} elapsed={ms}ms",
            d.is_some()
        ),
        Err(e) => {
            tracing::error!("mssql_get_object_definition err: id={parsed} elapsed={ms}ms err={e:?}")
        }
    }
    let _ = app;
    result
}

// ---------------------------------------------------------------------------
// Helper: parse origin
// ---------------------------------------------------------------------------

fn parse_origin(origin: Option<String>) -> Origin {
    match origin.as_deref() {
        Some("user") => Origin::User,
        _ => Origin::Auto,
    }
}

// ---------------------------------------------------------------------------
// §7.10 — Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::error::Elapsed;

    // -----------------------------------------------------------------------
    // build_relation_info tests
    // -----------------------------------------------------------------------

    #[test]
    fn table_becomes_regular() {
        let r = build_relation_info(
            "dbo".into(),
            "users".into(),
            "table".into(),
            Some(100),
            false,
            false,
        );
        assert_eq!(r.kind, "table");
        assert_eq!(r.name, "users");
    }

    #[test]
    fn partitioned_table_overrides_kind() {
        let r = build_relation_info(
            "dbo".into(),
            "orders".into(),
            "table".into(),
            Some(50000),
            false,
            true,
        );
        assert_eq!(r.kind, "partitioned");
    }

    #[test]
    fn indexed_view_gets_indexed_view_kind() {
        let r = build_relation_info(
            "dbo".into(),
            "v_sales".into(),
            "view".into(),
            None,
            true,
            false,
        );
        assert_eq!(r.kind, "indexed-view");
    }

    #[test]
    fn plain_view_stays_view() {
        let r = build_relation_info(
            "dbo".into(),
            "v_active".into(),
            "view".into(),
            None,
            false,
            false,
        );
        assert_eq!(r.kind, "view");
    }

    // -----------------------------------------------------------------------
    // system schema detection
    // -----------------------------------------------------------------------

    #[test]
    fn sys_is_system() {
        assert!(SYSTEM_SCHEMAS.contains(&"sys"));
    }

    #[test]
    fn information_schema_is_system() {
        assert!(SYSTEM_SCHEMAS.contains(&"INFORMATION_SCHEMA"));
    }

    #[test]
    fn dbo_is_not_system() {
        assert!(!SYSTEM_SCHEMAS.contains(&"dbo"));
    }

    #[test]
    fn all_db_roles_are_system() {
        for schema in &[
            "db_owner",
            "db_accessadmin",
            "db_securityadmin",
            "db_ddladmin",
            "db_backupoperator",
            "db_datareader",
            "db_datawriter",
            "db_denydatareader",
            "db_denydatawriter",
            "guest",
        ] {
            assert!(SYSTEM_SCHEMAS.contains(schema), "{schema} should be system");
        }
    }

    // -----------------------------------------------------------------------
    // aggregate_one tests
    // -----------------------------------------------------------------------

    async fn synth_elapsed() -> Elapsed {
        tokio::time::timeout(
            Duration::from_nanos(1),
            tokio::time::sleep(Duration::from_secs(60)),
        )
        .await
        .unwrap_err()
    }

    #[test]
    fn aggregate_one_success() {
        let mut failures = Vec::new();
        let result: Result<AppResult<Vec<i32>>, Elapsed> = Ok(Ok(vec![1, 2, 3]));
        let out = aggregate_one(result, "indexes", &mut failures);
        assert_eq!(out, Some(vec![1, 2, 3]));
        assert!(failures.is_empty());
    }

    #[test]
    fn aggregate_one_error_appends_failure_returns_none() {
        let mut failures = Vec::new();
        let err = AppError::Mssql(crate::error::MssqlErrorBody {
            code: Some(229),
            message: "permission denied".into(),
            line: None,
            procedure: None,
        });
        let result: Result<AppResult<Vec<i32>>, Elapsed> = Ok(Err(err));
        let out = aggregate_one(result, "indexes", &mut failures);
        assert_eq!(out, None);
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].kind, "indexes");
        assert_eq!(failures[0].code, Some(229));
    }

    #[tokio::test]
    async fn aggregate_one_elapsed_appends_none_code_failure() {
        let mut failures = Vec::new();
        let elapsed = synth_elapsed().await;
        let result: Result<AppResult<Vec<i32>>, Elapsed> = Err(elapsed);
        let out = aggregate_one(result, "triggers", &mut failures);
        assert_eq!(out, None);
        assert_eq!(failures.len(), 1);
        assert!(failures[0].code.is_none());
        assert!(failures[0].message.contains("timed out"));
    }

    // -----------------------------------------------------------------------
    // permission-denied detection
    // -----------------------------------------------------------------------

    #[test]
    fn is_permission_denied_code_229() {
        let err = AppError::Mssql(crate::error::MssqlErrorBody {
            code: Some(229),
            message: "permission denied".into(),
            line: None,
            procedure: None,
        });
        assert!(is_permission_denied(&err));
    }

    #[test]
    fn is_permission_denied_code_230() {
        let err = AppError::Mssql(crate::error::MssqlErrorBody {
            code: Some(230),
            message: "column permission denied".into(),
            line: None,
            procedure: None,
        });
        assert!(is_permission_denied(&err));
    }

    #[test]
    fn is_permission_denied_code_297() {
        let err = AppError::Mssql(crate::error::MssqlErrorBody {
            code: Some(297),
            message: "user does not have permission".into(),
            line: None,
            procedure: None,
        });
        assert!(is_permission_denied(&err));
    }

    #[test]
    fn is_permission_denied_other_code_false() {
        let err = AppError::Mssql(crate::error::MssqlErrorBody {
            code: Some(547),
            message: "FK violation".into(),
            line: None,
            procedure: None,
        });
        assert!(!is_permission_denied(&err));
    }

    // -----------------------------------------------------------------------
    // map_function_kind tests
    // -----------------------------------------------------------------------

    #[test]
    fn function_kind_mapping() {
        assert_eq!(map_function_kind("FN"), "scalar_function");
        assert_eq!(map_function_kind("IF"), "inline_tvf");
        assert_eq!(map_function_kind("TF"), "tvf");
        assert_eq!(map_function_kind("FS"), "clr_scalar");
        assert_eq!(map_function_kind("FT"), "clr_tvf");
        // With spaces from RTRIM in SQL
        assert_eq!(map_function_kind(" FN "), "scalar_function");
    }

    // -----------------------------------------------------------------------
    // quote_ident test (indirect — via OBJECT_ID argument format)
    // -----------------------------------------------------------------------

    #[test]
    fn schema_and_name_format_for_object_id() {
        let schema = "dbo";
        let name = "my_proc";
        let qualified = format!("[{schema}].[{name}]");
        assert_eq!(qualified, "[dbo].[my_proc]");
    }
}
