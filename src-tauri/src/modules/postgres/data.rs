use std::time::{Duration, Instant};

use deadpool_postgres::Object as PgObject;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::State;
use tokio::time::timeout;
use tokio_postgres::types::ToSql;
use tokio_postgres::NoTls;
use tokio_postgres_rustls::MakeRustlsConnect;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::postgres::params::SslMode;
use crate::modules::postgres::pool::PgPoolRegistry;
use crate::modules::postgres::tls::client_config_for;

/// Hard cap on a single `postgres_query_table` / `postgres_count_table` call.
/// Mirrors the schema browser's `LIST_OBJECTS_TIMEOUT`.
const QUERY_TIMEOUT: Duration = Duration::from_secs(15);
/// Sanity bound on per-call page size — the frontend selector tops out at 1000;
/// we accept up to 5x that as headroom while still preventing runaway requests.
const MAX_LIMIT: i64 = 5000;
/// Cells whose JSON-string length exceeds this threshold are returned as a
/// `truncated` envelope instead of the full value (`bytea` always becomes a
/// `binary` envelope regardless of size).
const TRUNCATE_BYTES: usize = 1_048_576;

#[derive(Debug, Clone, Serialize)]
pub struct DataColumn {
    pub name: String,
    pub data_type: String,
    pub ordinal_position: i32,
    pub is_nullable: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderBy {
    pub column: String,
    pub direction: SortDirection,
}

/// Filter predicate accepted by the data-grid commands. The `op` field
/// discriminates the variant and matches the operator surface promised by the
/// `postgres-data-grid` spec. Any unknown op is rejected at deserialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum Filter {
    #[serde(rename = "=")]
    Eq { column: String, value: JsonValue },
    #[serde(rename = "!=")]
    Ne { column: String, value: JsonValue },
    #[serde(rename = "<")]
    Lt { column: String, value: JsonValue },
    #[serde(rename = "<=")]
    Le { column: String, value: JsonValue },
    #[serde(rename = ">")]
    Gt { column: String, value: JsonValue },
    #[serde(rename = ">=")]
    Ge { column: String, value: JsonValue },
    #[serde(rename = "LIKE")]
    Like { column: String, value: JsonValue },
    #[serde(rename = "NOT LIKE")]
    NotLike { column: String, value: JsonValue },
    #[serde(rename = "IS NULL")]
    IsNull { column: String },
    #[serde(rename = "IS NOT NULL")]
    IsNotNull { column: String },
    #[serde(rename = "BETWEEN")]
    Between {
        column: String,
        min: JsonValue,
        max: JsonValue,
    },
}

#[derive(Debug, Deserialize)]
pub struct QueryTableOptions {
    pub limit: i64,
    pub offset: i64,
    #[serde(default)]
    pub order_by: Vec<OrderBy>,
    #[serde(default)]
    pub filters: Vec<Filter>,
}

#[derive(Debug, Serialize)]
pub struct AppliedQuery {
    pub limit: i64,
    pub offset: i64,
    pub order_by: Vec<OrderBy>,
    pub filters: Vec<Filter>,
}

#[derive(Debug, Serialize)]
pub struct QueryTableResult {
    pub columns: Vec<DataColumn>,
    pub rows: Vec<Vec<JsonValue>>,
    pub applied: AppliedQuery,
    pub query_ms: u64,
    pub truncated_columns: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct CountTableResult {
    pub count: i64,
    pub query_ms: u64,
}

/// Quote a Postgres identifier following the standard double-quote rule:
/// wrap in `"` and double any internal `"`. Always-quoted: avoids any case
/// folding or keyword collisions, and renders mixed-case names correctly.
pub(crate) fn quote_ident(s: &str) -> String {
    let escaped = s.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

/// Convert a JSON filter value to an owned `ToSql` parameter. We bind with
/// the JSON value's natural Rust type (bool/i64/f64/String) and let Postgres
/// implicit-cast where possible. Types that need explicit casting (uuid,
/// dates, …) will surface a Postgres error to the user, who can fall back
/// to the SQL editor (#6) for those columns. `null` is rejected — the
/// caller MUST use `IS NULL` / `IS NOT NULL` instead.
fn json_to_param(v: &JsonValue) -> AppResult<Box<dyn ToSql + Sync + Send>> {
    match v {
        JsonValue::Null => Err(AppError::Validation(
            "null filter value not allowed; use IS NULL / IS NOT NULL".into(),
        )),
        JsonValue::Bool(b) => Ok(Box::new(*b)),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(Box::new(i))
            } else if let Some(f) = n.as_f64() {
                Ok(Box::new(f))
            } else {
                Err(AppError::Validation(format!(
                    "unsupported number literal: {n}"
                )))
            }
        }
        JsonValue::String(s) => Ok(Box::new(s.clone())),
        JsonValue::Array(_) | JsonValue::Object(_) => Err(AppError::Validation(
            "array/object filter values are not supported".into(),
        )),
    }
}

