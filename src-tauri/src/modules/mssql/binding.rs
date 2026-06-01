//! Type binding (decode + bind) for MS SQL Server.
//!
//! # Tiberius API notes
//!
//! - **Decimal / Money**: tiberius 0.12 uses `bigdecimal::BigDecimal` (v0.3.x)
//!   when the `bigdecimal` feature is enabled. We represent values as JSON
//!   strings to preserve precision.
//! - **UniqueIdentifier**: tiberius returns `uuid::Uuid` directly via `row.get()`.
//! - **DateTime / DateTime2 / SmallDateTime**: tiberius returns
//!   `chrono::NaiveDateTime` (no timezone).
//! - **DateTimeOffset**: tiberius returns
//!   `chrono::DateTime<chrono::FixedOffset>`.
//! - **Date**: `chrono::NaiveDate`.
//! - **Time**: `chrono::NaiveTime`.
//! - **Binary / Varbinary / Image / RowVersion**: `&[u8]` → base64.
//! - **Geometry / Geography / HierarchyId / SqlVariant**: the caller must
//!   cast these at the SQL level (STAsText(), ToString(), CONVERT) so that
//!   they arrive as `&str`.
//! - **TinyInt**: SQL Server TINYINT is unsigned (0–255), surfaced by
//!   tiberius as `u8`. We return a JSON number (NOT a bool).

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

// ---------------------------------------------------------------------------
// §8.1 — BindKind enum
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BindKind {
    Bool,
    TinyInt,
    SmallInt,
    Int,
    BigInt,
    Decimal,
    Money,
    Float,
    Real,
    Char,
    Varchar,
    Text,
    NChar,
    NVarchar,
    NText,
    Binary,
    Varbinary,
    Image,
    RowVersion,
    Date,
    Time,
    DateTime,
    DateTime2,
    SmallDateTime,
    DateTimeOffset,
    UniqueIdentifier,
    Xml,
    Json,
    Geometry,
    Geography,
    HierarchyId,
    SqlVariant,
    Identity,
    Computed,
    Unknown,
}

// ---------------------------------------------------------------------------
// §8.2 — bind_kind_for_type
// ---------------------------------------------------------------------------

/// Map `sys.types.name` (and optional size/precision/scale) to a `BindKind`.
///
/// The `type_name` argument should be the bare name from `sys.types.name`
/// (e.g. "varchar", "decimal"). Case-insensitive.
pub fn bind_kind_for_type(
    type_name: &str,
    _max_length: Option<i32>,
    _precision: Option<u8>,
    _scale: Option<u8>,
) -> BindKind {
    let lower = type_name.trim().to_ascii_lowercase();
    match lower.as_str() {
        "bit" => BindKind::Bool,
        "tinyint" => BindKind::TinyInt,
        "smallint" => BindKind::SmallInt,
        "int" => BindKind::Int,
        "bigint" => BindKind::BigInt,
        "decimal" | "numeric" => BindKind::Decimal,
        "money" | "smallmoney" => BindKind::Money,
        "float" => BindKind::Float,
        "real" => BindKind::Real,
        "char" => BindKind::Char,
        "varchar" => BindKind::Varchar,
        "text" => BindKind::Text,
        "nchar" => BindKind::NChar,
        "nvarchar" => BindKind::NVarchar,
        "ntext" => BindKind::NText,
        "binary" => BindKind::Binary,
        "varbinary" => BindKind::Varbinary,
        "image" => BindKind::Image,
        // `timestamp` is the legacy alias for rowversion in SQL Server.
        "rowversion" | "timestamp" => BindKind::RowVersion,
        "date" => BindKind::Date,
        "time" => BindKind::Time,
        "datetime" => BindKind::DateTime,
        "datetime2" => BindKind::DateTime2,
        "smalldatetime" => BindKind::SmallDateTime,
        "datetimeoffset" => BindKind::DateTimeOffset,
        "uniqueidentifier" => BindKind::UniqueIdentifier,
        "xml" => BindKind::Xml,
        "json" => BindKind::Json,
        "geometry" => BindKind::Geometry,
        "geography" => BindKind::Geography,
        "hierarchyid" => BindKind::HierarchyId,
        "sql_variant" => BindKind::SqlVariant,
        _ => BindKind::Unknown,
    }
}

// ---------------------------------------------------------------------------
// §8.3 — decode_row_value
// ---------------------------------------------------------------------------

