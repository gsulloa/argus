//! Editable-table support: PK lookup, edit-SQL builder, preview command,
//! transactional apply command. Reuses the read-only flag check from
//! `PgPoolRegistry`, the `quote_ident` helper from `data`, and the same
//! 15s timeout + cancel-token pattern.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::{AppHandle, State};
use tokio::time::timeout;
use tokio_postgres::types::ToSql;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::postgres::binding::{bind_edit_value, ColumnTypeIndex};
use crate::modules::postgres::data::{
    fire_cancel, list_columns, process_row, quote_ident, DataColumn,
};
use crate::modules::postgres::pool::PgPoolRegistry;

/// Hard cap on the apply transaction. Mirrors the data-grid commands.
const QUERY_TIMEOUT: Duration = Duration::from_secs(15);
/// Cap on the concatenated SQL we forward to the activity log.
const APPLY_LOG_SQL_CAP_CHARS: usize = 4000;
const PARAM_TRUNCATE_MARKER: char = '…';

// --------------------------------------------------------------------------
// Edit op payload
// --------------------------------------------------------------------------

/// Discriminated union of edit operations the frontend can submit.
///
/// `pk` and `changes` / `values` use ordered maps for deterministic SQL
/// generation (consumers and tests don't have to care about HashMap iteration
/// order). All values flow as JSON and get bound as Postgres parameters.
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

// --------------------------------------------------------------------------
// SQL builder
// --------------------------------------------------------------------------

