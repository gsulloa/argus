//! Free-form SQL execution. Two commands surface the user's editor:
//!
//! - `postgres_run_sql(connection_id, sql, origin?)` runs one statement.
//! - `postgres_run_sql_many(connection_id, statements, origin?)` runs an
//!   already-split list of statements sequentially on the same client.
//!
//! Read-only enforcement happens here via `is_mutating_sql` (a heuristic — see
//! its docs). The pool's existing read-only hook also rejects mutations at the
//! wire, but doing the check in this module lets us return a clean validation
//! error before dispatch and lets multi-statement runs halt cleanly.

use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use deadpool_postgres::Object as PgObject;
use serde::Serialize;
use serde_json::Value as JsonValue;
use tauri::{AppHandle, Manager, State};
use time::format_description::well_known::Rfc3339;
use time::{Date, OffsetDateTime, PrimitiveDateTime, Time};
use tokio::time::timeout;
use tokio_postgres::types::{FromSql, Type as PgType};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::postgres::data::{fire_cancel, DataColumn};
use crate::modules::postgres::pool::PgPoolRegistry;
use crate::modules::query_cancel::{CancelAction, RunningQueryRegistry};
use crate::modules::query_history::{self, HistoryOrigin, HistoryStatus, NewEntry};
use crate::platform::DbState;

/// Hard cap on a single `postgres_run_sql` statement. Generous (60s) because
/// the user is intentionally running arbitrary SQL — but bounded so a runaway
/// query doesn't pin a pool client forever. A real cancel button is follow-up.
const RUN_SQL_TIMEOUT: Duration = Duration::from_secs(60);
/// Maximum rows we materialize for a single result set. Past this we mark the
/// response truncated and stop fetching.
const RESULT_ROW_CAP: usize = 10_000;
/// Inline preview length when a textual cell is too large to ship verbatim.
const INLINE_TRUNCATE_BYTES: usize = 1_048_576;

// --------------------------------------------------------------------------
// Mutation classifier
// --------------------------------------------------------------------------

/// Best-effort classifier: returns `true` when `sql` LOOKS like it mutates
/// state. Strips a leading SQL comment block, then peeks at the first keyword.
/// Conservative — anything we don't recognize as plainly read-only is treated
/// as mutating, so a read-only connection rejects unknown DDL/DCL words.
///
/// This is a heuristic; it can be fooled by `DO $$ INSERT … $$` blocks or
/// stored procs that mutate via SELECT. Defense-in-depth: the pool is also
/// configured `default_transaction_read_only = on` for read-only connections,
/// so the wire-level guard is the real safety net.
pub(crate) fn is_mutating_sql(sql: &str) -> bool {
    let stripped = strip_leading_comments(sql);
    let mut chars = stripped.chars();
    let mut first_word = String::new();
    while let Some(c) = chars.next() {
        if c.is_alphabetic() {
            first_word.push(c.to_ascii_uppercase());
            for c2 in chars.by_ref() {
                if c2.is_alphabetic() || c2 == '_' {
                    first_word.push(c2.to_ascii_uppercase());
                } else {
                    break;
                }
            }
            break;
        }
    }
    if first_word.is_empty() {
        return false;
    }
    // Read-only first keywords. Anything else is treated as mutating.
    matches!(
        first_word.as_str(),
        "SELECT"
            | "WITH"
            | "EXPLAIN"
            | "SHOW"
            | "VALUES"
            | "TABLE"
            | "FETCH"
            | "BEGIN"
            | "START"
            | "COMMIT"
            | "ROLLBACK"
            | "SAVEPOINT"
            | "RELEASE"
            | "SET"
            | "RESET"
            | "DECLARE"
            | "CLOSE"
            | "MOVE"
            | "DEALLOCATE"
            | "DISCARD"
            | "LISTEN"
            | "UNLISTEN"
            | "PREPARE"
    ) == false
}

fn strip_leading_comments(sql: &str) -> &str {
    let bytes = sql.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b' ' || b == b'\t' || b == b'\n' || b == b'\r' {
            i += 1;
            continue;
        }
        if b == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-' {
            // line comment until newline.
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            // block comment, possibly nested.
            i += 2;
            let mut depth: usize = 1;
            while i + 1 < bytes.len() && depth > 0 {
                if bytes[i] == b'/' && bytes[i + 1] == b'*' {
                    depth += 1;
                    i += 2;
                } else if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        break;
    }
    &sql[i.min(sql.len())..]
}

// --------------------------------------------------------------------------
// Result envelope
// --------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RunSqlResult {
    Rows {
        columns: Vec<DataColumn>,
        rows: Vec<Vec<JsonValue>>,
        truncated_columns: Vec<String>,
        truncated: bool,
        query_ms: u64,
    },
    Affected {
        command_tag: String,
        affected_rows: u64,
        query_ms: u64,
    },
}

/// Per-statement error envelope used by `postgres_run_sql_many`. The single
/// command surfaces these via `AppError::Postgres` instead.
#[derive(Debug, Clone, Serialize)]
pub struct RunSqlErrorEnvelope {
    pub message: String,
    pub code: Option<String>,
    pub position: Option<i32>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RunManyOutcome {
    Ok {
        statement_index: usize,
        result: RunSqlResult,
    },
    Err {
        statement_index: usize,
        error: RunSqlErrorEnvelope,
    },
    Skipped {
        statement_index: usize,
    },
}

// --------------------------------------------------------------------------
// Core execution
// --------------------------------------------------------------------------

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

// --------------------------------------------------------------------------
// Newtype FromSql decoders for types not handled by tokio-postgres builtins
// --------------------------------------------------------------------------

/// Postgres INTERVAL wire format: 16 bytes big-endian
///   bytes  0..8  → i64 microseconds
///   bytes  8..12 → i32 days
///   bytes 12..16 → i32 months
struct PgInterval(String);

impl<'a> FromSql<'a> for PgInterval {
    fn from_sql(
        _ty: &PgType,
        raw: &'a [u8],
    ) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        if raw.len() != 16 {
            return Err(format!("interval: expected 16 bytes, got {}", raw.len()).into());
        }
        let micros = i64::from_be_bytes(raw[0..8].try_into().unwrap());
        let days = i32::from_be_bytes(raw[8..12].try_into().unwrap());
        let months = i32::from_be_bytes(raw[12..16].try_into().unwrap());

