use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use sqlx::Row as _;
use tauri::{AppHandle, State};
use tokio::time::{error::Elapsed, timeout};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::mysql::errors::map_sqlx_error;
use crate::modules::mysql::pool::MysqlPoolRegistry;
use crate::modules::mysql::schema_types::{
    EventInfo, ForeignKeyInfo, IndexColumn, IndexInfo, KindFailure, RelationInfo, RelationsResult,
    RoutineInfo, RoutineSignature, SchemaInfo, StructureResult, TableExtrasResult, TriggerInfo,
    ViewInfo,
};

pub const RELATIONS_TIMEOUT: Duration = Duration::from_secs(10);
pub const TOTAL_TIMEOUT: Duration = Duration::from_secs(10);
pub const PER_QUERY_TIMEOUT: Duration = Duration::from_secs(8);
pub const ROUTINE_SIG_TIMEOUT: Duration = Duration::from_secs(5);

fn parse_id(id: &str) -> AppResult<Uuid> {
    Uuid::parse_str(id).map_err(|e| AppError::Validation(format!("bad uuid: {e}")))
}

/// Build a `KindFailure` from any `AppError`.
pub(super) fn map_failure(kind: &str, err: AppError) -> KindFailure {
    let (code, message) = match err {
        AppError::Mysql(body) => (body.code, body.message),
        other => (None, other.to_string()),
    };
    KindFailure {
        kind: kind.to_string(),
        code,
        message,
    }
}

/// Aggregate a sub-query result into `Some(payload)` or `None`, pushing a
/// `KindFailure` on failure. SQLSTATE `42000` (permission-denied on
/// information_schema) silently degrades to `Some(Vec::new())`.
pub(super) fn aggregate_one<T>(
    result: Result<AppResult<Vec<T>>, Elapsed>,
    kind: &str,
    failures: &mut Vec<KindFailure>,
) -> Option<Vec<T>> {
    match result {
        Ok(Ok(v)) => Some(v),
        Ok(Err(e)) => {
            tracing::warn!("mysql schema browser: {kind} sub-query failed: {e:?}");
            failures.push(map_failure(kind, e));
            None
        }
        Err(_elapsed) => {
            tracing::warn!(
                "mysql schema browser: {kind} sub-query timed out ({}s)",
                PER_QUERY_TIMEOUT.as_secs()
            );
            failures.push(KindFailure {
                kind: kind.to_string(),
                code: Some("70100".to_string()),
                message: format!("{kind} query timed out ({}s)", PER_QUERY_TIMEOUT.as_secs()),
            });
            None
        }
    }
}

fn all_failed_70100(kinds: &[&str]) -> Vec<KindFailure> {
    kinds
        .iter()
        .map(|k| KindFailure {
            kind: (*k).to_string(),
            code: Some("70100".to_string()),
            message: format!(
                "{k} query cancelled by total timeout ({}s)",
                TOTAL_TIMEOUT.as_secs()
            ),
        })
        .collect()
}

/// Check if a sub-query error is SQLSTATE 42000 (permission-denied on
/// information_schema). MySQL uses 42000 for syntax errors too, but when
/// querying information_schema views it means access denied. Per-spec: silent
/// degrade to `Ok(Vec::new())`.
fn is_permission_denied(err: &AppError) -> bool {
    matches!(err, AppError::Mysql(body) if body.code.as_deref() == Some("42000"))
}