/// Build the parameterized SQL for one `EditOp`. UPDATE and INSERT wrap their
/// `RETURNING *` in `row_to_json(_argus_r)::text` so the apply command can
/// decode the refreshed row using the existing data-module pipeline.
///
/// Uses type-aware binding: each column's Postgres `data_type` drives whether
/// the value is bound as a native Rust primitive (plain `$N`) or as a `String`
/// with a server-side cast (`$N::<type>`). See `binding::bind_edit_value`.
///
/// Validation is performed inline:
/// - update: non-empty `pk` covering all PK columns, non-empty `changes`
/// - insert: non-empty `values`
/// - delete: non-empty `pk` covering all PK columns
/// - every referenced column MUST exist in `columns` (else `AppError::Validation`)
pub fn build_edit_sql(
    schema: &str,
    relation: &str,
    op: &EditOp,
    columns: &[DataColumn],
    pk_columns: &[String],
) -> AppResult<(String, Vec<Box<dyn ToSql + Sync + Send>>)> {
    let qualified = format!("{}.{}", quote_ident(schema), quote_ident(relation));
    let type_idx = ColumnTypeIndex::from_iter(
        columns
            .iter()
            .map(|c| (c.name.as_str(), c.data_type.as_str())),
    );

    match op {
        EditOp::Update { pk, changes } => {
            if changes.is_empty() {
                return Err(AppError::Validation("update op has empty `changes`".into()));
            }
            check_pk_coverage("update", pk, pk_columns)?;
            let mut params: Vec<Box<dyn ToSql + Sync + Send>> = Vec::new();

            let mut set_parts: Vec<String> = Vec::with_capacity(changes.len());
            for (col, val) in changes.iter() {
                let kind = type_idx.kind_for(col).ok_or_else(|| {
                    AppError::Validation(format!("unknown column \"{col}\" on {schema}.{relation}"))
                })?;
                let bound = bind_edit_value(val, col, kind)?;
                params.push(bound.value);
                set_parts.push(format!(
                    "{} = {}",
                    quote_ident(col),
                    bound.placeholder.render(params.len()),
                ));
            }

            let mut where_parts: Vec<String> = Vec::with_capacity(pk.len());
            for (col, val) in pk.iter() {
                let kind = type_idx.kind_for(col).ok_or_else(|| {
                    AppError::Validation(format!("unknown column \"{col}\" on {schema}.{relation}"))
                })?;
                let bound = bind_edit_value(val, col, kind)?;
                params.push(bound.value);
                where_parts.push(format!(
                    "{} = {}",
                    quote_ident(col),
                    bound.placeholder.render(params.len()),
                ));
            }

            let inner = format!(
                "UPDATE {qualified} SET {set} WHERE {wh} RETURNING *",
                set = set_parts.join(", "),
                wh = where_parts.join(" AND "),
            );
            let sql = format!(
                "WITH _argus_r AS ({inner}) \
                 SELECT row_to_json(_argus_r)::text FROM _argus_r"
            );
            Ok((sql, params))
        }
        EditOp::Insert { values } => {
            if values.is_empty() {
                return Err(AppError::Validation("insert op has empty `values`".into()));
            }
            let mut params: Vec<Box<dyn ToSql + Sync + Send>> = Vec::new();
            let mut col_parts: Vec<String> = Vec::with_capacity(values.len());
            let mut val_parts: Vec<String> = Vec::with_capacity(values.len());
            for (col, val) in values.iter() {
                let kind = type_idx.kind_for(col).ok_or_else(|| {
                    AppError::Validation(format!("unknown column \"{col}\" on {schema}.{relation}"))
                })?;
                let bound = bind_edit_value(val, col, kind)?;
                params.push(bound.value);
                col_parts.push(quote_ident(col));
                val_parts.push(bound.placeholder.render(params.len()));
            }
            let inner = format!(
                "INSERT INTO {qualified} ({cols}) VALUES ({vals}) RETURNING *",
                cols = col_parts.join(", "),
                vals = val_parts.join(", "),
            );
            let sql = format!(
                "WITH _argus_r AS ({inner}) \
                 SELECT row_to_json(_argus_r)::text FROM _argus_r"
            );
            Ok((sql, params))
        }
        EditOp::Delete { pk } => {
            check_pk_coverage("delete", pk, pk_columns)?;
            let mut params: Vec<Box<dyn ToSql + Sync + Send>> = Vec::new();
            let mut where_parts: Vec<String> = Vec::with_capacity(pk.len());
            for (col, val) in pk.iter() {
                let kind = type_idx.kind_for(col).ok_or_else(|| {
                    AppError::Validation(format!("unknown column \"{col}\" on {schema}.{relation}"))
                })?;
                let bound = bind_edit_value(val, col, kind)?;
                params.push(bound.value);
                where_parts.push(format!(
                    "{} = {}",
                    quote_ident(col),
                    bound.placeholder.render(params.len()),
                ));
            }
            let sql = format!(
                "DELETE FROM {qualified} WHERE {wh}",
                wh = where_parts.join(" AND "),
            );
            Ok((sql, params))
        }
    }
}

fn check_pk_coverage(
    op_label: &str,
    pk: &BTreeMap<String, JsonValue>,
    pk_columns: &[String],
) -> AppResult<()> {
    if pk.is_empty() {
        return Err(AppError::Validation(format!(
            "{op_label} op has empty `pk`"
        )));
    }
    if !pk_columns.is_empty() {
        let missing: Vec<&String> = pk_columns.iter().filter(|c| !pk.contains_key(*c)).collect();
        if !missing.is_empty() {
            let joined = missing
                .iter()
                .map(|s| format!("\"{}\"", s))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(AppError::Validation(format!(
                "{op_label} op missing PK column(s): {joined}"
            )));
        }
    }
    Ok(())
}

// --------------------------------------------------------------------------
// Param formatting for the activity log
// --------------------------------------------------------------------------

fn truncate_with_marker(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max_chars).collect();
    out.push(PARAM_TRUNCATE_MARKER);
    out
}

// --------------------------------------------------------------------------
// Primary key + enum metadata command
// --------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct TableEditMetadata {
    pub pk_columns: Option<Vec<String>>,
    pub enums: BTreeMap<String, Vec<String>>,
}

const SQL_PK_LOOKUP: &str = "\
SELECT a.attname
FROM pg_catalog.pg_index i
JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute a
  ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
WHERE n.nspname = $1
  AND c.relname = $2
  AND i.indisprimary