        let years = months / 12;
        let mons = months % 12;

        let mut parts: Vec<String> = Vec::new();

        if years != 0 {
            if years.abs() == 1 {
                parts.push(format!("{} year", years));
            } else {
                parts.push(format!("{} years", years));
            }
        }
        if mons != 0 {
            if mons.abs() == 1 {
                parts.push(format!("{} mon", mons));
            } else {
                parts.push(format!("{} mons", mons));
            }
        }
        if days != 0 {
            if days.abs() == 1 {
                parts.push(format!("{} day", days));
            } else {
                parts.push(format!("{} days", days));
            }
        }

        // Time component from microseconds (independent sign from days/months).
        let neg_time = micros < 0;
        let abs_micros = micros.unsigned_abs();
        let us_rem = abs_micros % 1_000_000;
        let total_secs = abs_micros / 1_000_000;
        let secs = total_secs % 60;
        let total_mins = total_secs / 60;
        let mins = total_mins % 60;
        let hours = total_mins / 60;

        // Always emit the time component — it's part of the canonical interval
        // representation (Postgres does not suppress it for date-only values).
        let time_str = if us_rem == 0 {
            if neg_time {
                format!("-{:02}:{:02}:{:02}", hours, mins, secs)
            } else {
                format!("{:02}:{:02}:{:02}", hours, mins, secs)
            }
        } else {
            // Trim trailing zeros from fractional seconds.
            let frac = format!("{:06}", us_rem);
            let frac = frac.trim_end_matches('0');
            if neg_time {
                format!("-{:02}:{:02}:{:02}.{}", hours, mins, secs, frac)
            } else {
                format!("{:02}:{:02}:{:02}.{}", hours, mins, secs, frac)
            }
        };

        parts.push(time_str);

        Ok(PgInterval(parts.join(" ")))
    }

    fn accepts(ty: &PgType) -> bool {
        *ty == PgType::INTERVAL
    }
}

/// Postgres XID (transaction id) — 4-byte big-endian u32.
struct PgXid(u32);

impl<'a> FromSql<'a> for PgXid {
    fn from_sql(
        _ty: &PgType,
        raw: &'a [u8],
    ) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        if raw.len() != 4 {
            return Err(format!("xid: expected 4 bytes, got {}", raw.len()).into());
        }
        Ok(PgXid(u32::from_be_bytes(raw[0..4].try_into().unwrap())))
    }

    fn accepts(ty: &PgType) -> bool {
        *ty == PgType::XID
    }
}

/// Postgres XID8 — 8-byte big-endian u64.
struct PgXid8(u64);

impl<'a> FromSql<'a> for PgXid8 {
    fn from_sql(
        _ty: &PgType,
        raw: &'a [u8],
    ) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        if raw.len() != 8 {
            return Err(format!("xid8: expected 8 bytes, got {}", raw.len()).into());
        }
        Ok(PgXid8(u64::from_be_bytes(raw[0..8].try_into().unwrap())))
    }

    fn accepts(ty: &PgType) -> bool {
        *ty == PgType::XID8
    }
}

/// Postgres INET / CIDR wire format:
///   byte 0: family (2 = IPv4, 3 = IPv6)
///   byte 1: bits (prefix length)
///   byte 2: is_cidr (0 or 1)
///   byte 3: addr_len (4 or 16)
///   bytes 4..: address bytes (addr_len of them)
struct PgInet(String);

impl<'a> FromSql<'a> for PgInet {
    fn from_sql(
        _ty: &PgType,
        raw: &'a [u8],
    ) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        if raw.len() < 4 {
            return Err(format!("inet: expected at least 4 bytes, got {}", raw.len()).into());
        }
        let family = raw[0];
        let bits = raw[1];
        let is_cidr = raw[2];
        let addr_len = raw[3] as usize;
        if raw.len() != 4 + addr_len {
            return Err(format!("inet: expected {} bytes, got {}", 4 + addr_len, raw.len()).into());
        }
        let addr_bytes = &raw[4..];
        let s = match family {
            2 => {
                // IPv4
                if addr_len != 4 {
                    return Err(format!("inet: IPv4 addr_len must be 4, got {}", addr_len).into());
                }
                let ip = Ipv4Addr::new(addr_bytes[0], addr_bytes[1], addr_bytes[2], addr_bytes[3]);
                if is_cidr == 0 && bits == 32 {
                    ip.to_string()
                } else {
                    format!("{}/{}", ip, bits)
                }
            }
            3 => {
                // IPv6
                if addr_len != 16 {
                    return Err(format!("inet: IPv6 addr_len must be 16, got {}", addr_len).into());
                }
                let mut octets = [0u8; 16];
                octets.copy_from_slice(addr_bytes);
                let ip = Ipv6Addr::from(octets);
                if is_cidr == 0 && bits == 128 {
                    ip.to_string()
                } else {
                    format!("{}/{}", ip, bits)
                }
            }
            _ => return Err(format!("inet: unknown address family {}", family).into()),
        };
        Ok(PgInet(s))
    }

    fn accepts(ty: &PgType) -> bool {
        *ty == PgType::INET || *ty == PgType::CIDR
    }
}

/// Postgres MACADDR (6 bytes) / MACADDR8 (8 bytes) — lowercase colon-separated hex.
struct PgMacAddr(String);

impl<'a> FromSql<'a> for PgMacAddr {
    fn from_sql(
        _ty: &PgType,
        raw: &'a [u8],
    ) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        if raw.len() != 6 && raw.len() != 8 {
            return Err(format!("macaddr: expected 6 or 8 bytes, got {}", raw.len()).into());
        }
        let s = raw
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<Vec<_>>()
            .join(":");
        Ok(PgMacAddr(s))
    }

    fn accepts(ty: &PgType) -> bool {
        *ty == PgType::MACADDR || *ty == PgType::MACADDR8
    }
}