fn placeholder_for(idx: usize) -> String {
    format!("${idx}")
}

fn binary_predicate(
    col: &str,
    op_sql: &str,
    val: &JsonValue,
    params: &mut Vec<Box<dyn ToSql + Sync + Send>>,
) -> AppResult<String> {
    let p = json_to_param(val)?;
    params.push(p);
    Ok(format!(
        "{} {} {}",
        quote_ident(col),
        op_sql,
        placeholder_for(params.len())
    ))
}

fn predicate_for(
    f: &Filter,
    params: &mut Vec<Box<dyn ToSql + Sync + Send>>,
) -> AppResult<String> {
    match f {
        Filter::Eq { column, value } => binary_predicate(column, "=", value, params),
        Filter::Ne { column, value } => binary_predicate(column, "<>", value, params),
        Filter::Lt { column, value } => binary_predicate(column, "<", value, params),
        Filter::Le { column, value } => binary_predicate(column, "<=", value, params),
        Filter::Gt { column, value } => binary_predicate(column, ">", value, params),
        Filter::Ge { column, value } => binary_predicate(column, ">=", value, params),
        Filter::Like { column, value } => binary_predicate(column, "LIKE", value, params),
        Filter::NotLike { column, value } => binary_predicate(column, "NOT LIKE", value, params),
        Filter::IsNull { column } => Ok(format!("{} IS NULL", quote_ident(column))),
        Filter::IsNotNull { column } => Ok(format!("{} IS NOT NULL", quote_ident(column))),
        Filter::Between { column, min, max } => {
            let pmin = json_to_param(min)?;
            params.push(pmin);
            let ph_min = placeholder_for(params.len());
            let pmax = json_to_param(max)?;
            params.push(pmax);
            let ph_max = placeholder_for(params.len());
            Ok(format!(
                "{} BETWEEN {} AND {}",
                quote_ident(column),
                ph_min,
                ph_max
            ))
        }
    }
}

fn build_where_clause(
    filters: &[Filter],
    params: &mut Vec<Box<dyn ToSql + Sync + Send>>,
) -> AppResult<String> {
    if filters.is_empty() {
        return Ok(String::new());
    }
    let mut parts = Vec::with_capacity(filters.len());
    for f in filters {
        parts.push(predicate_for(f, params)?);
    }
    Ok(format!(" WHERE {}", parts.join(" AND ")))
}

fn build_order_clause(order: &[OrderBy]) -> String {
    if order.is_empty() {
        return String::new();
    }
    let parts: Vec<String> = order
        .iter()
        .map(|o| {
            let dir = match o.direction {
                SortDirection::Asc => "ASC",
                SortDirection::Desc => "DESC",
            };
            format!("{} {}", quote_ident(&o.column), dir)
        })
        .collect();
    format!(" ORDER BY {}", parts.join(", "))
}

