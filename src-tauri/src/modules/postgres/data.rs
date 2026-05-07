use std::collections::HashMap;
use std::time::{Duration, Instant};

use deadpool_postgres::Object as PgObject;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::{AppHandle, State};
use tokio::time::timeout;
use tokio_postgres::types::ToSql;
use tokio_postgres::NoTls;
use tokio_postgres_rustls::MakeRustlsConnect;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, format_params, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
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

/// Operator surface accepted by Structured filters. The wire form mirrors the
/// `postgres-data-grid` spec: SQL keywords stay uppercase (`=`, `LIKE`,
/// `IS NULL`, …); sugar operators are PascalCase (`Contains`, `In`, …).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
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
    #[serde(rename = "LIKE")]
    Like,
    #[serde(rename = "NOT LIKE")]
    NotLike,
    #[serde(rename = "ILIKE")]
    Ilike,
    #[serde(rename = "NOT ILIKE")]
    NotIlike,
    Contains,
    StartsWith,
    EndsWith,
    In,
    NotIn,
    #[serde(rename = "BETWEEN")]
    Between,
    #[serde(rename = "IS NULL")]
    IsNull,
    #[serde(rename = "IS NOT NULL")]
    IsNotNull,
}

/// Either a named column or the special "Any column" pseudo-column. The wire
/// form is internally tagged: `{ kind: "named", name: "..." }` or
/// `{ kind: "any_column" }`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ColumnRef {
    Named { name: String },
    AnyColumn,
}

/// A single condition leaf — a column / operator / optional value triple. The
/// `value` shape varies by operator (scalar / array / `{min, max}` / absent),
/// so it lands here as `serde_json::Value` and is validated when the predicate
/// is compiled.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Condition {
    pub column: ColumnRef,
    pub op: Operator,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<JsonValue>,
}

/// One node of the filter tree — either a condition leaf or an OR group. The
/// wire form is internally tagged:
/// - `{ kind: "condition", column, op, value? }`
/// - `{ kind: "or_group", children: [...] }`
///
/// The `or_group` arm carries `Vec<FilterNode>` so the wire shape is uniform;
/// nested `or_group` inside another `or_group` is rejected at validation time
/// (see `validate_filter_tree`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FilterNode {
    Condition(Condition),
    OrGroup { children: Vec<FilterNode> },
}

/// Recursive filter payload: an implicit AND root joining condition leaves
/// and OR groups.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FilterTree {
    #[serde(default)]
    pub children: Vec<FilterNode>,
}

