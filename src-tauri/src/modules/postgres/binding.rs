use std::collections::HashMap;

use serde_json::Value as JsonValue;
use tokio_postgres::types::ToSql;

use crate::error::{AppError, AppResult};

/// Placeholder template for a single bound parameter. `Plain` renders to
/// `$N` (used for native-bind types where tokio-postgres serializes the value
/// directly). `Cast` renders to `$N::text::<type>` — the inner `::text` cast
/// forces Postgres to infer `$N` as `text`, which is what tokio-postgres binds
/// `String` to. Without the inner cast, `$N::<type>` makes Postgres infer `$N`
/// as the target type directly (for cast-from-self types like `jsonb`, `uuid`,
/// `numeric`), and tokio-postgres rejects the bind with `error serializing
/// parameter N`.
#[derive(Debug, Clone)]
pub(crate) enum PlaceholderTemplate {
    Plain,
    Cast(String),
}

impl PlaceholderTemplate {
    pub(crate) fn render(&self, idx: usize) -> String {
        match self {
            PlaceholderTemplate::Plain => format!("${idx}"),
            PlaceholderTemplate::Cast(t) => format!("${idx}::text::{t}"),
        }
    }
}

/// One bound parameter ready to push into the params Vec, paired with the
/// placeholder template the SQL builder must render at the param's position.
pub(crate) struct BoundParam {
    pub(crate) value: Box<dyn ToSql + Sync + Send>,
    pub(crate) placeholder: PlaceholderTemplate,
}

/// How a JSON value should be coerced for binding against a given Postgres
/// column type. Drives both the Rust target type and the placeholder shape
/// (plain `$N` or a `$N::<type>` cast).
#[derive(Debug, Clone)]
pub(crate) enum BindKind {
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

impl BindKind {
    pub(crate) fn display_name(&self) -> std::borrow::Cow<'_, str> {
        match self {
            BindKind::Int2 => "smallint".into(),
            BindKind::Int4 => "integer".into(),
            BindKind::Int8 => "bigint".into(),
            BindKind::Float4 => "real".into(),
            BindKind::Float8 => "double precision".into(),
            BindKind::Numeric => "numeric".into(),
            BindKind::Bool => "boolean".into(),
            BindKind::Text => "text".into(),
            BindKind::Uuid => "uuid".into(),
            BindKind::Date => "date".into(),
            BindKind::Time => "time".into(),
            BindKind::TimeTz => "timetz".into(),
            BindKind::Timestamp => "timestamp".into(),
            BindKind::TimestampTz => "timestamptz".into(),
            BindKind::Bytea => "bytea".into(),
            BindKind::Json => "json".into(),
            BindKind::Jsonb => "jsonb".into(),
            BindKind::Fallback(s) => s.as_str().into(),
        }
    }
}