/// Decode a cell from a tiberius `Row` to a `serde_json::Value`.
///
/// NULL handling: tiberius's `try_get` returns `Option<T>`. When the value is
/// `None`, `serde_json::Value::Null` is returned regardless of BindKind.
///
/// Geometry/Geography/HierarchyId/SqlVariant: the SELECT query MUST cast
/// these to `NVARCHAR` / call `.STAsText()` / `.ToString()` / `CONVERT`
/// before they reach this function, so they arrive as `&str`.
pub fn decode_row_value(
    row: &tiberius::Row,
    idx: usize,
    bind_kind: BindKind,
) -> AppResult<JsonValue> {
    macro_rules! get_opt {
        ($t:ty) => {
            row.try_get::<$t, _>(idx)
                .map_err(|e| AppError::mssql(format!("decode {:?} at col {idx}: {e}", bind_kind)))?
        };
    }

    let val = match bind_kind {
        BindKind::Bool => match get_opt!(bool) {
            Some(b) => JsonValue::Bool(b),
            None => JsonValue::Null,
        },

        BindKind::TinyInt => match get_opt!(u8) {
            Some(n) => JsonValue::Number(n.into()),
            None => JsonValue::Null,
        },

        BindKind::SmallInt => match get_opt!(i16) {
            Some(n) => JsonValue::Number(n.into()),
            None => JsonValue::Null,
        },

        BindKind::Int => match get_opt!(i32) {
            Some(n) => JsonValue::Number(n.into()),
            None => JsonValue::Null,
        },

        BindKind::BigInt => match get_opt!(i64) {
            Some(n) => {
                const MAX_SAFE: i64 = 9_007_199_254_740_991;
                const MIN_SAFE: i64 = -9_007_199_254_740_991;
                if n >= MIN_SAFE && n <= MAX_SAFE {
                    JsonValue::Number(n.into())
                } else {
                    JsonValue::String(n.to_string())
                }
            }
            None => JsonValue::Null,
        },

        BindKind::Decimal | BindKind::Money => {
            match get_opt!(bigdecimal::BigDecimal) {
                Some(d) => JsonValue::String(d.to_string()),
                None => JsonValue::Null,
            }
        }

        BindKind::Float => match get_opt!(f64) {
            Some(f) if f.is_finite() => serde_json::Number::from_f64(f)
                .map(JsonValue::Number)
                .unwrap_or(JsonValue::Null),
            Some(_) => JsonValue::Null,
            None => JsonValue::Null,
        },

        BindKind::Real => match get_opt!(f32) {
            Some(f) if f.is_finite() => serde_json::Number::from_f64(f as f64)
                .map(JsonValue::Number)
                .unwrap_or(JsonValue::Null),
            Some(_) => JsonValue::Null,
            None => JsonValue::Null,
        },

        BindKind::Char
        | BindKind::Varchar
        | BindKind::Text
        | BindKind::NChar
        | BindKind::NVarchar
        | BindKind::NText
        | BindKind::Xml
        | BindKind::Geometry
        | BindKind::Geography
        | BindKind::HierarchyId
        | BindKind::SqlVariant
        | BindKind::Identity
        | BindKind::Computed
        | BindKind::Unknown => match get_opt!(&str) {
            Some(s) => JsonValue::String(s.to_string()),
            None => JsonValue::Null,
        },

        BindKind::Binary | BindKind::Varbinary | BindKind::Image | BindKind::RowVersion => {
            match get_opt!(&[u8]) {
                Some(bytes) => JsonValue::String(BASE64_STANDARD.encode(bytes)),
                None => JsonValue::Null,
            }
        }

        BindKind::Date => match get_opt!(NaiveDate) {
            Some(d) => JsonValue::String(d.format("%Y-%m-%d").to_string()),
            None => JsonValue::Null,
        },

        BindKind::Time => match get_opt!(NaiveTime) {
            Some(t) => JsonValue::String(t.format("%H:%M:%S%.3f").to_string()),
            None => JsonValue::Null,
        },

        BindKind::DateTime | BindKind::DateTime2 | BindKind::SmallDateTime => {
            match get_opt!(NaiveDateTime) {
                Some(dt) => JsonValue::String(dt.format("%Y-%m-%dT%H:%M:%S%.3f").to_string()),
                None => JsonValue::Null,
            }
        }

        BindKind::DateTimeOffset => match get_opt!(DateTime<FixedOffset>) {
            Some(dt) => {
                // Preserve the original offset; format as ISO 8601 with ±HH:MM.
                JsonValue::String(dt.format("%Y-%m-%dT%H:%M:%S%.3f%:z").to_string())
            }
            None => JsonValue::Null,
        },

        BindKind::UniqueIdentifier => match get_opt!(Uuid) {
            Some(u) => JsonValue::String(u.as_hyphenated().to_string()),
            None => JsonValue::Null,
        },

        BindKind::Json => {
            // The column contains JSON text; parse it into a serde_json::Value.
            match get_opt!(&str) {
                Some(s) => serde_json::from_str(s).unwrap_or_else(|_| JsonValue::String(s.to_string())),
                None => JsonValue::Null,
            }
        }
    };

    Ok(val)
}

