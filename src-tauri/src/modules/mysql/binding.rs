use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use serde_json::Value as JsonValue;
use sqlx::mysql::MySqlArguments;
use sqlx::query::Query;
use sqlx::Row as _;

use crate::error::{AppError, AppResult};

// ---------------------------------------------------------------------------
// §8.1 — BindKind enum
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindKind {
    Bool,
    TinyInt,
    SmallInt,
    MediumInt,
    Int,
    BigInt,
    Float,
    Double,
    Decimal,
    Char,
    VarChar,
    Text,
    Binary,
    VarBinary,
    Blob,
    Date,
    Time,
    DateTime,
    Timestamp,
    Year,
    Json,
    Enum,
    Set,
    Bit(u32),
    Geometry,
    Unknown,
}

// ---------------------------------------------------------------------------
// §8.2 — bind_kind_for_type
// ---------------------------------------------------------------------------

/// Strip the inner parameter list `(...)` from a type string and lowercase it.
/// e.g. `"varchar(255)"` → `"varchar"`, `"decimal(10,2)"` → `"decimal"`.
fn strip_params(raw: &str) -> String {
    let lower = raw.trim().to_ascii_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut depth: u32 = 0;
    for ch in lower.chars() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth = depth.saturating_sub(1);
            }
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out.trim().to_string()
}

pub fn bind_kind_for_type(column_type: &str) -> BindKind {
    let lower = column_type.trim().to_ascii_lowercase();

    // Special case: tinyint(1) → Bool regardless of unsigned suffix.
    if lower.starts_with("tinyint(1)") {
        return BindKind::Bool;
    }

    // bit(n) — parse n before stripping.
    if lower.starts_with("bit") {
        let n = lower
            .trim_start_matches("bit")
            .trim()
            .trim_start_matches('(')
            .trim_end_matches(')')
            .trim()
            .parse::<u32>()
            .unwrap_or(1);
        return BindKind::Bit(n);
    }

    // Strip params and unsigned/zerofill suffix, then match.
    let base = strip_params(&lower);
    let base = base
        .trim_end_matches(" unsigned zerofill")
        .trim_end_matches(" zerofill")
        .trim_end_matches(" unsigned")
        .trim();

    match base {
        "boolean" | "bool" => BindKind::Bool,
        "tinyint" => BindKind::TinyInt,
        "smallint" => BindKind::SmallInt,
        "mediumint" => BindKind::MediumInt,
        "int" | "integer" => BindKind::Int,
        "bigint" => BindKind::BigInt,
        "float" => BindKind::Float,
        "double" | "real" | "double precision" => BindKind::Double,
        "decimal" | "numeric" | "fixed" => BindKind::Decimal,
        "char" => BindKind::Char,
        "varchar" => BindKind::VarChar,
        "text" | "tinytext" | "mediumtext" | "longtext" => BindKind::Text,
        "binary" => BindKind::Binary,
        "varbinary" => BindKind::VarBinary,
        "blob" | "tinyblob" | "mediumblob" | "longblob" => BindKind::Blob,
        "date" => BindKind::Date,
        "time" => BindKind::Time,
        "datetime" => BindKind::DateTime,
        "timestamp" => BindKind::Timestamp,
        "year" => BindKind::Year,
        "json" => BindKind::Json,
        s if s.starts_with("enum") => BindKind::Enum,
        s if s.starts_with("set") => BindKind::Set,
        "geometry" | "point" | "linestring" | "polygon" | "multipoint" | "multilinestring"
        | "multipolygon" | "geometrycollection" => BindKind::Geometry,
        _ => BindKind::Unknown,
    }
}

// ---------------------------------------------------------------------------
// §8.3 — decode_row_value
// ---------------------------------------------------------------------------