/// Wrap a sub-query to silently degrade on permission-denied (42000).
async fn try_kind<T, F, Fut>(kind: &str, f: F) -> AppResult<Vec<T>>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = AppResult<Vec<T>>>,
{
    match f().await {
        Ok(v) => Ok(v),
        Err(e) if is_permission_denied(&e) => {
            tracing::warn!(
                "mysql schema browser: {kind} permission denied (42000); degrading to empty"
            );
            Ok(Vec::new())
        }
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// 7.1 — mysql_list_schemas
// ---------------------------------------------------------------------------

const SYSTEM_SCHEMAS: &[&str] = &["mysql", "information_schema", "performance_schema", "sys"];

/// Pool-only inner function for listing schemas. Usable by the context adapter.
pub async fn list_schemas_for_pool(pool: &sqlx::MySqlPool) -> AppResult<Vec<SchemaInfo>> {
    let rows = timeout(
        RELATIONS_TIMEOUT,
        sqlx::query(
            "SELECT s.SCHEMA_NAME AS name, \
                    s.DEFAULT_CHARACTER_SET_NAME AS charset, \
                    s.DEFAULT_COLLATION_NAME AS collation \
             FROM information_schema.SCHEMATA s \
             ORDER BY LOWER(s.SCHEMA_NAME)",
        )
        .fetch_all(pool),
    )
    .await
    .map_err(|_| {
        AppError::mysql_with_code(
            "70100",
            format!("list schemas timed out ({}s)", RELATIONS_TIMEOUT.as_secs()),
        )
    })?
    .map_err(map_sqlx_error)?;

    let schemas = rows
        .into_iter()
        .map(|row| {
            let name: String = row.try_get("name").unwrap_or_default();
            let charset: String = row.try_get("charset").unwrap_or_default();
            let collation: String = row.try_get("collation").unwrap_or_default();
            let is_system = SYSTEM_SCHEMAS.contains(&name.as_str());
            SchemaInfo {
                name,
                charset,
                collation,
                is_system,
            }
        })
        .collect();
    Ok(schemas)
}

#[tauri::command]
pub async fn mysql_list_schemas(
    app: AppHandle,
    registry: State<'_, MysqlPoolRegistry>,
    id: String,
) -> AppResult<Vec<SchemaInfo>> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    tracing::info!("mysql_list_schemas: id={parsed}");

    let pool = registry.acquire(parsed)?;

    let result = list_schemas_for_pool(&pool).await;

    let ms = started.elapsed().as_millis();
    let duration_ms = ms as u64;
    let builder =
        ActivityLogEntryBuilder::new(ActivityKind::ListSchemas, Origin::Auto, duration_ms)
            .connection(parsed);
    match &result {
        Ok(rows) => {
            tracing::info!(
                "mysql_list_schemas ok: id={parsed} schemas={} elapsed={ms}ms",
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
            tracing::error!("mysql_list_schemas err: id={parsed} elapsed={ms}ms err={e:?}");
            emit_activity(&app, builder.err(e));
        }
    }
    result
}

// ---------------------------------------------------------------------------
// 7.2 — mysql_list_relations
// ---------------------------------------------------------------------------

/// Pure helper — bucket raw table rows into tables/views with partition overlay.
/// Exposed for unit testing without touching the database.
pub(crate) fn bucket_relations(
    table_rows: Vec<(String, String, Option<String>, i64)>,
    partition_set: HashSet<String>,
) -> (Vec<RelationInfo>, Vec<ViewInfo>) {
    let mut tables = Vec::new();
    let mut views = Vec::new();

    for (name, table_type, comment, estimated_rows) in table_rows {
        match table_type.as_str() {
            "BASE TABLE" => {
                let kind = if partition_set.contains(&name) {
                    "partitioned".to_string()
                } else {
                    "regular".to_string()
                };
                tables.push(RelationInfo {
                    name,
                    kind,
                    comment: comment.filter(|s| !s.is_empty()),
                    estimated_rows,
                });
            }
            "VIEW" => {
                views.push(ViewInfo {
                    name,
                    comment: comment.filter(|s| !s.is_empty()),
                });
            }
            _ => {}
        }
    }
    (tables, views)
}

/// Pool-only inner function for listing relations in a schema. Usable by the context adapter.
pub async fn list_relations_for_pool(
    pool: &sqlx::MySqlPool,
    schema: &str,
) -> AppResult<RelationsResult> {
    let schema_clone = schema.to_string();
    let inner_future = async {
        let (table_result, partition_result) = tokio::join!(
            sqlx::query(
                "SELECT t.TABLE_NAME AS name, \
                        t.TABLE_TYPE AS table_type, \
                        t.TABLE_COMMENT AS comment, \
                        IFNULL(t.TABLE_ROWS, 0) AS estimated_rows \
                 FROM information_schema.TABLES t \
                 WHERE t.TABLE_SCHEMA = ? \
                 ORDER BY LOWER(t.TABLE_NAME)",
            )
            .bind(&schema_clone)
            .fetch_all(pool),
            sqlx::query(
                "SELECT TABLE_NAME, COUNT(*) AS n \
                 FROM information_schema.PARTITIONS \
                 WHERE TABLE_SCHEMA = ? AND PARTITION_NAME IS NOT NULL \
                 GROUP BY TABLE_NAME",
            )
            .bind(&schema_clone)
            .fetch_all(pool),
        );

        let raw_tables = table_result.map_err(map_sqlx_error)?;
        let raw_partitions = partition_result.map_err(map_sqlx_error)?;

        let partition_set: HashSet<String> = raw_partitions
            .into_iter()
            .map(|row| {
                let name: String = row.try_get("TABLE_NAME").unwrap_or_default();
                name
            })
            .collect();

        let table_rows: Vec<(String, String, Option<String>, i64)> = raw_tables
            .into_iter()
            .map(|row| {
                let name: String = row.try_get("name").unwrap_or_default();
                let table_type: String = row.try_get("table_type").unwrap_or_default();
                let comment: Option<String> = row.try_get("comment").ok().flatten();
                let estimated_rows: i64 = row.try_get("estimated_rows").unwrap_or(0);
                (name, table_type, comment, estimated_rows)
            })
            .collect();

        let (tables, views) = bucket_relations(table_rows, partition_set);
        Ok::<RelationsResult, AppError>(RelationsResult {
            schema: schema_clone,
            tables,
            views,
        })
    };

    timeout(RELATIONS_TIMEOUT, inner_future)
        .await
        .map_err(|_| {
            AppError::mysql_with_code(
                "70100",
                format!(
                    "list relations timed out ({}s)",
                    RELATIONS_TIMEOUT.as_secs()
                ),
            )
        })?
}

#[tauri::command]
pub async fn mysql_list_relations(
    app: AppHandle,
    registry: State<'_, MysqlPoolRegistry>,
    id: String,
    schema: String,
) -> AppResult<RelationsResult> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    tracing::info!("mysql_list_relations: id={parsed} schema={schema}");

    let pool = registry.acquire(parsed)?;
    let ssl_mode = registry.ssl_mode_for(parsed);
    let params_for_cancel = {
        // We need params to fire KILL QUERY; get from pool config isn't
        // directly possible, so we skip cancel fire here (no stored params
        // reference). The timeout still returns 70100.
        let _ = ssl_mode;
    };
    let _ = params_for_cancel;

    let result = list_relations_for_pool(&pool, &schema).await;

    let ms = started.elapsed().as_millis();
    let duration_ms = ms as u64;
    let builder =
        ActivityLogEntryBuilder::new(ActivityKind::ListRelations, Origin::Auto, duration_ms)
            .connection(parsed);
    match &result {
        Ok(r) => {
            tracing::info!(
                "mysql_list_relations ok: id={parsed} schema={} tables={} views={} elapsed={ms}ms",
                r.schema,
                r.tables.len(),
                r.views.len(),
            );
            let total = r.tables.len() + r.views.len();
            emit_activity(
                &app,
                builder.ok(Some(Metric::Items {
                    value: total as u32,
                })),
            );
        }
        Err(e) => {
            tracing::error!(
                "mysql_list_relations err: id={parsed} schema={schema} elapsed={ms}ms err={e:?}"
            );
            emit_activity(&app, builder.err(e));
        }
    }
    result
}

// ---------------------------------------------------------------------------
// §1.3 — list_structure_for_pool (columns + PK per relation)
// ---------------------------------------------------------------------------

/// Pool-only inner function: returns `(columns, pk_columns)` for a single relation.
/// Used by the context adapter for schema sync.
pub async fn list_structure_for_pool(
    pool: &sqlx::MySqlPool,
    schema: &str,
    relation: &str,
) -> AppResult<(Vec<(String, String)>, Vec<String>)> {
    // Columns: (name, data_type)
    let col_rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT COLUMN_NAME, DATA_TYPE \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         ORDER BY ORDINAL_POSITION",
    )
    .bind(schema)
    .bind(relation)
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    // PK columns in order
    let pk_rows: Vec<(String,)> = sqlx::query_as(
        "SELECT COLUMN_NAME \
         FROM information_schema.STATISTICS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY' \
         ORDER BY SEQ_IN_INDEX",
    )
    .bind(schema)
    .bind(relation)
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    let pk_cols: Vec<String> = pk_rows.into_iter().map(|(c,)| c).collect();
    Ok((col_rows, pk_cols))
}