/// Builds the parameterized `SELECT` for a paginated table read. The result
/// SQL wraps the inner read in `row_to_json(_argus_t)::text` so the rust
/// side can decode every cell uniformly without having a custom `FromSql`
/// for every Postgres type — at the small cost of one extra catalog
/// per-column lookup which we do separately for the `columns` payload.
pub(crate) fn build_select_sql(
    schema: &str,
    relation: &str,
    order: &[OrderBy],
    filters: &[Filter],
    limit: i64,
    offset: i64,
) -> AppResult<(String, Vec<Box<dyn ToSql + Sync + Send>>)> {
    let mut params: Vec<Box<dyn ToSql + Sync + Send>> = Vec::new();
    let where_sql = build_where_clause(filters, &mut params)?;
    let order_sql = build_order_clause(order);
    let from = format!("{}.{}", quote_ident(schema), quote_ident(relation));
    let sql = format!(
        "SELECT row_to_json(_argus_t)::text AS data \
         FROM (SELECT * FROM {from}{where_sql}{order_sql} LIMIT {limit} OFFSET {offset}) AS _argus_t"
    );
    Ok((sql, params))
}

pub(crate) fn build_count_sql(
    schema: &str,
    relation: &str,
    filters: &[Filter],
) -> AppResult<(String, Vec<Box<dyn ToSql + Sync + Send>>)> {
    let mut params: Vec<Box<dyn ToSql + Sync + Send>> = Vec::new();
    let where_sql = build_where_clause(filters, &mut params)?;
    let from = format!("{}.{}", quote_ident(schema), quote_ident(relation));
    let sql = format!("SELECT COUNT(*)::bigint FROM {from}{where_sql}");
    Ok((sql, params))
}

const SQL_LIST_COLUMNS: &str = "\
SELECT a.attname,
       pg_catalog.format_type(a.atttypid, a.atttypmod),
       a.attnum::int4,
       NOT a.attnotnull
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1
  AND c.relname = $2
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY a.attnum";

