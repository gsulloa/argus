//! MySQL editable-table support: PK lookup, SQL builders, validation, and
//! transactional apply command. Mirrors `postgres::edit` adapted for MySQL
//! (backtick quoting, `?` placeholders, LAST_INSERT_ID, in-transaction re-fetch
//! instead of RETURNING).

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::mysql::binding::{
    bind_edit_value, decode_row_value, mysql_quote_ident, mysql_quote_qualified, BindKind,
};
use crate::modules::mysql::cancel::capture_thread_id;
use crate::modules::mysql::data::fetch_column_meta;
use crate::modules::mysql::errors::map_sqlx_error;
use crate::modules::mysql::pool::MysqlPoolRegistry;

/// Hard cap on the apply transaction.
const QUERY_TIMEOUT: Duration = Duration::from_secs(15);
/// Truncation threshold (same as data grid).
const TRUNCATE_BYTES: usize = 1_048_576;

// ---------------------------------------------------------------------------
// §10.1 — Data structures
// ---------------------------------------------------------------------------

/// Discriminated union of edit operations the frontend can submit.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
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
pub struct ApplyEditsResult {
    pub applied: usize,
    pub errors: Vec<EditError>,
    pub rows: Vec<RefreshedRow>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EditError {
    pub op_index: usize,
    pub error: String,
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefreshedRow {
    pub op_index: usize,
    pub pk: BTreeMap<String, JsonValue>,
    pub row: Vec<JsonValue>,
    pub action: String, // "inserted" | "updated" | "deleted"
}

#[derive(Debug, Clone, Serialize)]
pub struct PrimaryKeyResult {
    pub columns: Vec<String>,
    pub auto_increment_column: Option<String>,
}

// ---------------------------------------------------------------------------
// §10.2 — Op validation (pure function)
// ---------------------------------------------------------------------------

pub fn validate_edits(
    edits: &[EditOp],
    table_columns: &std::collections::HashMap<String, BindKind>,
    pk_columns: &[String],
) -> Result<(), (usize, AppError)> {
    for (i, op) in edits.iter().enumerate() {
        match op {
            EditOp::Update { pk, changes } => {
                if pk.is_empty() {
                    return Err((i, AppError::Validation("update op has empty `pk`".into())));
                }
                // Check PK coverage.
                for pk_col in pk_columns {
                    if !pk.contains_key(pk_col) {
                        return Err((
                            i,
                            AppError::Validation(format!(
                                "update op missing PK column \"{}\"",
                                pk_col
                            )),
                        ));
                    }
                }
                if changes.is_empty() {
                    return Err((
                        i,
                        AppError::Validation("update op has empty `changes`".into()),
                    ));
                }
                for col in changes.keys() {
                    let bk = table_columns.get(col).ok_or_else(|| {
                        (
                            i,
                            AppError::Validation(format!("unknown column \"{col}\" in changes")),
                        )
                    })?;
                    if matches!(bk, BindKind::Geometry) {
                        return Err((
                            i,
                            AppError::Validation(
                                "editing GEOMETRY columns is not supported; use the SQL editor"
                                    .into(),
                            ),
                        ));
                    }
                }
            }
            EditOp::Insert { values } => {
                if values.is_empty() {
                    return Err((
                        i,
                        AppError::Validation("insert op has empty `values`".into()),
                    ));
                }
                for col in values.keys() {
                    let bk = table_columns.get(col).ok_or_else(|| {
                        (
                            i,
                            AppError::Validation(format!("unknown column \"{col}\" in values")),
                        )
                    })?;
                    if matches!(bk, BindKind::Geometry) {
                        return Err((
                            i,
                            AppError::Validation(
                                "editing GEOMETRY columns is not supported; use the SQL editor"
                                    .into(),
                            ),
                        ));
                    }
                }
            }
            EditOp::Delete { pk } => {
                if pk.is_empty() {
                    return Err((i, AppError::Validation("delete op has empty `pk`".into())));
                }
                for pk_col in pk_columns {
                    if !pk.contains_key(pk_col) {
                        return Err((
                            i,
                            AppError::Validation(format!(
                                "delete op missing PK column \"{}\"",
                                pk_col
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
// §10.7 — SQL builder helpers (pub(crate) so tests can call without sqlx)
// ---------------------------------------------------------------------------

/// Build the UPDATE SQL string (no binding). Returns `(sql, change_cols, pk_cols)`.
pub(crate) fn build_update_sql(
    schema: &str,
    relation: &str,
    change_cols: &[&str],
    pk_cols: &[&str],
    json_cols: &std::collections::HashSet<String>,
) -> AppResult<String> {
    if change_cols.is_empty() {
        return Err(AppError::Validation("update op has empty `changes`".into()));
    }
    if pk_cols.is_empty() {
        return Err(AppError::Validation("update op has empty `pk`".into()));
    }
    let qualified = mysql_quote_qualified(schema, relation);
    let set_parts: Vec<String> = change_cols
        .iter()
        .map(|col| {
            let q = mysql_quote_ident(col);
            if json_cols.contains(*col) {
                format!("{q} = CAST(? AS JSON)")
            } else {
                format!("{q} = ?")
            }
        })
        .collect();
    let where_parts: Vec<String> = pk_cols
        .iter()
        .map(|col| {
            let q = mysql_quote_ident(col);
            format!("{q} = ?")
        })
        .collect();
    Ok(format!(
        "UPDATE {qualified} SET {set} WHERE {wh}",
        set = set_parts.join(", "),
        wh = where_parts.join(" AND "),
    ))
}

/// Build the INSERT SQL string.
pub(crate) fn build_insert_sql(
    schema: &str,
    relation: &str,
    col_names: &[&str],
    json_cols: &std::collections::HashSet<String>,
) -> AppResult<String> {
    if col_names.is_empty() {
        return Err(AppError::Validation("insert op has empty `values`".into()));
    }
    let qualified = mysql_quote_qualified(schema, relation);
    let cols: Vec<String> = col_names.iter().map(|c| mysql_quote_ident(c)).collect();
    let vals: Vec<String> = col_names
        .iter()
        .map(|col| {
            if json_cols.contains(*col) {
                "CAST(? AS JSON)".to_string()
            } else {
                "?".to_string()
            }
        })
        .collect();
    Ok(format!(
        "INSERT INTO {qualified} ({cols}) VALUES ({vals})",
        cols = cols.join(", "),
        vals = vals.join(", "),
    ))
}

/// Build the DELETE SQL string.
pub(crate) fn build_delete_sql(
    schema: &str,
    relation: &str,
    pk_cols: &[&str],
) -> AppResult<String> {
    if pk_cols.is_empty() {
        return Err(AppError::Validation("delete op has empty `pk`".into()));
    }
    let qualified = mysql_quote_qualified(schema, relation);
    let where_parts: Vec<String> = pk_cols
        .iter()
        .map(|col| {
            let q = mysql_quote_ident(col);
            format!("{q} = ?")
        })
        .collect();
    Ok(format!(
        "DELETE FROM {qualified} WHERE {wh}",
        wh = where_parts.join(" AND "),
    ))
}

/// Determine which columns are JSON-typed from the bind map.
fn json_columns(
    bind_map: &std::collections::HashMap<String, BindKind>,
) -> std::collections::HashSet<String> {
    bind_map
        .iter()
        .filter_map(|(k, v)| {
            if matches!(v, BindKind::Json) {
                Some(k.clone())
            } else {
                None
            }
        })
        .collect()
}

/// Fetch primary key columns for a table.
async fn fetch_pk_columns(
    conn: &mut sqlx::MySqlConnection,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT kcu.COLUMN_NAME \
         FROM information_schema.KEY_COLUMN_USAGE kcu \
         WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ? AND kcu.CONSTRAINT_NAME = 'PRIMARY' \
         ORDER BY kcu.ORDINAL_POSITION",
    )
    .bind(schema)
    .bind(relation)
    .fetch_all(&mut *conn)
    .await
    .map_err(map_sqlx_error)?;
    Ok(rows.into_iter().map(|(c,)| c).collect())
}

/// Fetch auto-increment column name for a table (if any).
async fn fetch_auto_increment_column(
    conn: &mut sqlx::MySqlConnection,
    schema: &str,
    relation: &str,
) -> AppResult<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND EXTRA LIKE '%auto_increment%' \
         LIMIT 1",
    )
    .bind(schema)
    .bind(relation)
    .fetch_optional(&mut *conn)
    .await
    .map_err(map_sqlx_error)?;
    Ok(row.map(|(c,)| c))
}

/// Decode a row from the connection, applying per-cell truncation.
fn decode_refreshed_row(
    row: &sqlx::mysql::MySqlRow,
    col_infos: &[crate::modules::mysql::data::ColumnInfo],
    bind_map: &std::collections::HashMap<String, BindKind>,
) -> AppResult<(Vec<JsonValue>, Vec<String>)> {
    let mut vals: Vec<JsonValue> = Vec::with_capacity(col_infos.len());
    let mut truncated_cols: Vec<String> = Vec::new();
    for (i, col) in col_infos.iter().enumerate() {
        let bk = bind_map.get(&col.name).unwrap_or(&BindKind::Unknown);
        let val = decode_row_value(row, i, bk)?;
        let serialized = serde_json::to_string(&val).unwrap_or_default();
        if serialized.len() > TRUNCATE_BYTES {
            let size = serialized.len();
            let mut trunc = serde_json::Map::new();
            trunc.insert("truncated".into(), JsonValue::Bool(true));
            trunc.insert("size".into(), JsonValue::Number(size.into()));
            vals.push(JsonValue::Object(trunc));
            if !truncated_cols.contains(&col.name) {
                truncated_cols.push(col.name.clone());
            }
        } else {
            vals.push(val);
        }
    }
    Ok((vals, truncated_cols))
}

/// Build the SELECT * WHERE pk= SQL for refetch.
fn build_refetch_sql(schema: &str, relation: &str, pk_cols: &[String]) -> String {
    let qualified = mysql_quote_qualified(schema, relation);
    let where_parts: Vec<String> = pk_cols
        .iter()
        .map(|col| format!("{} = ?", mysql_quote_ident(col)))
        .collect();
    format!(
        "SELECT * FROM {qualified} WHERE {wh}",
        wh = where_parts.join(" AND ")
    )
}

// ---------------------------------------------------------------------------
// §10.4 — mysql_apply_table_edits
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mysql_apply_table_edits(
    app: AppHandle,
    registry: State<'_, MysqlPoolRegistry>,
    id: Uuid,
    schema: String,
    relation: String,
    edits: Vec<EditOp>,
    origin: Option<Origin>,
) -> AppResult<ApplyEditsResult> {
    let started = Instant::now();
    let activity_origin = origin.unwrap_or_default();

    // §10.3 — Read-only check before BEGIN.
    match registry.read_only_for(id) {
        Some(true) => {
            return Err(AppError::Validation("connection is read-only".into()));
        }
        None => {
            return Err(AppError::NotFound(format!("no active pool for {id}")));
        }
        Some(false) => {}
    }

    if edits.is_empty() {
        return Err(AppError::Validation("no edits to apply".into()));
    }

    let inner: AppResult<ApplyEditsResult> = async {
        let pool = registry.acquire(id)?;
        let mut conn = pool.acquire().await.map_err(map_sqlx_error)?;
        let _thread_id = capture_thread_id(&mut conn).await?;

        // Fetch column metadata.
        let meta = fetch_column_meta(&pool, &schema, &relation).await?;
        let json_cols = json_columns(&meta.bind_map);

        // Fetch PK columns.
        let pk_columns = fetch_pk_columns(&mut conn, &schema, &relation).await?;
        let auto_inc = fetch_auto_increment_column(&mut conn, &schema, &relation).await?;

        // §10.2 — Validate edits before BEGIN.
        if let Err((op_index, err)) = validate_edits(&edits, &meta.bind_map, &pk_columns) {
            let (code, message) = extract_code_message(&err);
            return Ok(ApplyEditsResult {
                applied: 0,
                errors: vec![EditError {
                    op_index,
                    error: message,
                    code,
                }],
                rows: vec![],
            });
        }

        // Start transaction.
        let work = async {
            sqlx::query("BEGIN")
                .execute(&mut *conn)
                .await
                .map_err(map_sqlx_error)?;

            let mut collected_rows: Vec<RefreshedRow> = Vec::new();
            let mut applied_count: usize = 0;

            for (op_index, op) in edits.iter().enumerate() {
                let result = apply_one_op(
                    op,
                    op_index,
                    &schema,
                    &relation,
                    &meta,
                    &pk_columns,
                    &json_cols,
                    &auto_inc,
                    &mut conn,
                )
                .await;

                match result {
                    Ok(row) => {
                        collected_rows.push(row);
                        applied_count += 1;
                    }
                    Err(err) => {
                        // Rollback on first op failure.
                        let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                        let (code, message) = extract_code_message(&err);
                        return Ok::<ApplyEditsResult, AppError>(ApplyEditsResult {
                            applied: applied_count,
                            errors: vec![EditError {
                                op_index,
                                error: message,
                                code,
                            }],
                            rows: collected_rows,
                        });
                    }
                }
            }

            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(map_sqlx_error)?;

            Ok(ApplyEditsResult {
                applied: edits.len(),
                errors: vec![],
                rows: collected_rows,
            })
        };

        match tokio::time::timeout(QUERY_TIMEOUT, work).await {
            Ok(r) => r,
            Err(_) => {
                // Best-effort rollback on timeout.
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                Err(AppError::mysql_with_code(
                    "70100",
                    format!("apply edits timed out ({}s)", QUERY_TIMEOUT.as_secs()),
                ))
            }
        }
    }
    .await;

    // Activity log.
    let total_ms = started.elapsed().as_millis() as u64;
    let builder = ActivityLogEntryBuilder::new(ActivityKind::ApplyEdits, activity_origin, total_ms)
        .connection(id);
    match &inner {
        Ok(r) => emit_activity(
            &app,
            builder.ok(Some(Metric::Items {
                value: if r.errors.is_empty() {
                    r.applied as u32
                } else {
                    r.applied as u32
                },
            })),
        ),
        Err(e) => emit_activity(&app, builder.err(e)),
    }
    inner
}

/// Apply a single edit op within an open transaction connection.
async fn apply_one_op(
    op: &EditOp,
    op_index: usize,
    schema: &str,
    relation: &str,
    meta: &crate::modules::mysql::data::ColumnMeta,
    pk_columns: &[String],
    json_cols: &std::collections::HashSet<String>,
    auto_inc: &Option<String>,
    conn: &mut sqlx::MySqlConnection,
) -> AppResult<RefreshedRow> {
    match op {
        EditOp::Update { pk, changes } => {
            let change_col_names: Vec<&str> = changes.keys().map(|s| s.as_str()).collect();
            let pk_col_names: Vec<&str> = pk.keys().map(|s| s.as_str()).collect();
            let sql = build_update_sql(
                schema,
                relation,
                &change_col_names,
                &pk_col_names,
                json_cols,
            )?;

            // Build query with bound values: changes first, then pk.
            let mut q = sqlx::query(&sql);
            for (col, val) in changes.iter() {
                let bk = meta
                    .bind_map
                    .get(col.as_str())
                    .unwrap_or(&BindKind::Unknown);
                q = bind_edit_value(q, val, bk)?;
            }
            for (col, val) in pk.iter() {
                let bk = meta
                    .bind_map
                    .get(col.as_str())
                    .unwrap_or(&BindKind::Unknown);
                q = bind_edit_value(q, val, bk)?;
            }
            q.execute(&mut *conn).await.map_err(map_sqlx_error)?;

            // Determine PK for refetch: if any PK column is in changes, use new value.
            let mut refetch_pk: BTreeMap<String, JsonValue> = BTreeMap::new();
            for pk_col in pk_columns {
                let val = changes
                    .get(pk_col)
                    .unwrap_or_else(|| pk.get(pk_col).unwrap());
                refetch_pk.insert(pk_col.clone(), val.clone());
            }

            // In-transaction re-fetch.
            let row_vals =
                refetch_row(conn, schema, relation, pk_columns, &refetch_pk, meta).await?;

            Ok(RefreshedRow {
                op_index,
                pk: refetch_pk,
                row: row_vals,
                action: "updated".into(),
            })
        }
        EditOp::Insert { values } => {
            let col_names: Vec<&str> = values.keys().map(|s| s.as_str()).collect();
            let sql = build_insert_sql(schema, relation, &col_names, json_cols)?;

            let mut q = sqlx::query(&sql);
            for (col, val) in values.iter() {
                let bk = meta
                    .bind_map
                    .get(col.as_str())
                    .unwrap_or(&BindKind::Unknown);
                q = bind_edit_value(q, val, bk)?;
            }
            let result = q.execute(&mut *conn).await.map_err(map_sqlx_error)?;
            let last_insert_id = result.last_insert_id();

            // Determine PK for refetch.
            let mut refetch_pk: BTreeMap<String, JsonValue> = BTreeMap::new();
            for pk_col in pk_columns {
                if let Some(ai_col) = auto_inc {
                    if pk_col == ai_col && !values.contains_key(pk_col) {
                        // Use last_insert_id.
                        refetch_pk.insert(pk_col.clone(), JsonValue::Number(last_insert_id.into()));
                        continue;
                    }
                }
                if let Some(v) = values.get(pk_col) {
                    refetch_pk.insert(pk_col.clone(), v.clone());
                }
            }

            let row_vals =
                refetch_row(conn, schema, relation, pk_columns, &refetch_pk, meta).await?;

            Ok(RefreshedRow {
                op_index,
                pk: refetch_pk,
                row: row_vals,
                action: "inserted".into(),
            })
        }
        EditOp::Delete { pk } => {
            let pk_col_names: Vec<&str> = pk.keys().map(|s| s.as_str()).collect();
            let sql = build_delete_sql(schema, relation, &pk_col_names)?;

            let mut q = sqlx::query(&sql);
            for (col, val) in pk.iter() {
                let bk = meta
                    .bind_map
                    .get(col.as_str())
                    .unwrap_or(&BindKind::Unknown);
                q = bind_edit_value(q, val, bk)?;
            }
            q.execute(&mut *conn).await.map_err(map_sqlx_error)?;

            Ok(RefreshedRow {
                op_index,
                pk: pk.clone(),
                row: vec![],
                action: "deleted".into(),
            })
        }
    }
}

/// Re-fetch a single row by PK within the current transaction.
async fn refetch_row(
    conn: &mut sqlx::MySqlConnection,
    schema: &str,
    relation: &str,
    pk_columns: &[String],
    pk_values: &BTreeMap<String, JsonValue>,
    meta: &crate::modules::mysql::data::ColumnMeta,
) -> AppResult<Vec<JsonValue>> {
    if pk_columns.is_empty() || pk_values.is_empty() {
        return Ok(vec![]);
    }
    let sql = build_refetch_sql(schema, relation, pk_columns);
    let mut q = sqlx::query(&sql);
    for pk_col in pk_columns {
        let val = pk_values.get(pk_col).unwrap_or(&JsonValue::Null);
        let bk = meta.bind_map.get(pk_col).unwrap_or(&BindKind::Unknown);
        q = bind_edit_value(q, val, bk)?;
    }
    let row = q.fetch_optional(&mut *conn).await.map_err(map_sqlx_error)?;
    match row {
        Some(r) => {
            let (vals, _) = decode_refreshed_row(&r, &meta.infos, &meta.bind_map)?;
            Ok(vals)
        }
        None => Ok(vec![]),
    }
}

fn extract_code_message(err: &AppError) -> (Option<String>, String) {
    match err {
        AppError::Mysql(body) => (body.code.clone(), body.message.clone()),
        other => (None, other.to_string()),
    }
}

// ---------------------------------------------------------------------------
// §10.5 — mysql_table_primary_key
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mysql_table_primary_key(
    app: AppHandle,
    registry: State<'_, MysqlPoolRegistry>,
    id: Uuid,
    schema: String,
    relation: String,
    origin: Option<Origin>,
) -> AppResult<PrimaryKeyResult> {
    let started = Instant::now();
    let activity_origin = origin.unwrap_or_default();

    let inner: AppResult<PrimaryKeyResult> = async {
        let pool = registry.acquire(id)?;
        let mut conn = pool.acquire().await.map_err(map_sqlx_error)?;

        let pk_cols = fetch_pk_columns(&mut conn, &schema, &relation).await?;
        let auto_inc = fetch_auto_increment_column(&mut conn, &schema, &relation).await?;

        Ok(PrimaryKeyResult {
            columns: pk_cols,
            auto_increment_column: auto_inc,
        })
    }
    .await;

    let total_ms = started.elapsed().as_millis() as u64;
    let builder =
        ActivityLogEntryBuilder::new(ActivityKind::ListTableExtras, activity_origin, total_ms)
            .connection(id);
    match &inner {
        Ok(r) => emit_activity(
            &app,
            builder.ok(Some(Metric::Items {
                value: r.columns.len() as u32,
            })),
        ),
        Err(e) => emit_activity(&app, builder.err(e)),
    }
    inner
}

// ---------------------------------------------------------------------------
// §10.7 — Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mk_bind_map() -> std::collections::HashMap<String, BindKind> {
        let mut m = std::collections::HashMap::new();
        m.insert("id".into(), BindKind::Int);
        m.insert("name".into(), BindKind::VarChar);
        m.insert("data".into(), BindKind::Json);
        m.insert("geo".into(), BindKind::Geometry);
        m
    }

    fn no_json() -> std::collections::HashSet<String> {
        std::collections::HashSet::new()
    }

    fn json_set(cols: &[&str]) -> std::collections::HashSet<String> {
        cols.iter().map(|s| s.to_string()).collect()
    }

    // -----------------------------------------------------------------------
    // SQL builder tests
    // -----------------------------------------------------------------------

    #[test]
    fn build_update_basic() {
        let sql = build_update_sql("db", "users", &["name"], &["id"], &no_json()).unwrap();
        assert!(sql.contains("UPDATE `db`.`users`"), "sql: {sql}");
        assert!(sql.contains("SET `name` = ?"), "sql: {sql}");
        assert!(sql.contains("WHERE `id` = ?"), "sql: {sql}");
        assert!(!sql.contains("RETURNING"), "no RETURNING in MySQL: {sql}");
    }

    #[test]
    fn build_update_with_json_column_uses_cast() {
        let sql = build_update_sql("db", "t", &["data"], &["id"], &json_set(&["data"])).unwrap();
        assert!(sql.contains("CAST(? AS JSON)"), "sql: {sql}");
    }

    #[test]
    fn build_update_multi_changes() {
        let sql = build_update_sql("db", "t", &["a", "b"], &["id"], &no_json()).unwrap();
        assert!(
            sql.contains("`a` = ?") && sql.contains("`b` = ?"),
            "sql: {sql}"
        );
        assert!(sql.contains("WHERE `id` = ?"), "sql: {sql}");
    }

    #[test]
    fn build_update_composite_pk() {
        let sql =
            build_update_sql("db", "t", &["val"], &["tenant_id", "user_id"], &no_json()).unwrap();
        assert!(
            sql.contains("`tenant_id` = ?") && sql.contains("`user_id` = ?"),
            "sql: {sql}"
        );
    }

    #[test]
    fn build_update_empty_changes_rejected() {
        let err = build_update_sql("db", "t", &[], &["id"], &no_json()).unwrap_err();
        assert!(matches!(err, AppError::Validation(ref m) if m.contains("changes")));
    }

    #[test]
    fn build_update_empty_pk_rejected() {
        let err = build_update_sql("db", "t", &["name"], &[], &no_json()).unwrap_err();
        assert!(matches!(err, AppError::Validation(ref m) if m.contains("pk")));
    }

    #[test]
    fn build_insert_basic() {
        let sql = build_insert_sql("db", "users", &["name", "email"], &no_json()).unwrap();
        assert!(sql.contains("INSERT INTO `db`.`users`"), "sql: {sql}");
        assert!(
            sql.contains("`name`") && sql.contains("`email`"),
            "sql: {sql}"
        );
        assert!(sql.contains("VALUES"), "sql: {sql}");
        assert!(!sql.contains("RETURNING"), "no RETURNING in MySQL: {sql}");
    }

    #[test]
    fn build_insert_with_json_column() {
        let sql = build_insert_sql("db", "t", &["data"], &json_set(&["data"])).unwrap();
        assert!(sql.contains("CAST(? AS JSON)"), "sql: {sql}");
    }

    #[test]
    fn build_insert_empty_cols_rejected() {
        let err = build_insert_sql("db", "t", &[], &no_json()).unwrap_err();
        assert!(matches!(err, AppError::Validation(ref m) if m.contains("values")));
    }

    #[test]
    fn build_delete_basic() {
        let sql = build_delete_sql("db", "users", &["id"]).unwrap();
        assert!(sql.contains("DELETE FROM `db`.`users`"), "sql: {sql}");
        assert!(sql.contains("WHERE `id` = ?"), "sql: {sql}");
    }

    #[test]
    fn build_delete_composite_pk() {
        let sql = build_delete_sql("db", "t", &["tenant_id", "user_id"]).unwrap();
        assert!(
            sql.contains("`tenant_id` = ?") && sql.contains("`user_id` = ?"),
            "sql: {sql}"
        );
    }

    #[test]
    fn build_delete_empty_pk_rejected() {
        let err = build_delete_sql("db", "t", &[]).unwrap_err();
        assert!(matches!(err, AppError::Validation(ref m) if m.contains("pk")));
    }

    // -----------------------------------------------------------------------
    // Validation tests
    // -----------------------------------------------------------------------

    fn pk_cols(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn map_of(entries: &[(&str, JsonValue)]) -> BTreeMap<String, JsonValue> {
        let mut m = BTreeMap::new();
        for (k, v) in entries {
            m.insert((*k).to_string(), v.clone());
        }
        m
    }

    #[test]
    fn validate_update_ok() {
        let edits = vec![EditOp::Update {
            pk: map_of(&[("id", json!(1))]),
            changes: map_of(&[("name", json!("Alice"))]),
        }];
        assert!(validate_edits(&edits, &mk_bind_map(), &pk_cols(&["id"])).is_ok());
    }

    #[test]
    fn validate_update_missing_pk_col() {
        let edits = vec![EditOp::Update {
            pk: map_of(&[("id", json!(1))]),
            changes: map_of(&[("name", json!("Alice"))]),
        }];
        // pk_columns requires both tenant_id and id
        let err =
            validate_edits(&edits, &mk_bind_map(), &pk_cols(&["tenant_id", "id"])).unwrap_err();
        assert_eq!(err.0, 0);
        assert!(err.1.to_string().contains("tenant_id"));
    }

    #[test]
    fn validate_update_empty_pk_rejected() {
        let edits = vec![EditOp::Update {
            pk: BTreeMap::new(),
            changes: map_of(&[("name", json!("x"))]),
        }];
        let err = validate_edits(&edits, &mk_bind_map(), &pk_cols(&["id"])).unwrap_err();
        assert_eq!(err.0, 0);
        assert!(err.1.to_string().contains("empty"));
    }

    #[test]
    fn validate_update_empty_changes_rejected() {
        let edits = vec![EditOp::Update {
            pk: map_of(&[("id", json!(1))]),
            changes: BTreeMap::new(),
        }];
        let err = validate_edits(&edits, &mk_bind_map(), &pk_cols(&["id"])).unwrap_err();
        assert_eq!(err.0, 0);
        assert!(err.1.to_string().contains("changes"));
    }

    #[test]
    fn validate_update_unknown_column_rejected() {
        let edits = vec![EditOp::Update {
            pk: map_of(&[("id", json!(1))]),
            changes: map_of(&[("ghost", json!("x"))]),
        }];
        let err = validate_edits(&edits, &mk_bind_map(), &pk_cols(&["id"])).unwrap_err();
        assert_eq!(err.0, 0);
        assert!(err.1.to_string().contains("ghost"));
    }

    #[test]
    fn validate_geometry_in_changes_rejected() {
        let edits = vec![EditOp::Update {
            pk: map_of(&[("id", json!(1))]),
            changes: map_of(&[("geo", json!("POINT(1 2)"))]),
        }];
        let err = validate_edits(&edits, &mk_bind_map(), &pk_cols(&["id"])).unwrap_err();
        assert_eq!(err.0, 0);
        assert!(err.1.to_string().to_lowercase().contains("geometry"));
    }

    #[test]
    fn validate_insert_ok() {
        let edits = vec![EditOp::Insert {
            values: map_of(&[("name", json!("Alice"))]),
        }];
        assert!(validate_edits(&edits, &mk_bind_map(), &pk_cols(&["id"])).is_ok());
    }

    #[test]
    fn validate_insert_unknown_column_rejected() {
        let edits = vec![EditOp::Insert {
            values: map_of(&[("ghost", json!("x"))]),
        }];
        let err = validate_edits(&edits, &mk_bind_map(), &pk_cols(&["id"])).unwrap_err();
        assert!(err.1.to_string().contains("ghost"));
    }

    #[test]
    fn validate_insert_geometry_rejected() {
        let edits = vec![EditOp::Insert {
            values: map_of(&[("geo", json!("POINT(1 2)"))]),
        }];
        let err = validate_edits(&edits, &mk_bind_map(), &pk_cols(&["id"])).unwrap_err();
        assert!(err.1.to_string().to_lowercase().contains("geometry"));
    }

    #[test]
    fn validate_delete_ok() {
        let edits = vec![EditOp::Delete {
            pk: map_of(&[("id", json!(1))]),
        }];
        assert!(validate_edits(&edits, &mk_bind_map(), &pk_cols(&["id"])).is_ok());
    }

    #[test]
    fn validate_delete_missing_pk_col() {
        let edits = vec![EditOp::Delete {
            pk: map_of(&[("id", json!(1))]),
        }];
        let err =
            validate_edits(&edits, &mk_bind_map(), &pk_cols(&["tenant_id", "id"])).unwrap_err();
        assert!(err.1.to_string().contains("tenant_id"));
    }

    #[test]
    fn validate_delete_empty_pk_rejected() {
        let edits = vec![EditOp::Delete {
            pk: BTreeMap::new(),
        }];
        let err = validate_edits(&edits, &mk_bind_map(), &pk_cols(&["id"])).unwrap_err();
        assert!(err.1.to_string().contains("empty"));
    }

    // -----------------------------------------------------------------------
    // SQL builder — identifier quoting
    // -----------------------------------------------------------------------

    #[test]
    fn backtick_identifiers_in_update() {
        let sql =
            build_update_sql("my`db", "my`table", &["col`name"], &["id"], &no_json()).unwrap();
        assert!(sql.contains("`my``db`"), "sql: {sql}");
        assert!(sql.contains("`my``table`"), "sql: {sql}");
        assert!(sql.contains("`col``name`"), "sql: {sql}");
    }

    #[test]
    fn backtick_identifiers_in_insert() {
        let sql = build_insert_sql("db", "t", &["col`name"], &no_json()).unwrap();
        assert!(sql.contains("`col``name`"), "sql: {sql}");
    }

    #[test]
    fn backtick_identifiers_in_delete() {
        let sql = build_delete_sql("db", "t", &["col`id"]).unwrap();
        assert!(sql.contains("`col``id`"), "sql: {sql}");
    }

    // -----------------------------------------------------------------------
    // Refetch SQL builder
    // -----------------------------------------------------------------------

    #[test]
    fn refetch_sql_correct() {
        let sql = build_refetch_sql("db", "users", &["id".to_string()]);
        assert!(sql.starts_with("SELECT * FROM `db`.`users` WHERE"));
        assert!(sql.contains("`id` = ?"));
    }

    #[test]
    fn refetch_sql_composite_pk() {
        let sql = build_refetch_sql("db", "t", &["a".to_string(), "b".to_string()]);
        assert!(sql.contains("`a` = ?") && sql.contains("`b` = ?"));
    }
}