ORDER BY array_position(i.indkey, a.attnum)";

const SQL_ENUM_LOOKUP: &str = "\
SELECT a.attname,
       e.enumlabel
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
WHERE n.nspname = $1
  AND c.relname = $2
  AND a.attnum > 0
  AND NOT a.attisdropped
  AND t.typcategory = 'E'
ORDER BY a.attnum, e.enumsortorder";

#[tauri::command]
pub async fn postgres_table_primary_key(
    app: AppHandle,
    pools: State<'_, PgPoolRegistry>,
    id: String,
    schema: String,
    relation: String,
    origin: Option<Origin>,
) -> AppResult<TableEditMetadata> {
    let started = Instant::now();
    let activity_origin = origin.unwrap_or_default();
    let parsed =
        Uuid::parse_str(&id).map_err(|e| AppError::Validation(format!("bad uuid: {e}")))?;

    let inner: AppResult<TableEditMetadata> = async {
        let sslmode = pools.sslmode_for(&parsed).await?;
        let client = pools.acquire(&parsed).await?;
        let cancel_token = client.cancel_token();

        // PK lookup.
        let pk_rows = match timeout(
            QUERY_TIMEOUT,
            client.query(SQL_PK_LOOKUP, &[&schema, &relation]),
        )
        .await
        {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => return Err(AppError::from(e)),
            Err(_) => {
                fire_cancel(cancel_token, sslmode).await;
                drop(client);
                return Err(AppError::postgres_with_code(
                    "57014",
                    format!("pk lookup timed out ({}s)", QUERY_TIMEOUT.as_secs()),
                ));
            }
        };
        let pk_columns: Option<Vec<String>> = if pk_rows.is_empty() {
            None
        } else {
            Some(pk_rows.iter().map(|r| r.get::<_, String>(0)).collect())
        };

        // Enum lookup.
        let enum_rows = client.query(SQL_ENUM_LOOKUP, &[&schema, &relation]).await?;
        let mut enums: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for row in enum_rows {
            let col: String = row.get(0);
            let label: String = row.get(1);
            enums.entry(col).or_default().push(label);
        }

        Ok(TableEditMetadata { pk_columns, enums })
    }
    .await;

    let total_ms = started.elapsed().as_millis() as u64;
    let builder =
        ActivityLogEntryBuilder::new(ActivityKind::ListTableExtras, activity_origin, total_ms)
            .connection(parsed);
    match &inner {
        Ok(r) => {
            let count = r.pk_columns.as_ref().map(|v| v.len()).unwrap_or(0) + r.enums.len();
            emit_activity(
                &app,
                builder.ok(Some(Metric::Items {
                    value: count as u32,
                })),
            );
        }
        Err(e) => emit_activity(&app, builder.err(e)),
    }
    inner
}

// --------------------------------------------------------------------------
// Apply command (transactional commit)
// --------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct RefreshedRow {
    pub pk: BTreeMap<String, JsonValue>,
    pub row: Option<Vec<JsonValue>>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ApplyEditsOutcome {
    /// All edits committed successfully.
    Ok {
        committed: usize,
        refreshed_rows: Vec<RefreshedRow>,
        query_ms: u64,
    },
    /// One of the ops failed during the transaction; ROLLBACK was issued.
    /// Distinct from `AppError::Validation` (read-only / shape) which surfaces
    /// as a thrown error to the frontend.
    OpFailed {
        code: Option<String>,
        message: String,
        failed_op_index: usize,
    },
}