/// Convert a `tokio_postgres::Row` value at `idx` into a `JsonValue`. We try
/// the most likely Rust types first and fall back to a String of the Postgres
/// representation when nothing matches. Large strings and binary collapse to
/// the same envelope shape used by `postgres_query_table`.
fn cell_to_json(
    row: &tokio_postgres::Row,
    idx: usize,
    column_name: &str,
    truncated_columns: &mut Vec<String>,
) -> JsonValue {
    let col = &row.columns()[idx];
    let pg_type = col.type_();
    // Common scalar types first.
    match *pg_type {
        PgType::BOOL => match row.try_get::<_, Option<bool>>(idx) {
            Ok(Some(b)) => return JsonValue::Bool(b),
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        PgType::INT2 => match row.try_get::<_, Option<i16>>(idx) {
            Ok(Some(v)) => return JsonValue::Number((v as i64).into()),
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        PgType::INT4 => match row.try_get::<_, Option<i32>>(idx) {
            Ok(Some(v)) => return JsonValue::Number((v as i64).into()),
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        PgType::INT8 => match row.try_get::<_, Option<i64>>(idx) {
            Ok(Some(v)) => return JsonValue::Number(v.into()),
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        PgType::FLOAT4 => match row.try_get::<_, Option<f32>>(idx) {
            Ok(Some(v)) => {
                let n = serde_json::Number::from_f64(v as f64);
                return n.map(JsonValue::Number).unwrap_or(JsonValue::Null);
            }
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        PgType::FLOAT8 => match row.try_get::<_, Option<f64>>(idx) {
            Ok(Some(v)) => {
                let n = serde_json::Number::from_f64(v);
                return n.map(JsonValue::Number).unwrap_or(JsonValue::Null);
            }
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        PgType::JSON | PgType::JSONB => match row.try_get::<_, Option<JsonValue>>(idx) {
            Ok(Some(v)) => return v,
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        PgType::BYTEA => match row.try_get::<_, Option<Vec<u8>>>(idx) {
            Ok(Some(bytes)) => {
                let mut hex = String::with_capacity(bytes.len() * 2);
                for b in bytes.iter().take(64) {
                    use std::fmt::Write;
                    let _ = write!(&mut hex, "{:02x}", b);
                }
                if !truncated_columns.iter().any(|n| n == column_name) {
                    truncated_columns.push(column_name.to_string());
                }
                return binary_envelope(hex, bytes.len());
            }
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        // Date / time types — `tokio-postgres`'s `with-time-0_3` feature
        // bridges to the `time` crate's types. Each is rendered as a string
        // so the grid shows the real value, not `<timestamptz>`.
        PgType::TIMESTAMPTZ => match row.try_get::<_, Option<OffsetDateTime>>(idx) {
            Ok(Some(v)) => {
                // RFC 3339 is a strict subset of ISO 8601 and is the canonical
                // representation Postgres' clients expect for timestamptz.
                return JsonValue::String(v.format(&Rfc3339).unwrap_or_else(|_| v.to_string()));
            }
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        PgType::TIMESTAMP => match row.try_get::<_, Option<PrimitiveDateTime>>(idx) {
            // PrimitiveDateTime has no offset, so RFC 3339 doesn't apply.
            // Display gives "YYYY-MM-DD HH:MM:SS.fffffffff" — readable and
            // unambiguous; the trailing zeros may bother some users but the
            // alternative is bespoke format strings for one column.
            Ok(Some(v)) => return JsonValue::String(v.to_string()),
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        PgType::DATE => match row.try_get::<_, Option<Date>>(idx) {
            // `Date::Display` → "YYYY-MM-DD".
            Ok(Some(v)) => return JsonValue::String(v.to_string()),
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        PgType::TIME => match row.try_get::<_, Option<Time>>(idx) {
            // `Time::Display` → "HH:MM:SS.fffffffff".
            Ok(Some(v)) => return JsonValue::String(v.to_string()),
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        PgType::UUID => match row.try_get::<_, Option<Uuid>>(idx) {
            Ok(Some(v)) => return JsonValue::String(v.to_string()),
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        PgType::OID => match row.try_get::<_, Option<u32>>(idx) {
            Ok(Some(v)) => return JsonValue::Number(u64::from(v).into()),
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        PgType::XID => match row.try_get::<_, Option<PgXid>>(idx) {
            Ok(Some(v)) => return JsonValue::Number(u64::from(v.0).into()),
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        PgType::XID8 => match row.try_get::<_, Option<PgXid8>>(idx) {
            Ok(Some(v)) => return JsonValue::Number(v.0.into()),
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        PgType::INTERVAL => match row.try_get::<_, Option<PgInterval>>(idx) {
            Ok(Some(v)) => return JsonValue::String(v.0),
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        PgType::INET | PgType::CIDR => match row.try_get::<_, Option<PgInet>>(idx) {
            Ok(Some(v)) => return JsonValue::String(v.0),
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        PgType::MACADDR | PgType::MACADDR8 => match row.try_get::<_, Option<PgMacAddr>>(idx) {
            Ok(Some(v)) => return JsonValue::String(v.0),
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        _ => {}
    }
    // Try string. Covers TEXT, VARCHAR, NAME, UUID, dates, etc. — they all
    // implement FromSql for String via their textual repr.
    if let Ok(opt) = row.try_get::<_, Option<String>>(idx) {
        return match opt {
            Some(s) => {
                if s.len() > INLINE_TRUNCATE_BYTES {
                    let preview: String = s.chars().take(2048).collect();
                    if !truncated_columns.iter().any(|n| n == column_name) {
                        truncated_columns.push(column_name.to_string());
                    }
                    truncated_envelope(preview, s.len())
                } else {
                    JsonValue::String(s)
                }
            }
            None => JsonValue::Null,
        };
    }
    // Last resort: render as a typed envelope describing the unsupported type.
    // The user sees what's happening rather than a blank cell.
    JsonValue::String(format!("<{}>", pg_type.name()))
}

fn columns_from_row_meta(row_columns: &[tokio_postgres::Column]) -> Vec<DataColumn> {
    row_columns
        .iter()
        .enumerate()
        .map(|(i, c)| DataColumn {
            name: c.name().to_string(),
            data_type: c.type_().name().to_string(),
            ordinal_position: (i + 1) as i32,
            is_nullable: true,
        })
        .collect()
}

/// Synthesize a Postgres-style command tag from the SQL's first keyword and
/// the affected-row count. tokio-postgres' `Client::execute` only returns the
/// row count — the underlying tag string is parsed and dropped. We rebuild
/// something close to what the user would see in `psql` so the UI summary
/// reads naturally (`INSERT 0 3`, `UPDATE 5`, `CREATE TABLE`).
fn synthesize_command_tag(sql: &str, affected: u64) -> String {
    let stripped = strip_leading_comments(sql);
    let mut chars = stripped.chars();
    let mut keyword = String::new();
    while let Some(c) = chars.next() {
        if c.is_alphabetic() {
            keyword.push(c.to_ascii_uppercase());
            for c2 in chars.by_ref() {
                if c2.is_alphabetic() {
                    keyword.push(c2.to_ascii_uppercase());
                } else {
                    break;
                }
            }
            break;
        }
    }
    if keyword.is_empty() {
        return format!("EXECUTED {}", affected);
    }
    match keyword.as_str() {
        "INSERT" => format!("INSERT 0 {}", affected),
        "UPDATE" | "DELETE" | "SELECT" | "MOVE" | "FETCH" | "COPY" | "MERGE" => {
            format!("{} {}", keyword, affected)
        }
        _ => keyword, // DDL & friends — no count.
    }
}

/// Run a single statement on `client`. Treats SELECT-shape statements as a
/// rows result; everything else as `affected`. The classifier here is only
/// used to short-circuit read-only enforcement; the actual SELECT-vs-execute
/// branching uses the existence of result columns.
async fn run_one(client: &PgObject, sql: &str, is_read_only: bool) -> AppResult<RunSqlResult> {
    if is_read_only && is_mutating_sql(sql) {
        return Err(AppError::Validation("connection is read-only".into()));
    }
    let started = Instant::now();
    // `simple_query` returns an enum stream we'd have to interpret — instead
    // we use `query` for SELECT-shape and `execute` for the rest, classifying
    // by whether the prepared statement carries result columns. We prepare
    // first so the same code path handles both. `prepare` is cheap (it goes to
    // the wire once) and lets us decide in the same connection trip.
    let stmt = client.prepare(sql).await?;
    if stmt.columns().is_empty() {
        // No result set → execute, return affected.
        let affected = client.execute(&stmt, &[]).await?;
        let query_ms = started.elapsed().as_millis() as u64;
        return Ok(RunSqlResult::Affected {
            command_tag: synthesize_command_tag(sql, affected),
            affected_rows: affected,
            query_ms,
        });
    }
    // Rows path. `query` materializes the entire result set; we cap by
    // truncating after the fact. A streaming cursor approach is a future
    // improvement — for now this matches the existing `postgres_query_table`
    // pattern and keeps the cap as a safety net.
    let rows = client.query(&stmt, &[]).await?;
    let columns = columns_from_row_meta(stmt.columns());
    let mut truncated_columns: Vec<String> = Vec::new();
    let mut out_rows: Vec<Vec<JsonValue>> = Vec::new();
    let truncated = rows.len() > RESULT_ROW_CAP;
    for row in rows.iter().take(RESULT_ROW_CAP) {
        let mut cells: Vec<JsonValue> = Vec::with_capacity(columns.len());
        for (i, col) in columns.iter().enumerate() {
            cells.push(cell_to_json(row, i, &col.name, &mut truncated_columns));
        }
        out_rows.push(cells);
    }
    let query_ms = started.elapsed().as_millis() as u64;
    Ok(RunSqlResult::Rows {
        columns,
        rows: out_rows,
        truncated_columns,
        truncated,
        query_ms,
    })
}

fn parse_id(id: &str) -> AppResult<Uuid> {
    Uuid::parse_str(id).map_err(|e| AppError::Validation(format!("bad uuid: {e}")))
}

fn metric_for_result(result: &RunSqlResult) -> Metric {
    match result {
        RunSqlResult::Rows { rows, .. } => Metric::Rows {
            value: rows.len() as u64,
        },
        RunSqlResult::Affected { affected_rows, .. } => Metric::Affected {
            value: *affected_rows as i64,
        },
    }
}

// --------------------------------------------------------------------------
// Query history persistence
// --------------------------------------------------------------------------

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn origin_to_history(o: Origin) -> HistoryOrigin {
    match o {
        Origin::User => HistoryOrigin::User,
        Origin::Auto => HistoryOrigin::Auto,
    }
}

/// Resolve the latest registered name for a connection. Falls back to the
/// stringified UUID if the connection has been removed (the run still
/// succeeded against an active pool, so this is a defensive fallback only).
fn fetch_connection_name(app: &AppHandle, id: Uuid) -> String {
    let db = app.state::<DbState>();
    let conn = db.0.lock().expect("db poisoned");
    conn.query_row(
        "SELECT name FROM connections WHERE id = ?1",
        rusqlite::params![id.as_bytes().to_vec()],
        |r| r.get::<_, String>(0),
    )
    .unwrap_or_else(|_| id.to_string())
}

fn build_history_entry_ok(
    connection_id: Uuid,
    connection_name: &str,
    sql: &str,
    origin: Origin,
    started_at_ms: i64,
    duration_ms: u64,
    result: &RunSqlResult,
) -> NewEntry {
    let (row_count, command_tag) = match result {
        RunSqlResult::Rows { rows, .. } => (Some(rows.len() as i64), None),
        RunSqlResult::Affected {
            affected_rows,
            command_tag,
            ..
        } => (Some(*affected_rows as i64), Some(command_tag.clone())),
    };
    NewEntry {
        connection_id,
        connection_name: connection_name.to_string(),
        sql: sql.to_string(),
        origin: origin_to_history(origin),
        status: HistoryStatus::Ok,
        started_at: started_at_ms,
        duration_ms: duration_ms as i64,
        row_count,
        command_tag,
        error_code: None,
        error_message: None,
    }
}

fn build_history_entry_err(
    connection_id: Uuid,
    connection_name: &str,
    sql: &str,
    origin: Origin,
    started_at_ms: i64,
    duration_ms: u64,
    err: &AppError,
) -> NewEntry {
    let (code, message) = match err {
        AppError::Postgres(b) => (b.code.clone(), b.message.clone()),
        other => (None, other.to_string()),
    };
    NewEntry {
        connection_id,
        connection_name: connection_name.to_string(),
        sql: sql.to_string(),
        origin: origin_to_history(origin),
        status: HistoryStatus::Err,
        started_at: started_at_ms,
        duration_ms: duration_ms as i64,
        row_count: None,
        command_tag: None,
        error_code: code,
        error_message: Some(message),
    }
}

fn record_history_ok(
    app: &AppHandle,
    connection_id: Uuid,
    connection_name: &str,
    sql: &str,
    origin: Origin,
    started_at_ms: i64,
    duration_ms: u64,
    result: &RunSqlResult,
) {
    let entry = build_history_entry_ok(
        connection_id,
        connection_name,
        sql,
        origin,
        started_at_ms,
        duration_ms,
        result,
    );
    let db = app.state::<DbState>();
    let conn = db.0.lock().expect("db poisoned");
    query_history::insert_entry(&conn, entry);
}

fn record_history_err(
    app: &AppHandle,
    connection_id: Uuid,
    connection_name: &str,
    sql: &str,
    origin: Origin,
    started_at_ms: i64,
    duration_ms: u64,
    err: &AppError,
) {
    let entry = build_history_entry_err(
        connection_id,
        connection_name,
        sql,
        origin,
        started_at_ms,
        duration_ms,
        err,
    );
    let db = app.state::<DbState>();
    let conn = db.0.lock().expect("db poisoned");
    query_history::insert_entry(&conn, entry);
}

// --------------------------------------------------------------------------
// Tauri commands
// --------------------------------------------------------------------------

#[tauri::command]
pub async fn postgres_run_sql(
    app: AppHandle,
    pools: State<'_, PgPoolRegistry>,
    registry: State<'_, RunningQueryRegistry>,
    id: String,
    sql: String,
    origin: Option<Origin>,
    run_token: Option<String>,
) -> AppResult<RunSqlResult> {
    let started_wall_ms = now_unix_ms();
    let started = Instant::now();
    let activity_origin = origin.unwrap_or(Origin::User);
    let parsed = parse_id(&id)?;

    if sql.trim().is_empty() {
        return Err(AppError::Validation("empty SQL".into()));
    }

    let connection_name = fetch_connection_name(&app, parsed);

    let inner: AppResult<RunSqlResult> = async {
        let summaries = pools.list_active().await;
        let pool_entry = summaries
            .into_iter()
            .find(|s| s.id == parsed)
            .ok_or_else(|| AppError::NotFound(format!("no active pool for {parsed}")))?;
        let is_read_only = pool_entry.read_only;
        let sslmode = pools.sslmode_for(&parsed).await?;
        let client = pools.acquire(&parsed).await?;
        let cancel_token = client.cancel_token();

        // Register with the cancel registry if a run_token was supplied.
        let _guard = if let Some(ref tok_str) = run_token {
            if let Ok(token) = Uuid::parse_str(tok_str) {
                let ct = cancel_token.clone();
                let action: CancelAction = Arc::new(move || {
                    let ct = ct.clone();
                    Box::pin(async move { fire_cancel(ct, sslmode).await })
                });
                Some(registry.register(token, action).await)
            } else {
                None
            }
        } else {
            None
        };

        let result = match timeout(RUN_SQL_TIMEOUT, run_one(&client, &sql, is_read_only)).await {
            Ok(r) => r,
            Err(_) => {
                fire_cancel(cancel_token, sslmode).await;
                drop(client);
                Err(AppError::postgres_with_code(
                    "57014",
                    format!("run-sql timed out ({}s)", RUN_SQL_TIMEOUT.as_secs()),
                ))
            }
        };

        // If the run was cancelled, override any result/error with the neutral cancelled error.
        if _guard.as_ref().map_or(false, |g| g.cancelled()) {
            return Err(AppError::cancelled());
        }

        result
    }
    .await;

    let total_ms = started.elapsed().as_millis() as u64;
    let builder = ActivityLogEntryBuilder::new(ActivityKind::RunSql, activity_origin, total_ms)
        .connection(parsed)
        .sql(sql.clone());
    match &inner {
        Ok(r) => {
            emit_activity(&app, builder.ok(Some(metric_for_result(r))));
            record_history_ok(
                &app,
                parsed,
                &connection_name,
                &sql,
                activity_origin,
                started_wall_ms,
                total_ms,
                r,
            );
        }
        Err(e) => {
            emit_activity(&app, builder.err(e));
            record_history_err(
                &app,
                parsed,
                &connection_name,
                &sql,
                activity_origin,
                started_wall_ms,
                total_ms,
                e,
            );
        }
    }
    inner
}

#[tauri::command]
pub async fn postgres_run_sql_many(
    app: AppHandle,
    pools: State<'_, PgPoolRegistry>,
    registry: State<'_, RunningQueryRegistry>,
    id: String,
    statements: Vec<String>,
    origin: Option<Origin>,
    run_token: Option<String>,
) -> AppResult<Vec<RunManyOutcome>> {
    let activity_origin = origin.unwrap_or(Origin::User);
    let parsed = parse_id(&id)?;

    if statements.is_empty() {
        return Err(AppError::Validation("no statements to run".into()));
    }

    let summaries = pools.list_active().await;
    let pool_entry = summaries
        .into_iter()
        .find(|s| s.id == parsed)
        .ok_or_else(|| AppError::NotFound(format!("no active pool for {parsed}")))?;
    let is_read_only = pool_entry.read_only;
    let sslmode = pools.sslmode_for(&parsed).await?;
    // Hold the same client across the whole run so session-scoped statements
    // (SET search_path, BEGIN/COMMIT) take effect for later statements.
    let client = pools.acquire(&parsed).await?;
    let cancel_token = client.cancel_token();
    let connection_name = fetch_connection_name(&app, parsed);

    // Register with the cancel registry once for the whole batch.
    let guard = if let Some(ref tok_str) = run_token {
        if let Ok(token) = Uuid::parse_str(tok_str) {
            let ct = cancel_token.clone();
            let action: CancelAction = Arc::new(move || {
                let ct = ct.clone();
                Box::pin(async move { fire_cancel(ct, sslmode).await })
            });
            Some(registry.register(token, action).await)
        } else {
            None
        }
    } else {
        None
    };

    let mut outcomes: Vec<RunManyOutcome> = Vec::with_capacity(statements.len());
    let mut halted = false;

    for (idx, sql) in statements.iter().enumerate() {
        if halted {
            outcomes.push(RunManyOutcome::Skipped {
                statement_index: idx,
            });
            continue;
        }
        if sql.trim().is_empty() {
            // Skip empty splits silently — emit nothing.
            outcomes.push(RunManyOutcome::Skipped {
                statement_index: idx,
            });
            continue;
        }
        let started_wall_ms = now_unix_ms();
        let started = Instant::now();
        let result = timeout(RUN_SQL_TIMEOUT, run_one(&client, sql, is_read_only)).await;
        let total_ms = started.elapsed().as_millis() as u64;

        // If the batch was cancelled during this statement, stop immediately.
        if guard.as_ref().map_or(false, |g| g.cancelled()) {
            drop(client);
            return Err(AppError::cancelled());
        }

        let builder = ActivityLogEntryBuilder::new(ActivityKind::RunSql, activity_origin, total_ms)
            .connection(parsed)
            .sql(sql.clone());

        match result {
            Ok(Ok(r)) => {
                emit_activity(&app, builder.ok(Some(metric_for_result(&r))));
                record_history_ok(
                    &app,
                    parsed,
                    &connection_name,
                    sql,
                    activity_origin,
                    started_wall_ms,
                    total_ms,
                    &r,
                );
                outcomes.push(RunManyOutcome::Ok {
                    statement_index: idx,
                    result: r,
                });
            }
            Ok(Err(e)) => {
                emit_activity(&app, builder.err(&e));
                record_history_err(
                    &app,
                    parsed,
                    &connection_name,
                    sql,
                    activity_origin,
                    started_wall_ms,
                    total_ms,
                    &e,
                );
                let env = match &e {
                    AppError::Postgres(b) => RunSqlErrorEnvelope {
                        message: b.message.clone(),
                        code: b.code.clone(),
                        position: b.position,
                    },
                    other => RunSqlErrorEnvelope {
                        message: other.to_string(),
                        code: None,
                        position: None,
                    },
                };
                outcomes.push(RunManyOutcome::Err {
                    statement_index: idx,
                    error: env,
                });
                halted = true;
            }
            Err(_) => {
                let timeout_err = AppError::postgres_with_code(
                    "57014",
                    format!("run-sql timed out ({}s)", RUN_SQL_TIMEOUT.as_secs()),
                );
                fire_cancel(cancel_token.clone(), sslmode).await;
                emit_activity(&app, builder.err(&timeout_err));
                record_history_err(
                    &app,
                    parsed,
                    &connection_name,
                    sql,
                    activity_origin,
                    started_wall_ms,
                    total_ms,
                    &timeout_err,
                );
                outcomes.push(RunManyOutcome::Err {
                    statement_index: idx,
                    error: RunSqlErrorEnvelope {
                        message: format!("run-sql timed out ({}s)", RUN_SQL_TIMEOUT.as_secs()),
                        code: Some("57014".to_string()),
                        position: None,
                    },
                });
                halted = true;
            }
        }
    }

    drop(client);
    Ok(outcomes)
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifier_select_is_not_mutating() {
        assert!(!is_mutating_sql("SELECT 1"));
        assert!(!is_mutating_sql("  select * from t"));
        assert!(!is_mutating_sql("WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(!is_mutating_sql("EXPLAIN SELECT 1"));
        assert!(!is_mutating_sql("SHOW search_path"));
        assert!(!is_mutating_sql("VALUES (1), (2)"));
    }

    #[test]
    fn classifier_strips_leading_comments() {
        assert!(!is_mutating_sql("-- comment\nSELECT 1"));
        assert!(!is_mutating_sql("/* block */ SELECT 1"));
        assert!(!is_mutating_sql("/* nested /* deeper */ still */ SELECT 1"));
        assert!(is_mutating_sql("/* hi */ DELETE FROM t"));
    }

    #[test]
    fn classifier_dml_and_ddl_are_mutating() {
        assert!(is_mutating_sql("INSERT INTO t VALUES (1)"));
        assert!(is_mutating_sql("UPDATE t SET x=1"));
        assert!(is_mutating_sql("DELETE FROM t"));
        assert!(is_mutating_sql("CREATE TABLE t (id int)"));
        assert!(is_mutating_sql("DROP TABLE t"));
        assert!(is_mutating_sql("ALTER TABLE t ADD COLUMN x int"));
        assert!(is_mutating_sql("TRUNCATE t"));
        assert!(is_mutating_sql("GRANT SELECT ON t TO u"));
        assert!(is_mutating_sql("REVOKE SELECT ON t FROM u"));
        assert!(is_mutating_sql("DO $$ BEGIN PERFORM 1; END $$"));
        assert!(is_mutating_sql("CALL my_proc(1)"));
    }

    #[test]
    fn classifier_session_keywords_are_not_mutating() {
        assert!(!is_mutating_sql("SET search_path TO public"));
        assert!(!is_mutating_sql("BEGIN"));
        assert!(!is_mutating_sql("COMMIT"));
        assert!(!is_mutating_sql("ROLLBACK"));
        assert!(!is_mutating_sql("SAVEPOINT s1"));
    }

    #[test]
    fn classifier_empty_is_not_mutating() {
        assert!(!is_mutating_sql(""));
        assert!(!is_mutating_sql("  \n\t  "));
        assert!(!is_mutating_sql("/* only comment */"));
    }

    #[test]
    fn synthesize_tag_matches_pg_shapes() {
        assert_eq!(
            synthesize_command_tag("INSERT INTO t VALUES (1)", 3),
            "INSERT 0 3"
        );
        assert_eq!(synthesize_command_tag("UPDATE t SET x=1", 5), "UPDATE 5");
        assert_eq!(synthesize_command_tag("DELETE FROM t", 0), "DELETE 0");
        assert_eq!(
            synthesize_command_tag("CREATE TABLE t (id int)", 0),
            "CREATE"
        );
        assert_eq!(
            synthesize_command_tag("SET search_path TO public", 0),
            "SET"
        );
        assert_eq!(
            synthesize_command_tag("/* x */ INSERT INTO t VALUES (1)", 1),
            "INSERT 0 1"
        );
        assert_eq!(synthesize_command_tag("", 0), "EXECUTED 0");
    }

    #[test]
    fn run_sql_result_serializes_with_kind_tag() {
        let r = RunSqlResult::Rows {
            columns: vec![],
            rows: vec![],
            truncated_columns: vec![],
            truncated: false,
            query_ms: 5,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v.get("kind").unwrap(), "rows");
        assert_eq!(v.get("query_ms").unwrap(), 5);

        let a = RunSqlResult::Affected {
            command_tag: "INSERT 0 3".into(),
            affected_rows: 3,
            query_ms: 7,
        };
        let v = serde_json::to_value(&a).unwrap();
        assert_eq!(v.get("kind").unwrap(), "affected");
        assert_eq!(v.get("affected_rows").unwrap(), 3);
        assert_eq!(v.get("command_tag").unwrap(), "INSERT 0 3");
    }

    #[test]
    fn many_ok_err_skipped_persists_two_history_rows() {
        // Mirrors the behavior of `postgres_run_sql_many` when invoked with
        // [ok, err, skipped]: two history rows are written, in started_at
        // order, with the right field shapes.
        use crate::modules::query_history::{self, HistoryStatus, ListRequest};
        use crate::platform::storage::open_in_memory;

        let db = open_in_memory().unwrap();
        let cid = Uuid::new_v4();

        // Statement 1: ok, returns 5 rows.
        let r_rows = RunSqlResult::Rows {
            columns: vec![],
            rows: vec![vec![]; 5],
            truncated_columns: vec![],
            truncated: false,
            query_ms: 5,
        };
        let entry1 =
            build_history_entry_ok(cid, "local-pg", "SELECT 1", Origin::User, 100, 5, &r_rows);
        query_history::insert_entry(&db, entry1);

        // Statement 2: err with SQLSTATE.
        let err = AppError::postgres_with_code("42601", "syntax error at or near \"SELEC\"");
        let entry2 =
            build_history_entry_err(cid, "local-pg", "SELEC 2", Origin::User, 200, 3, &err);
        query_history::insert_entry(&db, entry2);

        // Statement 3: skipped — postgres_run_sql_many calls neither helper.
        // Verify by NOT calling them.

        let resp = query_history::list_entries(&db, ListRequest::default()).unwrap();
        assert_eq!(resp.total, 2, "skipped statement must not produce a row");
        assert_eq!(resp.entries.len(), 2);
        // Most recent first by started_at DESC.
        assert_eq!(resp.entries[0].sql, "SELEC 2");
        assert_eq!(resp.entries[0].status, HistoryStatus::Err);
        assert_eq!(resp.entries[0].error_code.as_deref(), Some("42601"));
        assert!(resp.entries[0].error_message.is_some());
        assert_eq!(resp.entries[0].row_count, None);

        assert_eq!(resp.entries[1].sql, "SELECT 1");
        assert_eq!(resp.entries[1].status, HistoryStatus::Ok);
        assert_eq!(resp.entries[1].row_count, Some(5));
        assert_eq!(resp.entries[1].error_code, None);
    }

    #[test]
    fn affected_result_history_entry_has_command_tag() {
        let cid = Uuid::new_v4();
        let r = RunSqlResult::Affected {
            command_tag: "INSERT 0 3".into(),
            affected_rows: 3,
            query_ms: 12,
        };
        let entry = build_history_entry_ok(
            cid,
            "local-pg",
            "INSERT INTO t VALUES (1), (2), (3)",
            Origin::User,
            500,
            12,
            &r,
        );
        assert_eq!(entry.command_tag.as_deref(), Some("INSERT 0 3"));
        assert_eq!(entry.row_count, Some(3));
    }

    #[test]
    fn run_many_outcome_serializes_with_status_tag() {
        let ok = RunManyOutcome::Ok {
            statement_index: 0,
            result: RunSqlResult::Affected {
                command_tag: "UPDATE 1".into(),
                affected_rows: 1,
                query_ms: 2,
            },
        };
        let v = serde_json::to_value(&ok).unwrap();
        assert_eq!(v.get("status").unwrap(), "ok");
        assert_eq!(v.get("statement_index").unwrap(), 0);
        assert!(v.get("result").is_some());

        let skipped = RunManyOutcome::Skipped { statement_index: 2 };
        let v = serde_json::to_value(&skipped).unwrap();
        assert_eq!(v.get("status").unwrap(), "skipped");
        assert_eq!(v.get("statement_index").unwrap(), 2);

        let err = RunManyOutcome::Err {
            statement_index: 1,
            error: RunSqlErrorEnvelope {
                message: "syntax".into(),
                code: Some("42601".into()),
                position: Some(7),
            },
        };
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v.get("status").unwrap(), "err");
        let e = v.get("error").unwrap();
        assert_eq!(e.get("code").unwrap(), "42601");
        assert_eq!(e.get("position").unwrap(), 7);
    }

    // ------------------------------------------------------------------
    // Newtype decoder tests (no live DB needed — pure byte-level)
    // ------------------------------------------------------------------

    /// Build a 16-byte INTERVAL wire buffer from components.
    fn interval_bytes(micros: i64, days: i32, months: i32) -> Vec<u8> {
        let mut b = Vec::with_capacity(16);
        b.extend_from_slice(&micros.to_be_bytes());
        b.extend_from_slice(&days.to_be_bytes());
        b.extend_from_slice(&months.to_be_bytes());
        b
    }

    #[test]
    fn interval_full_components() {
        // 1 year 2 mons 3 days 04:05:06
        // months = 1*12 + 2 = 14
        // micros for 04:05:06 = (4*3600 + 5*60 + 6) * 1_000_000 = 14706 * 1_000_000
        let micros: i64 = (4 * 3600 + 5 * 60 + 6) * 1_000_000;
        let raw = interval_bytes(micros, 3, 14);
        let s = PgInterval::from_sql(&PgType::INTERVAL, &raw).unwrap().0;
        assert_eq!(s, "1 year 2 mons 3 days 04:05:06");
    }

    #[test]
    fn interval_sub_second() {
        // 0 years 0 mons 0 days 00:00:01.500000 → trimmed → 00:00:01.5
        let micros: i64 = 1_500_000;
        let raw = interval_bytes(micros, 0, 0);
        let s = PgInterval::from_sql(&PgType::INTERVAL, &raw).unwrap().0;
        assert_eq!(s, "00:00:01.5");
    }

    #[test]
    fn interval_sub_second_no_trailing_zeros() {
        // 123456 microseconds = 0.123456 seconds, no trailing zeros to trim
        let micros: i64 = 123_456;
        let raw = interval_bytes(micros, 0, 0);
        let s = PgInterval::from_sql(&PgType::INTERVAL, &raw).unwrap().0;
        assert_eq!(s, "00:00:00.123456");
    }

    #[test]
    fn interval_negative_time() {
        // -04:05:06
        let micros: i64 = -((4 * 3600 + 5 * 60 + 6) * 1_000_000);
        let raw = interval_bytes(micros, 0, 0);
        let s = PgInterval::from_sql(&PgType::INTERVAL, &raw).unwrap().0;
        assert_eq!(s, "-04:05:06");
    }

    #[test]
    fn interval_all_zero() {
        let raw = interval_bytes(0, 0, 0);
        let s = PgInterval::from_sql(&PgType::INTERVAL, &raw).unwrap().0;
        assert_eq!(s, "00:00:00");
    }

    #[test]
    fn interval_singular_units() {
        // 1 year 1 mon 1 day 00:00:01
        let micros: i64 = 1_000_000;
        let raw = interval_bytes(micros, 1, 13); // 13 months = 1 year 1 mon
        let s = PgInterval::from_sql(&PgType::INTERVAL, &raw).unwrap().0;
        assert_eq!(s, "1 year 1 mon 1 day 00:00:01");
    }

    #[test]
    fn interval_plural_units() {
        // 2 years 3 mons 5 days 00:00:00
        let raw = interval_bytes(0, 5, 27); // 27 months = 2 years 3 mons
        let s = PgInterval::from_sql(&PgType::INTERVAL, &raw).unwrap().0;
        assert_eq!(s, "2 years 3 mons 5 days 00:00:00");
    }

    #[test]
    fn interval_bad_length_is_err() {
        let raw = vec![0u8; 8]; // too short
        assert!(PgInterval::from_sql(&PgType::INTERVAL, &raw).is_err());
        let raw = vec![0u8; 17]; // too long
        assert!(PgInterval::from_sql(&PgType::INTERVAL, &raw).is_err());
    }

    #[test]
    fn xid_roundtrip() {
        let val: u32 = 0xDEAD_BEEF;
        let raw = val.to_be_bytes();
        let decoded = PgXid::from_sql(&PgType::XID, &raw).unwrap();
        assert_eq!(decoded.0, val);
    }

    #[test]
    fn xid_bad_length_is_err() {
        assert!(PgXid::from_sql(&PgType::XID, &[0u8; 8]).is_err());
        assert!(PgXid::from_sql(&PgType::XID, &[]).is_err());
    }

    #[test]
    fn xid8_roundtrip() {
        let val: u64 = 0x0102_0304_0506_0708;
        let raw = val.to_be_bytes();
        let decoded = PgXid8::from_sql(&PgType::XID8, &raw).unwrap();
        assert_eq!(decoded.0, val);
    }

    #[test]
    fn xid8_bad_length_is_err() {
        assert!(PgXid8::from_sql(&PgType::XID8, &[0u8; 4]).is_err());
        assert!(PgXid8::from_sql(&PgType::XID8, &[]).is_err());
    }

    #[test]
    fn inet_ipv4_host_no_suffix() {
        // family=2, bits=32 (full), is_cidr=0, addr_len=4, addr=192.168.0.1
        let raw = vec![2u8, 32, 0, 4, 192, 168, 0, 1];
        let s = PgInet::from_sql(&PgType::INET, &raw).unwrap().0;
        assert_eq!(s, "192.168.0.1");
    }

    #[test]
    fn inet_ipv4_cidr() {
        // family=2, bits=8, is_cidr=1, addr_len=4, addr=10.0.0.0
        let raw = vec![2u8, 8, 1, 4, 10, 0, 0, 0];
        let s = PgInet::from_sql(&PgType::CIDR, &raw).unwrap().0;
        assert_eq!(s, "10.0.0.0/8");
    }

    #[test]
    fn inet_ipv4_host_with_prefix() {
        // family=2, bits=24, is_cidr=0, addr_len=4, addr=192.168.1.100
        let raw = vec![2u8, 24, 0, 4, 192, 168, 1, 100];
        let s = PgInet::from_sql(&PgType::INET, &raw).unwrap().0;
        assert_eq!(s, "192.168.1.100/24");
    }

    #[test]
    fn inet_ipv6_host_no_suffix() {
        // family=3, bits=128, is_cidr=0, addr_len=16, addr=::1
        let mut raw = vec![3u8, 128, 0, 16];
        raw.extend_from_slice(&[0u8; 15]);
        raw.push(1u8);
        let s = PgInet::from_sql(&PgType::INET, &raw).unwrap().0;
        assert_eq!(s, "::1");
    }

    #[test]
    fn inet_ipv6_cidr() {
        // family=3, bits=64, is_cidr=1, addr_len=16, addr=2001:db8::
        let mut raw = vec![3u8, 64, 1, 16];
        // 2001:0db8:0000:0000:0000:0000:0000:0000
        raw.extend_from_slice(&[0x20, 0x01, 0x0d, 0xb8]);
        raw.extend_from_slice(&[0u8; 12]);
        let s = PgInet::from_sql(&PgType::CIDR, &raw).unwrap().0;
        assert_eq!(s, "2001:db8::/64");
    }

    #[test]
    fn inet_bad_length_is_err() {
        // Only 3 header bytes — missing addr_len byte
        assert!(PgInet::from_sql(&PgType::INET, &[2u8, 32, 0]).is_err());
        // Header says addr_len=4 but only 3 address bytes follow
        assert!(PgInet::from_sql(&PgType::INET, &[2u8, 32, 0, 4, 192, 168, 0]).is_err());
    }

    #[test]
    fn macaddr_6byte() {
        let raw = vec![0x08u8, 0x00, 0x2b, 0x01, 0x02, 0x03];
        let s = PgMacAddr::from_sql(&PgType::MACADDR, &raw).unwrap().0;
        assert_eq!(s, "08:00:2b:01:02:03");
    }

    #[test]
    fn macaddr8_8byte() {
        let raw = vec![0x08u8, 0x00, 0x2b, 0xff, 0xfe, 0x01, 0x02, 0x03];
        let s = PgMacAddr::from_sql(&PgType::MACADDR8, &raw).unwrap().0;
        assert_eq!(s, "08:00:2b:ff:fe:01:02:03");
    }

    #[test]
    fn macaddr_bad_length_is_err() {
        // 5 bytes — invalid
        let raw = vec![0u8; 5];
        assert!(PgMacAddr::from_sql(&PgType::MACADDR, &raw).is_err());
        // 7 bytes — invalid
        let raw = vec![0u8; 7];
        assert!(PgMacAddr::from_sql(&PgType::MACADDR, &raw).is_err());
    }
}