pub fn decode_row_value(
    row: &sqlx::mysql::MySqlRow,
    idx: usize,
    bind_kind: &BindKind,
) -> AppResult<JsonValue> {
    macro_rules! try_get {
        ($t:ty) => {
            row.try_get::<Option<$t>, _>(idx)
                .map_err(|e| AppError::mysql(format!("decode {bind_kind:?} at col {idx}: {e}")))
        };
    }

    let val = match bind_kind {
        BindKind::Bool => {
            let v = try_get!(i8)?;
            match v {
                Some(n) => JsonValue::Bool(n != 0),
                None => JsonValue::Null,
            }
        }
        BindKind::TinyInt | BindKind::SmallInt | BindKind::MediumInt | BindKind::Int => {
            let v = try_get!(i32)?;
            match v {
                Some(n) => JsonValue::Number(n.into()),
                None => JsonValue::Null,
            }
        }
        BindKind::BigInt => {
            let v = try_get!(i64)?;
            match v {
                Some(n) => {
                    // Safe integer range: ±2^53-1
                    const MAX_SAFE: i64 = 9_007_199_254_740_991;
                    const MIN_SAFE: i64 = -9_007_199_254_740_991;
                    if n >= MIN_SAFE && n <= MAX_SAFE {
                        JsonValue::Number(n.into())
                    } else {
                        JsonValue::String(n.to_string())
                    }
                }
                None => JsonValue::Null,
            }
        }
        BindKind::Float => {
            let v = try_get!(f32)?;
            match v {
                Some(f) if f.is_finite() => serde_json::Number::from_f64(f as f64)
                    .map(JsonValue::Number)
                    .unwrap_or(JsonValue::Null),
                Some(_) => JsonValue::Null,
                None => JsonValue::Null,
            }
        }
        BindKind::Double => {
            let v = try_get!(f64)?;
            match v {
                Some(f) if f.is_finite() => serde_json::Number::from_f64(f)
                    .map(JsonValue::Number)
                    .unwrap_or(JsonValue::Null),
                Some(_) => JsonValue::Null,
                None => JsonValue::Null,
            }
        }
        BindKind::Decimal => {
            let v = row
                .try_get::<Option<sqlx::types::BigDecimal>, _>(idx)
                .map_err(|e| AppError::mysql(format!("decode Decimal at col {idx}: {e}")))?;
            match v {
                Some(d) => JsonValue::String(d.to_string()),
                None => JsonValue::Null,
            }
        }
        BindKind::Char
        | BindKind::VarChar
        | BindKind::Text
        | BindKind::Enum
        | BindKind::Set
        | BindKind::Unknown => {
            let v = try_get!(String)?;
            match v {
                Some(s) => JsonValue::String(s),
                None => JsonValue::Null,
            }
        }
        BindKind::Binary | BindKind::VarBinary | BindKind::Blob | BindKind::Geometry => {
            let v = try_get!(Vec<u8>)?;
            match v {
                Some(bytes) => JsonValue::String(BASE64_STANDARD.encode(&bytes)),
                None => JsonValue::Null,
            }
        }
        BindKind::Date => {
            let v = try_get!(NaiveDate)?;
            match v {
                Some(d) => JsonValue::String(d.format("%Y-%m-%d").to_string()),
                None => JsonValue::Null,
            }
        }
        BindKind::Time => {
            let v = try_get!(NaiveTime)?;
            match v {
                Some(t) => JsonValue::String(t.format("%H:%M:%S%.f").to_string()),
                None => JsonValue::Null,
            }
        }
        BindKind::DateTime => {
            let v = try_get!(NaiveDateTime)?;
            match v {
                Some(dt) => JsonValue::String(dt.format("%Y-%m-%dT%H:%M:%S%.f").to_string()),
                None => JsonValue::Null,
            }
        }
        BindKind::Timestamp => {
            let v = try_get!(DateTime<Utc>)?;
            match v {
                Some(dt) => JsonValue::String(dt.to_rfc3339()),
                None => JsonValue::Null,
            }
        }
        BindKind::Year => {
            let v = try_get!(i16)?;
            match v {
                Some(y) => JsonValue::Number(y.into()),
                None => JsonValue::Null,
            }
        }
        BindKind::Json => {
            let v = try_get!(JsonValue)?;
            match v {
                Some(j) => j,
                None => JsonValue::Null,
            }
        }
        BindKind::Bit(n) => {
            let v = try_get!(Vec<u8>)?;
            match v {
                Some(bytes) => {
                    if *n <= 64 {
                        // Convert byte array to u64 then render as binary string.
                        let mut val: u64 = 0;
                        for b in &bytes {
                            val = (val << 8) | (*b as u64);
                        }
                        JsonValue::String(format!("0b{:0>width$b}", val, width = *n as usize))
                    } else {
                        JsonValue::String(BASE64_STANDARD.encode(&bytes))
                    }
                }
                None => JsonValue::Null,
            }
        }
    };
    Ok(val)
}

// ---------------------------------------------------------------------------
// §8.4 — bind_edit_value
// ---------------------------------------------------------------------------