async fn list_columns(
    client: &PgObject,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<DataColumn>> {
    let rows = client
        .query(SQL_LIST_COLUMNS, &[&schema, &relation])
        .await?;
    if rows.is_empty() {
        return Err(AppError::postgres_with_code(
            "42P01",
            format!("relation {schema}.{relation} not found"),
        ));
    }
    Ok(rows
        .into_iter()
        .map(|r| DataColumn {
            name: r.get(0),
            data_type: r.get(1),
            ordinal_position: r.get(2),
            is_nullable: r.get(3),
        })
        .collect())
}

fn truncated_envelope(preview: String, byte_length: usize) -> JsonValue {
    serde_json::json!({
        "kind": "truncated",
        "preview": preview,
        "byte_length": byte_length,
    })
}

fn binary_envelope(preview: String, byte_length: usize) -> JsonValue {
    serde_json::json!({
        "kind": "binary",
        "preview": preview,
        "byte_length": byte_length,
    })
}

/// Apply per-cell post-processing: replace `bytea` with a `binary` envelope and
/// any value whose JSON string-length crosses `TRUNCATE_BYTES` with a `truncated`
/// envelope. Records each affected column in `truncated_columns`.
fn transform_cell(
    data_type: &str,
    column_name: &str,
    raw: JsonValue,
    truncated_columns: &mut Vec<String>,
) -> JsonValue {
    if matches!(&raw, JsonValue::Null) {
        return JsonValue::Null;
    }

    if data_type.eq_ignore_ascii_case("bytea") {
        if let JsonValue::String(s) = &raw {
            // Postgres serializes bytea via `row_to_json` as `"\\x<hex>"`.
            let hex = s.strip_prefix("\\x").unwrap_or(s.as_str());
            let byte_length = hex.len() / 2;
            let preview: String = hex.chars().take(64).collect();
            if !truncated_columns.iter().any(|n| n == column_name) {
                truncated_columns.push(column_name.to_string());
            }
            return binary_envelope(preview, byte_length);
        }
    }

    let length_estimate = match &raw {
        JsonValue::String(s) => s.len(),
        other => serde_json::to_string(other).map(|v| v.len()).unwrap_or(0),
    };

    if length_estimate > TRUNCATE_BYTES {
        let preview: String = match &raw {
            JsonValue::String(s) => s.chars().take(2048).collect(),
            other => serde_json::to_string(other)
                .unwrap_or_default()
                .chars()
                .take(2048)
                .collect(),
        };
        if !truncated_columns.iter().any(|n| n == column_name) {
            truncated_columns.push(column_name.to_string());
        }
        return truncated_envelope(preview, length_estimate);
    }

    raw
}

fn process_row(
    json_text: &str,
    columns: &[DataColumn],
    truncated_columns: &mut Vec<String>,
) -> AppResult<Vec<JsonValue>> {
    let parsed: JsonValue = serde_json::from_str(json_text)
        .map_err(|e| AppError::postgres(format!("decode row_to_json: {e}")))?;
    let obj = match parsed {
        JsonValue::Object(m) => m,
        _ => {
            return Err(AppError::postgres(
                "row_to_json did not return an object",
            ))
        }
    };
    let mut out = Vec::with_capacity(columns.len());
    for col in columns {
        let raw = obj.get(&col.name).cloned().unwrap_or(JsonValue::Null);
        out.push(transform_cell(
            &col.data_type,
            &col.name,
            raw,
            truncated_columns,
        ));
    }
    Ok(out)
}

fn parse_id(id: &str) -> AppResult<Uuid> {
    Uuid::parse_str(id).map_err(|e| AppError::Validation(format!("bad uuid: {e}")))
}

/// Best-effort cancellation matching the schema browser's pattern. Returns
/// regardless of whether the cancel itself succeeds — the timeout error is
/// already on its way to the UI.
async fn fire_cancel(cancel_token: tokio_postgres::CancelToken, sslmode: SslMode) {
    let outcome = match client_config_for(sslmode) {
        Ok(Some(cfg)) => {
            let connector = MakeRustlsConnect::new((*cfg).clone());
            cancel_token.cancel_query(connector).await
        }
        Ok(None) => cancel_token.cancel_query(NoTls).await,
        Err(e) => {
            tracing::warn!("data: could not build TLS for cancel: {e:?}");
            return;
        }
    };
    if let Err(e) = outcome {
        tracing::warn!("data: pg_cancel_backend failed: {e}");
    }
}

#[tauri::command]
pub async fn postgres_query_table(
    pools: State<'_, PgPoolRegistry>,
    id: String,
    schema: String,
    relation: String,
    options: serde_json::Value,
) -> AppResult<QueryTableResult> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    let opts: QueryTableOptions = serde_json::from_value(options)
        .map_err(|e| AppError::Validation(format!("invalid query options: {e}")))?;

    if opts.limit <= 0 || opts.limit > MAX_LIMIT {
        return Err(AppError::Validation(format!(
            "limit must be in [1, {MAX_LIMIT}]"
        )));
    }
    if opts.offset < 0 {
        return Err(AppError::Validation("offset must be >= 0".into()));
    }

    tracing::info!(
        "postgres_query_table: id={parsed} schema={schema} relation={relation} \
         limit={} offset={} order={} filters={}",
        opts.limit,
        opts.offset,
        opts.order_by.len(),
        opts.filters.len()
    );

    let sslmode = pools.sslmode_for(&parsed).await?;
    let client = pools.acquire(&parsed).await?;
    let cancel_token = client.cancel_token();

    // Resolve column metadata first — also serves as the "relation exists" check.
    let columns = match timeout(QUERY_TIMEOUT, list_columns(&client, &schema, &relation)).await {
        Ok(r) => r?,
        Err(_) => {
            fire_cancel(cancel_token, sslmode).await;
            drop(client);
            return Err(AppError::postgres_with_code(
                "57014",
                format!(
                    "table query timed out resolving columns ({}s)",
                    QUERY_TIMEOUT.as_secs()
                ),
            ));
        }
    };

    let (sql, params) = build_select_sql(
        &schema,
        &relation,
        &opts.order_by,
        &opts.filters,
        opts.limit,
        opts.offset,
    )?;
    tracing::debug!("postgres_query_table sql: {sql}");

    let param_refs: Vec<&(dyn ToSql + Sync)> = params
        .iter()
        .map(|b| b.as_ref() as &(dyn ToSql + Sync))
        .collect();

    let cancel_token_for_query = client.cancel_token();
    let query_started = Instant::now();
    let rows = match timeout(QUERY_TIMEOUT, client.query(&sql, &param_refs)).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return Err(AppError::from(e)),
        Err(_) => {
            fire_cancel(cancel_token_for_query, sslmode).await;
            drop(client);
            return Err(AppError::postgres_with_code(
                "57014",
                format!("table query timed out ({}s)", QUERY_TIMEOUT.as_secs()),
            ));
        }
    };
    let query_ms = query_started.elapsed().as_millis() as u64;

    let mut truncated_columns: Vec<String> = Vec::new();
    let mut out_rows: Vec<Vec<JsonValue>> = Vec::with_capacity(rows.len());
    for row in &rows {
        let json_text: String = row.get(0);
        out_rows.push(process_row(&json_text, &columns, &mut truncated_columns)?);
    }

    let applied = AppliedQuery {
        limit: opts.limit,
        offset: opts.offset,
        order_by: opts.order_by.clone(),
        filters: opts.filters.clone(),
    };

    tracing::info!(
        "postgres_query_table ok: id={parsed} schema={schema} relation={relation} \
         rows={} query_ms={} total_ms={}",
        out_rows.len(),
        query_ms,
        started.elapsed().as_millis()
    );

    Ok(QueryTableResult {
        columns,
        rows: out_rows,
        applied,
        query_ms,
        truncated_columns,
    })
}

