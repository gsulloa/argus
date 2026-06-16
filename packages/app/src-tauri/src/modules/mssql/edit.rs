//! MS SQL Server editable-table support: PK lookup, SQL builders, validation,
//! transactional apply command.
//!
//! Key differences vs MySQL:
//! - Uses `OUTPUT INSERTED.*` / `OUTPUT DELETED.*` instead of a re-fetch round-trip.
//! - Trigger degradation: SQL Server error 334 forces fallback to INSERT/UPDATE/DELETE
//!   without OUTPUT, then a re-fetch via SELECT WHERE pk = @P.
//! - Placeholder syntax: @P1, @P2, ... (not `?`).
//! - Identifier quoting: [square brackets] (not backticks).

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::{AppHandle, State};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::error::{AppError, AppResult, MssqlErrorBody};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::mssql::binding::{
    bind_edit_value, decode_row_value, mssql_quote_ident, mssql_quote_qualified, BindKind,
};
use crate::modules::mssql::data::{fetch_column_meta, ColumnMeta};
use crate::modules::mssql::errors::map_tiberius_error;
use crate::modules::mssql::pool::MssqlPoolRegistry;

/// SQL Server error 334 = "OUTPUT clause not allowed when target table has
/// enabled triggers".
const ERROR_OUTPUT_TRIGGER: i32 = 334;

/// Truncation threshold (same as data grid).
const TRUNCATE_BYTES: usize = 1_048_576;

// ---------------------------------------------------------------------------
// Trigger-degradation cache
// ---------------------------------------------------------------------------

/// Per-`(connection_uuid, schema, relation)` flag: true = use no-OUTPUT path.
type TriggerCache = RwLock<HashMap<(Uuid, String, String), bool>>;

static TRIGGER_CACHE: OnceLock<TriggerCache> = OnceLock::new();

fn trigger_cache() -> &'static TriggerCache {
    TRIGGER_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

async fn is_degraded(conn_id: Uuid, schema: &str, relation: &str) -> bool {
    let key = (conn_id, schema.to_string(), relation.to_string());
    trigger_cache()
        .read()
        .await
        .get(&key)
        .copied()
        .unwrap_or(false)
}

async fn mark_degraded(conn_id: Uuid, schema: &str, relation: &str) {
    let key = (conn_id, schema.to_string(), relation.to_string());
    trigger_cache().write().await.insert(key, true);
}

// ---------------------------------------------------------------------------
// §10.1 — Data structures
// ---------------------------------------------------------------------------

/// Column info used during validation and SQL building.
#[derive(Debug, Clone)]
pub struct ColumnInfo {
    pub name: String,
    pub bind_kind: BindKind,
    pub is_nullable: bool,
    pub is_identity: bool,
    pub is_computed: bool,
}

