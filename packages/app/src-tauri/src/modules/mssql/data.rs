//! MS SQL Server data grid: query + count commands with filter/sort/pagination.
//!
//! # Cold-load race protection note (§9.5)
//! Cold-load race protection is enforced in the React layer (same as MySQL/Postgres).
//! The backend always returns the latest server snapshot for the bound params.
//!
//! # Server-side cancellation on tab close (§9.6)
//! Cancellation is handled by `cancel::run_cancellable_query` from Phase D.
//! The frontend is responsible for calling an appropriate cancel command when
//! a tab closes; the `run_cancellable_query` wrapper fires TDS Attention + KILL.

use std::collections::HashMap;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::mssql::binding::{
    bind_filter_value, bind_kind_for_type, decode_row_value, mssql_quote_ident,
    mssql_quote_qualified, BindKind,
};
use crate::modules::mssql::cancel::run_cancellable_query;
use crate::modules::mssql::errors::map_tiberius_error;
use crate::modules::mssql::pool::MssqlPoolRegistry;

/// Hard cap on query/count calls.
const QUERY_TIMEOUT_SECS: u64 = 15;
/// Default page size when the caller does not specify a limit.
const DEFAULT_LIMIT: u32 = 1000;
/// Sanity bound on per-call page size.
const MAX_LIMIT: u32 = 5000;
/// Cells whose JSON-string serialization exceeds this byte size are truncated.
const TRUNCATE_BYTES: usize = 1_048_576; // 1 MiB

// ---------------------------------------------------------------------------
// §9.1 — Data structures
// ---------------------------------------------------------------------------

/// Filter operators. No ILIKE — use LIKE + case_insensitive flag.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Operator {
    #[serde(rename = "=")]
    Eq,
    #[serde(rename = "!=")]
    Ne,
    #[serde(rename = "<")]
    Lt,
    #[serde(rename = "<=")]
    Le,
    #[serde(rename = ">")]
    Gt,
    #[serde(rename = ">=")]
    Ge,
    Like,
    #[serde(rename = "NOT LIKE")]
    NotLike,
    Contains,
    #[serde(rename = "STARTS_WITH")]
    StartsWith,
    #[serde(rename = "ENDS_WITH")]
    EndsWith,
    #[serde(rename = "IS NULL")]
    IsNull,
    #[serde(rename = "IS NOT NULL")]
    IsNotNull,
    In,
    #[serde(rename = "NOT IN")]
    NotIn,
    Between,
}

/// A filter row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterRow {
    pub enabled: bool,
    pub column: String,
    pub op: Operator,
    #[serde(default)]
    pub values: Vec<JsonValue>,
    #[serde(default)]
    pub case_insensitive: bool,
}

/// Root combinator for the filter tree.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Combinator {
    #[default]
    And,
    Or,
}