#[derive(Debug, Deserialize)]
pub struct QueryTableOptions {
    pub limit: i64,
    pub offset: i64,
    #[serde(default)]
    pub order_by: Vec<OrderBy>,
    #[serde(default)]
    pub filter_tree: Option<FilterTree>,
    #[serde(default)]
    pub raw_where: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct CountTableOptions {
    #[serde(default)]
    pub filter_tree: Option<FilterTree>,
    #[serde(default)]
    pub raw_where: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AppliedQuery {
    pub limit: i64,
    pub offset: i64,
    pub order_by: Vec<OrderBy>,
    pub filter_tree: Option<FilterTree>,
    pub raw_where: Option<String>,
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

/// Placeholder template for a single bound parameter. `Plain` renders to
/// `$N`; `Cast` renders to `$N::<type>` so Postgres parses the bound text
/// into the column's expected type.
#[derive(Debug, Clone)]
enum PlaceholderTemplate {
    Plain,
    Cast(String),
}

impl PlaceholderTemplate {
    fn render(&self, idx: usize) -> String {
        match self {
            PlaceholderTemplate::Plain => format!("${idx}"),
            PlaceholderTemplate::Cast(t) => format!("${idx}::{t}"),
        }
    }
}

/// One bound parameter ready to push into the params Vec, paired with the
/// placeholder template the SQL builder must render at the param's position.
struct BoundParam {
    value: Box<dyn ToSql + Sync + Send>,
    placeholder: PlaceholderTemplate,
}

/// How a JSON filter value should be coerced for binding against a given
/// Postgres column type. Drives both the Rust target type and the placeholder
/// shape (plain `$N` or a `$N::<type>` cast).
#[derive(Debug, Clone)]
enum BindKind {
    Int2,
    Int4,
    Int8,
    Float4,
    Float8,
    Numeric,
    Bool,
    Text,
    Uuid,
    Date,
    Time,
    TimeTz,
    Timestamp,
    TimestampTz,
    Bytea,
    Json,
    Jsonb,
    /// Catch-all for column types we don't have a native mapping for.
    /// We bind a `String` and let Postgres parse it via `$N::<type>`.
    Fallback(String),
}

/// Strip parameterized modifiers from a `pg_catalog.format_type` string and
/// lowercase it. Examples:
/// - `varchar(255)` → `varchar`
/// - `numeric(10,2)` → `numeric`
/// - `timestamp(6) with time zone` → `timestamp with time zone`
/// - `character varying(50)` → `character varying`
fn normalize_pg_type(raw: &str) -> String {
    let lower = raw.trim().to_ascii_lowercase();
    let mut stripped = String::with_capacity(lower.len());
    let mut depth: u32 = 0;
    for ch in lower.chars() {
        match ch {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ if depth == 0 => stripped.push(ch),
            _ => {}
        }
    }
    // Collapse runs of whitespace introduced by elided modifiers, e.g.
    // `timestamp  with time zone` → `timestamp with time zone`.
    let mut collapsed = String::with_capacity(stripped.len());
    let mut prev_space = false;
    for ch in stripped.chars() {
        if ch == ' ' || ch == '\t' {
            if !prev_space {
                collapsed.push(' ');
            }
            prev_space = true;
        } else {
            collapsed.push(ch);
            prev_space = false;
        }
    }
    collapsed.trim().to_string()
}

/// Pick the bind kind for a Postgres column type. The input is the raw
/// `data_type` from `pg_catalog.format_type` (already what `list_columns`
/// returns).
fn bind_kind_for_type(data_type: &str) -> BindKind {
    let normalized = normalize_pg_type(data_type);
    match normalized.as_str() {
        "smallint" | "int2" | "smallserial" | "serial2" => BindKind::Int2,
        "integer" | "int" | "int4" | "serial" | "serial4" => BindKind::Int4,
        "bigint" | "int8" | "bigserial" | "serial8" => BindKind::Int8,
        "real" | "float4" => BindKind::Float4,
        "double precision" | "float8" => BindKind::Float8,
        "numeric" | "decimal" => BindKind::Numeric,
        "boolean" | "bool" => BindKind::Bool,
        "text" | "character varying" | "varchar" | "character" | "char" | "bpchar" | "name"
        | "citext" => BindKind::Text,
        "uuid" => BindKind::Uuid,
        "date" => BindKind::Date,
        "time" | "time without time zone" => BindKind::Time,
        "time with time zone" | "timetz" => BindKind::TimeTz,
        "timestamp" | "timestamp without time zone" => BindKind::Timestamp,
        "timestamp with time zone" | "timestamptz" => BindKind::TimestampTz,
        "bytea" => BindKind::Bytea,
        "json" => BindKind::Json,
        "jsonb" => BindKind::Jsonb,
        _ => BindKind::Fallback(normalized),
    }
}

/// Per-relation index from column name → bind kind. Built once per filter
/// compile and consulted per condition.
struct ColumnTypeIndex {
    kinds: HashMap<String, BindKind>,
}

impl ColumnTypeIndex {
    fn from_columns(columns: &[DataColumn]) -> Self {
        let mut kinds = HashMap::with_capacity(columns.len());
        for c in columns {
            kinds.insert(c.name.clone(), bind_kind_for_type(&c.data_type));
        }
        Self { kinds }
    }

    fn kind_for(&self, name: &str) -> Option<&BindKind> {
        self.kinds.get(name)
    }
}

/// Short rendering of a JSON value for inclusion in validation messages.
fn repr_for_error(v: &JsonValue) -> String {
    match v {
        JsonValue::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn parse_int_value(v: &JsonValue, column: &str) -> AppResult<i64> {
    match v {
        JsonValue::Number(n) => n.as_i64().ok_or_else(|| {
            AppError::Validation(format!(
                "expected integer for column '{column}', got '{}'",
                repr_for_error(v)
            ))
        }),
        JsonValue::String(s) => s.trim().parse::<i64>().map_err(|_| {
            AppError::Validation(format!(
                "expected integer for column '{column}', got '{}'",
                repr_for_error(v)
            ))
        }),
        _ => Err(AppError::Validation(format!(
            "expected integer for column '{column}', got '{}'",
            repr_for_error(v)
        ))),
    }
}

fn parse_float_value(v: &JsonValue, column: &str) -> AppResult<f64> {
    match v {
        JsonValue::Number(n) => n.as_f64().ok_or_else(|| {
            AppError::Validation(format!(
                "expected number for column '{column}', got '{}'",
                repr_for_error(v)
            ))
        }),
        JsonValue::String(s) => s.trim().parse::<f64>().map_err(|_| {
            AppError::Validation(format!(
                "expected number for column '{column}', got '{}'",
                repr_for_error(v)
            ))
        }),
        _ => Err(AppError::Validation(format!(
            "expected number for column '{column}', got '{}'",
            repr_for_error(v)
        ))),
    }
}

fn coerce_to_string(v: &JsonValue) -> String {
    match v {
        JsonValue::String(s) => s.clone(),
        JsonValue::Number(n) => n.to_string(),
        JsonValue::Bool(b) => b.to_string(),
        // bind_value rejects Null/Array/Object before this is reached.
        other => other.to_string(),
    }
}

/// Convert a JSON filter value into an owned `ToSql` parameter typed for the
/// column's resolved Postgres data type, plus the placeholder template the
/// SQL builder must render. `null` is rejected — the caller MUST use
/// `IS NULL` / `IS NOT NULL` instead.
fn bind_value(v: &JsonValue, column: &str, kind: &BindKind) -> AppResult<BoundParam> {
    if matches!(v, JsonValue::Null) {
        return Err(AppError::Validation(
            "null filter value not allowed; use IS NULL / IS NOT NULL".into(),
        ));
    }
    if matches!(v, JsonValue::Array(_) | JsonValue::Object(_)) {
        return Err(AppError::Validation(
            "array/object filter values are not supported".into(),
        ));
    }
    match kind {
        BindKind::Int2 => {
            let n = parse_int_value(v, column)?;
            let n16 = i16::try_from(n).map_err(|_| {
                AppError::Validation(format!(
                    "value {n} out of range for column '{column}' (smallint)"
                ))
            })?;
            Ok(BoundParam {
                value: Box::new(n16),
                placeholder: PlaceholderTemplate::Plain,
            })
        }
        BindKind::Int4 => {
            let n = parse_int_value(v, column)?;
            let n32 = i32::try_from(n).map_err(|_| {
                AppError::Validation(format!(
                    "value {n} out of range for column '{column}' (integer)"
                ))
            })?;
            Ok(BoundParam {
                value: Box::new(n32),
                placeholder: PlaceholderTemplate::Plain,
            })
        }
        BindKind::Int8 => {
            let n = parse_int_value(v, column)?;
            Ok(BoundParam {
                value: Box::new(n),
                placeholder: PlaceholderTemplate::Plain,
            })
        }
        BindKind::Float4 => {
            let n = parse_float_value(v, column)?;
            Ok(BoundParam {
                value: Box::new(n as f32),
                placeholder: PlaceholderTemplate::Plain,
            })
        }
        BindKind::Float8 => {
            let n = parse_float_value(v, column)?;
            Ok(BoundParam {
                value: Box::new(n),
                placeholder: PlaceholderTemplate::Plain,
            })
        }
        BindKind::Numeric => {
            let s = match v {
                JsonValue::Number(n) => n.to_string(),
                JsonValue::String(s) => s.clone(),
                _ => {
                    return Err(AppError::Validation(format!(
                        "expected numeric for column '{column}', got '{}'",
                        repr_for_error(v)
                    )))
                }
            };
            Ok(BoundParam {
                value: Box::new(s),
                placeholder: PlaceholderTemplate::Cast("numeric".into()),
            })
        }
        BindKind::Bool => match v {
            JsonValue::Bool(b) => Ok(BoundParam {
                value: Box::new(*b),
                placeholder: PlaceholderTemplate::Plain,
            }),
            _ => Err(AppError::Validation(format!(
                "expected boolean for column '{column}', got '{}'",
                repr_for_error(v)
            ))),
        },
        BindKind::Text => Ok(BoundParam {
            value: Box::new(coerce_to_string(v)),
            placeholder: PlaceholderTemplate::Plain,
        }),
        BindKind::Uuid => Ok(BoundParam {
            value: Box::new(coerce_to_string(v)),
            placeholder: PlaceholderTemplate::Cast("uuid".into()),
        }),
        BindKind::Date => Ok(BoundParam {
            value: Box::new(coerce_to_string(v)),
            placeholder: PlaceholderTemplate::Cast("date".into()),
        }),
        BindKind::Time => Ok(BoundParam {
            value: Box::new(coerce_to_string(v)),
            placeholder: PlaceholderTemplate::Cast("time".into()),
        }),
        BindKind::TimeTz => Ok(BoundParam {
            value: Box::new(coerce_to_string(v)),
            placeholder: PlaceholderTemplate::Cast("timetz".into()),
        }),
        BindKind::Timestamp => Ok(BoundParam {
            value: Box::new(coerce_to_string(v)),
            placeholder: PlaceholderTemplate::Cast("timestamp".into()),
        }),
        BindKind::TimestampTz => Ok(BoundParam {
            value: Box::new(coerce_to_string(v)),
            placeholder: PlaceholderTemplate::Cast("timestamptz".into()),
        }),
        BindKind::Bytea => Ok(BoundParam {
            value: Box::new(coerce_to_string(v)),
            placeholder: PlaceholderTemplate::Cast("bytea".into()),
        }),
        BindKind::Json => Ok(BoundParam {
            value: Box::new(coerce_to_string(v)),
            placeholder: PlaceholderTemplate::Cast("json".into()),
        }),
        BindKind::Jsonb => Ok(BoundParam {
            value: Box::new(coerce_to_string(v)),
            placeholder: PlaceholderTemplate::Cast("jsonb".into()),
        }),
        BindKind::Fallback(type_name) => Ok(BoundParam {
            value: Box::new(coerce_to_string(v)),
            placeholder: PlaceholderTemplate::Cast(type_name.clone()),
        }),
    }
}

/// SQL fragment for a single-bound binary operator. Caller has already
/// pushed the parameter and computed the placeholder index.
fn binary_op_sql(col_with_cast: &str, op: Operator, placeholder: &str) -> String {
    match op {
        Operator::Eq => format!("{col_with_cast} = {placeholder}"),
        Operator::Ne => format!("{col_with_cast} <> {placeholder}"),
        Operator::Lt => format!("{col_with_cast} < {placeholder}"),
        Operator::Le => format!("{col_with_cast} <= {placeholder}"),
        Operator::Gt => format!("{col_with_cast} > {placeholder}"),
        Operator::Ge => format!("{col_with_cast} >= {placeholder}"),
        Operator::Like => format!("{col_with_cast} LIKE {placeholder}"),
        Operator::NotLike => format!("{col_with_cast} NOT LIKE {placeholder}"),
        Operator::Ilike => format!("{col_with_cast} ILIKE {placeholder}"),
        Operator::NotIlike => format!("{col_with_cast} NOT ILIKE {placeholder}"),
        Operator::Contains => {
            format!("{col_with_cast} ILIKE '%' || {placeholder} || '%'")
        }
        Operator::StartsWith => format!("{col_with_cast} ILIKE {placeholder} || '%'"),
        Operator::EndsWith => format!("{col_with_cast} ILIKE '%' || {placeholder}"),
        // Multi-bound / value-less operators are not handled here — callers
        // must dispatch on operator before calling this.
        Operator::In
        | Operator::NotIn
        | Operator::Between
        | Operator::IsNull
        | Operator::IsNotNull => {
            unreachable!("binary_op_sql called with multi-bound or value-less operator");
        }
    }
}

/// Pattern operators always bind text on both sides. The frontend gates
/// these to text-family columns; on the backend we still force `BindKind::Text`
/// so the placeholder stays plain `$N` and the bind type is `String`.
fn is_pattern_operator(op: Operator) -> bool {
    matches!(
        op,
        Operator::Like
            | Operator::NotLike
            | Operator::Ilike
            | Operator::NotIlike
            | Operator::Contains
            | Operator::StartsWith
            | Operator::EndsWith
    )
}

/// Compile one column / operator / value triple to a parametrized SQL
/// fragment. `cast_suffix` is `""` for normal references and `"::text"` for
/// Any-column branches. `kind` is the bind kind resolved from the column's
/// data type — pattern operators override it to `Text`.
fn predicate_for(
    column_name: &str,
    op: Operator,
    value: Option<&JsonValue>,
    cast_suffix: &str,
    kind: &BindKind,
    params: &mut Vec<Box<dyn ToSql + Sync + Send>>,
) -> AppResult<String> {
    let col_with_cast = format!("{}{}", quote_ident(column_name), cast_suffix);
    let effective_kind: &BindKind = if is_pattern_operator(op) {
        &BindKind::Text
    } else {
        kind
    };
    match op {
        Operator::IsNull => {
            if value.is_some_and(|v| !matches!(v, JsonValue::Null)) {
                return Err(AppError::Validation(
                    "IS NULL must not carry a value".into(),
                ));
            }
            Ok(format!("{col_with_cast} IS NULL"))
        }
        Operator::IsNotNull => {
            if value.is_some_and(|v| !matches!(v, JsonValue::Null)) {
                return Err(AppError::Validation(
                    "IS NOT NULL must not carry a value".into(),
                ));
            }
            Ok(format!("{col_with_cast} IS NOT NULL"))
        }
        Operator::Between => {
            let v = value
                .ok_or_else(|| AppError::Validation("BETWEEN requires { min, max }".into()))?;
            let obj = v.as_object().ok_or_else(|| {
                AppError::Validation("BETWEEN requires { min, max } object".into())
            })?;
            let min = obj
                .get("min")
                .ok_or_else(|| AppError::Validation("BETWEEN missing `min`".into()))?;
            let max = obj
                .get("max")
                .ok_or_else(|| AppError::Validation("BETWEEN missing `max`".into()))?;
            let bmin = bind_value(min, column_name, effective_kind)?;
            params.push(bmin.value);
            let ph_min = bmin.placeholder.render(params.len());
            let bmax = bind_value(max, column_name, effective_kind)?;
            params.push(bmax.value);
            let ph_max = bmax.placeholder.render(params.len());
            Ok(format!("{col_with_cast} BETWEEN {ph_min} AND {ph_max}"))
        }
        Operator::In | Operator::NotIn => {
            let v = value
                .ok_or_else(|| AppError::Validation("In/NotIn require an array value".into()))?;
            let arr = v
                .as_array()
                .ok_or_else(|| AppError::Validation("In/NotIn require an array value".into()))?;
            if arr.is_empty() {
                return Err(AppError::Validation(
                    "In/NotIn require a non-empty array".into(),
                ));
            }
            let mut placeholders = Vec::with_capacity(arr.len());
            for item in arr {
                let bound = bind_value(item, column_name, effective_kind)?;
                params.push(bound.value);
                placeholders.push(bound.placeholder.render(params.len()));
            }
            let kw = if matches!(op, Operator::In) {
                "IN"
            } else {
                "NOT IN"
            };
            Ok(format!(
                "{col_with_cast} {kw} ({})",
                placeholders.join(", ")
            ))
        }
        // Single-bound binary ops.
        _ => {
            let v =
                value.ok_or_else(|| AppError::Validation("operator requires a value".into()))?;
            let bound = bind_value(v, column_name, effective_kind)?;
            params.push(bound.value);
            let placeholder = bound.placeholder.render(params.len());
            Ok(binary_op_sql(&col_with_cast, op, &placeholder))
        }
    }
}

/// True for Postgres types that survive a `::text` cast in a way the user
/// expects when searching across "any column". Bytea is excluded (cast yields
/// the hex-escaped form, never what a user typed); composite/row types are
/// excluded because their text rep is implementation-defined and noisy.
///
/// `data_type` here comes from `pg_catalog.format_type` — the same source
/// `list_columns` uses — so builtin types arrive as canonical lowercase
/// tokens (e.g. `text`, `timestamp without time zone`, `numeric(10,2)`).
fn text_castable(data_type: &str) -> bool {
    let t = data_type.trim().to_ascii_lowercase();
    let head = t.split('(').next().unwrap_or(&t).trim();

    if head == "bytea" {
        return false;
    }
    // Composite / row types come back as either `record` or as a qualified
    // user type. Heuristic: builtin types are a flat set of lowercase tokens;
    // anything containing a `.` (qualified user type) is opaque to us.
    if head.contains('.') || head.contains('"') {
        return false;
    }
    // Builtin allow-list. Arrays (suffix `[]`) of these are also castable.
    let mut base = head;
    if let Some(stripped) = base.strip_suffix("[]") {
        base = stripped.trim();
    }
    matches!(
        base,
        "text"
            | "character varying"
            | "varchar"
            | "character"
            | "char"
            | "bpchar"
            | "name"
            | "citext"
            | "uuid"
            | "json"
            | "jsonb"
            | "boolean"
            | "bool"
            | "smallint"
            | "int2"
            | "integer"
            | "int4"
            | "bigint"
            | "int8"
            | "real"
            | "float4"
            | "double precision"
            | "float8"
            | "numeric"
            | "decimal"
            | "money"
            | "date"
            | "time"
            | "time without time zone"
            | "time with time zone"
            | "timetz"
            | "timestamp"
            | "timestamp without time zone"
            | "timestamp with time zone"
            | "timestamptz"
            | "interval"
            | "smallserial"
            | "serial"
            | "bigserial"
            | "inet"
            | "cidr"
            | "macaddr"
            | "macaddr8"
            | "xml"
    )
}

/// Validate that an operator is allowed on the Any-column pseudo-column.
/// Per spec, comparators / `BETWEEN` / `In` / null variants are rejected
/// (the SQL would be nonsensical or the result misleading).
fn validate_any_column_operator(op: Operator) -> AppResult<()> {
    match op {
        Operator::Eq
        | Operator::Ne
        | Operator::Like
        | Operator::NotLike
        | Operator::Ilike
        | Operator::NotIlike
        | Operator::Contains
        | Operator::StartsWith
        | Operator::EndsWith => Ok(()),
        _ => Err(AppError::Validation(format!(
            "operator {op:?} is not allowed on Any column"
        ))),
    }
}

/// Expand an Any-column condition into a parenthesized OR-of-per-column
/// predicates. The same parameter slot (`$n`) is shared across every branch.
fn expand_any_column(
    op: Operator,
    value: Option<&JsonValue>,
    columns: &[DataColumn],
    params: &mut Vec<Box<dyn ToSql + Sync + Send>>,
) -> AppResult<String> {
    validate_any_column_operator(op)?;
    let castable: Vec<&DataColumn> = columns
        .iter()
        .filter(|c| text_castable(&c.data_type))
        .collect();
    if castable.is_empty() {
        return Ok("(FALSE)".to_string());
    }
    // All allowed Any-column ops are single-bound binary ops, so we push
    // the value once and reuse the placeholder across every branch. The
    // column is cast to `::text` on the SQL side, so the bind is text.
    let v =
        value.ok_or_else(|| AppError::Validation("Any column operator requires a value".into()))?;
    let bound = bind_value(v, "any_column", &BindKind::Text)?;
    params.push(bound.value);
    let ph = bound.placeholder.render(params.len());
    let parts: Vec<String> = castable
        .iter()
        .map(|c| {
            let col_cast = format!("{}::text", quote_ident(&c.name));
            binary_op_sql(&col_cast, op, &ph)
        })
        .collect();
    Ok(format!("({})", parts.join(" OR ")))
}

fn compile_condition(
    cond: &Condition,
    columns: &[DataColumn],
    column_index: &ColumnTypeIndex,
    params: &mut Vec<Box<dyn ToSql + Sync + Send>>,
) -> AppResult<String> {
    match &cond.column {
        ColumnRef::Named { name } => {
            let kind = column_index.kind_for(name).ok_or_else(|| {
                AppError::Validation(format!("filter references unknown column '{name}'"))
            })?;
            predicate_for(name, cond.op, cond.value.as_ref(), "", kind, params)
        }
        ColumnRef::AnyColumn => expand_any_column(cond.op, cond.value.as_ref(), columns, params),
    }
}

/// Reject trees that violate the one-level-of-nesting rule. Conditions are
/// always fine; or_group children must all be conditions.
fn validate_filter_tree(tree: &FilterTree) -> AppResult<()> {
    for node in &tree.children {
        if let FilterNode::OrGroup { children } = node {
            for c in children {
                if let FilterNode::OrGroup { .. } = c {
                    return Err(AppError::Validation(
                        "or_group inside or_group is not allowed".into(),
                    ));
                }
            }
        }
    }
    Ok(())
}

/// Walk the tree and emit the AND-joined root with parenthesized OR groups.
/// Returns an empty string when the tree has no children (caller decides
/// whether to emit a `WHERE` keyword).
pub(crate) fn compile_filter_tree(
    tree: &FilterTree,
    columns: &[DataColumn],
    params: &mut Vec<Box<dyn ToSql + Sync + Send>>,
) -> AppResult<String> {
    validate_filter_tree(tree)?;
    if tree.children.is_empty() {
        return Ok(String::new());
    }
    let column_index = ColumnTypeIndex::from_columns(columns);
    let mut parts = Vec::with_capacity(tree.children.len());
    for node in &tree.children {
        match node {
            FilterNode::Condition(c) => {
                parts.push(compile_condition(c, columns, &column_index, params)?);
            }
            FilterNode::OrGroup { children } => {
                let mut inner = Vec::with_capacity(children.len());
                for c in children {
                    match c {
                        FilterNode::Condition(cond) => {
                            inner.push(compile_condition(cond, columns, &column_index, params)?);
                        }
                        FilterNode::OrGroup { .. } => {
                            // Rejected by validate_filter_tree, but be explicit.
                            return Err(AppError::Validation(
                                "or_group inside or_group is not allowed".into(),
                            ));
                        }
                    }
                }
                if inner.is_empty() {
                    // Empty OR group is a no-op; skip it (UI auto-collapses).
                    continue;
                }
                parts.push(format!("({})", inner.join(" OR ")));
            }
        }
    }
    if parts.is_empty() {
        return Ok(String::new());
    }
    Ok(parts.join(" AND "))
}

/// Build the WHERE body for either filter_tree (parametrized) or raw_where
/// (verbatim). Mutually exclusive: both set is a validation error.
fn build_where_body(
    filter_tree: Option<&FilterTree>,
    raw_where: Option<&str>,
    columns: &[DataColumn],
    params: &mut Vec<Box<dyn ToSql + Sync + Send>>,
) -> AppResult<String> {
    if filter_tree.is_some() && raw_where.is_some() {
        return Err(AppError::Validation(
            "filter_tree and raw_where are mutually exclusive".into(),
        ));
    }
    if let Some(raw) = raw_where {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Ok(String::new());
        }
        return Ok(trimmed.to_string());
    }
    if let Some(tree) = filter_tree {
        return compile_filter_tree(tree, columns, params);
    }
    Ok(String::new())
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
    filter_tree: Option<&FilterTree>,
    raw_where: Option<&str>,
    columns: &[DataColumn],
    limit: i64,
    offset: i64,
) -> AppResult<(String, Vec<Box<dyn ToSql + Sync + Send>>)> {
    let mut params: Vec<Box<dyn ToSql + Sync + Send>> = Vec::new();
    let where_body = build_where_body(filter_tree, raw_where, columns, &mut params)?;
    let where_sql = if where_body.is_empty() {
        String::new()
    } else {
        format!(" WHERE {where_body}")
    };
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
    filter_tree: Option<&FilterTree>,
    raw_where: Option<&str>,
    columns: &[DataColumn],
) -> AppResult<(String, Vec<Box<dyn ToSql + Sync + Send>>)> {
    let mut params: Vec<Box<dyn ToSql + Sync + Send>> = Vec::new();
    let where_body = build_where_body(filter_tree, raw_where, columns, &mut params)?;
    let where_sql = if where_body.is_empty() {
        String::new()
    } else {
        format!(" WHERE {where_body}")
    };
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

pub(super) async fn list_columns(
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

pub(super) fn process_row(
    json_text: &str,
    columns: &[DataColumn],
    truncated_columns: &mut Vec<String>,
) -> AppResult<Vec<JsonValue>> {
    let parsed: JsonValue = serde_json::from_str(json_text)
        .map_err(|e| AppError::postgres(format!("decode row_to_json: {e}")))?;
    let obj = match parsed {
        JsonValue::Object(m) => m,
        _ => return Err(AppError::postgres("row_to_json did not return an object")),
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
pub(super) async fn fire_cancel(cancel_token: tokio_postgres::CancelToken, sslmode: SslMode) {
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
    app: AppHandle,
    pools: State<'_, PgPoolRegistry>,
    id: String,
    schema: String,
    relation: String,
    options: serde_json::Value,
    origin: Option<Origin>,
) -> AppResult<QueryTableResult> {
    let started = Instant::now();
    let activity_origin = origin.unwrap_or_default();
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
    if opts.filter_tree.is_some() && opts.raw_where.is_some() {
        return Err(AppError::Validation(
            "filter_tree and raw_where are mutually exclusive".into(),
        ));
    }

    tracing::info!(
        "postgres_query_table: id={parsed} schema={schema} relation={relation} \
         limit={} offset={} order={} structured={} raw={}",
        opts.limit,
        opts.offset,
        opts.order_by.len(),
        opts.filter_tree
            .as_ref()
            .map(|t| t.children.len())
            .unwrap_or(0),
        opts.raw_where.as_deref().map(|s| s.len()).unwrap_or(0)
    );

    let mut emitted_sql: Option<String> = None;
    let mut emitted_params: Option<Vec<String>> = None;
    let inner: AppResult<QueryTableResult> = async {
        let sslmode = pools.sslmode_for(&parsed).await?;
        let client = pools.acquire(&parsed).await?;
        let cancel_token = client.cancel_token();

        let columns = match timeout(QUERY_TIMEOUT, list_columns(&client, &schema, &relation)).await
        {
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
            opts.filter_tree.as_ref(),
            opts.raw_where.as_deref(),
            &columns,
            opts.limit,
            opts.offset,
        )?;
        tracing::debug!("postgres_query_table sql: {sql}");
        emitted_sql = Some(sql.clone());
        emitted_params = Some(format_params(&params));

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
            filter_tree: opts.filter_tree.clone(),
            raw_where: opts.raw_where.clone(),
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
    .await;

    let total_ms = started.elapsed().as_millis() as u64;
    let mut builder =
        ActivityLogEntryBuilder::new(ActivityKind::QueryTable, activity_origin, total_ms)
            .connection(parsed);
    if let Some(sql) = emitted_sql {
        builder = builder.sql(sql);
    }
    if let Some(params) = emitted_params {
        builder = builder.params(params);
    }
    match &inner {
        Ok(r) => emit_activity(
            &app,
            builder.ok(Some(Metric::Rows {
                value: r.rows.len() as u64,
            })),
        ),
        Err(e) => emit_activity(&app, builder.err(e)),
    }
    inner
}

#[tauri::command]
pub async fn postgres_count_table(
    app: AppHandle,
    pools: State<'_, PgPoolRegistry>,
    id: String,
    schema: String,
    relation: String,
    options: Option<serde_json::Value>,
    origin: Option<Origin>,
) -> AppResult<CountTableResult> {
    let started = Instant::now();
    let activity_origin = origin.unwrap_or_default();
    let parsed = parse_id(&id)?;
    let opts: CountTableOptions = match options {
        Some(v) => serde_json::from_value(v)
            .map_err(|e| AppError::Validation(format!("invalid count options: {e}")))?,
        None => CountTableOptions::default(),
    };

    if opts.filter_tree.is_some() && opts.raw_where.is_some() {
        return Err(AppError::Validation(
            "filter_tree and raw_where are mutually exclusive".into(),
        ));
    }

    tracing::info!(
        "postgres_count_table: id={parsed} schema={schema} relation={relation} \
         structured={} raw={}",
        opts.filter_tree
            .as_ref()
            .map(|t| t.children.len())
            .unwrap_or(0),
        opts.raw_where.as_deref().map(|s| s.len()).unwrap_or(0)
    );

    let mut emitted_sql: Option<String> = None;
    let mut emitted_params: Option<Vec<String>> = None;
    let inner: AppResult<CountTableResult> = async {
        let sslmode = pools.sslmode_for(&parsed).await?;
        let client = pools.acquire(&parsed).await?;
        let cancel_token = client.cancel_token();

        // The Any-column expansion needs the column list. List_columns is
        // cheap and gives us the canonical type strings.
        let columns = match timeout(QUERY_TIMEOUT, list_columns(&client, &schema, &relation)).await
        {
            Ok(r) => r?,
            Err(_) => {
                fire_cancel(cancel_token, sslmode).await;
                drop(client);
                return Err(AppError::postgres_with_code(
                    "57014",
                    format!(
                        "count timed out resolving columns ({}s)",
                        QUERY_TIMEOUT.as_secs()
                    ),
                ));
            }
        };

        let (sql, params) = build_count_sql(
            &schema,
            &relation,
            opts.filter_tree.as_ref(),
            opts.raw_where.as_deref(),
            &columns,
        )?;
        tracing::debug!("postgres_count_table sql: {sql}");
        emitted_sql = Some(sql.clone());
        emitted_params = Some(format_params(&params));

        let param_refs: Vec<&(dyn ToSql + Sync)> = params
            .iter()
            .map(|b| b.as_ref() as &(dyn ToSql + Sync))
            .collect();

        let cancel_token_for_query = client.cancel_token();
        let query_started = Instant::now();
        let row = match timeout(QUERY_TIMEOUT, client.query_one(&sql, &param_refs)).await {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => return Err(AppError::from(e)),
            Err(_) => {
                fire_cancel(cancel_token_for_query, sslmode).await;
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
    .await;

    let total_ms = started.elapsed().as_millis() as u64;
    let mut builder =
        ActivityLogEntryBuilder::new(ActivityKind::CountTable, activity_origin, total_ms)
            .connection(parsed);
    if let Some(sql) = emitted_sql {
        builder = builder.sql(sql);
    }
    if let Some(params) = emitted_params {
        builder = builder.params(params);
    }
    match &inner {
        Ok(r) => emit_activity(&app, builder.ok(Some(Metric::Count { value: r.count }))),
        Err(e) => emit_activity(&app, builder.err(e)),
    }
    inner
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

    fn col(name: &str, data_type: &str) -> DataColumn {
        DataColumn {
            name: name.into(),
            data_type: data_type.into(),
            ordinal_position: 1,
            is_nullable: true,
        }
    }

    fn cond(name: &str, op: Operator, value: Option<JsonValue>) -> FilterNode {
        FilterNode::Condition(Condition {
            column: ColumnRef::Named { name: name.into() },
            op,
            value,
        })
    }

    fn any_cond(op: Operator, value: Option<JsonValue>) -> FilterNode {
        FilterNode::Condition(Condition {
            column: ColumnRef::AnyColumn,
            op,
            value,
        })
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
            build_select_sql("public", "users", &[], None, None, &[], 200, 0).unwrap();
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
            build_select_sql("public", "users", &order, None, None, &[], 200, 0).unwrap();
        assert!(sql.contains("ORDER BY \"country\" ASC, \"created_at\" DESC"));
    }

    #[test]
    fn compile_filter_tree_empty_emits_no_where() {
        let tree = FilterTree::default();
        let mut params = Vec::new();
        let body = compile_filter_tree(&tree, &[], &mut params).unwrap();
        assert!(body.is_empty());
        assert!(params.is_empty());
    }

    #[test]
    fn compile_filter_tree_single_condition() {
        let tree = FilterTree {
            children: vec![cond("country", Operator::Eq, Some(json!("CL")))],
        };
        let cols = vec![col("country", "text")];
        let mut params = Vec::new();
        let body = compile_filter_tree(&tree, &cols, &mut params).unwrap();
        assert_eq!(body, "\"country\" = $1");
        assert_eq!(params.len(), 1);
    }

    #[test]
    fn compile_filter_tree_multiple_anded() {
        let tree = FilterTree {
            children: vec![
                cond("country", Operator::Eq, Some(json!("CL"))),
                cond("deleted_at", Operator::IsNull, None),
            ],
        };
        let cols = vec![
            col("country", "text"),
            col("deleted_at", "timestamp with time zone"),
        ];
        let mut params = Vec::new();
        let body = compile_filter_tree(&tree, &cols, &mut params).unwrap();
        assert_eq!(body, "\"country\" = $1 AND \"deleted_at\" IS NULL");
        assert_eq!(params.len(), 1);
    }

    #[test]
    fn compile_filter_tree_or_group_parenthesized() {
        let tree = FilterTree {
            children: vec![
                cond("country", Operator::Eq, Some(json!("CL"))),
                FilterNode::OrGroup {
                    children: vec![
                        cond("status", Operator::Eq, Some(json!("active"))),
                        cond("status", Operator::Eq, Some(json!("pending"))),
                    ],
                },
            ],
        };
        let cols = vec![col("country", "text"), col("status", "text")];
        let mut params = Vec::new();
        let body = compile_filter_tree(&tree, &cols, &mut params).unwrap();
        assert_eq!(
            body,
            "\"country\" = $1 AND (\"status\" = $2 OR \"status\" = $3)"
        );
        assert_eq!(params.len(), 3);
    }

    #[test]
    fn compile_filter_tree_or_group_with_one_child_still_parens() {
        let tree = FilterTree {
            children: vec![FilterNode::OrGroup {
                children: vec![cond("a", Operator::Eq, Some(json!(1)))],
            }],
        };
        let cols = vec![col("a", "integer")];
        let mut params = Vec::new();
        let body = compile_filter_tree(&tree, &cols, &mut params).unwrap();
        assert_eq!(body, "(\"a\" = $1)");
    }

    #[test]
    fn compile_filter_tree_rejects_nested_or_group() {
        let tree = FilterTree {
            children: vec![FilterNode::OrGroup {
                children: vec![FilterNode::OrGroup {
                    children: vec![cond("a", Operator::Eq, Some(json!(1)))],
                }],
            }],
        };
        let cols = vec![col("a", "integer")];
        let mut params = Vec::new();
        let err = compile_filter_tree(&tree, &cols, &mut params).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn compile_filter_tree_rejects_empty_in() {
        let tree = FilterTree {
            children: vec![cond("status", Operator::In, Some(json!([])))],
        };
        let cols = vec![col("status", "text")];
        let mut params = Vec::new();
        let err = compile_filter_tree(&tree, &cols, &mut params).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn compile_filter_tree_rejects_missing_between_bounds() {
        let tree = FilterTree {
            children: vec![cond("x", Operator::Between, Some(json!({ "min": 1 })))],
        };
        let cols = vec![col("x", "integer")];
        let mut params = Vec::new();
        let err = compile_filter_tree(&tree, &cols, &mut params).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn predicate_for_eq() {
        let mut params = Vec::new();
        let sql = predicate_for(
            "a",
            Operator::Eq,
            Some(&json!(1)),
            "",
            &BindKind::Int4,
            &mut params,
        )
        .unwrap();
        assert_eq!(sql, "\"a\" = $1");
        assert_eq!(params.len(), 1);
    }

    #[test]
    fn predicate_for_contains_uses_ilike_concat() {
        let mut params = Vec::new();
        let sql = predicate_for(
            "name",
            Operator::Contains,
            Some(&json!("ana")),
            "",
            &BindKind::Text,
            &mut params,
        )
        .unwrap();
        assert_eq!(sql, "\"name\" ILIKE '%' || $1 || '%'");
    }

    #[test]
    fn predicate_for_starts_with() {
        let mut params = Vec::new();
        let sql = predicate_for(
            "name",
            Operator::StartsWith,
            Some(&json!("ana")),
            "",
            &BindKind::Text,
            &mut params,
        )
        .unwrap();
        assert_eq!(sql, "\"name\" ILIKE $1 || '%'");
    }

    #[test]
    fn predicate_for_ends_with() {
        let mut params = Vec::new();
        let sql = predicate_for(
            "name",
            Operator::EndsWith,
            Some(&json!("ana")),
            "",
            &BindKind::Text,
            &mut params,
        )
        .unwrap();
        assert_eq!(sql, "\"name\" ILIKE '%' || $1");
    }

    #[test]
    fn predicate_for_in_binds_each_element() {
        let mut params = Vec::new();
        let sql = predicate_for(
            "status",
            Operator::In,
            Some(&json!(["a", "b", "c"])),
            "",
            &BindKind::Text,
            &mut params,
        )
        .unwrap();
        assert_eq!(sql, "\"status\" IN ($1, $2, $3)");
        assert_eq!(params.len(), 3);
    }

    #[test]
    fn predicate_for_not_in() {
        let mut params = Vec::new();
        let sql = predicate_for(
            "status",
            Operator::NotIn,
            Some(&json!(["a", "b"])),
            "",
            &BindKind::Text,
            &mut params,
        )
        .unwrap();
        assert_eq!(sql, "\"status\" NOT IN ($1, $2)");
    }

    #[test]
    fn predicate_for_between_binds_two() {
        let mut params = Vec::new();
        let sql = predicate_for(
            "created_at",
            Operator::Between,
            Some(&json!({ "min": "2026-01-01", "max": "2026-04-30" })),
            "",
            &BindKind::TimestampTz,
            &mut params,
        )
        .unwrap();
        assert_eq!(
            sql,
            "\"created_at\" BETWEEN $1::timestamptz AND $2::timestamptz"
        );
        assert_eq!(params.len(), 2);
    }

    #[test]
    fn predicate_for_is_null_uses_no_param() {
        let mut params = Vec::new();
        let sql = predicate_for(
            "a",
            Operator::IsNull,
            None,
            "",
            &BindKind::Int4,
            &mut params,
        )
        .unwrap();
        assert_eq!(sql, "\"a\" IS NULL");
        assert!(params.is_empty());
    }

    #[test]
    fn predicate_for_is_null_with_value_is_rejected() {
        let mut params = Vec::new();
        let err = predicate_for(
            "a",
            Operator::IsNull,
            Some(&json!("x")),
            "",
            &BindKind::Text,
            &mut params,
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn predicate_for_applies_cast_suffix() {
        let mut params = Vec::new();
        let sql = predicate_for(
            "a",
            Operator::Eq,
            Some(&json!("1")),
            "::text",
            &BindKind::Text,
            &mut params,
        )
        .unwrap();
        assert_eq!(sql, "\"a\"::text = $1");
    }

    #[test]
    fn text_castable_handles_common_types() {
        assert!(text_castable("text"));
        assert!(text_castable("integer"));
        assert!(text_castable("uuid"));
        assert!(text_castable("jsonb"));
        assert!(text_castable("timestamp without time zone"));
        assert!(text_castable("numeric(10,2)"));
        assert!(text_castable("text[]"));
        assert!(!text_castable("bytea"));
        assert!(!text_castable("public.my_composite_type"));
        assert!(!text_castable("\"public\".\"my_t\""));
    }

    #[test]
    fn expand_any_column_mixed_columns_skips_bytea_and_composite() {
        let cols = vec![
            col("name", "text"),
            col("payload", "bytea"),
            col("data", "public.my_composite_type"),
            col("notes", "text"),
        ];
        let mut params = Vec::new();
        let body = expand_any_column(
            Operator::Contains,
            Some(&json!("argus")),
            &cols,
            &mut params,
        )
        .unwrap();
        assert_eq!(
            body,
            "(\"name\"::text ILIKE '%' || $1 || '%' OR \"notes\"::text ILIKE '%' || $1 || '%')"
        );
        // Only one parameter is bound — shared $1 across branches.
        assert_eq!(params.len(), 1);
    }

    #[test]
    fn expand_any_column_only_bytea_compiles_to_false() {
        let cols = vec![col("a", "bytea"), col("b", "bytea")];
        let mut params = Vec::new();
        let body = expand_any_column(Operator::Eq, Some(&json!("x")), &cols, &mut params).unwrap();
        assert_eq!(body, "(FALSE)");
        assert!(params.is_empty());
    }

    #[test]
    fn expand_any_column_rejects_disallowed_operator() {
        let cols = vec![col("a", "text")];
        let mut params = Vec::new();
        let err = expand_any_column(
            Operator::Between,
            Some(&json!({ "min": 1, "max": 2 })),
            &cols,
            &mut params,
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn build_select_sql_filter_tree_eq_and_is_null() {
        let tree = FilterTree {
            children: vec![
                cond("country", Operator::Eq, Some(json!("CL"))),
                cond("deleted_at", Operator::IsNull, None),
            ],
        };
        let cols = vec![
            col("country", "text"),
            col("deleted_at", "timestamp with time zone"),
        ];
        let (sql, params) =
            build_select_sql("public", "users", &[], Some(&tree), None, &cols, 100, 0).unwrap();
        assert!(
            sql.contains("WHERE \"country\" = $1 AND \"deleted_at\" IS NULL"),
            "sql was: {sql}"
        );
        assert_eq!(params.len(), 1);
    }

    #[test]
    fn build_select_sql_raw_where_emits_verbatim() {
        let raw = "created_at > now() - interval '7 days' AND payload->>'source' = 'webhook'";
        let (sql, params) =
            build_select_sql("public", "events", &[], None, Some(raw), &[], 100, 0).unwrap();
        assert!(sql.contains(&format!("WHERE {raw}")), "sql was: {sql}");
        assert!(params.is_empty());
    }

    #[test]
    fn build_select_sql_raw_where_trims_surrounding_whitespace() {
        let (sql, _) =
            build_select_sql("public", "t", &[], None, Some("  a > 1  "), &[], 10, 0).unwrap();
        assert!(sql.contains("WHERE a > 1"));
    }

    #[test]
    fn build_select_sql_rejects_both_filter_tree_and_raw_where() {
        let tree = FilterTree::default();
        let err = build_select_sql("public", "t", &[], Some(&tree), Some("a > 1"), &[], 10, 0)
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn build_select_sql_quotes_identifiers_with_embedded_quote() {
        let tree = FilterTree {
            children: vec![cond("we\"ird", Operator::Eq, Some(json!("v")))],
        };
        let cols = vec![col("we\"ird", "text")];
        let (sql, _params) =
            build_select_sql("we\"ird", "we\"ird_t", &[], Some(&tree), None, &cols, 10, 0).unwrap();
        assert!(
            sql.contains("\"we\"\"ird\".\"we\"\"ird_t\""),
            "sql was: {sql}"
        );
        assert!(sql.contains("WHERE \"we\"\"ird\" = $1"));
    }

    #[test]
    fn build_count_sql_no_filters() {
        let (sql, params) = build_count_sql("public", "users", None, None, &[]).unwrap();
        assert_eq!(sql, "SELECT COUNT(*)::bigint FROM \"public\".\"users\"");
        assert!(params.is_empty());
    }

    #[test]
    fn build_count_sql_filter_tree_matches_params() {
        let tree = FilterTree {
            children: vec![
                cond("country", Operator::Eq, Some(json!("CL"))),
                cond("deleted_at", Operator::IsNull, None),
            ],
        };
        let cols = vec![
            col("country", "text"),
            col("deleted_at", "timestamp with time zone"),
        ];
        let (sql, params) = build_count_sql("public", "users", Some(&tree), None, &cols).unwrap();
        assert!(sql.contains("WHERE \"country\" = $1 AND \"deleted_at\" IS NULL"));
        assert_eq!(params.len(), 1);
    }

    #[test]
    fn build_count_sql_raw_where_inlines() {
        let (sql, params) =
            build_count_sql("public", "events", None, Some("created_at > now()"), &[]).unwrap();
        assert_eq!(
            sql,
            "SELECT COUNT(*)::bigint FROM \"public\".\"events\" WHERE created_at > now()"
        );
        assert!(params.is_empty());
    }

    #[test]
    fn null_filter_value_rejected() {
        let mut params = Vec::new();
        let err = predicate_for(
            "a",
            Operator::Eq,
            Some(&JsonValue::Null),
            "",
            &BindKind::Text,
            &mut params,
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn unknown_op_is_rejected_at_deserialize_time() {
        // The closed Operator enum rejects anything outside the spec set.
        let raw = json!("DROP");
        let r: Result<Operator, _> = serde_json::from_value(raw);
        assert!(r.is_err());
    }

    #[test]
    fn any_column_with_contains_compiles_via_expansion() {
        let cols = vec![
            col("name", "text"),
            col("email", "text"),
            col("notes", "text"),
        ];
        let tree = FilterTree {
            children: vec![any_cond(Operator::Contains, Some(json!("argus")))],
        };
        let mut params = Vec::new();
        let body = compile_filter_tree(&tree, &cols, &mut params).unwrap();
        assert_eq!(
            body,
            "(\"name\"::text ILIKE '%' || $1 || '%' OR \"email\"::text ILIKE '%' || $1 || '%' OR \"notes\"::text ILIKE '%' || $1 || '%')"
        );
        assert_eq!(params.len(), 1);
    }

    #[test]
    fn any_column_disallowed_operator_rejected_through_compile_path() {
        let cols = vec![col("a", "text")];
        let tree = FilterTree {
            children: vec![any_cond(Operator::Gt, Some(json!(1)))],
        };
        let mut params = Vec::new();
        let err = compile_filter_tree(&tree, &cols, &mut params).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
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

    // --- bind_value / column-typed parameter tests ---

    #[test]
    fn normalize_pg_type_strips_modifiers() {
        assert_eq!(normalize_pg_type("varchar(255)"), "varchar");
        assert_eq!(normalize_pg_type("numeric(10,2)"), "numeric");
        assert_eq!(
            normalize_pg_type("timestamp(6) with time zone"),
            "timestamp with time zone"
        );
        assert_eq!(
            normalize_pg_type("character varying(50)"),
            "character varying"
        );
        assert_eq!(normalize_pg_type("INTEGER"), "integer");
        assert_eq!(normalize_pg_type("  text  "), "text");
    }

    #[test]
    fn bind_kind_for_type_covers_common_postgres_types() {
        assert!(matches!(bind_kind_for_type("integer"), BindKind::Int4));
        assert!(matches!(bind_kind_for_type("int4"), BindKind::Int4));
        assert!(matches!(bind_kind_for_type("smallint"), BindKind::Int2));
        assert!(matches!(bind_kind_for_type("bigint"), BindKind::Int8));
        assert!(matches!(
            bind_kind_for_type("double precision"),
            BindKind::Float8
        ));
        assert!(matches!(
            bind_kind_for_type("numeric(10,2)"),
            BindKind::Numeric
        ));
        assert!(matches!(bind_kind_for_type("boolean"), BindKind::Bool));
        assert!(matches!(
            bind_kind_for_type("character varying(255)"),
            BindKind::Text
        ));
        assert!(matches!(bind_kind_for_type("uuid"), BindKind::Uuid));
        assert!(matches!(bind_kind_for_type("date"), BindKind::Date));
        assert!(matches!(
            bind_kind_for_type("timestamp with time zone"),
            BindKind::TimestampTz
        ));
        assert!(matches!(bind_kind_for_type("jsonb"), BindKind::Jsonb));
        // Fallback path
        match bind_kind_for_type("inet") {
            BindKind::Fallback(name) => assert_eq!(name, "inet"),
            other => panic!("expected fallback for inet, got {other:?}"),
        }
    }

    #[test]
    fn predicate_for_int4_binds_i32_with_plain_placeholder() {
        let mut params = Vec::new();
        let sql = predicate_for(
            "product_id",
            Operator::Eq,
            Some(&json!(20528)),
            "",
            &BindKind::Int4,
            &mut params,
        )
        .unwrap();
        assert_eq!(sql, "\"product_id\" = $1");
        assert_eq!(params.len(), 1);
        let dbg = format!("{:?}", params[0]);
        assert_eq!(dbg, "20528");
    }

    #[test]
    fn predicate_for_int8_binds_i64_with_plain_placeholder() {
        let mut params = Vec::new();
        let sql = predicate_for(
            "id",
            Operator::Eq,
            Some(&json!(9_223_372_036_854_775_000_i64)),
            "",
            &BindKind::Int8,
            &mut params,
        )
        .unwrap();
        assert_eq!(sql, "\"id\" = $1");
        let dbg = format!("{:?}", params[0]);
        assert_eq!(dbg, "9223372036854775000");
    }

    #[test]
    fn predicate_for_int4_accepts_string_form_of_integer() {
        let mut params = Vec::new();
        let sql = predicate_for(
            "product_id",
            Operator::Eq,
            Some(&json!("20528")),
            "",
            &BindKind::Int4,
            &mut params,
        )
        .unwrap();
        assert_eq!(sql, "\"product_id\" = $1");
        let dbg = format!("{:?}", params[0]);
        assert_eq!(dbg, "20528");
    }

    #[test]
    fn predicate_for_int4_rejects_non_integer_string() {
        let mut params = Vec::new();
        let err = predicate_for(
            "product_id",
            Operator::Eq,
            Some(&json!("abc")),
            "",
            &BindKind::Int4,
            &mut params,
        )
        .unwrap_err();
        match err {
            AppError::Validation(msg) => {
                assert!(
                    msg.contains("expected integer for column 'product_id'"),
                    "msg was: {msg}"
                );
                assert!(msg.contains("abc"), "msg was: {msg}");
            }
            other => panic!("expected validation, got {other:?}"),
        }
        assert!(params.is_empty());
    }

    #[test]
    fn predicate_for_int4_rejects_out_of_range() {
        let mut params = Vec::new();
        let err = predicate_for(
            "id",
            Operator::Eq,
            Some(&json!(99_999_999_999_i64)),
            "",
            &BindKind::Int4,
            &mut params,
        )
        .unwrap_err();
        match err {
            AppError::Validation(msg) => assert!(
                msg.contains("out of range") && msg.contains("'id'"),
                "msg was: {msg}"
            ),
            other => panic!("expected validation, got {other:?}"),
        }
    }

    #[test]
    fn predicate_for_numeric_casts_placeholder_and_binds_string() {
        let mut params = Vec::new();
        let sql = predicate_for(
            "price",
            Operator::Lt,
            Some(&json!(19.99)),
            "",
            &BindKind::Numeric,
            &mut params,
        )
        .unwrap();
        assert_eq!(sql, "\"price\" < $1::numeric");
        let dbg = format!("{:?}", params[0]);
        assert_eq!(dbg, "\"19.99\"");
    }

    #[test]
    fn predicate_for_uuid_casts_placeholder() {
        let mut params = Vec::new();
        let sql = predicate_for(
            "user_id",
            Operator::Eq,
            Some(&json!("550e8400-e29b-41d4-a716-446655440000")),
            "",
            &BindKind::Uuid,
            &mut params,
        )
        .unwrap();
        assert_eq!(sql, "\"user_id\" = $1::uuid");
        let dbg = format!("{:?}", params[0]);
        assert_eq!(dbg, "\"550e8400-e29b-41d4-a716-446655440000\"");
    }

    #[test]
    fn predicate_for_in_on_int4_binds_each_element_as_i32() {
        let mut params = Vec::new();
        let sql = predicate_for(
            "status_code",
            Operator::In,
            Some(&json!([200, 201, 204])),
            "",
            &BindKind::Int4,
            &mut params,
        )
        .unwrap();
        assert_eq!(sql, "\"status_code\" IN ($1, $2, $3)");
        assert_eq!(params.len(), 3);
        assert_eq!(format!("{:?}", params[0]), "200");
        assert_eq!(format!("{:?}", params[2]), "204");
    }

    #[test]
    fn predicate_for_fallback_inet_uses_typed_cast() {
        let mut params = Vec::new();
        let kind = BindKind::Fallback("inet".into());
        let sql = predicate_for(
            "addr",
            Operator::Eq,
            Some(&json!("192.168.1.1")),
            "",
            &kind,
            &mut params,
        )
        .unwrap();
        assert_eq!(sql, "\"addr\" = $1::inet");
        let dbg = format!("{:?}", params[0]);
        assert_eq!(dbg, "\"192.168.1.1\"");
    }

    #[test]
    fn compile_filter_tree_rejects_unknown_column() {
        let tree = FilterTree {
            children: vec![cond("does_not_exist", Operator::Eq, Some(json!(1)))],
        };
        let cols = vec![col("id", "integer")];
        let mut params = Vec::new();
        let err = compile_filter_tree(&tree, &cols, &mut params).unwrap_err();
        match err {
            AppError::Validation(msg) => assert!(
                msg.contains("filter references unknown column 'does_not_exist'"),
                "msg was: {msg}"
            ),
            other => panic!("expected validation, got {other:?}"),
        }
    }

    #[test]
    fn compile_filter_tree_repro_int4_product_id() {
        // The original bug repro: filtering an int4 column with a JSON
        // number used to bind as i64 and fail with "error serializing
        // parameter 0".
        let tree = FilterTree {
            children: vec![cond("product_id", Operator::Eq, Some(json!(20528)))],
        };
        let cols = vec![col("product_id", "integer")];
        let mut params = Vec::new();
        let body = compile_filter_tree(&tree, &cols, &mut params).unwrap();
        assert_eq!(body, "\"product_id\" = $1");
        assert_eq!(params.len(), 1);
        assert_eq!(format!("{:?}", params[0]), "20528");
    }

    #[test]
    fn compile_filter_tree_timestamptz_between_casts_both_bounds() {
        let tree = FilterTree {
            children: vec![cond(
                "due_date",
                Operator::Between,
                Some(json!({ "min": "2026-03-01", "max": "2026-03-31" })),
            )],
        };
        let cols = vec![col("due_date", "date")];
        let mut params = Vec::new();
        let body = compile_filter_tree(&tree, &cols, &mut params).unwrap();
        assert_eq!(body, "\"due_date\" BETWEEN $1::date AND $2::date");
        assert_eq!(params.len(), 2);
    }

    #[test]
    fn compile_filter_tree_contains_on_text_column_no_cast() {
        let tree = FilterTree {
            children: vec![cond(
                "description",
                Operator::Contains,
                Some(json!("argus")),
            )],
        };
        let cols = vec![col("description", "text")];
        let mut params = Vec::new();
        let body = compile_filter_tree(&tree, &cols, &mut params).unwrap();
        assert_eq!(body, "\"description\" ILIKE '%' || $1 || '%'");
        assert_eq!(format!("{:?}", params[0]), "\"argus\"");
    }

    #[test]
    fn compile_filter_tree_any_column_keeps_text_cast_on_column() {
        let tree = FilterTree {
            children: vec![any_cond(Operator::Contains, Some(json!("x")))],
        };
        let cols = vec![col("a", "integer"), col("b", "text")];
        let mut params = Vec::new();
        let body = compile_filter_tree(&tree, &cols, &mut params).unwrap();
        assert_eq!(
            body,
            "(\"a\"::text ILIKE '%' || $1 || '%' OR \"b\"::text ILIKE '%' || $1 || '%')"
        );
        assert_eq!(params.len(), 1);
    }
}