/// Strip parameterized modifiers from a `pg_catalog.format_type` string and
/// lowercase it. Examples:
/// - `varchar(255)` → `varchar`
/// - `numeric(10,2)` → `numeric`
/// - `timestamp(6) with time zone` → `timestamp with time zone`
/// - `character varying(50)` → `character varying`
pub(crate) fn normalize_pg_type(raw: &str) -> String {
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
pub(crate) fn bind_kind_for_type(data_type: &str) -> BindKind {
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

/// Per-relation index from column name → bind kind. Built once per query and
/// consulted per column reference.
pub(crate) struct ColumnTypeIndex {
    kinds: HashMap<String, BindKind>,
}

impl ColumnTypeIndex {
    /// Build from any iterator of `(column_name, data_type)` pairs. Both
    /// strings are owned — callers adapt their `Vec<DataColumn>` via
    /// `.iter().map(|c| (c.name.as_str(), c.data_type.as_str()))`.
    pub(crate) fn from_iter<'a, I>(it: I) -> Self
    where
        I: IntoIterator<Item = (&'a str, &'a str)>,
    {
        let iter = it.into_iter();
        let (lo, _) = iter.size_hint();
        let mut kinds = HashMap::with_capacity(lo);
        for (name, data_type) in iter {
            kinds.insert(name.to_owned(), bind_kind_for_type(data_type));
        }
        Self { kinds }
    }

    pub(crate) fn kind_for(&self, name: &str) -> Option<&BindKind> {
        self.kinds.get(name)
    }
}

/// Short rendering of a JSON value for inclusion in validation messages.
pub(crate) fn repr_for_error(v: &JsonValue) -> String {
    match v {
        JsonValue::String(s) => s.clone(),
        other => other.to_string(),
    }
}

pub(crate) fn parse_int_value(v: &JsonValue, column: &str) -> AppResult<i64> {
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

pub(crate) fn parse_float_value(v: &JsonValue, column: &str) -> AppResult<f64> {
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

pub(crate) fn coerce_to_string(v: &JsonValue) -> String {
    match v {
        JsonValue::String(s) => s.clone(),
        JsonValue::Number(n) => n.to_string(),
        JsonValue::Bool(b) => b.to_string(),
        // bind_scalar rejects Null/Array/Object before this is reached.
        other => other.to_string(),
    }
}

/// Core scalar binding: converts a non-null, non-array, non-object JSON value
/// to a typed `BoundParam`. Callers MUST pre-check that `v` is not
/// `Null`/`Array`/`Object`.
fn bind_scalar(v: &JsonValue, column: &str, kind: &BindKind) -> AppResult<BoundParam> {
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
        BindKind::Json | BindKind::Jsonb => Ok(BoundParam {
            value: Box::new(v.clone()),
            placeholder: PlaceholderTemplate::Plain,
        }),
        BindKind::Fallback(type_name) => Ok(BoundParam {
            value: Box::new(coerce_to_string(v)),
            placeholder: PlaceholderTemplate::Cast(type_name.clone()),
        }),
    }
}

/// Convert a JSON filter value into a typed `BoundParam`. Rejects `null`,
/// `array`, and `object` values — callers MUST use `IS NULL` / `IS NOT NULL`
/// for null checks, and structured values are never valid filter operands.
pub(crate) fn bind_filter_value(
    v: &JsonValue,
    column: &str,
    kind: &BindKind,
) -> AppResult<BoundParam> {
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
    bind_scalar(v, column, kind)
}

/// Convert a JSON edit value into a typed `BoundParam`. Unlike
/// `bind_filter_value`, this accepts:
/// - `null` → typed `Option::<T>::None` with the placeholder shape for the kind
/// - `array`/`object` when `kind` is `Json` or `Jsonb` → serialized to a JSON
///   string and bound with the appropriate cast
/// - `array`/`object` for any other kind → `AppError::Validation`
pub(crate) fn bind_edit_value(
    v: &JsonValue,
    column: &str,
    kind: &BindKind,
) -> AppResult<BoundParam> {
    match v {
        JsonValue::Null => {
            let bp = match kind {
                BindKind::Int2 => BoundParam {
                    value: Box::new(Option::<i16>::None),
                    placeholder: PlaceholderTemplate::Plain,
                },
                BindKind::Int4 => BoundParam {
                    value: Box::new(Option::<i32>::None),
                    placeholder: PlaceholderTemplate::Plain,
                },
                BindKind::Int8 => BoundParam {
                    value: Box::new(Option::<i64>::None),
                    placeholder: PlaceholderTemplate::Plain,
                },
                BindKind::Float4 => BoundParam {
                    value: Box::new(Option::<f32>::None),
                    placeholder: PlaceholderTemplate::Plain,
                },
                BindKind::Float8 => BoundParam {
                    value: Box::new(Option::<f64>::None),
                    placeholder: PlaceholderTemplate::Plain,
                },
                BindKind::Bool => BoundParam {
                    value: Box::new(Option::<bool>::None),
                    placeholder: PlaceholderTemplate::Plain,
                },
                BindKind::Text => BoundParam {
                    value: Box::new(Option::<String>::None),
                    placeholder: PlaceholderTemplate::Plain,
                },
                BindKind::Numeric => BoundParam {
                    value: Box::new(Option::<String>::None),
                    placeholder: PlaceholderTemplate::Cast("numeric".into()),
                },
                BindKind::Uuid => BoundParam {
                    value: Box::new(Option::<String>::None),
                    placeholder: PlaceholderTemplate::Cast("uuid".into()),
                },
                BindKind::Date => BoundParam {
                    value: Box::new(Option::<String>::None),
                    placeholder: PlaceholderTemplate::Cast("date".into()),
                },
                BindKind::Time => BoundParam {
                    value: Box::new(Option::<String>::None),
                    placeholder: PlaceholderTemplate::Cast("time".into()),
                },
                BindKind::TimeTz => BoundParam {
                    value: Box::new(Option::<String>::None),
                    placeholder: PlaceholderTemplate::Cast("timetz".into()),
                },
                BindKind::Timestamp => BoundParam {
                    value: Box::new(Option::<String>::None),
                    placeholder: PlaceholderTemplate::Cast("timestamp".into()),
                },
                BindKind::TimestampTz => BoundParam {
                    value: Box::new(Option::<String>::None),
                    placeholder: PlaceholderTemplate::Cast("timestamptz".into()),
                },
                BindKind::Bytea => BoundParam {
                    value: Box::new(Option::<String>::None),
                    placeholder: PlaceholderTemplate::Cast("bytea".into()),
                },
                BindKind::Json | BindKind::Jsonb => BoundParam {
                    value: Box::new(Option::<JsonValue>::None),
                    placeholder: PlaceholderTemplate::Plain,
                },
                BindKind::Fallback(type_name) => BoundParam {
                    value: Box::new(Option::<String>::None),
                    placeholder: PlaceholderTemplate::Cast(type_name.clone()),
                },
            };
            Ok(bp)
        }
        JsonValue::Array(_) | JsonValue::Object(_) => match kind {
            BindKind::Json | BindKind::Jsonb => Ok(BoundParam {
                value: Box::new(v.clone()),
                placeholder: PlaceholderTemplate::Plain,
            }),
            _ => Err(AppError::Validation(format!(
                "structured value not allowed for column '{column}' of type {}",
                kind.display_name()
            ))),
        },
        _ => bind_scalar(v, column, kind),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bind_edit_value_int4_native() {
        let bp = bind_edit_value(&json!(42), "x", &BindKind::Int4).unwrap();
        assert!(matches!(bp.placeholder, PlaceholderTemplate::Plain));
    }

    #[test]
    fn bind_edit_value_jsonb_object_binds_native() {
        let bp = bind_edit_value(&json!({"a": 1}), "x", &BindKind::Jsonb).unwrap();
        assert!(matches!(bp.placeholder, PlaceholderTemplate::Plain));
    }

    #[test]
    fn bind_edit_value_null_on_int4() {
        let bp = bind_edit_value(&JsonValue::Null, "x", &BindKind::Int4).unwrap();
        assert!(matches!(bp.placeholder, PlaceholderTemplate::Plain));
    }

    #[test]
    fn bind_edit_value_null_on_jsonb() {
        let bp = bind_edit_value(&JsonValue::Null, "x", &BindKind::Jsonb).unwrap();
        assert!(matches!(bp.placeholder, PlaceholderTemplate::Plain));
    }

    #[test]
    fn bind_scalar_uuid_renders_double_cast() {
        let bp = bind_edit_value(
            &json!("00000000-0000-0000-0000-000000000000"),
            "x",
            &BindKind::Uuid,
        )
        .unwrap();
        assert_eq!(bp.placeholder.render(1), "$1::text::uuid");
    }

    #[test]
    fn bind_edit_value_object_on_text_rejected() {
        let err = bind_edit_value(&json!({"x": 1}), "name", &BindKind::Text)
            .err()
            .expect("expected Err");
        let msg = format!("{err}");
        assert!(msg.contains("name"), "msg: {msg}");
        assert!(msg.contains("text"), "msg: {msg}");
    }

    #[test]
    fn bind_filter_value_null_rejected() {
        let err = bind_filter_value(&JsonValue::Null, "x", &BindKind::Int4)
            .err()
            .expect("expected Err");
        assert!(format!("{err}").contains("null"));
    }

    #[test]
    fn bind_kind_display_names() {
        assert_eq!(BindKind::Int4.display_name().as_ref(), "integer");
        assert_eq!(BindKind::Jsonb.display_name().as_ref(), "jsonb");
        assert_eq!(BindKind::TimestampTz.display_name().as_ref(), "timestamptz");
        assert_eq!(
            BindKind::Fallback("inet".into()).display_name().as_ref(),
            "inet"
        );
    }

}