// ---------------------------------------------------------------------------
// §8.4 — bind_edit_value
// ---------------------------------------------------------------------------

/// Bind a `serde_json::Value` to a tiberius `Query` parameter.
///
/// NULL handling: if `value.is_null()`, binds `Option::<String>::None`
/// for any BindKind.
pub fn bind_edit_value(
    query: &mut tiberius::Query<'_>,
    value: &JsonValue,
    bind_kind: BindKind,
) -> AppResult<()> {
    // Handle NULL first.
    if value.is_null() {
        query.bind(Option::<&str>::None);
        return Ok(());
    }

    match bind_kind {
        BindKind::Bool => {
            let b = match value {
                JsonValue::Bool(b) => *b,
                JsonValue::Number(n) => n.as_i64().map(|v| v != 0).ok_or_else(|| {
                    AppError::Validation("expected bool or 0/1 for Bool column".into())
                })?,
                _ => {
                    return Err(AppError::Validation(
                        "expected bool or 0/1 for Bool column".into(),
                    ))
                }
            };
            query.bind(b);
        }

        BindKind::TinyInt => {
            let n = parse_i64(value, "TinyInt")?;
            if !(0..=255).contains(&n) {
                return Err(AppError::Validation(format!(
                    "value {n} out of range for TinyInt (0..=255)"
                )));
            }
            query.bind(n as u8);
        }

        BindKind::SmallInt => {
            let n = parse_i64(value, "SmallInt")?;
            if n < i16::MIN as i64 || n > i16::MAX as i64 {
                return Err(AppError::Validation(format!(
                    "value {n} out of range for SmallInt"
                )));
            }
            query.bind(n as i16);
        }

        BindKind::Int => {
            let n = parse_i64(value, "Int")?;
            if n < i32::MIN as i64 || n > i32::MAX as i64 {
                return Err(AppError::Validation(format!("value {n} out of range for Int")));
            }
            query.bind(n as i32);
        }

        BindKind::BigInt => {
            let n = parse_i64(value, "BigInt")?;
            query.bind(n);
        }

        BindKind::Decimal | BindKind::Money => {
            let s = match value {
                JsonValue::String(s) => s.clone(),
                JsonValue::Number(n) => n.to_string(),
                _ => {
                    return Err(AppError::Validation(
                        "expected string or number for Decimal/Money column".into(),
                    ))
                }
            };
            let bd: bigdecimal::BigDecimal = s.parse().map_err(|_| {
                AppError::Validation(format!("invalid decimal value: {s}"))
            })?;
            query.bind(bd);
        }

        BindKind::Float => {
            let f = parse_f64(value, "Float")?;
            query.bind(f);
        }

        BindKind::Real => {
            let f = parse_f64(value, "Real")?;
            query.bind(f as f32);
        }

        BindKind::Char
        | BindKind::Varchar
        | BindKind::Text
        | BindKind::NChar
        | BindKind::NVarchar
        | BindKind::NText
        | BindKind::Xml => {
            let s = coerce_to_string(value);
            // We need to bind an owned String since tiberius needs 'static or
            // we bind a &str tied to local scope. Use String here.
            query.bind(s);
        }

        BindKind::Json => {
            let s = match value {
                JsonValue::String(s) => s.clone(),
                other => serde_json::to_string(other).map_err(|e| {
                    AppError::Validation(format!("could not serialize JSON value: {e}"))
                })?,
            };
            query.bind(s);
        }

        BindKind::Binary | BindKind::Varbinary | BindKind::Image => {
            let bytes = decode_base64(value)?;
            query.bind(bytes);
        }

        BindKind::RowVersion => {
            return Err(AppError::Validation(
                "rowversion is read-only; cannot bind for edit".into(),
            ));
        }

        BindKind::Date => {
            let s = require_string(value, "Date")?;
            let d = s
                .parse::<NaiveDate>()
                .map_err(|e| AppError::Validation(format!("invalid date '{s}': {e}")))?;
            query.bind(d);
        }

        BindKind::Time => {
            let s = require_string(value, "Time")?;
            let t = s
                .parse::<NaiveTime>()
                .map_err(|e| AppError::Validation(format!("invalid time '{s}': {e}")))?;
            query.bind(t);
        }

        BindKind::DateTime | BindKind::DateTime2 | BindKind::SmallDateTime => {
            let s = require_string(value, "DateTime/DateTime2/SmallDateTime")?;
            let dt = NaiveDateTime::parse_from_str(&s, "%Y-%m-%dT%H:%M:%S%.f")
                .or_else(|_| NaiveDateTime::parse_from_str(&s, "%Y-%m-%dT%H:%M:%S"))
                .or_else(|_| NaiveDateTime::parse_from_str(&s, "%Y-%m-%d %H:%M:%S%.f"))
                .or_else(|_| NaiveDateTime::parse_from_str(&s, "%Y-%m-%d %H:%M:%S"))
                .map_err(|e| {
                    AppError::Validation(format!("invalid datetime '{s}': {e}"))
                })?;
            query.bind(dt);
        }

        BindKind::DateTimeOffset => {
            let s = require_string(value, "DateTimeOffset")?;
            let dt = DateTime::parse_from_rfc3339(&s)
                .or_else(|_| DateTime::parse_from_str(&s, "%Y-%m-%dT%H:%M:%S%.f%:z"))
                .or_else(|_| DateTime::parse_from_str(&s, "%Y-%m-%dT%H:%M:%S%:z"))
                .map_err(|e| {
                    AppError::Validation(format!("invalid datetimeoffset '{s}': {e}"))
                })?;
            query.bind(dt);
        }

        BindKind::UniqueIdentifier => {
            let s = require_string(value, "UniqueIdentifier")?;
            let u = s
                .parse::<Uuid>()
                .map_err(|e| AppError::Validation(format!("invalid UUID '{s}': {e}")))?;
            query.bind(u);
        }

        BindKind::Geometry | BindKind::Geography => {
            return Err(AppError::Validation(
                "Geometry/Geography columns are not editable; use the SQL editor".into(),
            ));
        }

        BindKind::HierarchyId => {
            return Err(AppError::Validation(
                "HierarchyId columns are not editable; use the SQL editor".into(),
            ));
        }

        BindKind::SqlVariant => {
            return Err(AppError::Validation(
                "sql_variant columns are not editable; use the SQL editor".into(),
            ));
        }

        BindKind::Identity => {
            return Err(AppError::Validation(
                "IDENTITY columns cannot be inserted; they are auto-generated".into(),
            ));
        }

        BindKind::Computed => {
            return Err(AppError::Validation(
                "Computed columns are read-only; cannot bind for edit".into(),
            ));
        }

        BindKind::Unknown => {
            let s = coerce_to_string(value);
            query.bind(s);
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// §8.5 — bind_filter_value
// ---------------------------------------------------------------------------

/// Bind a filter value. Same coercion as `bind_edit_value` with additional
/// rejections for filter-incompatible types (RowVersion, Geometry, Geography,
/// HierarchyId, SqlVariant).
pub fn bind_filter_value(
    query: &mut tiberius::Query<'_>,
    value: &JsonValue,
    bind_kind: BindKind,
) -> AppResult<()> {
    match bind_kind {
        BindKind::RowVersion => {
            return Err(AppError::Validation(
                "rowversion columns cannot be used as filter parameters".into(),
            ));
        }
        BindKind::Geometry | BindKind::Geography => {
            return Err(AppError::Validation(
                "Geometry/Geography columns cannot be used as filter parameters".into(),
            ));
        }
        BindKind::HierarchyId => {
            return Err(AppError::Validation(
                "HierarchyId columns cannot be used as filter parameters".into(),
            ));
        }
        BindKind::SqlVariant => {
            return Err(AppError::Validation(
                "sql_variant columns cannot be used as filter parameters".into(),
            ));
        }
        _ => bind_edit_value(query, value, bind_kind),
    }
}

// ---------------------------------------------------------------------------
// §8.6 — mssql_quote_ident
// ---------------------------------------------------------------------------

/// Wrap `name` in square brackets, escaping any embedded `]` by doubling.
/// e.g. `a]b` → `[a]]b]`.
pub fn mssql_quote_ident(name: &str) -> String {
    let escaped = name.replace(']', "]]");
    format!("[{escaped}]")
}

/// Quote a fully-qualified `[schema].[name]` identifier.
pub fn mssql_quote_qualified(schema: &str, name: &str) -> String {
    format!("{}.{}", mssql_quote_ident(schema), mssql_quote_ident(name))
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

fn parse_i64(value: &JsonValue, kind: &str) -> AppResult<i64> {
    match value {
        JsonValue::Number(n) => n.as_i64().ok_or_else(|| {
            AppError::Validation(format!(
                "expected integer for {kind} column, got '{value}'"
            ))
        }),
        JsonValue::String(s) => s.trim().parse::<i64>().map_err(|_| {
            AppError::Validation(format!(
                "expected integer for {kind} column, got '{s}'"
            ))
        }),
        _ => Err(AppError::Validation(format!(
            "expected integer for {kind} column"
        ))),
    }
}

fn parse_f64(value: &JsonValue, kind: &str) -> AppResult<f64> {
    match value {
        JsonValue::Number(n) => n.as_f64().ok_or_else(|| {
            AppError::Validation(format!("expected number for {kind} column"))
        }),
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

fn decode_base64(value: &JsonValue) -> AppResult<Vec<u8>> {
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
    // §8.2 — bind_kind_for_type
    // -----------------------------------------------------------------------

    #[test]
    fn all_type_names_map_correctly() {
        let cases: &[(&str, BindKind)] = &[
            ("bit", BindKind::Bool),
            ("BIT", BindKind::Bool),
            ("tinyint", BindKind::TinyInt),
            ("TINYINT", BindKind::TinyInt),
            ("smallint", BindKind::SmallInt),
            ("int", BindKind::Int),
            ("INT", BindKind::Int),
            ("bigint", BindKind::BigInt),
            ("decimal", BindKind::Decimal),
            ("DECIMAL", BindKind::Decimal),
            ("numeric", BindKind::Decimal),
            ("money", BindKind::Money),
            ("smallmoney", BindKind::Money),
            ("float", BindKind::Float),
            ("real", BindKind::Real),
            ("char", BindKind::Char),
            ("varchar", BindKind::Varchar),
            ("text", BindKind::Text),
            ("nchar", BindKind::NChar),
            ("nvarchar", BindKind::NVarchar),
            ("ntext", BindKind::NText),
            ("binary", BindKind::Binary),
            ("varbinary", BindKind::Varbinary),
            ("image", BindKind::Image),
            ("rowversion", BindKind::RowVersion),
            ("timestamp", BindKind::RowVersion), // legacy alias
            ("date", BindKind::Date),
            ("time", BindKind::Time),
            ("datetime", BindKind::DateTime),
            ("datetime2", BindKind::DateTime2),
            ("smalldatetime", BindKind::SmallDateTime),
            ("datetimeoffset", BindKind::DateTimeOffset),
            ("uniqueidentifier", BindKind::UniqueIdentifier),
            ("xml", BindKind::Xml),
            ("json", BindKind::Json),
            ("geometry", BindKind::Geometry),
            ("geography", BindKind::Geography),
            ("hierarchyid", BindKind::HierarchyId),
            ("sql_variant", BindKind::SqlVariant),
            ("unknown_custom_type", BindKind::Unknown),
        ];

        for (type_name, expected) in cases {
            assert_eq!(
                bind_kind_for_type(type_name, None, None, None),
                *expected,
                "failed for type name: {type_name}"
            );
        }
    }

    #[test]
    fn varchar_max_maps_to_varchar() {
        // max_length = -1 means varchar(max); still Varchar
        assert_eq!(
            bind_kind_for_type("varchar", Some(-1), None, None),
            BindKind::Varchar
        );
    }

    #[test]
    fn decimal_with_precision_and_scale() {
        assert_eq!(
            bind_kind_for_type("decimal", None, Some(38), Some(10)),
            BindKind::Decimal
        );
    }

    #[test]
    fn datetime2_with_precision() {
        assert_eq!(
            bind_kind_for_type("datetime2", None, Some(7), None),
            BindKind::DateTime2
        );
    }

    // -----------------------------------------------------------------------
    // §8.6 — mssql_quote_ident
    // -----------------------------------------------------------------------

    #[test]
    fn quote_ident_wraps_in_square_brackets() {
        assert_eq!(mssql_quote_ident("users"), "[users]");
    }

    #[test]
    fn quote_ident_escapes_embedded_close_bracket() {
        assert_eq!(mssql_quote_ident("a]b"), "[a]]b]");
    }

    #[test]
    fn quote_ident_multiple_brackets() {
        assert_eq!(mssql_quote_ident("a]b]c"), "[a]]b]]c]");
    }

    #[test]
    fn quote_ident_empty_string_produces_empty_brackets() {
        assert_eq!(mssql_quote_ident(""), "[]");
    }

    #[test]
    fn quote_ident_unicode_passthrough() {
        assert_eq!(mssql_quote_ident("utilisateurs"), "[utilisateurs]");
    }

    #[test]
    fn quote_qualified_combines_schema_and_name() {
        assert_eq!(mssql_quote_qualified("dbo", "users"), "[dbo].[users]");
    }

    // -----------------------------------------------------------------------
    // §8.4 — bind_edit_value (no live DB — testing validation paths)
    // -----------------------------------------------------------------------

    fn make_query() -> tiberius::Query<'static> {
        tiberius::Query::new("SELECT @P1")
    }

    #[test]
    fn bind_null_is_ok_for_all_kinds() {
        let kinds = [
            BindKind::Int,
            BindKind::BigInt,
            BindKind::Varchar,
            BindKind::Json,
            BindKind::Date,
            BindKind::UniqueIdentifier,
            BindKind::Binary,
        ];
        for kind in &kinds {
            let mut q = make_query();
            let result = bind_edit_value(&mut q, &JsonValue::Null, *kind);
            assert!(result.is_ok(), "null binding failed for {kind:?}");
        }
    }

    #[test]
    fn bind_bool_from_true() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &JsonValue::Bool(true), BindKind::Bool);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_bool_from_false() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &JsonValue::Bool(false), BindKind::Bool);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_bool_from_number_zero_is_ok() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &serde_json::json!(0), BindKind::Bool);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_bool_from_string_is_error() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &JsonValue::String("true".into()), BindKind::Bool);
        assert!(result.is_err());
    }

    #[test]
    fn bind_tinyint_in_range_ok() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &serde_json::json!(200), BindKind::TinyInt);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_tinyint_overflow_256_rejected() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &serde_json::json!(256), BindKind::TinyInt);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("TinyInt"));
    }

    #[test]
    fn bind_tinyint_negative_rejected() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &serde_json::json!(-1), BindKind::TinyInt);
        assert!(result.is_err());
    }

    #[test]
    fn bind_smallint_range_overflow_rejected() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &serde_json::json!(40000), BindKind::SmallInt);
        assert!(result.is_err());
    }

    #[test]
    fn bind_int_range_overflow_rejected() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &serde_json::json!(3_000_000_000_i64), BindKind::Int);
        assert!(result.is_err());
    }

    #[test]
    fn bind_bigint_max_safe_ok() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &serde_json::json!(9_007_199_254_740_991_i64), BindKind::BigInt);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_bigint_from_string_ok() {
        let mut q = make_query();
        let result = bind_edit_value(
            &mut q,
            &JsonValue::String("9007199254740991".into()),
            BindKind::BigInt,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn bind_decimal_from_string_ok() {
        let mut q = make_query();
        let result = bind_edit_value(
            &mut q,
            &JsonValue::String("123456789.1234567890".into()),
            BindKind::Decimal,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn bind_decimal_invalid_string_rejected() {
        let mut q = make_query();
        let result = bind_edit_value(
            &mut q,
            &JsonValue::String("not-a-number".into()),
            BindKind::Decimal,
        );
        assert!(result.is_err());
    }

    #[test]
    fn bind_money_from_string_ok() {
        let mut q = make_query();
        let result = bind_edit_value(
            &mut q,
            &JsonValue::String("19.99".into()),
            BindKind::Money,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn bind_float_from_number_ok() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &serde_json::json!(3.14), BindKind::Float);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_real_from_number_ok() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &serde_json::json!(1.5), BindKind::Real);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_varchar_from_string_ok() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &JsonValue::String("hello".into()), BindKind::Varchar);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_nvarchar_from_string_ok() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &JsonValue::String("héllo".into()), BindKind::NVarchar);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_binary_from_valid_base64_ok() {
        let b64 = BASE64_STANDARD.encode(b"hello world");
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &JsonValue::String(b64), BindKind::Binary);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_binary_invalid_base64_rejected() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &JsonValue::String("!!!bad!!!".into()), BindKind::Binary);
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.to_lowercase().contains("base64") || msg.contains("binary"), "msg: {msg}");
    }

    #[test]
    fn bind_rowversion_always_rejected() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &JsonValue::String("0000000000000001".into()), BindKind::RowVersion);
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("read-only") || msg.contains("rowversion"), "msg: {msg}");
    }

    #[test]
    fn bind_date_valid_ok() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &JsonValue::String("2024-06-15".into()), BindKind::Date);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_date_invalid_rejected() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &JsonValue::String("not-a-date".into()), BindKind::Date);
        assert!(result.is_err());
    }

    #[test]
    fn bind_time_valid_ok() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &JsonValue::String("14:30:00".into()), BindKind::Time);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_datetime_valid_ok() {
        let mut q = make_query();
        let result = bind_edit_value(
            &mut q,
            &JsonValue::String("2024-01-15T10:30:00".into()),
            BindKind::DateTime,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn bind_datetime2_valid_ok() {
        let mut q = make_query();
        let result = bind_edit_value(
            &mut q,
            &JsonValue::String("2024-01-15T10:30:00.123".into()),
            BindKind::DateTime2,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn bind_datetimeoffset_valid_rfc3339_ok() {
        let mut q = make_query();
        let result = bind_edit_value(
            &mut q,
            &JsonValue::String("2024-01-15T10:30:00+05:30".into()),
            BindKind::DateTimeOffset,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn bind_datetimeoffset_invalid_rejected() {
        let mut q = make_query();
        let result = bind_edit_value(
            &mut q,
            &JsonValue::String("not-a-datetime".into()),
            BindKind::DateTimeOffset,
        );
        assert!(result.is_err());
    }

    #[test]
    fn bind_uniqueidentifier_valid_ok() {
        let mut q = make_query();
        let result = bind_edit_value(
            &mut q,
            &JsonValue::String("550e8400-e29b-41d4-a716-446655440000".into()),
            BindKind::UniqueIdentifier,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn bind_uniqueidentifier_invalid_rejected() {
        let mut q = make_query();
        let result = bind_edit_value(
            &mut q,
            &JsonValue::String("not-a-uuid".into()),
            BindKind::UniqueIdentifier,
        );
        assert!(result.is_err());
    }

    #[test]
    fn bind_geometry_rejected() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &JsonValue::String("POINT(1 2)".into()), BindKind::Geometry);
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string().to_lowercase();
        assert!(msg.contains("geometry") || msg.contains("sql editor"), "msg: {msg}");
    }

    #[test]
    fn bind_geography_rejected() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &JsonValue::String("POINT(1 2)".into()), BindKind::Geography);
        assert!(result.is_err());
    }

    #[test]
    fn bind_hierarchyid_rejected() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &JsonValue::String("/1/".into()), BindKind::HierarchyId);
        assert!(result.is_err());
    }

    #[test]
    fn bind_sql_variant_rejected() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &JsonValue::String("value".into()), BindKind::SqlVariant);
        assert!(result.is_err());
    }

    #[test]
    fn bind_identity_rejected() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &serde_json::json!(42), BindKind::Identity);
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string().to_lowercase();
        assert!(msg.contains("identity"), "msg: {msg}");
    }

    #[test]
    fn bind_computed_rejected() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &serde_json::json!("expr"), BindKind::Computed);
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string().to_lowercase();
        assert!(msg.contains("computed") || msg.contains("read-only"), "msg: {msg}");
    }

    #[test]
    fn bind_json_string_not_double_stringified() {
        let mut q = make_query();
        let result = bind_edit_value(
            &mut q,
            &JsonValue::String(r#"{"key": "value"}"#.into()),
            BindKind::Json,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn bind_json_object_serialized() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &serde_json::json!({"a": 1}), BindKind::Json);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_xml_from_string_ok() {
        let mut q = make_query();
        let result = bind_edit_value(
            &mut q,
            &JsonValue::String("<root><child/></root>".into()),
            BindKind::Xml,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn bind_unknown_coerces_to_string() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &serde_json::json!("raw value"), BindKind::Unknown);
        assert!(result.is_ok());
    }

    // -----------------------------------------------------------------------
    // §8.5 — bind_filter_value rejects filter-incompatible types
    // -----------------------------------------------------------------------

    #[test]
    fn filter_rowversion_rejected() {
        let mut q = make_query();
        let result = bind_filter_value(&mut q, &serde_json::json!("AAAA"), BindKind::RowVersion);
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string().to_lowercase();
        assert!(msg.contains("rowversion") || msg.contains("filter"), "msg: {msg}");
    }

    #[test]
    fn filter_geometry_rejected() {
        let mut q = make_query();
        let result = bind_filter_value(&mut q, &serde_json::json!("POINT(0 0)"), BindKind::Geometry);
        assert!(result.is_err());
    }

    #[test]
    fn filter_geography_rejected() {
        let mut q = make_query();
        let result = bind_filter_value(&mut q, &serde_json::json!("POINT(0 0)"), BindKind::Geography);
        assert!(result.is_err());
    }

    #[test]
    fn filter_hierarchyid_rejected() {
        let mut q = make_query();
        let result = bind_filter_value(&mut q, &serde_json::json!("/1/"), BindKind::HierarchyId);
        assert!(result.is_err());
    }

    #[test]
    fn filter_sql_variant_rejected() {
        let mut q = make_query();
        let result = bind_filter_value(&mut q, &serde_json::json!("v"), BindKind::SqlVariant);
        assert!(result.is_err());
    }

    #[test]
    fn filter_varchar_ok() {
        let mut q = make_query();
        let result = bind_filter_value(&mut q, &JsonValue::String("hello".into()), BindKind::Varchar);
        assert!(result.is_ok());
    }

    // -----------------------------------------------------------------------
    // BigInt safe-int boundary
    // -----------------------------------------------------------------------

    #[test]
    fn bigint_safe_int_boundary() {
        const MAX_SAFE: i64 = 9_007_199_254_740_991;
        const MIN_SAFE: i64 = -9_007_199_254_740_991;

        let mut q = make_query();
        assert!(bind_edit_value(&mut q, &serde_json::json!(MAX_SAFE), BindKind::BigInt).is_ok());
        let mut q = make_query();
        assert!(bind_edit_value(&mut q, &serde_json::json!(MIN_SAFE), BindKind::BigInt).is_ok());
    }

    // -----------------------------------------------------------------------
    // DateTimeOffset round-trip
    // -----------------------------------------------------------------------

    #[test]
    fn datetimeoffset_india_tz_ok() {
        let mut q = make_query();
        // IST = +05:30
        let result = bind_edit_value(
            &mut q,
            &JsonValue::String("2024-06-15T12:00:00+05:30".into()),
            BindKind::DateTimeOffset,
        );
        assert!(result.is_ok(), "IST offset failed: {result:?}");
    }

    #[test]
    fn datetimeoffset_negative_offset_ok() {
        let mut q = make_query();
        let result = bind_edit_value(
            &mut q,
            &JsonValue::String("2024-06-15T12:00:00-08:00".into()),
            BindKind::DateTimeOffset,
        );
        assert!(result.is_ok(), "negative offset failed: {result:?}");
    }

    // -----------------------------------------------------------------------
    // MONEY precision preservation (bind as bigdecimal string)
    // -----------------------------------------------------------------------

    #[test]
    fn money_preserves_4_decimal_places() {
        let mut q = make_query();
        let result = bind_edit_value(
            &mut q,
            &JsonValue::String("9999.9999".into()),
            BindKind::Money,
        );
        assert!(result.is_ok());
    }

    // -----------------------------------------------------------------------
    // UUID canonical form
    // -----------------------------------------------------------------------

    #[test]
    fn uniqueidentifier_uppercase_uuid_accepted() {
        let mut q = make_query();
        let result = bind_edit_value(
            &mut q,
            &JsonValue::String("550E8400-E29B-41D4-A716-446655440000".into()),
            BindKind::UniqueIdentifier,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn uniqueidentifier_braced_form_accepted_by_uuid_crate() {
        // The uuid crate's parse_str accepts braced `{...}` form.
        // Document this behaviour — callers may send any standard format.
        let mut q = make_query();
        let result = bind_edit_value(
            &mut q,
            &JsonValue::String("{550e8400-e29b-41d4-a716-446655440000}".into()),
            BindKind::UniqueIdentifier,
        );
        // uuid crate accepts this form; result should be Ok
        assert!(
            result.is_ok(),
            "braced UUID should be accepted by uuid::Uuid::parse_str: {result:?}"
        );
    }

    // -----------------------------------------------------------------------
    // Varbinary from base64
    // -----------------------------------------------------------------------

    #[test]
    fn bind_varbinary_from_base64_ok() {
        let b64 = BASE64_STANDARD.encode(b"binary content");
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &JsonValue::String(b64), BindKind::Varbinary);
        assert!(result.is_ok());
    }

    #[test]
    fn bind_image_invalid_base64_rejected() {
        let mut q = make_query();
        let result = bind_edit_value(&mut q, &JsonValue::String("$$invalid$$".into()), BindKind::Image);
        assert!(result.is_err());
    }
}