#[tauri::command]
pub async fn postgres_count_table(
    pools: State<'_, PgPoolRegistry>,
    id: String,
    schema: String,
    relation: String,
    filters: Option<serde_json::Value>,
) -> AppResult<CountTableResult> {
    let started = Instant::now();
    let parsed = parse_id(&id)?;
    let filters_vec: Vec<Filter> = match filters {
        Some(v) => serde_json::from_value(v)
            .map_err(|e| AppError::Validation(format!("invalid filters: {e}")))?,
        None => Vec::new(),
    };

    tracing::info!(
        "postgres_count_table: id={parsed} schema={schema} relation={relation} filters={}",
        filters_vec.len()
    );

    let sslmode = pools.sslmode_for(&parsed).await?;
    let client = pools.acquire(&parsed).await?;
    let cancel_token = client.cancel_token();

    let (sql, params) = build_count_sql(&schema, &relation, &filters_vec)?;
    tracing::debug!("postgres_count_table sql: {sql}");

    let param_refs: Vec<&(dyn ToSql + Sync)> = params
        .iter()
        .map(|b| b.as_ref() as &(dyn ToSql + Sync))
        .collect();

    let query_started = Instant::now();
    let row = match timeout(QUERY_TIMEOUT, client.query_one(&sql, &param_refs)).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return Err(AppError::from(e)),
        Err(_) => {
            fire_cancel(cancel_token, sslmode).await;
            drop(client);
            return Err(AppError::postgres_with_code(
                "57014",
                format!("count timed out ({}s)", QUERY_TIMEOUT.as_secs()),
            ));
        }
    };
    let count: i64 = row.get(0);
    let query_ms = query_started.elapsed().as_millis() as u64;

    tracing::info!(
        "postgres_count_table ok: id={parsed} schema={schema} relation={relation} \
         count={count} query_ms={query_ms} total_ms={}",
        started.elapsed().as_millis()
    );

    Ok(CountTableResult { count, query_ms })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn order_asc(c: &str) -> OrderBy {
        OrderBy {
            column: c.into(),
            direction: SortDirection::Asc,
        }
    }
    fn order_desc(c: &str) -> OrderBy {
        OrderBy {
            column: c.into(),
            direction: SortDirection::Desc,
        }
    }

    #[test]
    fn quote_ident_simple() {
        assert_eq!(quote_ident("public"), "\"public\"");
        assert_eq!(quote_ident("Order"), "\"Order\"");
    }

    #[test]
    fn quote_ident_doubles_internal_quote() {
        assert_eq!(quote_ident("we\"ird"), "\"we\"\"ird\"");
        assert_eq!(quote_ident("\""), "\"\"\"\"");
    }

    #[test]
    fn build_select_sql_simple() {
        let (sql, params) =
            build_select_sql("public", "users", &[], &[], 200, 0).unwrap();
        assert!(sql.contains("\"public\".\"users\""));
        assert!(sql.contains("LIMIT 200"));
        assert!(sql.contains("OFFSET 0"));
        assert!(!sql.contains("WHERE"));
        assert!(!sql.contains("ORDER BY"));
        assert!(params.is_empty());
    }

    #[test]
    fn build_select_sql_multi_column_order() {
        let order = vec![order_asc("country"), order_desc("created_at")];
        let (sql, _params) =
            build_select_sql("public", "users", &order, &[], 200, 0).unwrap();
        assert!(sql.contains("ORDER BY \"country\" ASC, \"created_at\" DESC"));
    }

    #[test]
    fn build_select_sql_eq_filter() {
        let filters = vec![Filter::Eq {
            column: "country".into(),
            value: json!("CL"),
        }];
        let (sql, params) =
            build_select_sql("public", "users", &[], &filters, 100, 0).unwrap();
        assert!(sql.contains("WHERE \"country\" = $1"));
        assert_eq!(params.len(), 1);
    }

    #[test]
    fn build_select_sql_combined_filters() {
        let filters = vec![
            Filter::Eq {
                column: "country".into(),
                value: json!("CL"),
            },
            Filter::IsNull {
                column: "deleted_at".into(),
            },
        ];
        let (sql, params) =
            build_select_sql("public", "users", &[], &filters, 100, 0).unwrap();
        assert!(
            sql.contains("WHERE \"country\" = $1 AND \"deleted_at\" IS NULL"),
            "sql was: {sql}"
        );
        assert_eq!(params.len(), 1);
    }

    #[test]
    fn build_select_sql_every_binary_operator_uses_correct_sql() {
        let cases: Vec<(Filter, &str)> = vec![
            (
                Filter::Eq {
                    column: "a".into(),
                    value: json!(1),
                },
                "= $1",
            ),
            (
                Filter::Ne {
                    column: "a".into(),
                    value: json!(1),
                },
                "<> $1",
            ),
            (
                Filter::Lt {
                    column: "a".into(),
                    value: json!(1),
                },
                "< $1",
            ),
            (
                Filter::Le {
                    column: "a".into(),
                    value: json!(1),
                },
                "<= $1",
            ),
            (
                Filter::Gt {
                    column: "a".into(),
                    value: json!(1),
                },
                "> $1",
            ),
            (
                Filter::Ge {
                    column: "a".into(),
                    value: json!(1),
                },
                ">= $1",
            ),
            (
                Filter::Like {
                    column: "a".into(),
                    value: json!("x%"),
                },
                "LIKE $1",
            ),
            (
                Filter::NotLike {
                    column: "a".into(),
                    value: json!("x%"),
                },
                "NOT LIKE $1",
            ),
        ];
        for (filter, fragment) in cases {
            let (sql, _params) =
                build_select_sql("p", "t", &[], &[filter], 10, 0).unwrap();
            assert!(
                sql.contains(fragment),
                "expected sql to contain `{fragment}`, got: {sql}"
            );
        }
    }

    #[test]
    fn build_select_sql_between_binds_two_params() {
        let filters = vec![Filter::Between {
            column: "created_at".into(),
            min: json!("2026-01-01"),
            max: json!("2026-04-30"),
        }];
        let (sql, params) =
            build_select_sql("p", "t", &[], &filters, 10, 0).unwrap();
        assert!(
            sql.contains("WHERE \"created_at\" BETWEEN $1 AND $2"),
            "sql was: {sql}"
        );
        assert_eq!(params.len(), 2);
    }

    #[test]
    fn build_select_sql_is_null_uses_no_param() {
        let filters = vec![Filter::IsNull {
            column: "deleted_at".into(),
        }];
        let (sql, params) =
            build_select_sql("p", "t", &[], &filters, 10, 0).unwrap();
        assert!(sql.contains("\"deleted_at\" IS NULL"));
        assert!(params.is_empty());
    }

    #[test]
    fn build_select_sql_is_not_null_uses_no_param() {
        let filters = vec![Filter::IsNotNull {
            column: "deleted_at".into(),
        }];
        let (sql, params) =
            build_select_sql("p", "t", &[], &filters, 10, 0).unwrap();
        assert!(sql.contains("\"deleted_at\" IS NOT NULL"));
        assert!(params.is_empty());
    }

    #[test]
    fn build_select_sql_quotes_identifiers_with_embedded_quote() {
        let filters = vec![Filter::Eq {
            column: "we\"ird".into(),
            value: json!("v"),
        }];
        let (sql, _params) =
            build_select_sql("we\"ird", "we\"ird_t", &[], &filters, 10, 0).unwrap();
        assert!(
            sql.contains("\"we\"\"ird\".\"we\"\"ird_t\""),
            "sql was: {sql}"
        );
        assert!(sql.contains("WHERE \"we\"\"ird\" = $1"));
    }

    #[test]
    fn build_count_sql_no_filters() {
        let (sql, params) = build_count_sql("public", "users", &[]).unwrap();
        assert_eq!(
            sql,
            "SELECT COUNT(*)::bigint FROM \"public\".\"users\""
        );
        assert!(params.is_empty());
    }

    #[test]
    fn build_count_sql_with_filters_matches_params() {
        let filters = vec![
            Filter::Eq {
                column: "country".into(),
                value: json!("CL"),
            },
            Filter::IsNull {
                column: "deleted_at".into(),
            },
        ];
        let (sql, params) = build_count_sql("public", "users", &filters).unwrap();
        assert!(sql.contains("WHERE \"country\" = $1 AND \"deleted_at\" IS NULL"));
        assert_eq!(params.len(), 1);
    }

    #[test]
    fn null_filter_value_rejected() {
        let f = Filter::Eq {
            column: "a".into(),
            value: JsonValue::Null,
        };
        let mut params = Vec::new();
        let err = predicate_for(&f, &mut params).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn array_filter_value_rejected() {
        let f = Filter::Eq {
            column: "a".into(),
            value: json!([1, 2]),
        };
        let mut params = Vec::new();
        let err = predicate_for(&f, &mut params).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn unknown_op_is_rejected_at_deserialize_time() {
        // Mirrors how the IPC command surfaces the same error: serde rejects
        // any op outside the closed set, which we wrap in `AppError::Validation`.
        let raw = json!({ "op": "DROP", "column": "x" });
        let r: Result<Filter, _> = serde_json::from_value(raw);
        assert!(r.is_err());
        let msg = r.unwrap_err().to_string();
        assert!(
            msg.contains("DROP")
                || msg.to_ascii_lowercase().contains("unknown variant"),
            "expected serde error to mention the offending op or 'unknown variant', got: {msg}"
        );
    }

    #[test]
    fn transform_cell_passes_through_short_strings() {
        let mut t = Vec::new();
        let v = transform_cell("text", "name", json!("hello"), &mut t);
        assert_eq!(v, json!("hello"));
        assert!(t.is_empty());
    }

    #[test]
    fn transform_cell_preserves_null() {
        let mut t = Vec::new();
        let v = transform_cell("text", "name", JsonValue::Null, &mut t);
        assert_eq!(v, JsonValue::Null);
        assert!(t.is_empty());
    }

    #[test]
    fn transform_cell_envelopes_bytea() {
        let mut t = Vec::new();
        let v = transform_cell("bytea", "blob", json!("\\xdeadbeef"), &mut t);
        let kind = v.get("kind").and_then(|x| x.as_str()).unwrap();
        let preview = v.get("preview").and_then(|x| x.as_str()).unwrap();
        let bytes = v.get("byte_length").and_then(|x| x.as_u64()).unwrap();
        assert_eq!(kind, "binary");
        assert_eq!(preview, "deadbeef");
        assert_eq!(bytes, 4);
        assert_eq!(t, vec!["blob".to_string()]);
    }

    #[test]
    fn transform_cell_envelopes_oversize_string() {
        let mut t = Vec::new();
        let big = "x".repeat(TRUNCATE_BYTES + 10);
        let v = transform_cell("text", "doc", JsonValue::String(big), &mut t);
        let kind = v.get("kind").and_then(|x| x.as_str()).unwrap();
        assert_eq!(kind, "truncated");
        assert!(v.get("byte_length").and_then(|x| x.as_u64()).unwrap() > TRUNCATE_BYTES as u64);
        assert_eq!(t, vec!["doc".to_string()]);
    }
}