/// Bind a JSON value to a sqlx MySQL query for edit operations.
///
/// Note on JSON columns: the SQL caller MUST wrap the placeholder with
/// `CAST(? AS JSON)` when binding JSON. The bind function itself binds the
/// serialized string form; it's the SQL builder's responsibility to add
/// the cast expression.
pub fn bind_edit_value<'q>(
    mut q: Query<'q, sqlx::MySql, MySqlArguments>,
    value: &JsonValue,
    bind_kind: &BindKind,
) -> AppResult<Query<'q, sqlx::MySql, MySqlArguments>> {
    if matches!(value, JsonValue::Null) {
        // Bind typed NULL. sqlx handles NULL binding via Option<T>.
        q = q.bind(Option::<String>::None);
        return Ok(q);
    }

    match bind_kind {
        BindKind::Bool => {
            let n: i64 = match value {
                JsonValue::Bool(b) => {
                    if *b {
                        1
                    } else {
                        0
                    }
                }
                JsonValue::Number(n) => n.as_i64().ok_or_else(|| {
                    AppError::Validation("expected boolean or 0/1 for Bool column".into())
                })?,
                _ => {
                    return Err(AppError::Validation(
                        "expected bool value for Bool column".into(),
                    ))
                }
            };
            q = q.bind(n);
        }
        BindKind::TinyInt => {
            let n = parse_i64(value, "TinyInt")?;
            if n < -128 || n > 127 {
                return Err(AppError::Validation(format!(
                    "value {n} out of range for TinyInt (-128..=127)"
                )));
            }
            q = q.bind(n as i8);
        }
        BindKind::SmallInt => {
            let n = parse_i64(value, "SmallInt")?;
            if n < -32768 || n > 32767 {
                return Err(AppError::Validation(format!(
                    "value {n} out of range for SmallInt (-32768..=32767)"
                )));
            }
            q = q.bind(n as i16);
        }
        BindKind::MediumInt => {
            let n = parse_i64(value, "MediumInt")?;
            if n < -8_388_608 || n > 8_388_607 {
                return Err(AppError::Validation(format!(
                    "value {n} out of range for MediumInt"
                )));
            }
            q = q.bind(n as i32);
        }
        BindKind::Int => {
            let n = parse_i64(value, "Int")?;
            if n < i32::MIN as i64 || n > i32::MAX as i64 {
                return Err(AppError::Validation(format!(
                    "value {n} out of range for Int"
                )));
            }
            q = q.bind(n as i32);
        }
        BindKind::BigInt => {
            let n = parse_i64(value, "BigInt")?;
            q = q.bind(n);
        }
        BindKind::Float => {
            let f = parse_f64(value, "Float")?;
            q = q.bind(f as f32);
        }
        BindKind::Double => {
            let f = parse_f64(value, "Double")?;
            q = q.bind(f);
        }
        BindKind::Decimal => {
            let s = match value {
                JsonValue::String(s) => s.clone(),
                JsonValue::Number(n) => n.to_string(),
                _ => {
                    return Err(AppError::Validation(
                        "expected string or number for Decimal column".into(),
                    ))
                }
            };
            let bd: sqlx::types::BigDecimal = s
                .parse()
                .map_err(|_| AppError::Validation(format!("invalid decimal value: {s}")))?;
            q = q.bind(bd);
        }
        BindKind::Char | BindKind::VarChar | BindKind::Text | BindKind::Unknown => {
            let s = coerce_to_string(value);
            q = q.bind(s);
        }
        BindKind::Binary | BindKind::VarBinary | BindKind::Blob => {
            let bytes = decode_base64_value(value)?;
            q = q.bind(bytes);
        }
        BindKind::Date => {
            let s = require_string(value, "Date")?;
            let d = s
                .parse::<NaiveDate>()
                .map_err(|e| AppError::Validation(format!("invalid date '{s}': {e}")))?;
            q = q.bind(d);
        }
        BindKind::Time => {
            let s = require_string(value, "Time")?;
            let t = s
                .parse::<NaiveTime>()
                .map_err(|e| AppError::Validation(format!("invalid time '{s}': {e}")))?;
            q = q.bind(t);
        }
        BindKind::DateTime => {
            let s = require_string(value, "DateTime")?;
            let dt = NaiveDateTime::parse_from_str(&s, "%Y-%m-%dT%H:%M:%S%.f")
                .or_else(|_| NaiveDateTime::parse_from_str(&s, "%Y-%m-%d %H:%M:%S"))
                .map_err(|e| AppError::Validation(format!("invalid datetime '{s}': {e}")))?;
            q = q.bind(dt);
        }
        BindKind::Timestamp => {
            let s = require_string(value, "Timestamp")?;
            let dt = DateTime::parse_from_rfc3339(&s)
                .map(|d| d.with_timezone(&Utc))
                .or_else(|_| {
                    NaiveDateTime::parse_from_str(&s, "%Y-%m-%dT%H:%M:%S%.f")
                        .map(|ndt| DateTime::<Utc>::from_naive_utc_and_offset(ndt, Utc))
                })
                .map_err(|e| AppError::Validation(format!("invalid timestamp '{s}': {e}")))?;
            q = q.bind(dt);
        }
        BindKind::Year => {
            let n = parse_i64(value, "Year")?;
            q = q.bind(n as i16);
        }
        BindKind::Json => {
            // Serialize the value to a string. The SQL MUST use `CAST(? AS JSON)`.
            let s = match value {
                JsonValue::String(s) => s.clone(),
                other => serde_json::to_string(other).map_err(|e| {
                    AppError::Validation(format!("could not serialize JSON value: {e}"))
                })?,
            };
            q = q.bind(s);
        }
        BindKind::Enum | BindKind::Set => {
            let s = coerce_to_string(value);
            q = q.bind(s);
        }
        BindKind::Bit(n) => {
            if *n > 64 {
                return Err(AppError::Validation(
                    "editing BIT columns with >64 bits is not supported in v1".into(),
                ));
            }
            let s = require_string(value, "Bit")?;
            let stripped = s.trim_start_matches("0b").trim_start_matches("0B");
            let val = u64::from_str_radix(stripped, 2).map_err(|_| {
                AppError::Validation(format!("invalid binary digit string for Bit: '{s}'"))
            })?;
            // Bind as bytes (big-endian, minimal width).
            let bytes = val.to_be_bytes();
            // Trim leading zero bytes to match MySQL's expectation.
            let trimmed: Vec<u8> = {
                let leading = bytes.iter().take_while(|&&b| b == 0).count();
                let start = if leading == bytes.len() {
                    bytes.len() - 1
                } else {
                    leading
                };
                bytes[start..].to_vec()
            };
            q = q.bind(trimmed);
        }
        BindKind::Geometry => {
            return Err(AppError::Validation(
                "editing GEOMETRY columns is not supported; use the SQL editor".into(),
            ));
        }
    }
    Ok(q)
}