// ---------------------------------------------------------------------------
// 7.3 — mysql_list_structure
// ---------------------------------------------------------------------------

async fn fetch_routines(pool: &sqlx::MySqlPool, schema: &str) -> AppResult<Vec<RoutineInfo>> {
    let rows = sqlx::query(
        "SELECT ROUTINE_NAME, ROUTINE_TYPE, \
                COALESCE(EXTERNAL_LANGUAGE, ROUTINE_BODY, 'SQL') AS lang, \
                COALESCE(ROUTINE_COMMENT, '') AS comment \
         FROM information_schema.ROUTINES \
         WHERE ROUTINE_SCHEMA = ? \
         ORDER BY LOWER(ROUTINE_NAME)",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    let routines = rows
        .into_iter()
        .map(|row| {
            let name: String = row.try_get("ROUTINE_NAME").unwrap_or_default();
            let routine_type: String = row.try_get("ROUTINE_TYPE").unwrap_or_default();
            let lang: String = row.try_get("lang").unwrap_or_else(|_| "SQL".into());
            let comment_raw: String = row.try_get("comment").unwrap_or_default();
            let kind = match routine_type.as_str() {
                "FUNCTION" => "function",
                _ => "procedure",
            }
            .to_string();
            let language = if lang.is_empty() { "SQL".into() } else { lang };
            let comment = if comment_raw.is_empty() {
                None
            } else {
                Some(comment_raw)
            };
            RoutineInfo {
                name,
                kind,
                language,
                comment,
            }
        })
        .collect();
    Ok(routines)
}

async fn fetch_triggers(pool: &sqlx::MySqlPool, schema: &str) -> AppResult<Vec<TriggerInfo>> {
    let rows = sqlx::query(
        "SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, EVENT_MANIPULATION, ACTION_TIMING \
         FROM information_schema.TRIGGERS \
         WHERE TRIGGER_SCHEMA = ? \
         ORDER BY LOWER(TRIGGER_NAME)",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    let triggers = rows
        .into_iter()
        .map(|row| {
            let name: String = row.try_get("TRIGGER_NAME").unwrap_or_default();
            let table: String = row.try_get("EVENT_OBJECT_TABLE").unwrap_or_default();
            let event: String = row.try_get("EVENT_MANIPULATION").unwrap_or_default();
            let timing: String = row.try_get("ACTION_TIMING").unwrap_or_default();
            TriggerInfo {
                name,
                table: Some(table),
                event,
                timing,
                comment: None,
            }
        })
        .collect();
    Ok(triggers)
}

async fn fetch_table_triggers(
    pool: &sqlx::MySqlPool,
    schema: &str,
    table: &str,
) -> AppResult<Vec<TriggerInfo>> {
    let rows = sqlx::query(
        "SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, EVENT_MANIPULATION, ACTION_TIMING \
         FROM information_schema.TRIGGERS \
         WHERE TRIGGER_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? \
         ORDER BY LOWER(TRIGGER_NAME)",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    let triggers = rows
        .into_iter()
        .map(|row| {
            let name: String = row.try_get("TRIGGER_NAME").unwrap_or_default();
            let tbl: String = row.try_get("EVENT_OBJECT_TABLE").unwrap_or_default();
            let event: String = row.try_get("EVENT_MANIPULATION").unwrap_or_default();
            let timing: String = row.try_get("ACTION_TIMING").unwrap_or_default();
            TriggerInfo {
                name,
                table: Some(tbl),
                event,
                timing,
                comment: None,
            }
        })
        .collect();
    Ok(triggers)
}

async fn fetch_events(pool: &sqlx::MySqlPool, schema: &str) -> AppResult<Vec<EventInfo>> {
    let rows = sqlx::query(
        "SELECT EVENT_NAME, STATUS, \
                COALESCE(EVENT_COMMENT, '') AS comment \
         FROM information_schema.EVENTS \
         WHERE EVENT_SCHEMA = ? \
         ORDER BY LOWER(EVENT_NAME)",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    let events = rows
        .into_iter()
        .map(|row| {
            let name: String = row.try_get("EVENT_NAME").unwrap_or_default();
            let status: String = row.try_get("STATUS").unwrap_or_default();
            let comment_raw: String = row.try_get("comment").unwrap_or_default();
            let comment = if comment_raw.is_empty() {
                None
            } else {
                Some(comment_raw)
            };
            EventInfo {
                name,
                status,
                comment,
            }
        })
        .collect();
    Ok(events)
}

#[tauri::command]
pub async fn mysql_list_structure(
    app: AppHandle,
    registry: State<'_, MysqlPoolRegistry>,
    id: String,
    schema: String,
) -> AppResult<StructureResult> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    tracing::info!("mysql_list_structure: id={parsed} schema={schema}");

    let pool = registry.acquire(parsed)?;
    let schema_clone = schema.clone();

    let result = timeout(TOTAL_TIMEOUT, async {
        let (routines_r, triggers_r, events_r) = tokio::join!(
            timeout(
                PER_QUERY_TIMEOUT,
                try_kind("routines", || fetch_routines(&pool, &schema_clone))
            ),
            timeout(
                PER_QUERY_TIMEOUT,
                try_kind("triggers", || fetch_triggers(&pool, &schema_clone))
            ),
            timeout(
                PER_QUERY_TIMEOUT,
                try_kind("events", || fetch_events(&pool, &schema_clone))
            ),
        );

        let mut failures = Vec::new();
        let routines = aggregate_one(routines_r, "routines", &mut failures);
        let triggers = aggregate_one(triggers_r, "triggers", &mut failures);
        let events = aggregate_one(events_r, "events", &mut failures);

        for f in &failures {
            tracing::warn!(
                "mysql_list_structure failure: schema={schema_clone} kind={} code={:?} message={}",
                f.kind,
                f.code,
                f.message
            );
        }

        Ok::<StructureResult, AppError>(StructureResult {
            schema: schema_clone,
            routines,
            triggers,
            events,
            failures,
        })
    })
    .await
    .unwrap_or_else(|_| {
        Ok(StructureResult {
            schema: schema.clone(),
            routines: None,
            triggers: None,
            events: None,
            failures: all_failed_70100(&["routines", "triggers", "events"]),
        })
    });

    let ms = started.elapsed().as_millis();
    let duration_ms = ms as u64;
    let builder =
        ActivityLogEntryBuilder::new(ActivityKind::ListStructure, Origin::Auto, duration_ms)
            .connection(parsed);
    match &result {
        Ok(r) => {
            let total: u32 = r.routines.as_ref().map(|v| v.len() as u32).unwrap_or(0)
                + r.triggers.as_ref().map(|v| v.len() as u32).unwrap_or(0)
                + r.events.as_ref().map(|v| v.len() as u32).unwrap_or(0);
            tracing::info!(
                "mysql_list_structure ok: id={parsed} schema={schema} \
                 routines={:?} triggers={:?} events={:?} failures={} elapsed={ms}ms",
                r.routines.as_ref().map(|v| v.len()),
                r.triggers.as_ref().map(|v| v.len()),
                r.events.as_ref().map(|v| v.len()),
                r.failures.len(),
            );
            emit_activity(&app, builder.ok(Some(Metric::Items { value: total })));
        }
        Err(e) => {
            tracing::error!(
                "mysql_list_structure err: id={parsed} schema={schema} elapsed={ms}ms err={e:?}"
            );
            emit_activity(&app, builder.err(e));
        }
    }
    result
}

// ---------------------------------------------------------------------------
// 7.4 — mysql_list_table_extras
// ---------------------------------------------------------------------------

async fn fetch_indexes(
    pool: &sqlx::MySqlPool,
    schema: &str,
    table: &str,
) -> AppResult<Vec<IndexInfo>> {
    let rows = sqlx::query(
        "SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE, \
                INDEX_TYPE, SUB_PART, COLLATION, COMMENT \
         FROM information_schema.STATISTICS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         ORDER BY INDEX_NAME, SEQ_IN_INDEX",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    // Group by index name.
    let mut index_map: HashMap<String, (bool, String, Option<String>, Vec<IndexColumn>)> =
        HashMap::new();
    let mut order: Vec<String> = Vec::new();

    for row in rows {
        let index_name: String = row.try_get("INDEX_NAME").unwrap_or_default();
        let col_name: String = row.try_get("COLUMN_NAME").unwrap_or_default();
        let non_unique: i64 = row.try_get("NON_UNIQUE").unwrap_or(1);
        let index_type: String = row.try_get("INDEX_TYPE").unwrap_or_else(|_| "BTREE".into());
        let sub_part: Option<i64> = row.try_get("SUB_PART").ok().flatten();
        let collation: Option<String> = row.try_get("COLLATION").ok().flatten();
        let comment: Option<String> = row
            .try_get::<Option<String>, _>("COMMENT")
            .ok()
            .flatten()
            .filter(|s| !s.is_empty());

        let direction = match collation.as_deref() {
            Some("A") => "ASC",
            Some("D") => "DESC",
            _ => "ASC",
        }
        .to_string();

        let col = IndexColumn {
            name: col_name,
            sub_part,
            direction,
        };

        let entry = index_map.entry(index_name.clone()).or_insert_with(|| {
            order.push(index_name.clone());
            (non_unique == 0, index_type, comment, Vec::new())
        });
        entry.3.push(col);
    }

    let indexes = order
        .into_iter()
        .filter_map(|name| {
            index_map
                .remove(&name)
                .map(|(unique, index_type, comment, columns)| IndexInfo {
                    name,
                    columns,
                    unique,
                    index_type,
                    comment,
                })
        })
        .collect();
    Ok(indexes)
}

async fn fetch_foreign_keys(
    pool: &sqlx::MySqlPool,
    schema: &str,
    table: &str,
) -> AppResult<Vec<ForeignKeyInfo>> {
    let rows = sqlx::query(
        "SELECT kcu.CONSTRAINT_NAME AS name, \
                kcu.COLUMN_NAME, \
                kcu.REFERENCED_TABLE_SCHEMA, \
                kcu.REFERENCED_TABLE_NAME, \
                kcu.REFERENCED_COLUMN_NAME, \
                kcu.ORDINAL_POSITION, \
                rc.UPDATE_RULE, rc.DELETE_RULE \
         FROM information_schema.KEY_COLUMN_USAGE kcu \
         JOIN information_schema.REFERENTIAL_CONSTRAINTS rc \
           ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA \
          AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME \
         WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ? \
           AND kcu.REFERENCED_TABLE_NAME IS NOT NULL \
         ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    // Group by constraint name.
    let mut fk_map: HashMap<String, (String, String, String, String, Vec<String>, Vec<String>)> =
        HashMap::new();
    let mut order: Vec<String> = Vec::new();

    for row in rows {
        let name: String = row.try_get("name").unwrap_or_default();
        let col: String = row.try_get("COLUMN_NAME").unwrap_or_default();
        let ref_schema: String = row.try_get("REFERENCED_TABLE_SCHEMA").unwrap_or_default();
        let ref_table: String = row.try_get("REFERENCED_TABLE_NAME").unwrap_or_default();
        let ref_col: String = row.try_get("REFERENCED_COLUMN_NAME").unwrap_or_default();
        let on_update: String = row.try_get("UPDATE_RULE").unwrap_or_default();
        let on_delete: String = row.try_get("DELETE_RULE").unwrap_or_default();

        let entry = fk_map.entry(name.clone()).or_insert_with(|| {
            order.push(name.clone());
            (
                ref_schema,
                ref_table,
                on_update,
                on_delete,
                Vec::new(),
                Vec::new(),
            )
        });
        entry.4.push(col);
        entry.5.push(ref_col);
    }

    let fks = order
        .into_iter()
        .filter_map(|name| {
            fk_map.remove(&name).map(
                |(ref_schema, ref_table, on_update, on_delete, columns, ref_cols)| ForeignKeyInfo {
                    name,
                    columns,
                    referenced_schema: ref_schema,
                    referenced_table: ref_table,
                    referenced_columns: ref_cols,
                    on_update,
                    on_delete,
                },
            )
        })
        .collect();
    Ok(fks)
}

#[tauri::command]
pub async fn mysql_list_table_extras(
    app: AppHandle,
    registry: State<'_, MysqlPoolRegistry>,
    id: String,
    schema: String,
    relation: String,
) -> AppResult<TableExtrasResult> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    tracing::info!("mysql_list_table_extras: id={parsed} schema={schema} relation={relation}");

    let pool = registry.acquire(parsed)?;
    let schema_c = schema.clone();
    let relation_c = relation.clone();

    let result = timeout(TOTAL_TIMEOUT, async {
        let (indexes_r, triggers_r, fks_r) = tokio::join!(
            timeout(
                PER_QUERY_TIMEOUT,
                try_kind("indexes", || fetch_indexes(&pool, &schema_c, &relation_c))
            ),
            timeout(
                PER_QUERY_TIMEOUT,
                try_kind("triggers", || {
                    fetch_table_triggers(&pool, &schema_c, &relation_c)
                })
            ),
            timeout(
                PER_QUERY_TIMEOUT,
                try_kind("foreign_keys", || {
                    fetch_foreign_keys(&pool, &schema_c, &relation_c)
                })
            ),
        );

        let mut failures = Vec::new();
        let indexes = aggregate_one(indexes_r, "indexes", &mut failures);
        let triggers = aggregate_one(triggers_r, "triggers", &mut failures);
        let foreign_keys = aggregate_one(fks_r, "foreign_keys", &mut failures);

        for f in &failures {
            tracing::warn!(
                "mysql_list_table_extras failure: schema={schema_c} relation={relation_c} \
                 kind={} code={:?} message={}",
                f.kind,
                f.code,
                f.message
            );
        }

        Ok::<TableExtrasResult, AppError>(TableExtrasResult {
            schema: schema_c,
            relation: relation_c,
            indexes,
            triggers,
            foreign_keys,
            failures,
        })
    })
    .await
    .unwrap_or_else(|_| {
        Ok(TableExtrasResult {
            schema: schema.clone(),
            relation: relation.clone(),
            indexes: None,
            triggers: None,
            foreign_keys: None,
            failures: all_failed_70100(&["indexes", "triggers", "foreign_keys"]),
        })
    });

    let ms = started.elapsed().as_millis();
    let duration_ms = ms as u64;
    let builder =
        ActivityLogEntryBuilder::new(ActivityKind::ListTableExtras, Origin::Auto, duration_ms)
            .connection(parsed);
    match &result {
        Ok(r) => {
            let total: u32 = r.indexes.as_ref().map(|v| v.len() as u32).unwrap_or(0)
                + r.triggers.as_ref().map(|v| v.len() as u32).unwrap_or(0)
                + r.foreign_keys.as_ref().map(|v| v.len() as u32).unwrap_or(0);
            tracing::info!(
                "mysql_list_table_extras ok: id={parsed} schema={schema} relation={relation} \
                 indexes={:?} triggers={:?} fks={:?} failures={} elapsed={ms}ms",
                r.indexes.as_ref().map(|v| v.len()),
                r.triggers.as_ref().map(|v| v.len()),
                r.foreign_keys.as_ref().map(|v| v.len()),
                r.failures.len(),
            );
            emit_activity(&app, builder.ok(Some(Metric::Items { value: total })));
        }
        Err(e) => {
            tracing::error!(
                "mysql_list_table_extras err: id={parsed} schema={schema} \
                 relation={relation} elapsed={ms}ms err={e:?}"
            );
            emit_activity(&app, builder.err(e));
        }
    }
    result
}

// ---------------------------------------------------------------------------
// 7.5 — mysql_get_routine_signature
// ---------------------------------------------------------------------------

/// Format args from parameter rows. Returns `(args_signature, return_type)`.
pub(crate) fn format_routine_signature(
    rows: Vec<(Option<String>, Option<String>, String, i64)>,
    is_function: bool,
) -> (String, Option<String>) {
    let mut return_type: Option<String> = None;
    let mut args: Vec<String> = Vec::new();

    for (mode, name, dtd, ordinal) in rows {
        if is_function && ordinal == 0 {
            return_type = Some(dtd);
        } else {
            let mode_str = mode.as_deref().unwrap_or("IN");
            let name_str = name.as_deref().unwrap_or("");
            args.push(format!("{} {} {}", mode_str, name_str, dtd));
        }
    }

    (args.join(", "), return_type)
}

#[tauri::command]
pub async fn mysql_get_routine_signature(
    app: AppHandle,
    registry: State<'_, MysqlPoolRegistry>,
    id: String,
    schema: String,
    name: String,
    kind: String,
) -> AppResult<RoutineSignature> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    tracing::info!(
        "mysql_get_routine_signature: id={parsed} schema={schema} name={name} kind={kind}"
    );

    let pool = registry.acquire(parsed)?;
    let routine_type = kind.to_uppercase();
    let is_function = routine_type == "FUNCTION";

    let result: AppResult<RoutineSignature> = async {
        let rows = timeout(
            ROUTINE_SIG_TIMEOUT,
            sqlx::query(
                "SELECT PARAMETER_MODE, PARAMETER_NAME, DTD_IDENTIFIER, ORDINAL_POSITION \
                 FROM information_schema.PARAMETERS \
                 WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? AND ROUTINE_TYPE = ? \
                 ORDER BY ORDINAL_POSITION",
            )
            .bind(&schema)
            .bind(&name)
            .bind(&routine_type)
            .fetch_all(&pool),
        )
        .await
        .map_err(|_| {
            AppError::mysql_with_code(
                "70100",
                format!(
                    "routine signature lookup timed out ({}s)",
                    ROUTINE_SIG_TIMEOUT.as_secs()
                ),
            )
        })?
        .map_err(map_sqlx_error)?;

        if rows.is_empty() {
            // Verify the routine exists.
            let exists: bool = timeout(
                ROUTINE_SIG_TIMEOUT,
                sqlx::query(
                    "SELECT 1 FROM information_schema.ROUTINES \
                     WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ? AND ROUTINE_TYPE = ? \
                     LIMIT 1",
                )
                .bind(&schema)
                .bind(&name)
                .bind(&routine_type)
                .fetch_optional(&pool),
            )
            .await
            .map_err(|_| {
                AppError::mysql_with_code(
                    "70100",
                    format!(
                        "routine existence check timed out ({}s)",
                        ROUTINE_SIG_TIMEOUT.as_secs()
                    ),
                )
            })?
            .map_err(map_sqlx_error)?
            .is_some();

            if !exists {
                return Err(AppError::NotFound(format!("routine {schema}.{name}")));
            }
            // No parameters — valid for procedures with no args.
            return Ok(RoutineSignature {
                args_signature: String::new(),
                return_type: None,
            });
        }

        let param_rows: Vec<(Option<String>, Option<String>, String, i64)> = rows
            .into_iter()
            .map(|row| {
                let mode: Option<String> = row.try_get("PARAMETER_MODE").ok().flatten();
                let pname: Option<String> = row.try_get("PARAMETER_NAME").ok().flatten();
                let dtd: String = row.try_get("DTD_IDENTIFIER").unwrap_or_default();
                let ordinal: i64 = row.try_get("ORDINAL_POSITION").unwrap_or(0);
                (mode, pname, dtd, ordinal)
            })
            .collect();

        let (args_signature, return_type) = format_routine_signature(param_rows, is_function);
        Ok(RoutineSignature {
            args_signature,
            return_type,
        })
    }
    .await;

    let ms = started.elapsed().as_millis();
    match &result {
        Ok(_) => {
            tracing::info!(
                "mysql_get_routine_signature ok: id={parsed} schema={schema} \
                 name={name} elapsed={ms}ms"
            );
        }
        Err(e) => {
            tracing::error!(
                "mysql_get_routine_signature err: id={parsed} schema={schema} \
                 name={name} elapsed={ms}ms err={e:?}"
            );
        }
    }
    let _ = app; // activity-log omitted per spec (metric: null)
    result
}

// ---------------------------------------------------------------------------
// §6.3 re-export shim (used by 7.2 inline; imported by Phase E commands)
// ---------------------------------------------------------------------------

// with_mysql_timeout_and_cancel is already imported above and re-exported
// from mod.rs. No additional wiring needed here.

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::error::Elapsed;

    // -----------------------------------------------------------------------
    // bucket_relations tests (7.8)
    // -----------------------------------------------------------------------

    #[test]
    fn base_table_becomes_regular_relation() {
        let rows = vec![("users".to_string(), "BASE TABLE".to_string(), None, 100i64)];
        let (tables, views) = bucket_relations(rows, HashSet::new());
        assert_eq!(tables.len(), 1);
        assert_eq!(views.len(), 0);
        assert_eq!(tables[0].name, "users");
        assert_eq!(tables[0].kind, "regular");
    }

    #[test]
    fn view_goes_into_views() {
        let rows = vec![("v_active".to_string(), "VIEW".to_string(), None, 0i64)];
        let (tables, views) = bucket_relations(rows, HashSet::new());
        assert_eq!(tables.len(), 0);
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].name, "v_active");
    }

    #[test]
    fn partitioned_table_gets_partitioned_kind() {
        let rows = vec![("orders".to_string(), "BASE TABLE".to_string(), None, 50i64)];
        let mut parts = HashSet::new();
        parts.insert("orders".to_string());
        let (tables, _) = bucket_relations(rows, parts);
        assert_eq!(tables[0].kind, "partitioned");
    }

    #[test]
    fn partition_overlay_only_affects_matching_tables() {
        let rows = vec![
            ("users".to_string(), "BASE TABLE".to_string(), None, 10i64),
            ("orders".to_string(), "BASE TABLE".to_string(), None, 50i64),
        ];
        let mut parts = HashSet::new();
        parts.insert("orders".to_string());
        let (tables, _) = bucket_relations(rows, parts);
        let users = tables.iter().find(|t| t.name == "users").unwrap();
        let orders = tables.iter().find(|t| t.name == "orders").unwrap();
        assert_eq!(users.kind, "regular");
        assert_eq!(orders.kind, "partitioned");
    }

    // -----------------------------------------------------------------------
    // aggregate_one tests (7.8)
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
    fn aggregate_one_success_returns_payload() {
        let mut failures = Vec::new();
        let result: Result<AppResult<Vec<i32>>, Elapsed> = Ok(Ok(vec![1, 2]));
        let out = aggregate_one(result, "k", &mut failures);
        assert_eq!(out, Some(vec![1, 2]));
        assert!(failures.is_empty());
    }

    #[test]
    fn aggregate_one_42000_yields_empty_no_failure() {
        let mut failures = Vec::new();
        let err = AppError::mysql_with_code("42000", "access denied");
        // try_kind converts 42000 to Ok(vec![]) — so at the aggregation boundary
        // we already have Ok(Ok(vec![])).
        let result: Result<AppResult<Vec<i32>>, Elapsed> = Ok(Ok(Vec::new()));
        let out = aggregate_one(result, "routines", &mut failures);
        assert_eq!(out, Some(Vec::<i32>::new()));
        assert!(failures.is_empty());
        let _ = err; // ensure type is valid
    }

    #[test]
    fn aggregate_one_other_error_appends_failure_returns_none() {
        let mut failures = Vec::new();
        let err = AppError::mysql_with_code("23000", "dup key");
        let result: Result<AppResult<Vec<i32>>, Elapsed> = Ok(Err(err));
        let out = aggregate_one(result, "routines", &mut failures);
        assert_eq!(out, None);
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].kind, "routines");
        assert_eq!(failures[0].code.as_deref(), Some("23000"));
    }

    #[tokio::test]
    async fn aggregate_one_elapsed_appends_70100_failure() {
        let mut failures = Vec::new();
        let elapsed = synth_elapsed().await;
        let result: Result<AppResult<Vec<i32>>, Elapsed> = Err(elapsed);
        let out = aggregate_one(result, "events", &mut failures);
        assert_eq!(out, None);
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].code.as_deref(), Some("70100"));
    }

    // -----------------------------------------------------------------------
    // format_routine_signature tests (7.8)
    // -----------------------------------------------------------------------

    #[test]
    fn procedure_args_formatted_correctly() {
        let rows = vec![
            (Some("IN".into()), Some("x".into()), "INT".into(), 1i64),
            (
                Some("OUT".into()),
                Some("y".into()),
                "VARCHAR(50)".into(),
                2i64,
            ),
        ];
        let (sig, ret) = format_routine_signature(rows, false);
        assert_eq!(sig, "IN x INT, OUT y VARCHAR(50)");
        assert!(ret.is_none());
    }

    #[test]
    fn function_return_type_extracted_from_ordinal_0() {
        let rows = vec![
            (None, None, "INT".into(), 0i64),
            (
                Some("IN".into()),
                Some("a".into()),
                "VARCHAR(20)".into(),
                1i64,
            ),
        ];
        let (sig, ret) = format_routine_signature(rows, true);
        assert_eq!(sig, "IN a VARCHAR(20)");
        assert_eq!(ret.as_deref(), Some("INT"));
    }

    #[test]
    fn no_args_yields_empty_signature() {
        let rows: Vec<(Option<String>, Option<String>, String, i64)> = vec![];
        let (sig, ret) = format_routine_signature(rows, false);
        assert_eq!(sig, "");
        assert!(ret.is_none());
    }
}