#[tauri::command]
pub async fn postgres_apply_table_edits(
    app: AppHandle,
    pools: State<'_, PgPoolRegistry>,
    id: String,
    schema: String,
    relation: String,
    edits: Vec<EditOp>,
    origin: Option<Origin>,
) -> AppResult<ApplyEditsOutcome> {
    let started = Instant::now();
    let activity_origin = origin.unwrap_or_default();
    let parsed =
        Uuid::parse_str(&id).map_err(|e| AppError::Validation(format!("bad uuid: {e}")))?;

    if edits.is_empty() {
        return Err(AppError::Validation("no edits to apply".into()));
    }

    // We accumulate the concatenated SQL text for the activity log, regardless
    // of whether the apply succeeds or fails. Reset by scope; tracked across
    // the inner async block via captured locals.
    let mut emitted_sql: Option<String> = None;

    let inner: AppResult<(ApplyEditsOutcome, u64)> = async {
        // Read-only short-circuit.
        let summaries = pools.list_active().await;
        let pool_entry = summaries
            .into_iter()
            .find(|s| s.id == parsed)
            .ok_or_else(|| AppError::NotFound(format!("no active pool for {parsed}")))?;
        if pool_entry.read_only {
            return Err(AppError::Validation("connection is read-only".into()));
        }

        let sslmode = pools.sslmode_for(&parsed).await?;
        let client = pools.acquire(&parsed).await?;
        let cancel_token = client.cancel_token();

        // PK lookup once for validation + refreshed_rows pk extraction.
        let pk_rows = client.query(SQL_PK_LOOKUP, &[&schema, &relation]).await?;
        let pk_columns: Vec<String> = pk_rows.iter().map(|r| r.get::<_, String>(0)).collect();

        // Column metadata once for refreshed_rows decoding AND for the SQL
        // builder's per-placeholder cast types.
        let columns: Vec<DataColumn> = list_columns(&client, &schema, &relation).await?;

        // Pre-build all SQL+params so a builder error fails the whole call
        // before any BEGIN. Validation errors here surface as AppError, not
        // as a transaction OpFailed.
        let mut built: Vec<(String, Vec<Box<dyn ToSql + Sync + Send>>)> =
            Vec::with_capacity(edits.len());
        for op in edits.iter() {
            built.push(build_edit_sql(
                &schema,
                &relation,
                op,
                &columns,
                &pk_columns,
            )?);
        }

        // Activity-log SQL: concatenate all op SQLs, separated by "; ", capped.
        let joined = built
            .iter()
            .map(|(s, _)| s.as_str())
            .collect::<Vec<_>>()
            .join("; ");
        emitted_sql = Some(truncate_with_marker(&joined, APPLY_LOG_SQL_CAP_CHARS));

        // The whole transaction runs inside a single timeout window. Return
        // both the outcome and the running row-count so the outer activity
        // log can populate `metric.rows` accurately.
        let work = async {
            client.batch_execute("BEGIN").await?;

            let mut refreshed_rows: Vec<RefreshedRow> = Vec::new();
            let mut truncated_columns: Vec<String> = Vec::new();
            let mut rows_affected: u64 = 0;

            for (idx, ((sql, params), op)) in built.iter().zip(edits.iter()).enumerate() {
                let param_refs: Vec<&(dyn ToSql + Sync)> = params
                    .iter()
                    .map(|b| b.as_ref() as &(dyn ToSql + Sync))
                    .collect();

                match op {
                    EditOp::Update { .. } | EditOp::Insert { .. } => {
                        let row_result = client.query(sql, &param_refs).await;
                        match row_result {
                            Ok(rows) => {
                                rows_affected += rows.len() as u64;
                                if let Some(row) = rows.first() {
                                    let json_text: String = row.get(0);
                                    let processed =
                                        process_row(&json_text, &columns, &mut truncated_columns)?;
                                    let pk_map =
                                        extract_pk_from_row(&columns, &processed, &pk_columns);
                                    refreshed_rows.push(RefreshedRow {
                                        pk: pk_map,
                                        row: Some(processed),
                                    });
                                } else {
                                    // No row returned (likely an UPDATE that
                                    // matched zero rows).
                                    let pk_map: BTreeMap<String, JsonValue> = match op {
                                        EditOp::Update { pk, .. } => pk.clone(),
                                        _ => BTreeMap::new(),
                                    };
                                    refreshed_rows.push(RefreshedRow {
                                        pk: pk_map,
                                        row: None,
                                    });
                                }
                            }
                            Err(e) => {
                                let _ = client.batch_execute("ROLLBACK").await;
                                let app_err = AppError::from(e);
                                let (code, message) = match &app_err {
                                    AppError::Postgres(b) => (b.code.clone(), b.message.clone()),
                                    other => (None, other.to_string()),
                                };
                                return Ok::<_, AppError>((
                                    ApplyEditsOutcome::OpFailed {
                                        code,
                                        message,
                                        failed_op_index: idx,
                                    },
                                    rows_affected,
                                ));
                            }
                        }
                    }
                    EditOp::Delete { .. } => match client.execute(sql, &param_refs).await {
                        Ok(n) => rows_affected += n,
                        Err(e) => {
                            let _ = client.batch_execute("ROLLBACK").await;
                            let app_err = AppError::from(e);
                            let (code, message) = match &app_err {
                                AppError::Postgres(b) => (b.code.clone(), b.message.clone()),
                                other => (None, other.to_string()),
                            };
                            return Ok::<_, AppError>((
                                ApplyEditsOutcome::OpFailed {
                                    code,
                                    message,
                                    failed_op_index: idx,
                                },
                                rows_affected,
                            ));
                        }
                    },
                }
            }

            client.batch_execute("COMMIT").await?;
            let query_ms = started.elapsed().as_millis() as u64;
            Ok((
                ApplyEditsOutcome::Ok {
                    committed: edits.len(),
                    refreshed_rows,
                    query_ms,
                },
                rows_affected,
            ))
        };

        match timeout(QUERY_TIMEOUT, work).await {
            Ok(r) => r,
            Err(_) => {
                fire_cancel(cancel_token, sslmode).await;
                drop(client);
                Err(AppError::postgres_with_code(
                    "57014",
                    format!("apply edits timed out ({}s)", QUERY_TIMEOUT.as_secs()),
                ))
            }
        }
    }
    .await;

    let total_ms = started.elapsed().as_millis() as u64;
    let mut builder =
        ActivityLogEntryBuilder::new(ActivityKind::ApplyEdits, activity_origin, total_ms)
            .connection(parsed);
    if let Some(sql) = emitted_sql {
        builder = builder.sql(sql);
    }
    let outcome_result: AppResult<ApplyEditsOutcome> = match inner {
        Ok((
            ApplyEditsOutcome::Ok {
                committed,
                refreshed_rows,
                query_ms,
            },
            rows_affected,
        )) => {
            emit_activity(
                &app,
                builder.ok(Some(Metric::Rows {
                    value: rows_affected,
                })),
            );
            Ok(ApplyEditsOutcome::Ok {
                committed,
                refreshed_rows,
                query_ms,
            })
        }
        Ok((
            ApplyEditsOutcome::OpFailed {
                code,
                message,
                failed_op_index,
            },
            _rows_affected,
        )) => {
            let synth = if let Some(c) = &code {
                AppError::postgres_with_code(c.clone(), message.clone())
            } else {
                AppError::postgres(message.clone())
            };
            emit_activity(&app, builder.err(&synth));
            Ok(ApplyEditsOutcome::OpFailed {
                code,
                message,
                failed_op_index,
            })
        }
        Err(e) => {
            emit_activity(&app, builder.err(&e));
            Err(e)
        }
    };
    outcome_result
}