/// Discriminated union of edit operations.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EditOp {
    Update {
        pk: BTreeMap<String, JsonValue>,
        changes: BTreeMap<String, JsonValue>,
    },
    Insert {
        values: BTreeMap<String, JsonValue>,
    },
    Delete {
        pk: BTreeMap<String, JsonValue>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ApplyResult {
    pub refreshed_rows: Vec<Vec<JsonValue>>,
    pub columns: Vec<ColumnMeta>,
    pub degraded_to_refetch: bool,
    pub applied_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct PrimaryKeyInfo {
    pub columns: Option<Vec<String>>,
    pub identity_column: Option<String>,
}

// ---------------------------------------------------------------------------
// §10.2 — Op validation
// ---------------------------------------------------------------------------

/// Validate a batch of edit ops BEFORE any SQL is dispatched.
/// Returns `Err((op_index, AppError))` on first failure.
pub fn validate_edit_ops(
    ops: &[EditOp],
    columns: &HashMap<String, ColumnInfo>,
    pk_columns: &[String],
) -> Result<(), (usize, AppError)> {
    for (i, op) in ops.iter().enumerate() {
        match op {
            EditOp::Update { pk, changes } => {
                // PK coverage check.
                for pk_col in pk_columns {
                    if !pk.contains_key(pk_col) {
                        return Err((
                            i,
                            AppError::Validation(format!(
                                "update op #{i}: missing PK column \"{pk_col}\""
                            )),
                        ));
                    }
                }
                // non-empty changes
                if changes.is_empty() {
                    return Err((
                        i,
                        AppError::Validation(format!("update op #{i}: changes must not be empty")),
                    ));
                }
                // each changed column must exist and be writable
                for col in changes.keys() {
                    let info = columns.get(col).ok_or_else(|| {
                        (
                            i,
                            AppError::Validation(format!(
                                "update op #{i}: unknown column \"{col}\""
                            )),
                        )
                    })?;
                    if info.is_identity {
                        return Err((
                            i,
                            AppError::Validation(format!(
                                "update op #{i}: column \"{col}\" is an IDENTITY column and cannot be updated"
                            )),
                        ));
                    }
                    if info.is_computed {
                        return Err((
                            i,
                            AppError::Validation(format!(
                                "update op #{i}: column \"{col}\" is computed and cannot be updated; use the SQL editor"
                            )),
                        ));
                    }
                    match info.bind_kind {
                        BindKind::RowVersion => {
                            return Err((i, AppError::Validation(format!(
                                "update op #{i}: column \"{col}\" is rowversion (read-only); use the SQL editor"
                            ))));
                        }
                        BindKind::Geometry | BindKind::Geography => {
                            return Err((i, AppError::Validation(format!(
                                "update op #{i}: column \"{col}\" is geometry/geography and is not editable in v1; use the SQL editor"
                            ))));
                        }
                        BindKind::HierarchyId => {
                            return Err((i, AppError::Validation(format!(
                                "update op #{i}: column \"{col}\" is hierarchyid and is not editable in v1; use the SQL editor"
                            ))));
                        }
                        BindKind::SqlVariant => {
                            return Err((i, AppError::Validation(format!(
                                "update op #{i}: column \"{col}\" is sql_variant and is not editable in v1; use the SQL editor"
                            ))));
                        }
                        _ => {}
                    }
                }
            }
            EditOp::Insert { values } => {
                if values.is_empty() {
                    return Err((
                        i,
                        AppError::Validation(format!("insert op #{i}: values must not be empty")),
                    ));
                }
                for col in values.keys() {
                    let info = columns.get(col).ok_or_else(|| {
                        (
                            i,
                            AppError::Validation(format!(
                                "insert op #{i}: unknown column \"{col}\""
                            )),
                        )
                    })?;
                    if info.is_identity {
                        return Err((
                            i,
                            AppError::Validation(format!(
                                "insert op #{i}: cannot insert into IDENTITY column \"[{col}]\"; \
                                 use the SQL editor with SET IDENTITY_INSERT [{col}] ON"
                            )),
                        ));
                    }
                    if info.is_computed {
                        return Err((
                            i,
                            AppError::Validation(format!(
                                "insert op #{i}: column \"{col}\" is computed and cannot be inserted; use the SQL editor"
                            )),
                        ));
                    }
                    match info.bind_kind {
                        BindKind::RowVersion => {
                            return Err((i, AppError::Validation(format!(
                                "insert op #{i}: column \"{col}\" is rowversion (read-only); use the SQL editor"
                            ))));
                        }
                        BindKind::Geometry | BindKind::Geography => {
                            return Err((i, AppError::Validation(format!(
                                "insert op #{i}: column \"{col}\" is geometry/geography and is not editable in v1; use the SQL editor"
                            ))));
                        }
                        BindKind::HierarchyId => {
                            return Err((i, AppError::Validation(format!(
                                "insert op #{i}: column \"{col}\" is hierarchyid and is not editable in v1; use the SQL editor"
                            ))));
                        }
                        BindKind::SqlVariant => {
                            return Err((i, AppError::Validation(format!(
                                "insert op #{i}: column \"{col}\" is sql_variant and is not editable in v1; use the SQL editor"
                            ))));
                        }
                        _ => {}
                    }
                }
            }
            EditOp::Delete { pk } => {
                if pk.is_empty() {
                    return Err((
                        i,
                        AppError::Validation(format!("delete op #{i}: pk must not be empty")),
                    ));
                }
                for pk_col in pk_columns {
                    if !pk.contains_key(pk_col) {
                        return Err((
                            i,
                            AppError::Validation(format!(
                                "delete op #{i}: missing PK column \"{pk_col}\""
                            )),
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// §10.7 — SQL builders
// ---------------------------------------------------------------------------

/// Build `INSERT INTO [s].[t] ([c1], ...) OUTPUT INSERTED.* VALUES (@P1, ...)`.
/// When `use_output = false`, omit the OUTPUT clause.
pub fn build_insert_sql(
    schema: &str,
    relation: &str,
    col_names: &[&str],
    use_output: bool,
    next_param: &mut u32,
) -> AppResult<(String, Vec<String>)> {
    if col_names.is_empty() {
        return Err(AppError::Validation("insert op has empty values".into()));
    }
    let qualified = mssql_quote_qualified(schema, relation);
    let cols: Vec<String> = col_names.iter().map(|c| mssql_quote_ident(c)).collect();
    let mut placeholders: Vec<String> = Vec::with_capacity(col_names.len());
    for _ in col_names {
        placeholders.push(format!("@P{}", *next_param));
        *next_param += 1;
    }
    let output_clause = if use_output { " OUTPUT INSERTED.*" } else { "" };
    Ok((
        format!(
            "INSERT INTO {qualified} ({cols}){output} VALUES ({vals});",
            cols = cols.join(", "),
            output = output_clause,
            vals = placeholders.join(", "),
        ),
        placeholders,
    ))
}

/// Build `UPDATE [s].[t] SET [c1] = @P1, ... OUTPUT INSERTED.* WHERE [pk1] = @PN ...`.
/// Changes are BTreeMap-ordered (alphabetical) for determinism.
/// When `use_output = false`, omit the OUTPUT clause.
pub fn build_update_sql(
    schema: &str,
    relation: &str,
    changes: &BTreeMap<String, JsonValue>,
    pk: &BTreeMap<String, JsonValue>,
    use_output: bool,
    next_param: &mut u32,
) -> AppResult<String> {
    if changes.is_empty() {
        return Err(AppError::Validation(
            "update op: changes must not be empty".into(),
        ));
    }
    if pk.is_empty() {
        return Err(AppError::Validation(
            "update op: pk must not be empty".into(),
        ));
    }
    let qualified = mssql_quote_qualified(schema, relation);

    let set_parts: Vec<String> = changes
        .keys()
        .map(|col| {
            let q = mssql_quote_ident(col);
            let p = format!("@P{}", *next_param);
            *next_param += 1;
            format!("{q} = {p}")
        })
        .collect();

    let output_clause = if use_output { " OUTPUT INSERTED.*" } else { "" };

    let where_parts: Vec<String> = pk
        .keys()
        .map(|col| {
            let q = mssql_quote_ident(col);
            let p = format!("@P{}", *next_param);
            *next_param += 1;
            format!("{q} = {p}")
        })
        .collect();

    Ok(format!(
        "UPDATE {qualified} SET {set}{output} WHERE {wh};",
        set = set_parts.join(", "),
        output = output_clause,
        wh = where_parts.join(" AND "),
    ))
}

/// Build `DELETE FROM [s].[t] OUTPUT DELETED.* WHERE [pk1] = @P1 ...`.
/// When `use_output = false`, omit the OUTPUT clause.
pub fn build_delete_sql(
    schema: &str,
    relation: &str,
    pk: &BTreeMap<String, JsonValue>,
    use_output: bool,
    next_param: &mut u32,
) -> AppResult<String> {
    if pk.is_empty() {
        return Err(AppError::Validation(
            "delete op: pk must not be empty".into(),
        ));
    }
    let qualified = mssql_quote_qualified(schema, relation);

    let output_clause = if use_output { " OUTPUT DELETED.*" } else { "" };

    let where_parts: Vec<String> = pk
        .keys()
        .map(|col| {
            let q = mssql_quote_ident(col);
            let p = format!("@P{}", *next_param);
            *next_param += 1;
            format!("{q} = {p}")
        })
        .collect();

    Ok(format!(
        "DELETE FROM {qualified}{output} WHERE {wh};",
        output = output_clause,
        wh = where_parts.join(" AND "),
    ))
}

/// Build `SELECT * FROM [s].[t] WHERE [pk1] = @P1 ...` for re-fetch.
pub fn build_refetch_sql(
    schema: &str,
    relation: &str,
    pk_cols: &[String],
    next_param: &mut u32,
) -> String {
    let qualified = mssql_quote_qualified(schema, relation);
    let where_parts: Vec<String> = pk_cols
        .iter()
        .map(|col| {
            let q = mssql_quote_ident(col);
            let p = format!("@P{}", *next_param);
            *next_param += 1;
            format!("{q} = {p}")
        })
        .collect();
    format!(
        "SELECT * FROM {qualified} WHERE {wh};",
        wh = where_parts.join(" AND ")
    )
}

// ---------------------------------------------------------------------------
// Apply single op helpers
// ---------------------------------------------------------------------------

/// Bind the values from a BTreeMap (iterating in key order) to the query.
fn bind_btree_values(
    query: &mut tiberius::Query<'_>,
    map: &BTreeMap<String, JsonValue>,
    col_infos: &HashMap<String, ColumnInfo>,
) -> AppResult<()> {
    for (col, val) in map.iter() {
        let bk = col_infos
            .get(col)
            .map(|c| c.bind_kind)
            .unwrap_or(BindKind::Unknown);
        bind_edit_value(query, val, bk)?;
    }
    Ok(())
}

/// Decode a tiberius Row to a Vec<JsonValue> with truncation.
fn decode_row(row: &tiberius::Row, columns: &[ColumnMeta]) -> AppResult<Vec<JsonValue>> {
    let mut vals: Vec<JsonValue> = Vec::with_capacity(columns.len());
    for (i, col) in columns.iter().enumerate() {
        let val = decode_row_value(row, i, col.bind_kind)?;
        let serialized = serde_json::to_string(&val).unwrap_or_default();
        if serialized.len() > TRUNCATE_BYTES {
            let size = serialized.len();
            let mut trunc = serde_json::Map::new();
            trunc.insert("truncated".into(), JsonValue::Bool(true));
            trunc.insert("size".into(), JsonValue::Number(size.into()));
            vals.push(JsonValue::Object(trunc));
        } else {
            vals.push(val);
        }
    }
    Ok(vals)
}

/// Is this an AppError with SQL Server code 334 (OUTPUT + trigger conflict)?
fn is_trigger_error(err: &AppError) -> bool {
    matches!(err, AppError::Mssql(body) if body.code == Some(ERROR_OUTPUT_TRIGGER))
}

// ---------------------------------------------------------------------------
// §10.4 + §10.5 — mssql_apply_table_edits
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mssql_apply_table_edits(
    app: AppHandle,
    registry: State<'_, MssqlPoolRegistry>,
    id: Uuid,
    schema: String,
    relation: String,
    edits: Vec<EditOp>,
    origin: Option<Origin>,
) -> AppResult<ApplyResult> {
    let started = Instant::now();
    let activity_origin = origin.unwrap_or_default();

    // §10.3 — Read-only check via execute_mutation before any SQL.
    // We don't use the closure form here since we need to control the
    // transaction manually. But we still check read_only first.
    {
        match registry.read_only_for(id) {
            Some(true) => {
                return Err(AppError::Validation("connection is read-only".into()));
            }
            None => {
                return Err(AppError::Validation(format!(
                    "no active pool for connection {id}"
                )));
            }
            Some(false) => {}
        }
    }

    if edits.is_empty() {
        return Err(AppError::Validation("no edits to apply".into()));
    }

    let inner: AppResult<ApplyResult> = async {
        let mut conn = registry.acquire(id).await?;

        // 1. Fetch column metadata.
        let meta = fetch_column_meta(&mut conn, &schema, &relation).await?;

        // Build ColumnInfo map for validation.
        let col_info_map: HashMap<String, ColumnInfo> = meta
            .columns
            .iter()
            .map(|c| {
                (
                    c.name.clone(),
                    ColumnInfo {
                        name: c.name.clone(),
                        bind_kind: c.bind_kind,
                        is_nullable: c.is_nullable,
                        is_identity: c.is_identity,
                        is_computed: c.is_computed,
                    },
                )
            })
            .collect();

        // 2. Fetch PK columns.
        let pk_info = fetch_primary_key_inner(&mut conn, &schema, &relation).await?;
        let pk_columns: Vec<String> = pk_info.columns.unwrap_or_default();

        // 3. Validate all ops.
        if let Err((op_idx, err)) =
            validate_edit_ops(&edits, &col_info_map, &pk_columns)
        {
            return Err(AppError::Validation(format!(
                "edit op {op_idx} invalid: {err}"
            )));
        }

        // 4. Check trigger-degradation cache.
        let degraded = is_degraded(id, &schema, &relation).await;

        // 5 + 6 + 7. Execute ops.
        let result = apply_ops_with_output(
            &mut conn,
            id,
            &schema,
            &relation,
            &edits,
            &meta.columns,
            &col_info_map,
            &pk_columns,
            !degraded, // use_output = true unless already degraded
            started,
        )
        .await;

        match result {
            Ok(r) => Ok(r),
            Err(e) if is_trigger_error(&e) && !degraded => {
                // Trigger degradation: rollback already done inside apply_ops_with_output.
                // Mark degraded and retry without OUTPUT.
                mark_degraded(id, &schema, &relation).await;
                tracing::info!(
                    "mssql edit: trigger degradation for {schema}.{relation}; retrying without OUTPUT"
                );

                // Re-acquire a fresh connection (original may be in bad state).
                let mut conn2 = registry.acquire(id).await?;
                apply_ops_with_output(
                    &mut conn2,
                    id,
                    &schema,
                    &relation,
                    &edits,
                    &meta.columns,
                    &col_info_map,
                    &pk_columns,
                    false, // use_output = false (degraded path)
                    started,
                )
                .await
            }
            Err(e) => Err(e),
        }
    }
    .await;

    let total_ms = started.elapsed().as_millis() as u64;
    let builder = ActivityLogEntryBuilder::new(ActivityKind::ApplyEdits, activity_origin, total_ms)
        .connection(id);
    match &inner {
        Ok(r) => emit_activity(
            &app,
            builder.ok(Some(Metric::Items {
                value: r.refreshed_rows.len() as u32,
            })),
        ),
        Err(e) => emit_activity(&app, builder.err(e)),
    }
    inner
}

/// Execute all ops within a transaction, with optional OUTPUT clause.
/// On any error, rolls back the transaction before returning.
async fn apply_ops_with_output(
    conn: &mut bb8::PooledConnection<'static, bb8_tiberius::ConnectionManager>,
    _conn_id: Uuid,
    schema: &str,
    relation: &str,
    edits: &[EditOp],
    columns: &[ColumnMeta],
    col_info_map: &HashMap<String, ColumnInfo>,
    pk_columns: &[String],
    use_output: bool,
    started: Instant,
) -> AppResult<ApplyResult> {
    // Begin transaction.
    conn.simple_query("BEGIN TRAN")
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let mut all_refreshed: Vec<Vec<JsonValue>> = Vec::new();

    for (op_idx, op) in edits.iter().enumerate() {
        let result = apply_one_op(
            conn,
            op,
            schema,
            relation,
            columns,
            col_info_map,
            pk_columns,
            use_output,
        )
        .await;

        match result {
            Ok(rows) => {
                all_refreshed.extend(rows);
            }
            Err(e) => {
                // Rollback on any failure (best-effort).
                let _ = conn.simple_query("ROLLBACK TRAN").await.map(|_| ());

                // Check if this is a trigger degradation error (code 334).
                if is_trigger_error(&e) {
                    return Err(e);
                }

                return Err(AppError::Mssql(MssqlErrorBody {
                    code: match &e {
                        AppError::Mssql(b) => b.code,
                        _ => None,
                    },
                    message: format!("edit op {} failed: {}", op_idx, e),
                    line: None,
                    procedure: None,
                }));
            }
        }
    }

    // Commit.
    conn.simple_query("COMMIT TRAN")
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    Ok(ApplyResult {
        refreshed_rows: all_refreshed,
        columns: columns.to_vec(),
        degraded_to_refetch: !use_output,
        applied_ms: started.elapsed().as_millis() as u64,
    })
}

/// Apply a single edit op (INSERT/UPDATE/DELETE) within an open transaction.
async fn apply_one_op(
    conn: &mut bb8::PooledConnection<'static, bb8_tiberius::ConnectionManager>,
    op: &EditOp,
    schema: &str,
    relation: &str,
    columns: &[ColumnMeta],
    col_info_map: &HashMap<String, ColumnInfo>,
    pk_columns: &[String],
    use_output: bool,
) -> AppResult<Vec<Vec<JsonValue>>> {
    match op {
        EditOp::Insert { values } => {
            let col_names: Vec<&str> = values.keys().map(|s| s.as_str()).collect();
            let mut next_param = 1u32;
            let (sql, _) =
                build_insert_sql(schema, relation, &col_names, use_output, &mut next_param)?;

            let mut query = tiberius::Query::new(sql.as_str());
            // Bind in column order (BTreeMap iteration order is alphabetical).
            // However, col_names was built from values.keys() which is BTreeMap order.
            for (col, val) in values.iter() {
                let bk = col_info_map
                    .get(col.as_str())
                    .map(|c| c.bind_kind)
                    .unwrap_or(BindKind::Unknown);
                bind_edit_value(&mut query, val, bk)?;
            }

            if use_output {
                let rows = query
                    .query(conn)
                    .await
                    .map_err(map_tiberius_error)?
                    .into_first_result()
                    .await
                    .map_err(map_tiberius_error)?;
                let decoded: Vec<Vec<JsonValue>> = rows
                    .iter()
                    .map(|r| decode_row(r, columns))
                    .collect::<AppResult<_>>()?;
                Ok(decoded)
            } else {
                // Degradation path: INSERT without OUTPUT.
                query.execute(conn).await.map_err(map_tiberius_error)?;

                // Re-fetch via SCOPE_IDENTITY() if there's an identity column.
                let identity_col = columns
                    .iter()
                    .find(|c| c.is_identity)
                    .map(|c| c.name.clone());
                if let Some(id_col) = &identity_col {
                    // Check if this identity col is the PK.
                    if pk_columns.contains(id_col) {
                        let scope_id_rows = conn
                            .simple_query("SELECT CAST(SCOPE_IDENTITY() AS BIGINT) AS id")
                            .await
                            .map_err(map_tiberius_error)?
                            .into_first_result()
                            .await
                            .map_err(map_tiberius_error)?;
                        // SCOPE_IDENTITY() returns NUMERIC; we cast to BIGINT.
                        let scope_id: Option<i64> =
                            scope_id_rows.first().and_then(|r| r.get::<i64, _>(0));
                        if let Some(sid) = scope_id {
                            // Re-fetch by identity value.
                            let id_col_q = mssql_quote_ident(id_col);
                            let qualified = mssql_quote_qualified(schema, relation);
                            let refetch_sql =
                                format!("SELECT * FROM {qualified} WHERE {id_col_q} = @P1;");
                            let mut rq = tiberius::Query::new(refetch_sql.as_str());
                            rq.bind(sid);
                            let refetch_rows = rq
                                .query(conn)
                                .await
                                .map_err(map_tiberius_error)?
                                .into_first_result()
                                .await
                                .map_err(map_tiberius_error)?;
                            return Ok(refetch_rows
                                .iter()
                                .map(|r| decode_row(r, columns))
                                .collect::<AppResult<_>>()?);
                        }
                    }
                }

                // Fallback: re-fetch by provided PK values.
                let pk_from_values: BTreeMap<String, JsonValue> = pk_columns
                    .iter()
                    .filter_map(|pk_col| values.get(pk_col).map(|v| (pk_col.clone(), v.clone())))
                    .collect();
                if pk_from_values.is_empty() {
                    return Ok(vec![]);
                }
                let mut next = 1u32;
                let refetch_sql = build_refetch_sql(schema, relation, pk_columns, &mut next);
                let mut rq = tiberius::Query::new(refetch_sql.as_str());
                for pk_col in pk_columns {
                    let val = pk_from_values.get(pk_col).unwrap_or(&JsonValue::Null);
                    let bk = col_info_map
                        .get(pk_col.as_str())
                        .map(|c| c.bind_kind)
                        .unwrap_or(BindKind::Unknown);
                    bind_edit_value(&mut rq, val, bk)?;
                }
                let rows = rq
                    .query(conn)
                    .await
                    .map_err(map_tiberius_error)?
                    .into_first_result()
                    .await
                    .map_err(map_tiberius_error)?;
                Ok(rows
                    .iter()
                    .map(|r| decode_row(r, columns))
                    .collect::<AppResult<_>>()?)
            }
        }

        EditOp::Update { pk, changes } => {
            let mut next_param = 1u32;
            let sql = build_update_sql(schema, relation, changes, pk, use_output, &mut next_param)?;

            let mut query = tiberius::Query::new(sql.as_str());
            // Bind changes first (BTreeMap order = alphabetical), then pk.
            bind_btree_values(&mut query, changes, col_info_map)?;
            bind_btree_values(&mut query, pk, col_info_map)?;

            if use_output {
                let rows = query
                    .query(conn)
                    .await
                    .map_err(map_tiberius_error)?
                    .into_first_result()
                    .await
                    .map_err(map_tiberius_error)?;
                let decoded: Vec<Vec<JsonValue>> = rows
                    .iter()
                    .map(|r| decode_row(r, columns))
                    .collect::<AppResult<_>>()?;
                Ok(decoded)
            } else {
                // Degradation path: UPDATE without OUTPUT; re-fetch by PK.
                query.execute(conn).await.map_err(map_tiberius_error)?;

                // PK after update: if any PK col was changed, use new value.
                let pk_for_refetch: Vec<(String, JsonValue)> = pk_columns
                    .iter()
                    .map(|pk_col| {
                        let val = changes
                            .get(pk_col)
                            .or_else(|| pk.get(pk_col))
                            .cloned()
                            .unwrap_or(JsonValue::Null);
                        (pk_col.clone(), val)
                    })
                    .collect();

                let mut next = 1u32;
                let refetch_sql = build_refetch_sql(schema, relation, pk_columns, &mut next);
                let mut rq = tiberius::Query::new(refetch_sql.as_str());
                for (pk_col, val) in &pk_for_refetch {
                    let bk = col_info_map
                        .get(pk_col.as_str())
                        .map(|c| c.bind_kind)
                        .unwrap_or(BindKind::Unknown);
                    bind_edit_value(&mut rq, val, bk)?;
                }
                let rows = rq
                    .query(conn)
                    .await
                    .map_err(map_tiberius_error)?
                    .into_first_result()
                    .await
                    .map_err(map_tiberius_error)?;
                Ok(rows
                    .iter()
                    .map(|r| decode_row(r, columns))
                    .collect::<AppResult<_>>()?)
            }
        }

        EditOp::Delete { pk } => {
            let mut next_param = 1u32;
            let sql = build_delete_sql(schema, relation, pk, use_output, &mut next_param)?;

            let mut query = tiberius::Query::new(sql.as_str());
            bind_btree_values(&mut query, pk, col_info_map)?;

            if use_output {
                let rows = query
                    .query(conn)
                    .await
                    .map_err(map_tiberius_error)?
                    .into_first_result()
                    .await
                    .map_err(map_tiberius_error)?;
                // Return the deleted row (as it was).
                let decoded: Vec<Vec<JsonValue>> = rows
                    .iter()
                    .map(|r| decode_row(r, columns))
                    .collect::<AppResult<_>>()?;
                Ok(decoded)
            } else {
                // Degradation path: DELETE without OUTPUT — no re-fetch for deletes.
                query.execute(conn).await.map_err(map_tiberius_error)?;
                Ok(vec![])
            }
        }
    }
}

// ---------------------------------------------------------------------------
// §10.5 + §10.6 — mssql_table_primary_key
// ---------------------------------------------------------------------------

/// Fetch PK + identity column without a full connection closure.
async fn fetch_primary_key_inner(
    conn: &mut bb8::PooledConnection<'_, bb8_tiberius::ConnectionManager>,
    schema: &str,
    relation: &str,
) -> AppResult<PrimaryKeyInfo> {
    let qualified_name = format!("{}.{}", schema, relation);

    // PK columns in key_ordinal order.
    let pk_sql = "\
        SELECT c.name, c.is_identity \
        FROM sys.indexes i \
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
        JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
        WHERE i.object_id = OBJECT_ID(@P1) AND i.is_primary_key = 1 \
        ORDER BY ic.key_ordinal";

    let mut q = tiberius::Query::new(pk_sql);
    q.bind(qualified_name.as_str());

    let pk_rows = q
        .query(conn)
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let pk_cols: Vec<String> = pk_rows
        .iter()
        .filter_map(|r| r.get::<&str, _>(0).map(|s| s.to_string()))
        .collect();

    // IDENTITY column (at most one per table).
    let identity_sql =
        "SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(@P1) AND is_identity = 1";
    let mut qi = tiberius::Query::new(identity_sql);
    qi.bind(qualified_name.as_str());

    let id_rows = qi
        .query(conn)
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let identity_column: Option<String> = id_rows
        .first()
        .and_then(|r| r.get::<&str, _>(0).map(|s| s.to_string()));

    Ok(PrimaryKeyInfo {
        columns: if pk_cols.is_empty() {
            None
        } else {
            Some(pk_cols)
        },
        identity_column,
    })
}

#[tauri::command]
pub async fn mssql_table_primary_key(
    app: AppHandle,
    registry: State<'_, MssqlPoolRegistry>,
    id: Uuid,
    schema: String,
    relation: String,
    origin: Option<Origin>,
) -> AppResult<PrimaryKeyInfo> {
    let started = Instant::now();
    let activity_origin = origin.unwrap_or_default();

    let inner: AppResult<PrimaryKeyInfo> = async {
        let mut conn = registry.acquire(id).await?;
        fetch_primary_key_inner(&mut conn, &schema, &relation).await
    }
    .await;

    let total_ms = started.elapsed().as_millis() as u64;
    let builder =
        ActivityLogEntryBuilder::new(ActivityKind::ListTableExtras, activity_origin, total_ms)
            .connection(id);
    match &inner {
        Ok(r) => {
            let count = r.columns.as_ref().map(|c| c.len()).unwrap_or(0) as u32
                + r.identity_column.as_ref().map(|_| 1).unwrap_or(0);
            emit_activity(&app, builder.ok(Some(Metric::Items { value: count })));
        }
        Err(e) => emit_activity(&app, builder.err(e)),
    }
    inner
}

// ---------------------------------------------------------------------------
// §10.7 + §10.9 — Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mk_col_info(name: &str, bk: BindKind, is_identity: bool, is_computed: bool) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            bind_kind: bk,
            is_nullable: true,
            is_identity,
            is_computed,
        }
    }

    fn col_info_map() -> HashMap<String, ColumnInfo> {
        let mut m = HashMap::new();
        m.insert("id".into(), mk_col_info("id", BindKind::Int, false, false));
        m.insert(
            "name".into(),
            mk_col_info("name", BindKind::NVarchar, false, false),
        );
        m.insert(
            "email".into(),
            mk_col_info("email", BindKind::Varchar, false, false),
        );
        m.insert(
            "geo".into(),
            mk_col_info("geo", BindKind::Geometry, false, false),
        );
        m.insert(
            "rv".into(),
            mk_col_info("rv", BindKind::RowVersion, false, false),
        );
        m.insert(
            "hier".into(),
            mk_col_info("hier", BindKind::HierarchyId, false, false),
        );
        m.insert(
            "sv".into(),
            mk_col_info("sv", BindKind::SqlVariant, false, false),
        );
        m.insert(
            "id_col".into(),
            mk_col_info("id_col", BindKind::Int, true, false),
        );
        m.insert(
            "comp".into(),
            mk_col_info("comp", BindKind::NVarchar, false, true),
        );
        m
    }

    fn pk(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn btree(entries: &[(&str, JsonValue)]) -> BTreeMap<String, JsonValue> {
        let mut m = BTreeMap::new();
        for (k, v) in entries {
            m.insert((*k).to_string(), v.clone());
        }
        m
    }

    // -----------------------------------------------------------------------
    // SQL builder tests
    // -----------------------------------------------------------------------

    #[test]
    fn build_insert_with_output() {
        let col_names = ["name", "email"];
        let mut next = 1u32;
        let (sql, _) = build_insert_sql("dbo", "users", &col_names, true, &mut next).unwrap();
        assert!(sql.contains("INSERT INTO [dbo].[users]"), "sql: {sql}");
        assert!(sql.contains("OUTPUT INSERTED.*"), "sql: {sql}");
        assert!(sql.contains("[name]"), "sql: {sql}");
        assert!(sql.contains("[email]"), "sql: {sql}");
        assert!(sql.contains("@P1"), "sql: {sql}");
        assert!(sql.contains("@P2"), "sql: {sql}");
    }

    #[test]
    fn build_insert_without_output() {
        let col_names = ["name"];
        let mut next = 1u32;
        let (sql, _) = build_insert_sql("dbo", "users", &col_names, false, &mut next).unwrap();
        assert!(sql.contains("INSERT INTO [dbo].[users]"), "sql: {sql}");
        assert!(!sql.contains("OUTPUT"), "no OUTPUT: {sql}");
        assert!(sql.contains("[name]"), "sql: {sql}");
    }

    #[test]
    fn build_insert_empty_cols_rejected() {
        let mut next = 1u32;
        let err = build_insert_sql("dbo", "t", &[], true, &mut next).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn build_update_with_output() {
        let changes = btree(&[("email", json!("a@b.com")), ("name", json!("ana"))]);
        let pk = btree(&[("id", json!(1))]);
        let mut next = 1u32;
        let sql = build_update_sql("dbo", "users", &changes, &pk, true, &mut next).unwrap();
        // Changes in BTreeMap order: email first (alphabetical), then name.
        assert!(sql.contains("UPDATE [dbo].[users]"), "sql: {sql}");
        assert!(sql.contains("OUTPUT INSERTED.*"), "sql: {sql}");
        assert!(sql.contains("[email] = @P1"), "sql: {sql}");
        assert!(sql.contains("[name] = @P2"), "sql: {sql}");
        assert!(sql.contains("[id] = @P3"), "sql: {sql}");
    }

    #[test]
    fn build_update_without_output() {
        let changes = btree(&[("name", json!("ana"))]);
        let pk = btree(&[("id", json!(1))]);
        let mut next = 1u32;
        let sql = build_update_sql("dbo", "users", &changes, &pk, false, &mut next).unwrap();
        assert!(sql.contains("UPDATE [dbo].[users]"), "sql: {sql}");
        assert!(!sql.contains("OUTPUT"), "no OUTPUT: {sql}");
        assert!(sql.contains("WHERE [id] = @P2"), "sql: {sql}");
    }

    #[test]
    fn build_update_empty_changes_rejected() {
        let changes = BTreeMap::new();
        let pk = btree(&[("id", json!(1))]);
        let mut next = 1u32;
        let err = build_update_sql("dbo", "t", &changes, &pk, true, &mut next).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn build_delete_with_output() {
        let pk = btree(&[("tenant_id", json!(5)), ("user_id", json!(7))]);
        let mut next = 1u32;
        let sql = build_delete_sql("dbo", "t", &pk, true, &mut next).unwrap();
        assert!(sql.contains("DELETE FROM [dbo].[t]"), "sql: {sql}");
        assert!(sql.contains("OUTPUT DELETED.*"), "sql: {sql}");
        assert!(sql.contains("[tenant_id] = @P1"), "sql: {sql}");
        assert!(sql.contains("[user_id] = @P2"), "sql: {sql}");
    }

    #[test]
    fn build_delete_without_output() {
        let pk = btree(&[("id", json!(1))]);
        let mut next = 1u32;
        let sql = build_delete_sql("dbo", "users", &pk, false, &mut next).unwrap();
        assert!(!sql.contains("OUTPUT"), "no OUTPUT: {sql}");
        assert!(sql.contains("WHERE [id] = @P1"), "sql: {sql}");
    }

    #[test]
    fn build_delete_empty_pk_rejected() {
        let mut next = 1u32;
        let err = build_delete_sql("dbo", "t", &BTreeMap::new(), true, &mut next).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn build_refetch_sql_single_pk() {
        let mut next = 1u32;
        let sql = build_refetch_sql("dbo", "users", &["id".to_string()], &mut next);
        assert!(sql.contains("SELECT * FROM [dbo].[users]"), "sql: {sql}");
        assert!(sql.contains("[id] = @P1"), "sql: {sql}");
    }

    #[test]
    fn build_refetch_sql_composite_pk() {
        let mut next = 1u32;
        let sql = build_refetch_sql(
            "dbo",
            "t",
            &["tenant_id".to_string(), "user_id".to_string()],
            &mut next,
        );
        assert!(sql.contains("[tenant_id] = @P1"), "sql: {sql}");
        assert!(sql.contains("[user_id] = @P2"), "sql: {sql}");
    }

    #[test]
    fn pathological_identifier_escaped() {
        let mut next = 1u32;
        let (sql, _) =
            build_insert_sql("we]ird", "ta]ble", &["col]name"], true, &mut next).unwrap();
        assert!(sql.contains("[we]]ird]"), "sql: {sql}");
        assert!(sql.contains("[ta]]ble]"), "sql: {sql}");
        assert!(sql.contains("[col]]name]"), "sql: {sql}");
    }

    // -----------------------------------------------------------------------
    // Validation tests
    // -----------------------------------------------------------------------

    #[test]
    fn validate_update_ok() {
        let ops = vec![EditOp::Update {
            pk: btree(&[("id", json!(1))]),
            changes: btree(&[("name", json!("Alice"))]),
        }];
        validate_edit_ops(&ops, &col_info_map(), &pk(&["id"])).unwrap();
    }

    #[test]
    fn validate_update_missing_pk_col() {
        let ops = vec![EditOp::Update {
            pk: btree(&[("id", json!(1))]),
            changes: btree(&[("name", json!("x"))]),
        }];
        let err = validate_edit_ops(&ops, &col_info_map(), &pk(&["id", "tenant_id"])).unwrap_err();
        assert!(err.1.to_string().contains("tenant_id"));
    }

    #[test]
    fn validate_update_empty_changes_rejected() {
        let ops = vec![EditOp::Update {
            pk: btree(&[("id", json!(1))]),
            changes: BTreeMap::new(),
        }];
        let err = validate_edit_ops(&ops, &col_info_map(), &pk(&["id"])).unwrap_err();
        assert!(err.1.to_string().contains("empty"));
    }

    #[test]
    fn validate_update_unknown_column_rejected() {
        let ops = vec![EditOp::Update {
            pk: btree(&[("id", json!(1))]),
            changes: btree(&[("ghost", json!("x"))]),
        }];
        let err = validate_edit_ops(&ops, &col_info_map(), &pk(&["id"])).unwrap_err();
        assert!(err.1.to_string().contains("ghost"));
    }

    #[test]
    fn validate_update_identity_column_rejected() {
        let ops = vec![EditOp::Update {
            pk: btree(&[("id", json!(1))]),
            changes: btree(&[("id_col", json!(99))]),
        }];
        let err = validate_edit_ops(&ops, &col_info_map(), &pk(&["id"])).unwrap_err();
        assert!(err.1.to_string().to_lowercase().contains("identity"));
    }

    #[test]
    fn validate_update_computed_column_rejected() {
        let ops = vec![EditOp::Update {
            pk: btree(&[("id", json!(1))]),
            changes: btree(&[("comp", json!("x"))]),
        }];
        let err = validate_edit_ops(&ops, &col_info_map(), &pk(&["id"])).unwrap_err();
        assert!(err.1.to_string().to_lowercase().contains("computed"));
    }

    #[test]
    fn validate_update_geometry_rejected() {
        let ops = vec![EditOp::Update {
            pk: btree(&[("id", json!(1))]),
            changes: btree(&[("geo", json!("POINT(1 2)"))]),
        }];
        let err = validate_edit_ops(&ops, &col_info_map(), &pk(&["id"])).unwrap_err();
        assert!(err.1.to_string().to_lowercase().contains("geometry"));
    }

    #[test]
    fn validate_update_rowversion_rejected() {
        let ops = vec![EditOp::Update {
            pk: btree(&[("id", json!(1))]),
            changes: btree(&[("rv", json!("AAAA"))]),
        }];
        let err = validate_edit_ops(&ops, &col_info_map(), &pk(&["id"])).unwrap_err();
        assert!(err.1.to_string().to_lowercase().contains("rowversion"));
    }

    #[test]
    fn validate_insert_ok() {
        let ops = vec![EditOp::Insert {
            values: btree(&[("name", json!("Ana"))]),
        }];
        validate_edit_ops(&ops, &col_info_map(), &pk(&["id"])).unwrap();
    }

    #[test]
    fn validate_insert_identity_column_rejected() {
        let ops = vec![EditOp::Insert {
            values: btree(&[("id_col", json!(42)), ("name", json!("Ana"))]),
        }];
        let err = validate_edit_ops(&ops, &col_info_map(), &pk(&["id"])).unwrap_err();
        assert!(err.1.to_string().to_lowercase().contains("identity"));
    }

    #[test]
    fn validate_insert_geometry_rejected() {
        let ops = vec![EditOp::Insert {
            values: btree(&[("geo", json!("POINT(1 2)"))]),
        }];
        let err = validate_edit_ops(&ops, &col_info_map(), &pk(&["id"])).unwrap_err();
        assert!(err.1.to_string().to_lowercase().contains("geometry"));
    }

    #[test]
    fn validate_insert_hierarchyid_rejected() {
        let ops = vec![EditOp::Insert {
            values: btree(&[("hier", json!("/1/"))]),
        }];
        let err = validate_edit_ops(&ops, &col_info_map(), &pk(&["id"])).unwrap_err();
        assert!(err.1.to_string().to_lowercase().contains("hierarchyid"));
    }

    #[test]
    fn validate_insert_sqlvariant_rejected() {
        let ops = vec![EditOp::Insert {
            values: btree(&[("sv", json!("v"))]),
        }];
        let err = validate_edit_ops(&ops, &col_info_map(), &pk(&["id"])).unwrap_err();
        assert!(err.1.to_string().to_lowercase().contains("sql_variant"));
    }

    #[test]
    fn validate_delete_ok() {
        let ops = vec![EditOp::Delete {
            pk: btree(&[("id", json!(1))]),
        }];
        validate_edit_ops(&ops, &col_info_map(), &pk(&["id"])).unwrap();
    }

    #[test]
    fn validate_delete_missing_pk_col() {
        let ops = vec![EditOp::Delete {
            pk: btree(&[("id", json!(1))]),
        }];
        let err = validate_edit_ops(&ops, &col_info_map(), &pk(&["id", "tenant_id"])).unwrap_err();
        assert!(err.1.to_string().contains("tenant_id"));
    }

    #[test]
    fn validate_delete_empty_pk_rejected() {
        let ops = vec![EditOp::Delete {
            pk: BTreeMap::new(),
        }];
        let err = validate_edit_ops(&ops, &col_info_map(), &pk(&["id"])).unwrap_err();
        assert!(err.1.to_string().contains("empty"));
    }

    // -----------------------------------------------------------------------
    // Trigger degradation cache
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn trigger_cache_mark_and_read() {
        let id = Uuid::new_v4();
        assert!(!is_degraded(id, "dbo", "test_table").await);
        mark_degraded(id, "dbo", "test_table").await;
        assert!(is_degraded(id, "dbo", "test_table").await);
        // Different table not affected.
        assert!(!is_degraded(id, "dbo", "other_table").await);
    }

    // -----------------------------------------------------------------------
    // is_trigger_error
    // -----------------------------------------------------------------------

    #[test]
    fn is_trigger_error_detects_code_334() {
        let err = AppError::Mssql(MssqlErrorBody {
            code: Some(334),
            message: "OUTPUT clause with triggers".into(),
            line: None,
            procedure: None,
        });
        assert!(is_trigger_error(&err));
    }

    #[test]
    fn is_trigger_error_false_for_other_codes() {
        let err = AppError::Mssql(MssqlErrorBody {
            code: Some(208),
            message: "invalid object name".into(),
            line: None,
            procedure: None,
        });
        assert!(!is_trigger_error(&err));
    }

    // -----------------------------------------------------------------------
    // Placeholder sequencing across ops
    // -----------------------------------------------------------------------

    #[test]
    fn update_placeholders_sequential() {
        let changes = btree(&[("email", json!("a@b.com")), ("name", json!("ana"))]);
        let pk = btree(&[("id", json!(1))]);
        let mut next = 5u32; // start from 5 to verify sequencing
        let sql = build_update_sql("dbo", "users", &changes, &pk, true, &mut next).unwrap();
        assert!(sql.contains("@P5"), "sql: {sql}");
        assert!(sql.contains("@P6"), "sql: {sql}");
        assert!(sql.contains("@P7"), "sql: {sql}");
        assert_eq!(next, 8);
    }
}