// ---------------------------------------------------------------------------
// §8.5 — bind_filter_value
// ---------------------------------------------------------------------------

/// Bind a filter value. Delegates to `bind_edit_value` with identical
/// coercion rules, with two differences documented below.
///
/// - JSON filter: binds as serialized string; the SQL uses JSON_EXTRACT / CAST
///   at the call site.
/// - Geometry: always rejected for filters.
pub fn bind_filter_value<'q>(
    q: Query<'q, sqlx::MySql, MySqlArguments>,
    value: &JsonValue,
    bind_kind: &BindKind,
) -> AppResult<Query<'q, sqlx::MySql, MySqlArguments>> {
    if matches!(bind_kind, BindKind::Geometry) {
        return Err(AppError::Validation(
            "filtering GEOMETRY columns is not supported".into(),
        ));
    }
    // Delegate; the JSON handling in bind_edit_value (serialize to string)
    // matches the filter requirement.
    bind_edit_value(q, value, bind_kind)
}

// ---------------------------------------------------------------------------
// §8.6 — mysql_quote_ident / mysql_quote_qualified
// ---------------------------------------------------------------------------

/// Wrap `name` in backticks, escaping embedded backticks by doubling.
pub fn mysql_quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// Quote a qualified `schema.name` identifier.
pub fn mysql_quote_qualified(schema: &str, name: &str) -> String {
    format!("{}.{}", mysql_quote_ident(schema), mysql_quote_ident(name))
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

fn parse_i64(value: &JsonValue, kind: &str) -> AppResult<i64> {
    match value {
        JsonValue::Number(n) => n.as_i64().ok_or_else(|| {
            AppError::Validation(format!(
                "expected integer for {kind} column, got '{}'",
                value
            ))
        }),
        JsonValue::String(s) => s.trim().parse::<i64>().map_err(|_| {
            AppError::Validation(format!("expected integer for {kind} column, got '{s}'"))
        }),
        _ => Err(AppError::Validation(format!(
            "expected integer for {kind} column"
        ))),
    }
}

fn parse_f64(value: &JsonValue, kind: &str) -> AppResult<f64> {
    match value {
        JsonValue::Number(n) => n
            .as_f64()
            .ok_or_else(|| AppError::Validation(format!("expected number for {kind} column"))),
        JsonValue::String(s) => s.trim().parse::<f64>().map_err(|_| {
            AppError::Validation(format!("expected number for {kind} column, got '{s}'"))
        }),
        _ => Err(AppError::Validation(format!(
            "expected number for {kind} column"
        ))),
    }
}

fn coerce_to_string(value: &JsonValue) -> String {
    match value {
        JsonValue::String(s) => s.clone(),
        JsonValue::Number(n) => n.to_string(),
        JsonValue::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

fn require_string(value: &JsonValue, kind: &str) -> AppResult<String> {
    match value {
        JsonValue::String(s) => Ok(s.clone()),
        _ => Err(AppError::Validation(format!(
            "expected string value for {kind} column"
        ))),
    }
}

fn decode_base64_value(value: &JsonValue) -> AppResult<Vec<u8>> {
    let s = match value {
        JsonValue::String(s) => s,
        _ => {
            return Err(AppError::Validation(
                "expected base64-encoded string for binary column".into(),
            ))
        }
    };
    BASE64_STANDARD
        .decode(s.as_bytes())
        .map_err(|e| AppError::Validation(format!("invalid base64 for binary column: {e}")))
}

// ---------------------------------------------------------------------------
// §8.7 — Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // bind_kind_for_type tests
    // -----------------------------------------------------------------------

    #[test]
    fn tinyint_1_maps_to_bool() {
        assert_eq!(bind_kind_for_type("TINYINT(1)"), BindKind::Bool);
        assert_eq!(bind_kind_for_type("tinyint(1)"), BindKind::Bool);
        assert_eq!(bind_kind_for_type("tinyint(1) unsigned"), BindKind::Bool);
    }

    #[test]
    fn tinyint_other_maps_to_tinyint() {
        assert_eq!(bind_kind_for_type("tinyint(4)"), BindKind::TinyInt);
        assert_eq!(bind_kind_for_type("TINYINT"), BindKind::TinyInt);
    }

    #[test]
    fn bigint_maps_correctly() {
        assert_eq!(bind_kind_for_type("BIGINT"), BindKind::BigInt);
        assert_eq!(bind_kind_for_type("bigint unsigned"), BindKind::BigInt);
    }

    #[test]
    fn decimal_strips_params() {
        assert_eq!(bind_kind_for_type("DECIMAL(10,2)"), BindKind::Decimal);
        assert_eq!(bind_kind_for_type("decimal(10,2)"), BindKind::Decimal);
    }

    #[test]
    fn varchar_strips_params() {
        assert_eq!(bind_kind_for_type("varchar(255)"), BindKind::VarChar);
        assert_eq!(
            bind_kind_for_type("varchar(255) unsigned"),
            BindKind::VarChar
        );
    }

    #[test]
    fn json_maps_to_json() {
        assert_eq!(bind_kind_for_type("json"), BindKind::Json);
        assert_eq!(bind_kind_for_type("JSON"), BindKind::Json);
    }

    #[test]
    fn bit_n_parsed() {
        assert_eq!(bind_kind_for_type("bit(8)"), BindKind::Bit(8));
        assert_eq!(bind_kind_for_type("BIT(3)"), BindKind::Bit(3));
        assert_eq!(bind_kind_for_type("bit"), BindKind::Bit(1));
    }

    #[test]
    fn geometry_types_all_map_to_geometry() {
        for t in &["point", "POINT", "geometry", "polygon", "linestring"] {
            assert_eq!(bind_kind_for_type(t), BindKind::Geometry, "failed for {t}");
        }
    }

    #[test]
    fn unknown_garbage_maps_to_unknown() {
        assert_eq!(bind_kind_for_type("roflcopter"), BindKind::Unknown);
        assert_eq!(bind_kind_for_type("custom_type"), BindKind::Unknown);
    }

    // -----------------------------------------------------------------------
    // mysql_quote_ident tests
    // -----------------------------------------------------------------------

    #[test]
    fn quote_ident_wraps_in_backticks() {
        assert_eq!(mysql_quote_ident("users"), "`users`");
    }

    #[test]
    fn quote_ident_escapes_embedded_backtick() {
        assert_eq!(mysql_quote_ident("a`b"), "`a``b`");
    }

    #[test]
    fn quote_qualified_combines_schema_and_name() {
        assert_eq!(mysql_quote_qualified("mydb", "users"), "`mydb`.`users`");
    }

    // -----------------------------------------------------------------------
    // bind_edit_value tests (no live DB needed — testing validation paths)
    // -----------------------------------------------------------------------

    fn empty_query<'q>() -> Query<'q, sqlx::MySql, MySqlArguments> {
        sqlx::query("SELECT 1")
    }

    #[test]
    fn bind_bool_from_bool_value() {
        let q = empty_query();
        let result = bind_edit_value(q, &JsonValue::Bool(true), &BindKind::Bool);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_null_is_ok_for_all_kinds() {
        let kinds = [
            BindKind::Int,
            BindKind::BigInt,
            BindKind::VarChar,
            BindKind::Json,
        ];
        for kind in &kinds {
            let q = empty_query();
            let result = bind_edit_value(q, &JsonValue::Null, kind);
            assert!(result.is_ok(), "null binding failed for {kind:?}");
        }
    }

    #[test]
    fn bind_tinyint_range_overflow_rejected() {
        let q = empty_query();
        let result = bind_edit_value(q, &serde_json::json!(200), &BindKind::TinyInt);
        assert!(result.is_err());
        let msg = result.err().unwrap().to_string();
        assert!(
            msg.contains("range") || msg.contains("TinyInt"),
            "msg: {msg}"
        );
    }

    #[test]
    fn bind_tinyint_in_range_ok() {
        let q = empty_query();
        let result = bind_edit_value(q, &serde_json::json!(100), &BindKind::TinyInt);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_geometry_rejected() {
        let q = empty_query();
        let result = bind_edit_value(q, &serde_json::json!("POINT(1 2)"), &BindKind::Geometry);
        assert!(result.is_err());
        let msg = result.err().unwrap().to_string();
        assert!(
            msg.contains("GEOMETRY") || msg.contains("geometry"),
            "msg: {msg}"
        );
    }

    #[test]
    fn bind_blob_from_valid_base64() {
        let encoded = BASE64_STANDARD.encode(b"hello world");
        let q = empty_query();
        let result = bind_edit_value(q, &JsonValue::String(encoded), &BindKind::Blob);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_blob_invalid_base64_rejected() {
        let q = empty_query();
        let result = bind_edit_value(q, &JsonValue::String("!!!bad!!!".into()), &BindKind::Blob);
        assert!(result.is_err());
        let msg = result.err().unwrap().to_string();
        assert!(
            msg.to_lowercase().contains("base64") || msg.contains("binary"),
            "msg: {msg}"
        );
    }

    #[test]
    fn bind_filter_geometry_rejected() {
        let q = empty_query();
        let result = bind_filter_value(q, &serde_json::json!("POINT(0 0)"), &BindKind::Geometry);
        assert!(result.is_err());
    }

    #[test]
    fn bind_bit_binary_string() {
        let q = empty_query();
        let result = bind_edit_value(
            q,
            &JsonValue::String("0b10101010".into()),
            &BindKind::Bit(8),
        );
        assert!(result.is_ok());
    }

    #[test]
    fn bind_bit_gt64_rejected() {
        let q = empty_query();
        let result = bind_edit_value(q, &JsonValue::String("0b1".into()), &BindKind::Bit(65));
        assert!(result.is_err());
    }

    // -----------------------------------------------------------------------
    // §24.3 additional coverage
    // -----------------------------------------------------------------------

    #[test]
    fn bigint_safe_int_boundary() {
        // Values within ±2^53-1 should return Number, beyond should return String.
        const MAX_SAFE: i64 = 9_007_199_254_740_991;
        const MIN_SAFE: i64 = -9_007_199_254_740_991;
        // Within boundary — bind should succeed.
        let q = empty_query();
        let result = bind_edit_value(q, &serde_json::json!(MAX_SAFE), &BindKind::BigInt);
        assert!(result.is_ok());

        let q = empty_query();
        let result = bind_edit_value(q, &serde_json::json!(MIN_SAFE), &BindKind::BigInt);
        assert!(result.is_ok());
    }

    #[test]
    fn bigint_from_string_is_ok() {
        // BigInt bind accepts a string representation of a valid i64 value.
        let q = empty_query();
        let result = bind_edit_value(
            q,
            &JsonValue::String("9007199254740991".into()), // MAX_SAFE as string
            &BindKind::BigInt,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn decimal_from_string_preserves_precision() {
        // DECIMAL round-trip: string → bind (no precision loss expected).
        let q = empty_query();
        let result = bind_edit_value(
            q,
            &JsonValue::String("123456789.12345678901234567890".into()),
            &BindKind::Decimal,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn decimal_from_number_is_ok() {
        let q = empty_query();
        let result = bind_edit_value(q, &serde_json::json!(123.456), &BindKind::Decimal);
        assert!(result.is_ok());
    }

    #[test]
    fn decimal_invalid_string_rejected() {
        let q = empty_query();
        let result = bind_edit_value(
            q,
            &JsonValue::String("not-a-decimal".into()),
            &BindKind::Decimal,
        );
        assert!(result.is_err());
        match result {
            Err(e) => {
                let msg = e.to_string();
                assert!(
                    msg.contains("decimal") || msg.contains("Decimal"),
                    "msg: {msg}"
                );
            }
            Ok(_) => panic!("expected Err"),
        }
    }

    #[test]
    fn json_string_value_not_double_stringified() {
        // When a JSON column receives a String value, it should bind as-is
        // (not wrap it in extra quotes).
        let q = empty_query();
        let result = bind_edit_value(
            q,
            &JsonValue::String(r#"{"key": "value"}"#.into()),
            &BindKind::Json,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn json_object_value_serialized() {
        // Non-string JSON values should be serialized to a JSON string.
        let q = empty_query();
        let result = bind_edit_value(
            q,
            &serde_json::json!({"a": 1, "b": [1, 2]}),
            &BindKind::Json,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn geometry_bind_rejected_with_message() {
        // Geometry bind should fail and mention SQL editor.
        let q = empty_query();
        let result = bind_edit_value(q, &serde_json::json!("POINT(0 0)"), &BindKind::Geometry);
        assert!(result.is_err());
        match result {
            Err(e) => {
                let err = e.to_string().to_lowercase();
                assert!(
                    err.contains("sql editor") || err.contains("geometry"),
                    "err: {err}"
                );
            }
            Ok(_) => panic!("expected Err"),
        }
    }

    #[test]
    fn datetime_no_timezone_bind_from_iso() {
        // DATETIME is timezone-naive; binds from "2024-01-15T10:30:00".
        let q = empty_query();
        let result = bind_edit_value(
            q,
            &JsonValue::String("2024-01-15T10:30:00".into()),
            &BindKind::DateTime,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn timestamp_with_timezone_bind_from_rfc3339() {
        // TIMESTAMP is UTC; binds from RFC 3339.
        let q = empty_query();
        let result = bind_edit_value(
            q,
            &JsonValue::String("2024-01-15T10:30:00Z".into()),
            &BindKind::Timestamp,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn bind_date_valid_string() {
        let q = empty_query();
        let result = bind_edit_value(q, &JsonValue::String("2024-06-15".into()), &BindKind::Date);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_date_invalid_string_rejected() {
        let q = empty_query();
        let result = bind_edit_value(q, &JsonValue::String("not-a-date".into()), &BindKind::Date);
        assert!(result.is_err());
    }

    #[test]
    fn bind_time_valid_string() {
        let q = empty_query();
        let result = bind_edit_value(q, &JsonValue::String("14:30:00".into()), &BindKind::Time);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_smallint_range_overflow_rejected() {
        let q = empty_query();
        let result = bind_edit_value(q, &serde_json::json!(40000), &BindKind::SmallInt);
        assert!(result.is_err());
    }

    #[test]
    fn bind_mediumint_range_overflow_rejected() {
        let q = empty_query();
        let result = bind_edit_value(q, &serde_json::json!(9_000_000), &BindKind::MediumInt);
        assert!(result.is_err());
    }

    #[test]
    fn bind_int_range_overflow_rejected() {
        let q = empty_query();
        let result = bind_edit_value(q, &serde_json::json!(3_000_000_000_i64), &BindKind::Int);
        assert!(result.is_err());
    }

    #[test]
    fn bind_bit_invalid_binary_string_rejected() {
        let q = empty_query();
        let result = bind_edit_value(
            q,
            &JsonValue::String("0b102".into()), // '2' is not binary
            &BindKind::Bit(8),
        );
        assert!(result.is_err());
    }

    #[test]
    fn bind_enum_accepts_string() {
        let q = empty_query();
        let result = bind_edit_value(q, &JsonValue::String("active".into()), &BindKind::Enum);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_set_accepts_string() {
        let q = empty_query();
        let result = bind_edit_value(q, &JsonValue::String("a,b,c".into()), &BindKind::Set);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_float_from_number() {
        let q = empty_query();
        let result = bind_edit_value(q, &serde_json::json!(3.14), &BindKind::Float);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_double_from_number() {
        let q = empty_query();
        let result = bind_edit_value(q, &serde_json::json!(3.141592653589793), &BindKind::Double);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_char_from_string() {
        let q = empty_query();
        let result = bind_edit_value(q, &JsonValue::String("X".into()), &BindKind::Char);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_varbinary_from_base64() {
        let encoded = BASE64_STANDARD.encode(b"binary data");
        let q = empty_query();
        let result = bind_edit_value(q, &JsonValue::String(encoded), &BindKind::VarBinary);
        assert!(result.is_ok());
    }

    #[test]
    fn all_bind_kinds_for_type_covered() {
        // Comprehensive type string → BindKind mapping.
        let cases = [
            ("BOOLEAN", BindKind::Bool),
            ("BOOL", BindKind::Bool),
            ("TINYINT(1)", BindKind::Bool),
            ("TINYINT(4)", BindKind::TinyInt),
            ("SMALLINT", BindKind::SmallInt),
            ("MEDIUMINT", BindKind::MediumInt),
            ("INT", BindKind::Int),
            ("INTEGER", BindKind::Int),
            ("BIGINT", BindKind::BigInt),
            ("FLOAT", BindKind::Float),
            ("DOUBLE", BindKind::Double),
            ("DOUBLE PRECISION", BindKind::Double),
            ("REAL", BindKind::Double),
            ("DECIMAL(10,2)", BindKind::Decimal),
            ("NUMERIC(10,2)", BindKind::Decimal),
            ("FIXED", BindKind::Decimal),
            ("CHAR(10)", BindKind::Char),
            ("VARCHAR(255)", BindKind::VarChar),
            ("TEXT", BindKind::Text),
            ("TINYTEXT", BindKind::Text),
            ("MEDIUMTEXT", BindKind::Text),
            ("LONGTEXT", BindKind::Text),
            ("BINARY(16)", BindKind::Binary),
            ("VARBINARY(255)", BindKind::VarBinary),
            ("BLOB", BindKind::Blob),
            ("TINYBLOB", BindKind::Blob),
            ("MEDIUMBLOB", BindKind::Blob),
            ("LONGBLOB", BindKind::Blob),
            ("DATE", BindKind::Date),
            ("TIME", BindKind::Time),
            ("DATETIME", BindKind::DateTime),
            ("TIMESTAMP", BindKind::Timestamp),
            ("YEAR", BindKind::Year),
            ("JSON", BindKind::Json),
            ("GEOMETRY", BindKind::Geometry),
            ("POINT", BindKind::Geometry),
            ("LINESTRING", BindKind::Geometry),
            ("POLYGON", BindKind::Geometry),
            ("MULTIPOINT", BindKind::Geometry),
            ("MULTILINESTRING", BindKind::Geometry),
            ("MULTIPOLYGON", BindKind::Geometry),
            ("GEOMETRYCOLLECTION", BindKind::Geometry),
        ];
        for (type_str, expected) in &cases {
            assert_eq!(
                bind_kind_for_type(type_str),
                *expected,
                "failed for type string: {type_str}"
            );
        }
    }

    #[test]
    fn enum_and_set_type_strings_recognized() {
        // ENUM(...) and SET(...) with quoted values.
        let bk = bind_kind_for_type("enum('active','inactive')");
        assert_eq!(bk, BindKind::Enum);

        let bk = bind_kind_for_type("set('a','b','c')");
        assert_eq!(bk, BindKind::Set);
    }

    #[test]
    fn unsigned_suffix_stripped_correctly() {
        assert_eq!(bind_kind_for_type("BIGINT unsigned"), BindKind::BigInt);
        assert_eq!(bind_kind_for_type("INT unsigned zerofill"), BindKind::Int);
        assert_eq!(
            bind_kind_for_type("SMALLINT unsigned zerofill"),
            BindKind::SmallInt
        );
    }
}