/// The filter tree: a list of rows with a root combinator.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FilterTree {
    #[serde(default)]
    pub rows: Vec<FilterRow>,
    #[serde(default)]
    pub combinator: Combinator,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderClause {
    pub column: String,
    pub direction: SortDirection,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct QueryOptions {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    #[serde(default)]
    pub filter: Option<FilterTree>,
    #[serde(default)]
    pub order_by: Vec<OrderClause>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct CountOptions {
    pub filter: Option<FilterTree>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
    pub bind_kind: BindKind,
    pub is_nullable: bool,
    pub is_identity: bool,
    pub is_computed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<JsonValue>>,
    pub truncated_columns: Vec<String>,
    pub query_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CountResult {
    pub count: i64,
    pub approximate: bool,
    pub query_ms: u64,
}

// ---------------------------------------------------------------------------
// §9.2 — Filter compiler
// ---------------------------------------------------------------------------

/// Compile a `FilterTree` to `(where_clause, bound_params)`.
///
/// `next_param` is mutated to produce `@P1, @P2, ...` placeholders.
/// The returned bound_params are `(BindKind, JsonValue)` tuples.
/// At execute time, the caller binds each param with `bind_filter_value`.
pub fn compile_filter(
    tree: &FilterTree,
    columns: &HashMap<String, BindKind>,
    next_param: &mut u32,
) -> AppResult<(String, Vec<(BindKind, JsonValue)>)> {
    let mut binds: Vec<(BindKind, JsonValue)> = Vec::new();

    // Drop disabled rows.
    let active_rows: Vec<&FilterRow> = tree.rows.iter().filter(|r| r.enabled).collect();

    if active_rows.is_empty() {
        return Ok((String::new(), binds));
    }

    let mut frags: Vec<String> = Vec::with_capacity(active_rows.len());
    for row in &active_rows {
        let frag = compile_row(row, columns, &mut binds, next_param)?;
        frags.push(frag);
    }

    let joiner = match tree.combinator {
        Combinator::And => " AND ",
        Combinator::Or => " OR ",
    };
    let clause = frags.join(joiner);
    Ok((format!("WHERE {clause}"), binds))
}

fn next_placeholder(next_param: &mut u32) -> String {
    let p = *next_param;
    *next_param += 1;
    format!("@P{p}")
}

fn compile_row(
    row: &FilterRow,
    columns: &HashMap<String, BindKind>,
    binds: &mut Vec<(BindKind, JsonValue)>,
    next_param: &mut u32,
) -> AppResult<String> {
    let bind_kind = columns.get(&row.column).ok_or_else(|| {
        AppError::Validation(format!("unknown column {:?} in filter", row.column))
    })?;

    // Reject filter-incompatible BindKinds.
    match bind_kind {
        BindKind::RowVersion => {
            return Err(AppError::Validation(format!(
                "type rowversion cannot be filtered"
            )));
        }
        BindKind::Geometry | BindKind::Geography => {
            return Err(AppError::Validation(format!(
                "type geometry/geography cannot be filtered"
            )));
        }
        BindKind::HierarchyId => {
            return Err(AppError::Validation(format!(
                "type hierarchyid cannot be filtered"
            )));
        }
        BindKind::SqlVariant => {
            return Err(AppError::Validation(format!(
                "type sql_variant cannot be filtered"
            )));
        }
        _ => {}
    }

    let col_q = mssql_quote_ident(&row.column);
    let ci = row.case_insensitive;
    let op = row.op;

    // String bind kind used for pattern operators.
    let str_kind = BindKind::NVarchar;

    match op {
        Operator::IsNull => {
            if !row.values.is_empty() {
                return Err(AppError::Validation("IS NULL must not carry values".into()));
            }
            Ok(format!("{col_q} IS NULL"))
        }
        Operator::IsNotNull => {
            if !row.values.is_empty() {
                return Err(AppError::Validation(
                    "IS NOT NULL must not carry values".into(),
                ));
            }
            Ok(format!("{col_q} IS NOT NULL"))
        }
        Operator::Between => {
            if row.values.len() != 2 {
                return Err(AppError::Validation(format!(
                    "BETWEEN requires exactly 2 values, got {}",
                    row.values.len()
                )));
            }
            let p1 = next_placeholder(next_param);
            let p2 = next_placeholder(next_param);
            binds.push((*bind_kind, row.values[0].clone()));
            binds.push((*bind_kind, row.values[1].clone()));
            Ok(format!("{col_q} BETWEEN {p1} AND {p2}"))
        }
        Operator::In | Operator::NotIn => {
            if row.values.is_empty() {
                return Err(AppError::Validation(
                    "IN / NOT IN require at least 1 value".into(),
                ));
            }
            let placeholders: Vec<String> = row
                .values
                .iter()
                .map(|_| {
                    let p = next_placeholder(next_param);
                    p
                })
                .collect();
            for v in &row.values {
                binds.push((*bind_kind, v.clone()));
            }
            let kw = if matches!(op, Operator::In) {
                "IN"
            } else {
                "NOT IN"
            };
            Ok(format!("{col_q} {kw} ({})", placeholders.join(", ")))
        }
        Operator::Contains => {
            if row.values.len() != 1 {
                return Err(AppError::Validation(
                    "CONTAINS requires exactly 1 value".into(),
                ));
            }
            let p = next_placeholder(next_param);
            binds.push((str_kind, row.values[0].clone()));
            if ci {
                // LOWER([col]) LIKE LOWER('%' + @PN + '%')
                Ok(format!("LOWER({col_q}) LIKE LOWER('%' + {p} + '%')"))
            } else {
                Ok(format!("{col_q} LIKE '%' + {p} + '%'"))
            }
        }
        Operator::StartsWith => {
            if row.values.len() != 1 {
                return Err(AppError::Validation(
                    "STARTS_WITH requires exactly 1 value".into(),
                ));
            }
            let p = next_placeholder(next_param);
            binds.push((str_kind, row.values[0].clone()));
            if ci {
                Ok(format!("LOWER({col_q}) LIKE LOWER({p} + '%')"))
            } else {
                Ok(format!("{col_q} LIKE {p} + '%'"))
            }
        }
        Operator::EndsWith => {
            if row.values.len() != 1 {
                return Err(AppError::Validation(
                    "ENDS_WITH requires exactly 1 value".into(),
                ));
            }
            let p = next_placeholder(next_param);
            binds.push((str_kind, row.values[0].clone()));
            if ci {
                Ok(format!("LOWER({col_q}) LIKE LOWER('%' + {p})"))
            } else {
                Ok(format!("{col_q} LIKE '%' + {p}"))
            }
        }
        Operator::Like | Operator::NotLike => {
            if row.values.len() != 1 {
                return Err(AppError::Validation(
                    "LIKE / NOT LIKE require exactly 1 value".into(),
                ));
            }
            let p = next_placeholder(next_param);
            binds.push((str_kind, row.values[0].clone()));
            let kw = if matches!(op, Operator::Like) {
                "LIKE"
            } else {
                "NOT LIKE"
            };
            if ci {
                Ok(format!("LOWER({col_q}) {kw} LOWER({p})"))
            } else {
                Ok(format!("{col_q} {kw} {p}"))
            }
        }
        // Single-value comparison: Eq, Ne, Lt, Le, Gt, Ge
        _ => {
            if row.values.len() != 1 {
                return Err(AppError::Validation(format!(
                    "operator {:?} requires exactly 1 value, got {}",
                    op,
                    row.values.len()
                )));
            }
            let p = next_placeholder(next_param);
            binds.push((*bind_kind, row.values[0].clone()));
            let sql_op = match op {
                Operator::Eq => "=",
                Operator::Ne => "!=",
                Operator::Lt => "<",
                Operator::Le => "<=",
                Operator::Gt => ">",
                Operator::Ge => ">=",
                _ => unreachable!(),
            };
            Ok(format!("{col_q} {sql_op} {p}"))
        }
    }
}

// ---------------------------------------------------------------------------
// Column metadata fetch
// ---------------------------------------------------------------------------

/// Column metadata fetched from sys.columns + sys.types for a table.
pub struct ColumnMetaFetch {
    pub columns: Vec<ColumnMeta>,
    pub bind_map: HashMap<String, BindKind>,
}

/// Fetch column metadata from sys.columns for the given table.
/// Returns columns in column_id order.
pub async fn fetch_column_meta(
    client: &mut bb8::PooledConnection<'_, bb8_tiberius::ConnectionManager>,
    schema: &str,
    relation: &str,
) -> AppResult<ColumnMetaFetch> {
    let qualified_name = format!("{}.{}", schema, relation);

    let sql = "\
        SELECT c.name, t.name AS type_name, c.max_length, c.precision, c.scale, \
               c.is_nullable, c.is_identity, c.is_computed \
        FROM sys.columns c \
        JOIN sys.types t ON t.user_type_id = c.user_type_id \
        WHERE c.object_id = OBJECT_ID(@P1) \
        ORDER BY c.column_id";

    let mut query = tiberius::Query::new(sql);
    query.bind(qualified_name.as_str());

    let rows = query
        .query(client)
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let mut columns: Vec<ColumnMeta> = Vec::with_capacity(rows.len());
    let mut bind_map: HashMap<String, BindKind> = HashMap::with_capacity(rows.len());

    for row in &rows {
        let name: &str = row
            .get(0)
            .ok_or_else(|| AppError::mssql("column name is null"))?;
        let type_name: &str = row
            .get(1)
            .ok_or_else(|| AppError::mssql("type name is null"))?;
        let max_length: i16 = row.get::<i16, _>(2).unwrap_or(0);
        let precision: u8 = row.get::<u8, _>(3).unwrap_or(0);
        let scale: u8 = row.get::<u8, _>(4).unwrap_or(0);
        let is_nullable: bool = row.get::<bool, _>(5).unwrap_or(false);
        let is_identity: bool = row.get::<bool, _>(6).unwrap_or(false);
        let is_computed: bool = row.get::<bool, _>(7).unwrap_or(false);

        let bk = bind_kind_for_type(
            type_name,
            Some(max_length as i32),
            Some(precision),
            Some(scale),
        );
        bind_map.insert(name.to_string(), bk);
        columns.push(ColumnMeta {
            name: name.to_string(),
            data_type: type_name.to_string(),
            bind_kind: bk,
            is_nullable,
            is_identity,
            is_computed,
        });
    }

    Ok(ColumnMetaFetch { columns, bind_map })
}

/// Fetch the PK columns in key_ordinal order for ORDER BY default.
async fn fetch_pk_columns_for_order(
    client: &mut bb8::PooledConnection<'_, bb8_tiberius::ConnectionManager>,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<String>> {
    let qualified_name = format!("{}.{}", schema, relation);

    let sql = "\
        SELECT c.name \
        FROM sys.indexes i \
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
        JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
        WHERE i.object_id = OBJECT_ID(@P1) AND i.is_primary_key = 1 \
        ORDER BY ic.key_ordinal";

    let mut query = tiberius::Query::new(sql);
    query.bind(qualified_name.as_str());

    let rows = query
        .query(client)
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let cols: Vec<String> = rows
        .into_iter()
        .filter_map(|r| r.get::<&str, _>(0).map(|s| s.to_string()))
        .collect();

    Ok(cols)
}

// ---------------------------------------------------------------------------
// §9.3 — mssql_query_table
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mssql_query_table(
    app: AppHandle,
    registry: State<'_, MssqlPoolRegistry>,
    id: Uuid,
    schema: String,
    relation: String,
    options: QueryOptions,
    origin: Option<Origin>,
) -> AppResult<QueryResult> {
    let started = Instant::now();
    let activity_origin = origin.unwrap_or_default();

    // Resolve cancel params outside the closure.
    let cancel_params_opt = registry.encrypt_mode_for(id);

    let pool = registry.get_pool(id)?;

    let schema_clone = schema.clone();
    let relation_clone = relation.clone();

    let inner: AppResult<QueryResult> = run_cancellable_query(
        &pool,
        QUERY_TIMEOUT_SECS,
        cancel_params_opt.as_ref().map(|(_, _, p, pw)| {
            (
                p as &crate::modules::mssql::params::MssqlParams,
                pw.as_str(),
            )
        }),
        move |mut conn| async move {
            // 1. Fetch column metadata.
            let meta = fetch_column_meta(&mut conn, &schema_clone, &relation_clone).await?;

            // 2. Build projection — rewrite spatial/hierarchyid/sqlvariant columns.
            let projection = build_projection(&meta.columns);

            // 3. Compile filter.
            let mut next_param: u32 = 1;
            let (where_clause, bind_pairs) = if let Some(ref f) = options.filter {
                if f.rows.iter().any(|r| r.enabled) {
                    compile_filter(f, &meta.bind_map, &mut next_param)?
                } else {
                    (String::new(), vec![])
                }
            } else {
                (String::new(), vec![])
            };

            // 4. Build ORDER BY clause.
            let order_clause = if !options.order_by.is_empty() {
                let parts: Vec<String> = options
                    .order_by
                    .iter()
                    .map(|ob| {
                        let col_q = mssql_quote_ident(&ob.column);
                        let dir = match ob.direction {
                            SortDirection::Asc => "ASC",
                            SortDirection::Desc => "DESC",
                        };
                        format!("{col_q} {dir}")
                    })
                    .collect();
                parts.join(", ")
            } else {
                // Default: PK ASC; fallback to (SELECT NULL) for heaps.
                let pk_cols =
                    fetch_pk_columns_for_order(&mut conn, &schema_clone, &relation_clone).await?;
                if pk_cols.is_empty() {
                    "(SELECT NULL)".to_string()
                } else {
                    pk_cols
                        .iter()
                        .map(|c| format!("{} ASC", mssql_quote_ident(c)))
                        .collect::<Vec<_>>()
                        .join(", ")
                }
            };

            // 5. Pagination.
            let limit = options.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
            let offset = options.offset.unwrap_or(0);
            let qualified = mssql_quote_qualified(&schema_clone, &relation_clone);

            let mut sql = format!("SELECT {projection} FROM {qualified}");
            if !where_clause.is_empty() {
                sql.push(' ');
                sql.push_str(&where_clause);
            }
            sql.push_str(&format!(
                " ORDER BY {order_clause} OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY"
            ));

            // 6. Build and execute the parameterized query.
            let mut tib_query = tiberius::Query::new(sql.as_str());
            for (bk, val) in &bind_pairs {
                bind_filter_value(&mut tib_query, val, *bk)?;
            }

            let rows = tib_query
                .query(&mut conn)
                .await
                .map_err(map_tiberius_error)?
                .into_first_result()
                .await
                .map_err(map_tiberius_error)?;

            // 7. Decode rows with per-cell truncation.
            let col_count = meta.columns.len();
            let mut result_rows: Vec<Vec<JsonValue>> = Vec::with_capacity(rows.len());
            let mut truncated_cols: Vec<String> = Vec::new();

            for row in &rows {
                let mut decoded_row: Vec<JsonValue> = Vec::with_capacity(col_count);
                for (i, col_meta) in meta.columns.iter().enumerate() {
                    // For spatial/hierarchyid/sqlvariant columns, they arrive as &str
                    // (the projection rewrote them). Use Varchar decode.
                    let effective_bk = effective_decode_kind(col_meta.bind_kind);
                    let val = decode_row_value(row, i, effective_bk)?;
                    let serialized = serde_json::to_string(&val).unwrap_or_default();
                    if serialized.len() > TRUNCATE_BYTES {
                        let size = serialized.len();
                        let mut trunc = serde_json::Map::new();
                        trunc.insert("truncated".into(), JsonValue::Bool(true));
                        trunc.insert("size".into(), JsonValue::Number(size.into()));
                        decoded_row.push(JsonValue::Object(trunc));
                        if !truncated_cols.contains(&col_meta.name) {
                            truncated_cols.push(col_meta.name.clone());
                        }
                    } else {
                        decoded_row.push(val);
                    }
                }
                result_rows.push(decoded_row);
            }

            Ok(QueryResult {
                columns: meta.columns,
                rows: result_rows,
                truncated_columns: truncated_cols,
                query_ms: started.elapsed().as_millis() as u64,
            })
        },
    )
    .await;

    // Activity log.
    let total_ms = started.elapsed().as_millis() as u64;
    let builder = ActivityLogEntryBuilder::new(ActivityKind::QueryTable, activity_origin, total_ms)
        .connection(id);
    match &inner {
        Ok(r) => emit_activity(
            &app,
            builder.ok(Some(Metric::Items {
                value: r.rows.len() as u32,
            })),
        ),
        Err(e) => emit_activity(&app, builder.err(e)),
    }
    inner
}

/// Build the SELECT projection, rewriting spatial/hierarchyid/sqlvariant columns.
fn build_projection(columns: &[ColumnMeta]) -> String {
    if columns.is_empty() {
        return "*".to_string();
    }
    let parts: Vec<String> = columns
        .iter()
        .map(|col| {
            let q = mssql_quote_ident(&col.name);
            match col.bind_kind {
                BindKind::Geometry | BindKind::Geography => {
                    format!("{q}.STAsText() AS {q}")
                }
                BindKind::HierarchyId => {
                    format!("{q}.ToString() AS {q}")
                }
                BindKind::SqlVariant => {
                    format!("CONVERT(NVARCHAR(MAX), {q}) AS {q}")
                }
                _ => q,
            }
        })
        .collect();
    parts.join(", ")
}

/// For spatial/hierarchyid/sqlvariant columns that were rewritten to text,
/// decode as NVarchar (since they arrive as &str).
fn effective_decode_kind(bk: BindKind) -> BindKind {
    match bk {
        BindKind::Geometry | BindKind::Geography | BindKind::HierarchyId | BindKind::SqlVariant => {
            BindKind::NVarchar
        }
        other => other,
    }
}

// ---------------------------------------------------------------------------
// §9.4 — mssql_count_table
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mssql_count_table(
    app: AppHandle,
    registry: State<'_, MssqlPoolRegistry>,
    id: Uuid,
    schema: String,
    relation: String,
    options: CountOptions,
    origin: Option<Origin>,
) -> AppResult<CountResult> {
    let started = Instant::now();
    let activity_origin = origin.unwrap_or_default();

    let cancel_params_opt = registry.encrypt_mode_for(id);
    let pool = registry.get_pool(id)?;

    let schema_clone = schema.clone();
    let relation_clone = relation.clone();

    let inner: AppResult<CountResult> = run_cancellable_query(
        &pool,
        QUERY_TIMEOUT_SECS,
        cancel_params_opt.as_ref().map(|(_, _, p, pw)| {
            (
                p as &crate::modules::mssql::params::MssqlParams,
                pw.as_str(),
            )
        }),
        move |mut conn| async move {
            // Determine if filter is active.
            let has_filter = options
                .filter
                .as_ref()
                .map(|f| f.rows.iter().any(|r| r.enabled))
                .unwrap_or(false);

            if !has_filter {
                // Fast path: sys.dm_db_partition_stats (approximate).
                let approx_sql = "\
                    SELECT SUM(row_count) \
                    FROM sys.dm_db_partition_stats \
                    WHERE object_id = OBJECT_ID(@P1) AND index_id IN (0, 1)";

                let qualified_name = format!("{}.{}", schema_clone, relation_clone);
                let mut q = tiberius::Query::new(approx_sql);
                q.bind(qualified_name.as_str());

                let rows = q
                    .query(&mut conn)
                    .await
                    .map_err(map_tiberius_error)?
                    .into_first_result()
                    .await
                    .map_err(map_tiberius_error)?;

                if let Some(row) = rows.first() {
                    let count: Option<i64> = row.get(0);
                    let count = count.unwrap_or(0);
                    if count > 0 {
                        return Ok(CountResult {
                            count,
                            approximate: true,
                            query_ms: started.elapsed().as_millis() as u64,
                        });
                    }
                }

                // Fallback: exact COUNT_BIG(*) (view or zero-row table).
                let qualified = mssql_quote_qualified(&schema_clone, &relation_clone);
                let count_sql = format!("SELECT COUNT_BIG(*) FROM {qualified}");
                let rows = conn
                    .simple_query(&count_sql)
                    .await
                    .map_err(map_tiberius_error)?
                    .into_first_result()
                    .await
                    .map_err(map_tiberius_error)?;
                let count: i64 = rows.first().and_then(|r| r.get::<i64, _>(0)).unwrap_or(0);
                return Ok(CountResult {
                    count,
                    approximate: false,
                    query_ms: started.elapsed().as_millis() as u64,
                });
            }

            // Filtered path: compile filter and run COUNT_BIG(*).
            let filter = options.filter.as_ref().unwrap();
            let meta = fetch_column_meta(&mut conn, &schema_clone, &relation_clone).await?;
            let mut next_param: u32 = 1;
            let (where_clause, bind_pairs) =
                compile_filter(filter, &meta.bind_map, &mut next_param)?;

            let qualified = mssql_quote_qualified(&schema_clone, &relation_clone);
            let mut count_sql = format!("SELECT COUNT_BIG(*) FROM {qualified}");
            if !where_clause.is_empty() {
                count_sql.push(' ');
                count_sql.push_str(&where_clause);
            }

            let mut tib_query = tiberius::Query::new(count_sql.as_str());
            for (bk, val) in &bind_pairs {
                bind_filter_value(&mut tib_query, val, *bk)?;
            }

            let rows = tib_query
                .query(&mut conn)
                .await
                .map_err(map_tiberius_error)?
                .into_first_result()
                .await
                .map_err(map_tiberius_error)?;

            let count: i64 = rows.first().and_then(|r| r.get::<i64, _>(0)).unwrap_or(0);

            Ok(CountResult {
                count,
                approximate: false,
                query_ms: started.elapsed().as_millis() as u64,
            })
        },
    )
    .await;

    let total_ms = started.elapsed().as_millis() as u64;
    let builder = ActivityLogEntryBuilder::new(ActivityKind::CountTable, activity_origin, total_ms)
        .connection(id);
    match &inner {
        Ok(r) => emit_activity(&app, builder.ok(Some(Metric::Count { value: r.count }))),
        Err(e) => emit_activity(&app, builder.err(e)),
    }
    inner
}

// ---------------------------------------------------------------------------
// §9.7 — Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn col_map() -> HashMap<String, BindKind> {
        let mut m = HashMap::new();
        m.insert("id".into(), BindKind::Int);
        m.insert("name".into(), BindKind::NVarchar);
        m.insert("email".into(), BindKind::Varchar);
        m.insert("created_at".into(), BindKind::DateTime2);
        m.insert("amount".into(), BindKind::Decimal);
        m.insert("deleted_at".into(), BindKind::DateTime2);
        m.insert("country".into(), BindKind::NVarchar);
        m.insert("status".into(), BindKind::NVarchar);
        m.insert("geo".into(), BindKind::Geometry);
        m.insert("rv".into(), BindKind::RowVersion);
        m.insert("hier".into(), BindKind::HierarchyId);
        m.insert("sv".into(), BindKind::SqlVariant);
        m
    }

    fn make_tree(combinator: Combinator, rows: Vec<FilterRow>) -> FilterTree {
        FilterTree { rows, combinator }
    }

    fn row(col: &str, op: Operator, values: Vec<JsonValue>) -> FilterRow {
        FilterRow {
            enabled: true,
            column: col.into(),
            op,
            values,
            case_insensitive: false,
        }
    }

    fn row_ci(col: &str, op: Operator, values: Vec<JsonValue>) -> FilterRow {
        FilterRow {
            enabled: true,
            column: col.into(),
            op,
            values,
            case_insensitive: true,
        }
    }

    fn row_disabled(col: &str, op: Operator, values: Vec<JsonValue>) -> FilterRow {
        FilterRow {
            enabled: false,
            column: col.into(),
            op,
            values,
            case_insensitive: false,
        }
    }

    fn compile(tree: &FilterTree) -> AppResult<(String, Vec<(BindKind, JsonValue)>)> {
        let mut next = 1u32;
        compile_filter(tree, &col_map(), &mut next)
    }

    // --- Empty tree ---

    #[test]
    fn empty_tree_produces_no_where() {
        let tree = make_tree(Combinator::And, vec![]);
        let (clause, binds) = compile(&tree).unwrap();
        assert!(clause.is_empty());
        assert!(binds.is_empty());
    }

    #[test]
    fn disabled_rows_only_produces_no_where() {
        let tree = make_tree(
            Combinator::And,
            vec![row_disabled("id", Operator::Eq, vec![json!(1)])],
        );
        let (clause, binds) = compile(&tree).unwrap();
        assert!(clause.is_empty());
        assert!(binds.is_empty());
    }

    // --- Eq / Ne / Lt / Le / Gt / Ge ---

    #[test]
    fn eq_operator() {
        let tree = make_tree(
            Combinator::And,
            vec![row("id", Operator::Eq, vec![json!(1)])],
        );
        let (clause, binds) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE [id] = @P1");
        assert_eq!(binds.len(), 1);
        assert_eq!(binds[0].1, json!(1));
    }

    #[test]
    fn ne_operator() {
        let tree = make_tree(
            Combinator::And,
            vec![row("id", Operator::Ne, vec![json!(5)])],
        );
        let (clause, _) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE [id] != @P1");
    }

    #[test]
    fn lt_operator() {
        let tree = make_tree(
            Combinator::And,
            vec![row("id", Operator::Lt, vec![json!(10)])],
        );
        let (clause, _) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE [id] < @P1");
    }

    #[test]
    fn le_operator() {
        let tree = make_tree(
            Combinator::And,
            vec![row("id", Operator::Le, vec![json!(10)])],
        );
        let (clause, _) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE [id] <= @P1");
    }

    #[test]
    fn gt_operator() {
        let tree = make_tree(
            Combinator::And,
            vec![row("id", Operator::Gt, vec![json!(10)])],
        );
        let (clause, _) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE [id] > @P1");
    }

    #[test]
    fn ge_operator() {
        let tree = make_tree(
            Combinator::And,
            vec![row("id", Operator::Ge, vec![json!(10)])],
        );
        let (clause, _) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE [id] >= @P1");
    }

    // --- IS NULL / IS NOT NULL ---

    #[test]
    fn is_null_operator() {
        let tree = make_tree(
            Combinator::And,
            vec![row("deleted_at", Operator::IsNull, vec![])],
        );
        let (clause, binds) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE [deleted_at] IS NULL");
        assert!(binds.is_empty());
    }

    #[test]
    fn is_not_null_operator() {
        let tree = make_tree(
            Combinator::And,
            vec![row("deleted_at", Operator::IsNotNull, vec![])],
        );
        let (clause, binds) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE [deleted_at] IS NOT NULL");
        assert!(binds.is_empty());
    }

    #[test]
    fn is_null_with_value_rejected() {
        let tree = make_tree(
            Combinator::And,
            vec![row("deleted_at", Operator::IsNull, vec![json!("x")])],
        );
        let err = compile(&tree).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn is_not_null_with_value_rejected() {
        let tree = make_tree(
            Combinator::And,
            vec![row("deleted_at", Operator::IsNotNull, vec![json!("x")])],
        );
        let err = compile(&tree).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    // --- BETWEEN ---

    #[test]
    fn between_operator() {
        let tree = make_tree(
            Combinator::And,
            vec![row("id", Operator::Between, vec![json!(1), json!(10)])],
        );
        let (clause, binds) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE [id] BETWEEN @P1 AND @P2");
        assert_eq!(binds.len(), 2);
        assert_eq!(binds[0].1, json!(1));
        assert_eq!(binds[1].1, json!(10));
    }

    #[test]
    fn between_wrong_arity_rejected() {
        let tree = make_tree(
            Combinator::And,
            vec![row("id", Operator::Between, vec![json!(1)])],
        );
        let err = compile(&tree).unwrap_err();
        assert!(matches!(err, AppError::Validation(ref m) if m.contains("2")));
    }

    // --- IN / NOT IN ---

    #[test]
    fn in_operator() {
        let tree = make_tree(
            Combinator::And,
            vec![row(
                "status",
                Operator::In,
                vec![json!("active"), json!("pending"), json!("trial")],
            )],
        );
        let (clause, binds) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE [status] IN (@P1, @P2, @P3)");
        assert_eq!(binds.len(), 3);
    }

    #[test]
    fn not_in_operator() {
        let tree = make_tree(
            Combinator::And,
            vec![row("status", Operator::NotIn, vec![json!("deleted")])],
        );
        let (clause, binds) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE [status] NOT IN (@P1)");
        assert_eq!(binds.len(), 1);
    }

    #[test]
    fn in_empty_values_rejected() {
        let tree = make_tree(Combinator::And, vec![row("id", Operator::In, vec![])]);
        let err = compile(&tree).unwrap_err();
        assert!(matches!(err, AppError::Validation(ref m) if m.contains("IN")));
    }

    // --- LIKE / NOT LIKE ---

    #[test]
    fn like_operator() {
        let tree = make_tree(
            Combinator::And,
            vec![row("name", Operator::Like, vec![json!("al%")])],
        );
        let (clause, binds) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE [name] LIKE @P1");
        assert_eq!(binds.len(), 1);
        assert_eq!(binds[0].1, json!("al%"));
    }

    #[test]
    fn not_like_operator() {
        let tree = make_tree(
            Combinator::And,
            vec![row("name", Operator::NotLike, vec![json!("%test%")])],
        );
        let (clause, _) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE [name] NOT LIKE @P1");
    }

    #[test]
    fn like_case_insensitive() {
        let tree = make_tree(
            Combinator::And,
            vec![row_ci("name", Operator::Like, vec![json!("al%")])],
        );
        let (clause, _) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE LOWER([name]) LIKE LOWER(@P1)");
    }

    #[test]
    fn not_like_case_insensitive() {
        let tree = make_tree(
            Combinator::And,
            vec![row_ci("name", Operator::NotLike, vec![json!("%test%")])],
        );
        let (clause, _) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE LOWER([name]) NOT LIKE LOWER(@P1)");
    }

    // --- CONTAINS / STARTS_WITH / ENDS_WITH ---

    #[test]
    fn contains_without_ci_uses_plus_concat() {
        let tree = make_tree(
            Combinator::And,
            vec![row("name", Operator::Contains, vec![json!("ana")])],
        );
        let (clause, binds) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE [name] LIKE '%' + @P1 + '%'");
        assert_eq!(binds[0].1, json!("ana"));
    }

    #[test]
    fn contains_case_insensitive_uses_lower() {
        let tree = make_tree(
            Combinator::And,
            vec![row_ci("name", Operator::Contains, vec![json!("ana")])],
        );
        let (clause, _) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE LOWER([name]) LIKE LOWER('%' + @P1 + '%')");
    }

    #[test]
    fn starts_with_without_ci() {
        let tree = make_tree(
            Combinator::And,
            vec![row("email", Operator::StartsWith, vec![json!("admin")])],
        );
        let (clause, _) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE [email] LIKE @P1 + '%'");
    }

    #[test]
    fn starts_with_case_insensitive() {
        let tree = make_tree(
            Combinator::And,
            vec![row_ci("name", Operator::StartsWith, vec![json!("Jo")])],
        );
        let (clause, _) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE LOWER([name]) LIKE LOWER(@P1 + '%')");
    }

    #[test]
    fn ends_with_without_ci() {
        let tree = make_tree(
            Combinator::And,
            vec![row(
                "email",
                Operator::EndsWith,
                vec![json!("@example.com")],
            )],
        );
        let (clause, _) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE [email] LIKE '%' + @P1");
    }

    #[test]
    fn ends_with_case_insensitive() {
        let tree = make_tree(
            Combinator::And,
            vec![row_ci("name", Operator::EndsWith, vec![json!("son")])],
        );
        let (clause, _) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE LOWER([name]) LIKE LOWER('%' + @P1)");
    }

    // --- AND / OR root ---

    #[test]
    fn and_root_two_conditions() {
        let tree = make_tree(
            Combinator::And,
            vec![
                row("id", Operator::Eq, vec![json!(1)]),
                row("name", Operator::Eq, vec![json!("Ana")]),
            ],
        );
        let (clause, binds) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE [id] = @P1 AND [name] = @P2");
        assert_eq!(binds.len(), 2);
    }

    #[test]
    fn or_root_two_conditions() {
        let tree = make_tree(
            Combinator::Or,
            vec![
                row("id", Operator::Eq, vec![json!(1)]),
                row("id", Operator::Eq, vec![json!(2)]),
            ],
        );
        let (clause, _) = compile(&tree).unwrap();
        assert_eq!(clause, "WHERE [id] = @P1 OR [id] = @P2");
    }

    // --- Placeholder numbering across multi-row trees ---

    #[test]
    fn placeholder_numbering_sequential() {
        let tree = make_tree(
            Combinator::And,
            vec![
                row("country", Operator::Eq, vec![json!("CL")]),
                row("id", Operator::Between, vec![json!(1), json!(10)]),
                row("name", Operator::In, vec![json!("a"), json!("b")]),
            ],
        );
        let mut next = 1u32;
        let (clause, binds) = compile_filter(&tree, &col_map(), &mut next).unwrap();
        // country=@P1, between @P2/@P3, in @P4/@P5
        assert!(clause.contains("@P1"), "clause: {clause}");
        assert!(clause.contains("@P2"), "clause: {clause}");
        assert!(clause.contains("@P3"), "clause: {clause}");
        assert!(clause.contains("@P4"), "clause: {clause}");
        assert!(clause.contains("@P5"), "clause: {clause}");
        assert_eq!(binds.len(), 5);
    }

    // --- Identifier quoting ---

    #[test]
    fn identifier_with_bracket_is_escaped() {
        let mut m = col_map();
        m.insert("bad]name".into(), BindKind::NVarchar);
        let tree = make_tree(
            Combinator::And,
            vec![FilterRow {
                enabled: true,
                column: "bad]name".into(),
                op: Operator::Eq,
                values: vec![json!("x")],
                case_insensitive: false,
            }],
        );
        let mut next = 1u32;
        let (clause, _) = compile_filter(&tree, &m, &mut next).unwrap();
        assert!(clause.contains("[bad]]name]"), "clause: {clause}");
    }

    // --- Filter-incompatible BindKind rejections ---

    #[test]
    fn geometry_column_rejected_in_filter() {
        let tree = make_tree(
            Combinator::And,
            vec![row("geo", Operator::Eq, vec![json!("POINT(1 2)")])],
        );
        let err = compile(&tree).unwrap_err();
        assert!(matches!(err, AppError::Validation(ref m) if m.contains("geometry")));
    }

    #[test]
    fn rowversion_column_rejected_in_filter() {
        let tree = make_tree(
            Combinator::And,
            vec![row("rv", Operator::Eq, vec![json!("AAAA")])],
        );
        let err = compile(&tree).unwrap_err();
        assert!(matches!(err, AppError::Validation(ref m) if m.contains("rowversion")));
    }

    #[test]
    fn hierarchyid_column_rejected_in_filter() {
        let tree = make_tree(
            Combinator::And,
            vec![row("hier", Operator::Eq, vec![json!("/1/")])],
        );
        let err = compile(&tree).unwrap_err();
        assert!(matches!(err, AppError::Validation(ref m) if m.contains("hierarchyid")));
    }

    #[test]
    fn sqlvariant_column_rejected_in_filter() {
        let tree = make_tree(
            Combinator::And,
            vec![row("sv", Operator::Eq, vec![json!("val")])],
        );
        let err = compile(&tree).unwrap_err();
        assert!(matches!(err, AppError::Validation(ref m) if m.contains("sql_variant")));
    }

    // --- Limit capping ---

    #[test]
    fn limit_capping() {
        let capped = 10000_u32.min(MAX_LIMIT);
        assert_eq!(capped, MAX_LIMIT);
        let default = None::<u32>.unwrap_or(DEFAULT_LIMIT);
        assert_eq!(default, DEFAULT_LIMIT);
        let small = 500_u32.min(MAX_LIMIT);
        assert_eq!(small, 500);
    }

    // --- Projection builder ---

    #[test]
    fn build_projection_plain_columns() {
        let cols = vec![
            ColumnMeta {
                name: "id".into(),
                data_type: "int".into(),
                bind_kind: BindKind::Int,
                is_nullable: false,
                is_identity: true,
                is_computed: false,
            },
            ColumnMeta {
                name: "name".into(),
                data_type: "nvarchar".into(),
                bind_kind: BindKind::NVarchar,
                is_nullable: true,
                is_identity: false,
                is_computed: false,
            },
        ];
        let proj = build_projection(&cols);
        assert_eq!(proj, "[id], [name]");
    }

    #[test]
    fn build_projection_geometry_uses_stastext() {
        let cols = vec![ColumnMeta {
            name: "shape".into(),
            data_type: "geometry".into(),
            bind_kind: BindKind::Geometry,
            is_nullable: true,
            is_identity: false,
            is_computed: false,
        }];
        let proj = build_projection(&cols);
        assert!(proj.contains("STAsText()"), "proj: {proj}");
    }

    #[test]
    fn build_projection_hierarchyid_uses_tostring() {
        let cols = vec![ColumnMeta {
            name: "hier".into(),
            data_type: "hierarchyid".into(),
            bind_kind: BindKind::HierarchyId,
            is_nullable: true,
            is_identity: false,
            is_computed: false,
        }];
        let proj = build_projection(&cols);
        assert!(proj.contains("ToString()"), "proj: {proj}");
    }

    #[test]
    fn build_projection_sqlvariant_uses_convert() {
        let cols = vec![ColumnMeta {
            name: "sv".into(),
            data_type: "sql_variant".into(),
            bind_kind: BindKind::SqlVariant,
            is_nullable: true,
            is_identity: false,
            is_computed: false,
        }];
        let proj = build_projection(&cols);
        assert!(proj.contains("CONVERT(NVARCHAR(MAX)"), "proj: {proj}");
    }

    #[test]
    fn build_projection_empty_returns_star() {
        let proj = build_projection(&[]);
        assert_eq!(proj, "*");
    }
}