fn extract_pk_from_row(
    columns: &[DataColumn],
    processed: &[JsonValue],
    pk_columns: &[String],
) -> BTreeMap<String, JsonValue> {
    let mut out: BTreeMap<String, JsonValue> = BTreeMap::new();
    for col_name in pk_columns {
        if let Some(idx) = columns.iter().position(|c| &c.name == col_name) {
            if let Some(v) = processed.get(idx) {
                out.insert(col_name.clone(), v.clone());
            }
        }
    }
    out
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    fn columns_of(entries: &[(&str, &str)]) -> Vec<DataColumn> {
        entries
            .iter()
            .enumerate()
            .map(|(i, (name, dtype))| DataColumn {
                name: (*name).to_string(),
                data_type: (*dtype).to_string(),
                ordinal_position: (i + 1) as i32,
                is_nullable: true,
            })
            .collect()
    }

    #[test]
    fn build_update_native_columns_emit_plain_placeholders() {
        let op = EditOp::Update {
            pk: map_of(&[("id", json!(1))]),
            changes: map_of(&[("name", json!("ana"))]),
        };
        let cols = columns_of(&[("id", "bigint"), ("name", "text")]);
        let (sql, params) =
            build_edit_sql("public", "users", &op, &cols, &pk_cols(&["id"])).unwrap();
        assert!(sql.contains("UPDATE \"public\".\"users\""));
        assert!(sql.contains("SET \"name\" = $1"), "sql: {sql}");
        assert!(!sql.contains("$1::"), "no cast expected for text: {sql}");
        assert!(sql.contains("WHERE \"id\" = $2"), "sql: {sql}");
        assert!(!sql.contains("$2::"), "no cast expected for bigint: {sql}");
        assert!(sql.contains("RETURNING *"));
        assert!(sql.contains("WITH _argus_r AS"));
        assert_eq!(params.len(), 2);
    }

    #[test]
    fn build_update_multi_column_alphabetized() {
        let op = EditOp::Update {
            pk: map_of(&[("id", json!(1))]),
            changes: map_of(&[
                ("name", json!("ana")),
                ("email", json!("a@b.com")),
                ("age", json!(30)),
            ]),
        };
        let cols = columns_of(&[
            ("id", "integer"),
            ("name", "text"),
            ("email", "text"),
            ("age", "integer"),
        ]);
        let (sql, params) =
            build_edit_sql("public", "users", &op, &cols, &pk_cols(&["id"])).unwrap();
        // BTreeMap iterates alphabetically: age, email, name.
        let age_pos = sql.find("\"age\"").unwrap();
        let email_pos = sql.find("\"email\"").unwrap();
        let name_pos = sql.find("\"name\"").unwrap();
        assert!(age_pos < email_pos);
        assert!(email_pos < name_pos);
        // All columns are native-bind kinds (integer/text) — no parameter casts.
        assert!(
            !sql.contains("$1::")
                && !sql.contains("$2::")
                && !sql.contains("$3::")
                && !sql.contains("$4::"),
            "no param casts expected: {sql}"
        );
        assert_eq!(params.len(), 4);
    }

    #[test]
    fn build_update_with_empty_changes_rejected() {
        let op = EditOp::Update {
            pk: map_of(&[("id", json!(1))]),
            changes: BTreeMap::new(),
        };
        let cols = columns_of(&[("id", "integer")]);
        let err = build_edit_sql("public", "users", &op, &cols, &pk_cols(&["id"])).unwrap_err();
        assert!(matches!(err, AppError::Validation(ref m) if m.contains("changes")));
    }

    #[test]
    fn build_update_missing_pk_column_rejected() {
        let op = EditOp::Update {
            pk: map_of(&[("user_id", json!(7))]),
            changes: map_of(&[("name", json!("x"))]),
        };
        let cols = columns_of(&[
            ("tenant_id", "integer"),
            ("user_id", "integer"),
            ("name", "text"),
        ]);
        let err = build_edit_sql(
            "public",
            "t",
            &op,
            &cols,
            &pk_cols(&["tenant_id", "user_id"]),
        )
        .unwrap_err();
        match err {
            AppError::Validation(m) => assert!(m.contains("tenant_id"), "msg was: {m}"),
            other => panic!("expected validation, got {other:?}"),
        }
    }

    #[test]
    fn build_update_unknown_column_rejected() {
        let op = EditOp::Update {
            pk: map_of(&[("id", json!(1))]),
            changes: map_of(&[("ghost", json!("x"))]),
        };
        let cols = columns_of(&[("id", "integer")]);
        let err = build_edit_sql("public", "t", &op, &cols, &pk_cols(&["id"])).unwrap_err();
        match err {
            AppError::Validation(m) => assert!(m.contains("ghost"), "msg: {m}"),
            other => panic!("expected validation, got {other:?}"),
        }
    }

    #[test]
    fn build_insert_text_column_no_cast() {
        let op = EditOp::Insert {
            values: map_of(&[("name", json!("ana"))]),
        };
        let cols = columns_of(&[("id", "bigint"), ("name", "text")]);
        let (sql, params) = build_edit_sql("public", "users", &op, &cols, &[]).unwrap();
        assert!(sql.contains("INSERT INTO \"public\".\"users\" (\"name\")"));
        assert!(sql.contains("VALUES ($1)"), "sql: {sql}");
        assert!(!sql.contains("$1::"), "no cast for text: {sql}");
        assert!(sql.contains("RETURNING *"));
        assert_eq!(params.len(), 1);
    }

    #[test]
    fn build_insert_empty_values_rejected() {
        let op = EditOp::Insert {
            values: BTreeMap::new(),
        };
        let cols = columns_of(&[("name", "text")]);
        let err = build_edit_sql("public", "t", &op, &cols, &[]).unwrap_err();
        assert!(matches!(err, AppError::Validation(ref m) if m.contains("values")));
    }

    #[test]
    fn build_delete_integer_pk_no_cast() {
        let op = EditOp::Delete {
            pk: map_of(&[("tenant_id", json!(5)), ("user_id", json!(7))]),
        };
        let cols = columns_of(&[("tenant_id", "integer"), ("user_id", "integer")]);
        let (sql, params) = build_edit_sql(
            "public",
            "t",
            &op,
            &cols,
            &pk_cols(&["tenant_id", "user_id"]),
        )
        .unwrap();
        assert!(sql.contains("DELETE FROM \"public\".\"t\""));
        assert!(
            sql.contains("WHERE \"tenant_id\" = $1 AND \"user_id\" = $2"),
            "sql: {sql}"
        );
        assert!(!sql.contains("::"), "no casts for integer: {sql}");
        assert!(!sql.contains("RETURNING"));
        assert_eq!(params.len(), 2);
    }

    #[test]
    fn build_delete_empty_pk_rejected() {
        let op = EditOp::Delete {
            pk: BTreeMap::new(),
        };
        let err = build_edit_sql("public", "t", &op, &[], &[]).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn build_quotes_pathological_identifiers() {
        let op = EditOp::Insert {
            values: map_of(&[("we\"ird", json!("v"))]),
        };
        let cols = columns_of(&[("we\"ird", "text")]);
        let (sql, _params) = build_edit_sql("we\"ird", "we\"ird_t", &op, &cols, &[]).unwrap();
        assert!(
            sql.contains("\"we\"\"ird\".\"we\"\"ird_t\""),
            "sql was: {sql}"
        );
        assert!(sql.contains("(\"we\"\"ird\")"));
    }

    #[test]
    fn null_on_integer_column_binds_typed_none() {
        let op = EditOp::Update {
            pk: map_of(&[("id", json!(1))]),
            changes: map_of(&[("age", JsonValue::Null)]),
        };
        let cols = columns_of(&[("id", "bigint"), ("age", "integer")]);
        let (sql, params) = build_edit_sql("public", "t", &op, &cols, &pk_cols(&["id"])).unwrap();
        // Integer columns use a plain placeholder (no cast) — the boxed value
        // is Option::<i32>::None, which tokio-postgres sends as a NULL of OID int4.
        // The runtime type is verified by integration tests against real Postgres.
        assert!(sql.contains("\"age\" = $1"), "sql: {sql}");
        assert!(!sql.contains("$1::"), "no cast for integer null: {sql}");
        assert_eq!(params.len(), 2);
    }

    #[test]
    fn build_update_jsonb_column_binds_native() {
        let op = EditOp::Update {
            pk: map_of(&[("id", json!(1))]),
            changes: map_of(&[("metadata", json!({"a": 1}))]),
        };
        let cols = columns_of(&[("id", "integer"), ("metadata", "jsonb")]);
        let (sql, params) =
            build_edit_sql("market", "product", &op, &cols, &pk_cols(&["id"])).unwrap();
        assert!(sql.contains("SET \"metadata\" = $1 "), "sql: {sql}");
        assert!(sql.contains("WHERE \"id\" = $2 "), "sql: {sql}");
        assert!(!sql.contains("$1::"), "jsonb binds native, no cast: {sql}");
        assert!(!sql.contains("$2::"), "no cast for integer: {sql}");
        assert_eq!(params.len(), 2);
    }

    #[test]
    fn build_update_jsonb_null() {
        let op = EditOp::Update {
            pk: map_of(&[("id", json!(1))]),
            changes: map_of(&[("metadata", JsonValue::Null)]),
        };
        let cols = columns_of(&[("id", "integer"), ("metadata", "jsonb")]);
        let (sql, params) =
            build_edit_sql("market", "product", &op, &cols, &pk_cols(&["id"])).unwrap();
        assert!(sql.contains("SET \"metadata\" = $1 "), "sql: {sql}");
        assert!(!sql.contains("$1::"), "jsonb null binds native: {sql}");
        assert_eq!(params.len(), 2);
    }

    #[test]
    fn build_update_uuid_column_double_casts() {
        let uuid_val = "550e8400-e29b-41d4-a716-446655440000";
        let op = EditOp::Update {
            pk: map_of(&[("id", json!(uuid_val))]),
            changes: map_of(&[("ext_id", json!(uuid_val))]),
        };
        let cols = columns_of(&[("id", "uuid"), ("ext_id", "uuid")]);
        let (sql, params) = build_edit_sql("public", "t", &op, &cols, &pk_cols(&["id"])).unwrap();
        assert!(
            sql.contains("SET \"ext_id\" = $1::text::uuid"),
            "sql: {sql}"
        );
        assert!(sql.contains("WHERE \"id\" = $2::text::uuid"), "sql: {sql}");
        assert_eq!(params.len(), 2);
    }

    #[test]
    fn build_update_timestamptz_column_double_casts() {
        let op = EditOp::Update {
            pk: map_of(&[("id", json!(1))]),
            changes: map_of(&[("created_at", json!("2024-01-01T00:00:00Z"))]),
        };
        let cols = columns_of(&[
            ("id", "integer"),
            ("created_at", "timestamp with time zone"),
        ]);
        let (sql, params) = build_edit_sql("public", "t", &op, &cols, &pk_cols(&["id"])).unwrap();
        assert!(
            sql.contains("SET \"created_at\" = $1::text::timestamptz"),
            "sql: {sql}"
        );
        assert_eq!(params.len(), 2);
    }

    #[test]
    fn build_update_structured_value_on_text_column_rejected() {
        let op = EditOp::Update {
            pk: map_of(&[("id", json!(1))]),
            changes: map_of(&[("name", json!({"x": 1}))]),
        };
        let cols = columns_of(&[("id", "integer"), ("name", "text")]);
        let err = build_edit_sql("public", "t", &op, &cols, &pk_cols(&["id"])).unwrap_err();
        match err {
            AppError::Validation(msg) => {
                assert!(msg.contains("name"), "msg: {msg}");
                assert!(msg.contains("text"), "msg: {msg}");
            }
            other => panic!("expected validation, got {other:?}"),
        }
    }

    #[test]
    fn build_update_out_of_range_int_rejected() {
        let op = EditOp::Update {
            pk: map_of(&[("id", json!(1))]),
            changes: map_of(&[("count", json!(999_999_999_999_i64))]),
        };
        let cols = columns_of(&[("id", "integer"), ("count", "smallint")]);
        let err = build_edit_sql("public", "t", &op, &cols, &pk_cols(&["id"])).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn truncate_marker_appended_when_over_cap() {
        let cap = 200;
        let s: String = std::iter::repeat('x').take(cap + 5).collect();
        let out = truncate_with_marker(&s, cap);
        assert!(out.ends_with('…'));
        assert_eq!(out.chars().count(), cap + 1);
    }

}
