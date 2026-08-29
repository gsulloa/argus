//! Free-form SQL execution. Three commands surface the user's editor:
//!
//! - `postgres_run_sql(connection_id, sql, origin?)` runs one statement.
//! - `postgres_run_sql_many(connection_id, statements, origin?)` runs an
//!   already-split list of statements sequentially on the same client.
//! - `postgres_run_sql_stream(connection_id, sql, origin?, run_token, on_event)`
//!   runs one statement and delivers results incrementally over a `Channel`.
//!
//! Read-only enforcement happens here via `is_mutating_sql` (a heuristic — see
//! its docs). The pool's existing read-only hook also rejects mutations at the
//! wire, but doing the check in this module lets us return a clean validation
//! error before dispatch and lets multi-statement runs halt cleanly.

use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::TryStreamExt;

use deadpool_postgres::Object as PgObject;
use serde::Serialize;
use serde_json::Value as JsonValue;
use tauri::{AppHandle, Manager, State};
use time::format_description::well_known::Rfc3339;
use time::{Date, OffsetDateTime, PrimitiveDateTime, Time};
use tokio::time::timeout;
use tokio_postgres::types::{FromSql, Kind as PgKind, Type as PgType};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::postgres::data::{fire_cancel, DataColumn};
use crate::modules::postgres::pool::PgPoolRegistry;
use crate::modules::query_cancel::{CancelAction, RunningQueryRegistry};
use crate::modules::query_history::{self, HistoryOrigin, HistoryStatus, NewEntry};
use crate::platform::row_cap::{self, RowCapSource};
use crate::platform::sql_limit::{self, Dialect};
use crate::platform::DbState;

/// Hard cap on a single `postgres_run_sql` statement. Generous (60s) because
/// the user is intentionally running arbitrary SQL — but bounded so a runaway
/// query doesn't pin a pool client forever. A real cancel button is follow-up.
const RUN_SQL_TIMEOUT: Duration = Duration::from_secs(60);
/// Streaming: flush a `Batch` event when the buffer reaches this many rows …
const BATCH_ROWS: usize = 500;
/// … or when this much time has elapsed since the last flush, whichever first.
const BATCH_INTERVAL: Duration = Duration::from_millis(50);
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

/// Resolve the effective row cap for a single statement: reads the
/// configured `sql.rowCap` setting from the app's sqlite-backed `DbState`,
/// then combines it with whatever explicit limit `sql` carries and
/// [`row_cap::HARD_ROW_CAP`] via [`row_cap::effective_cap`].
///
/// The `DbState` mutex is locked only long enough to read the setting — the
/// lock is dropped before returning, well before any `.await` in the caller.
fn resolve_cap(app: &AppHandle, sql: &str) -> (u64, RowCapSource) {
    let configured = {
        let db = app.state::<DbState>();
        let conn = db.0.lock().expect("db poisoned");
        row_cap::configured_cap(&conn)
    };
    resolve_cap_from(configured, sql)
}

/// Pure cap-resolution logic factored out of [`resolve_cap`] so it is
/// testable without an `AppHandle`: combines an already-read `configured`
/// cap with whatever explicit limit `sql` carries under Postgres syntax.
fn resolve_cap_from(configured: u64, sql: &str) -> (u64, RowCapSource) {
    let explicit = sql_limit::explicit_row_limit(sql, Dialect::Postgres);
    row_cap::effective_cap(configured, explicit, row_cap::HARD_ROW_CAP)
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
        row_cap: u64,
        row_cap_source: RowCapSource,
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
// Streaming event types (postgres_run_sql_stream)
// --------------------------------------------------------------------------

/// Events emitted over the `tauri::ipc::Channel` for a streaming run.
///
/// The wire shape is `{ "event": "<variant>", …fields }` (serde tag).
/// Exactly one terminal event ends every stream: `done`, `affected`, or
/// `error`. The frontend can rely on receiving no further events after a
/// terminal.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum StreamEvent {
    /// Column metadata — always the first event for a SELECT-shape statement.
    Columns { columns: Vec<DataColumn> },
    /// A batch of converted rows. May arrive multiple times before `done`.
    Batch { rows: Vec<Vec<JsonValue>> },
    /// Terminal: SELECT-shape query completed successfully.
    Done {
        row_count: u64,
        truncated: bool,
        query_ms: u64,
        truncated_columns: Vec<String>,
        row_cap: u64,
        row_cap_source: RowCapSource,
    },
    /// Terminal: DML/DDL statement completed (no columns/batch events).
    Affected {
        command_tag: String,
        affected_rows: u64,
        query_ms: u64,
    },
    /// Terminal: any failure, including mid-stream errors.
    Error {
        message: String,
        code: Option<String>,
        position: Option<i32>,
    },
}

/// Outcome summary produced by `run_one_stream` and consumed by the command
/// to build the activity-log metric and history entry.
struct StreamOutcome {
    row_count: u64,
    affected: Option<u64>,
    command_tag: Option<String>,
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

/// Sign words in the NUMERIC wire format. Anything else is malformed.
const NUMERIC_POS: u16 = 0x0000;
const NUMERIC_NEG: u16 = 0x4000;
const NUMERIC_NAN: u16 = 0xC000;
const NUMERIC_PINF: u16 = 0xD000;
const NUMERIC_NINF: u16 = 0xF000;

/// Postgres NUMERIC wire format (`numeric_send`), all big-endian:
///   int16  ndigits   number of base-10000 digit groups that follow
///   int16  weight    base-10000 exponent of digits[0]
///   uint16 sign      0x0000 pos · 0x4000 neg · 0xC000 NaN · 0xD000 +Inf · 0xF000 -Inf
///   int16  dscale    digits after the decimal point
///   int16 × ndigits  the digit groups, each 0..=9999
///
/// Rendered as exact decimal text, never through `f64`: `numeric` is
/// arbitrary-precision by definition, so a float round-trip would silently
/// corrupt monetary and high-precision values — and `serde_json::Number`
/// (i64/u64/f64) cannot hold the range either. A String is the only lossless
/// option, and it matches what the table browser already returns for the same
/// column (it casts `::text` server-side, see `data.rs` `text_castable`).
struct PgNumeric(String);

impl<'a> FromSql<'a> for PgNumeric {
    fn from_sql(
        _ty: &PgType,
        raw: &'a [u8],
    ) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        if raw.len() < 8 {
            return Err(format!("numeric: expected at least 8 bytes, got {}", raw.len()).into());
        }
        let ndigits = i16::from_be_bytes(raw[0..2].try_into().unwrap());
        let weight = i32::from(i16::from_be_bytes(raw[2..4].try_into().unwrap()));
        let sign = u16::from_be_bytes(raw[4..6].try_into().unwrap());
        let dscale = i16::from_be_bytes(raw[6..8].try_into().unwrap());

        // The non-finite signs carry no digits; short-circuit on Postgres' own
        // text spellings.
        match sign {
            NUMERIC_NAN => return Ok(PgNumeric("NaN".to_string())),
            NUMERIC_PINF => return Ok(PgNumeric("Infinity".to_string())),
            NUMERIC_NINF => return Ok(PgNumeric("-Infinity".to_string())),
            NUMERIC_POS | NUMERIC_NEG => {}
            other => return Err(format!("numeric: unknown sign 0x{:04x}", other).into()),
        }
        if ndigits < 0 || dscale < 0 {
            return Err(format!(
                "numeric: negative ndigits ({}) or dscale ({})",
                ndigits, dscale
            )
            .into());
        }
        let ndigits = ndigits as usize;
        let dscale = dscale as usize;
        if raw.len() != 8 + 2 * ndigits {
            return Err(format!(
                "numeric: expected {} bytes for {} digit groups, got {}",
                8 + 2 * ndigits,
                ndigits,
                raw.len()
            )
            .into());
        }
        let digits: Vec<u16> = (0..ndigits)
            .map(|i| u16::from_be_bytes(raw[8 + 2 * i..10 + 2 * i].try_into().unwrap()))
            .collect();
        if digits.iter().any(|d| *d > 9999) {
            return Err("numeric: digit group out of base-10000 range".into());
        }

        // Digit group `i` carries base-10000 exponent `weight - i`; equivalently
        // exponent `e` lives at index `weight - e`, and any index outside
        // `0..ndigits` is an implicit zero. That single rule is what makes
        // leading-zero groups (`weight < -1`) and trailing-zero groups (`dscale`
        // reaching past `ndigits`) fall out without special cases.
        let group_at = |e: i32| -> u16 {
            let idx = weight - e;
            if idx < 0 {
                return 0;
            }
            digits.get(idx as usize).copied().unwrap_or(0)
        };

        let mut out = String::new();
        if sign == NUMERIC_NEG {
            out.push('-');
        }
        // Integer part: exponents `weight` down to 0, leading group unpadded.
        if weight < 0 {
            out.push('0');
        } else {
            out.push_str(&group_at(weight).to_string());
            for e in (0..weight).rev() {
                out.push_str(&format!("{:04}", group_at(e)));
            }
        }
        // Fractional part: exponents -1, -2, … zero-padded to 4 and concatenated,
        // then padded or truncated to exactly `dscale` characters.
        if dscale > 0 {
            let mut frac = String::with_capacity(dscale + 4);
            let mut e = -1i32;
            while frac.len() < dscale {
                frac.push_str(&format!("{:04}", group_at(e)));
                e -= 1;
            }
            frac.truncate(dscale);
            out.push('.');
            out.push_str(&frac);
        }
        Ok(PgNumeric(out))
    }

    fn accepts(ty: &PgType) -> bool {
        *ty == PgType::NUMERIC
    }
}

/// Postgres MONEY wire format: 8-byte big-endian i64 in the smallest currency
/// unit. The scale comes from the server's `lc_monetary` `frac_digits` and is
/// NOT carried on the wire; we assume 2, which is right for the `C` locale and
/// effectively every locale Argus meets. Rendered bare — no currency symbol, no
/// thousands separators — so the cell stays machine-parseable for copy/export
/// and still sorts numerically in the grid.
struct PgMoney(String);

impl<'a> FromSql<'a> for PgMoney {
    fn from_sql(
        _ty: &PgType,
        raw: &'a [u8],
    ) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        if raw.len() != 8 {
            return Err(format!("money: expected 8 bytes, got {}", raw.len()).into());
        }
        let units = i64::from_be_bytes(raw[0..8].try_into().unwrap());
        let sign = if units < 0 { "-" } else { "" };
        let abs = units.unsigned_abs();
        Ok(PgMoney(format!("{}{}.{:02}", sign, abs / 100, abs % 100)))
    }

    fn accepts(ty: &PgType) -> bool {
        *ty == PgType::MONEY
    }
}

/// Postgres TIMETZ wire format: 12 bytes big-endian
///   bytes 0..8  → i64 microseconds since midnight
///   bytes 8..12 → i32 zone offset in seconds **west** of UTC
///
/// Rendered `HH:MM:SS[.ffffff]±HH:MM`, negating the wire field so the offset
/// reads the way users write it (`+02:00`, not `-7200`). Sub-second digits are
/// not trimmed, matching the sibling TIME/TIMESTAMP arms which render through
/// `time`'s Display. A sub-minute offset (only historical zones have one) gets
/// a `:SS` tail rather than being silently rounded away.
struct PgTimeTz(String);

impl<'a> FromSql<'a> for PgTimeTz {
    fn from_sql(
        _ty: &PgType,
        raw: &'a [u8],
    ) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        if raw.len() != 12 {
            return Err(format!("timetz: expected 12 bytes, got {}", raw.len()).into());
        }
        let micros = i64::from_be_bytes(raw[0..8].try_into().unwrap());
        let zone = i32::from_be_bytes(raw[8..12].try_into().unwrap());
        if micros < 0 {
            return Err(format!("timetz: negative time-of-day {}", micros).into());
        }

        let us_rem = micros % 1_000_000;
        let total_secs = micros / 1_000_000;
        let secs = total_secs % 60;
        let total_mins = total_secs / 60;
        let mins = total_mins % 60;
        let hours = total_mins / 60;

        let mut s = format!("{:02}:{:02}:{:02}", hours, mins, secs);
        if us_rem != 0 {
            s.push_str(&format!(".{:06}", us_rem));
        }

        // Wire field is seconds WEST of UTC; the displayed offset is its negation.
        let offset = -zone;
        let osign = if offset < 0 { '-' } else { '+' };
        let oabs = offset.unsigned_abs();
        s.push(osign);
        s.push_str(&format!("{:02}:{:02}", oabs / 3600, (oabs % 3600) / 60));
        if oabs % 60 != 0 {
            s.push_str(&format!(":{:02}", oabs % 60));
        }
        Ok(PgTimeTz(s))
    }

    fn accepts(ty: &PgType) -> bool {
        *ty == PgType::TIMETZ
    }
}

/// Postgres BIT / VARBIT wire format:
///   bytes 0..4 → i32 bit length
///   bytes 4..  → ceil(len / 8) bytes, most-significant bit first
///
/// Rendered as exactly `len` '0'/'1' characters, so trailing pad bits in the
/// final byte are dropped rather than shown.
struct PgBits(String);

impl<'a> FromSql<'a> for PgBits {
    fn from_sql(
        _ty: &PgType,
        raw: &'a [u8],
    ) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        if raw.len() < 4 {
            return Err(format!("varbit: expected at least 4 bytes, got {}", raw.len()).into());
        }
        let bit_len = i32::from_be_bytes(raw[0..4].try_into().unwrap());
        if bit_len < 0 {
            return Err(format!("varbit: negative bit length {}", bit_len).into());
        }
        let bit_len = bit_len as usize;
        let nbytes = bit_len.div_ceil(8);
        if raw.len() != 4 + nbytes {
            return Err(format!(
                "varbit: expected {} bytes for {} bits, got {}",
                4 + nbytes,
                bit_len,
                raw.len()
            )
            .into());
        }
        let bits = &raw[4..];
        let s = (0..bit_len)
            .map(|i| {
                if bits[i / 8] >> (7 - i % 8) & 1 == 1 {
                    '1'
                } else {
                    '0'
                }
            })
            .collect();
        Ok(PgBits(s))
    }

    fn accepts(ty: &PgType) -> bool {
        *ty == PgType::BIT || *ty == PgType::VARBIT
    }
}

/// The geometric family, all big-endian `float8` payloads, rendered in the same
/// text form `geometry_out` produces:
///   POINT   (x,y)                      16 bytes
///   LSEG    [(x1,y1),(x2,y2)]          32 bytes
///   BOX     (x1,y1),(x2,y2)            32 bytes (high corner first)
///   LINE    {A,B,C}                    24 bytes
///   CIRCLE  <(x,y),r>                  24 bytes
///   PATH    ((…)) closed / [(…)] open  1-byte closed flag + i32 npts + points
///   POLYGON ((…))                      i32 npts + points
struct PgGeometry(String);

impl PgGeometry {
    /// Read `n` big-endian f64s starting at `off`, or `None` if the buffer is short.
    fn floats(raw: &[u8], off: usize, n: usize) -> Option<Vec<f64>> {
        if raw.len() < off + n * 8 {
            return None;
        }
        Some(
            (0..n)
                .map(|i| f64::from_be_bytes(raw[off + i * 8..off + i * 8 + 8].try_into().unwrap()))
                .collect(),
        )
    }

    /// `(x1,y1),(x2,y2),…` over a flat coordinate list.
    fn points(coords: &[f64]) -> String {
        coords
            .chunks(2)
            .map(|p| format!("({},{})", p[0], p[1]))
            .collect::<Vec<_>>()
            .join(",")
    }
}

impl<'a> FromSql<'a> for PgGeometry {
    fn from_sql(
        ty: &PgType,
        raw: &'a [u8],
    ) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        let short = || -> Box<dyn std::error::Error + Sync + Send> {
            format!("{}: malformed {}-byte payload", ty.name(), raw.len()).into()
        };
        let s = match *ty {
            PgType::POINT => {
                let c = Self::floats(raw, 0, 2).ok_or_else(short)?;
                format!("({},{})", c[0], c[1])
            }
            PgType::LSEG => {
                let c = Self::floats(raw, 0, 4).ok_or_else(short)?;
                format!("[{}]", Self::points(&c))
            }
            PgType::BOX => {
                let c = Self::floats(raw, 0, 4).ok_or_else(short)?;
                Self::points(&c)
            }
            PgType::LINE => {
                let c = Self::floats(raw, 0, 3).ok_or_else(short)?;
                format!("{{{},{},{}}}", c[0], c[1], c[2])
            }
            PgType::CIRCLE => {
                let c = Self::floats(raw, 0, 3).ok_or_else(short)?;
                format!("<({},{}),{}>", c[0], c[1], c[2])
            }
            PgType::PATH | PgType::POLYGON => {
                // PATH carries a leading closed flag; POLYGON is always closed.
                let (closed, off) = if *ty == PgType::PATH {
                    (*raw.first().ok_or_else(short)? != 0, 1)
                } else {
                    (true, 0)
                };
                if raw.len() < off + 4 {
                    return Err(short());
                }
                let npts = i32::from_be_bytes(raw[off..off + 4].try_into().unwrap());
                if npts < 0 {
                    return Err(short());
                }
                let c = Self::floats(raw, off + 4, npts as usize * 2).ok_or_else(short)?;
                if closed {
                    format!("({})", Self::points(&c))
                } else {
                    format!("[{}]", Self::points(&c))
                }
            }
            ref other => return Err(format!("geometry: unsupported type {}", other.name()).into()),
        };
        Ok(PgGeometry(s))
    }

    fn accepts(ty: &PgType) -> bool {
        matches!(
            *ty,
            PgType::POINT
                | PgType::LSEG
                | PgType::BOX
                | PgType::LINE
                | PgType::CIRCLE
                | PgType::PATH
                | PgType::POLYGON
        )
    }
}

/// Escape hatch onto the raw wire bytes of ANY column. `Row` exposes no public
/// raw accessor, but `try_get` is generic over `FromSql<'a>` and borrows from
/// the row — so a newtype whose `accepts` is total hands us the bytes for types
/// `tokio-postgres` has no `FromSql` for at all (arrays, ranges, domains,
/// geometry). This is what lets `decode_raw` be recursive.
struct PgRaw<'a>(&'a [u8]);

impl<'a> FromSql<'a> for PgRaw<'a> {
    fn from_sql(
        _ty: &PgType,
        raw: &'a [u8],
    ) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(PgRaw(raw))
    }

    fn accepts(_ty: &PgType) -> bool {
        true
    }
}

/// Minimal big-endian cursor over a Postgres binary payload. Every read is
/// bounds-checked and yields `None` past the end, so a malformed container
/// degrades to the undecodable-cell fallback instead of panicking.
struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }

    fn u8(&mut self) -> Option<u8> {
        let b = *self.buf.get(self.pos)?;
        self.pos += 1;
        Some(b)
    }

    fn i32(&mut self) -> Option<i32> {
        let bytes = self.buf.get(self.pos..self.pos + 4)?;
        self.pos += 4;
        Some(i32::from_be_bytes(bytes.try_into().unwrap()))
    }

    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let bytes = self.buf.get(self.pos..self.pos + n)?;
        self.pos += n;
        Some(bytes)
    }
}

/// Cap on `decode_raw` recursion (domain → range → array → …). Postgres type
/// graphs are acyclic and shallow, so this only ever fires on a hostile or
/// pathological catalog — where returning `None` beats blowing the stack.
const MAX_DECODE_DEPTH: usize = 8;
/// Postgres' own `MAXDIM`: arrays never carry more dimensions than this.
const MAX_ARRAY_DIMS: usize = 6;

/// Decode one cell straight from its wire bytes. Pure and DB-free (hence
/// directly unit-testable), and the single place a newly supported type gets
/// added. Returns `None` when nothing here knows the type, which is what
/// triggers `cell_to_json`'s UTF-8 → binary-envelope fallback.
///
/// The container kinds recurse, so every scalar below is automatically
/// available inside an array, a range bound, or behind a domain.
fn decode_raw(ty: &PgType, raw: &[u8], depth: usize) -> Option<JsonValue> {
    if depth > MAX_DECODE_DEPTH {
        return None;
    }
    match *ty {
        PgType::BOOL => <bool as FromSql>::from_sql(ty, raw)
            .ok()
            .map(JsonValue::Bool),
        PgType::INT2 => <i16 as FromSql>::from_sql(ty, raw)
            .ok()
            .map(|v| JsonValue::Number(i64::from(v).into())),
        PgType::INT4 => <i32 as FromSql>::from_sql(ty, raw)
            .ok()
            .map(|v| JsonValue::Number(i64::from(v).into())),
        PgType::INT8 => <i64 as FromSql>::from_sql(ty, raw)
            .ok()
            .map(|v| JsonValue::Number(v.into())),
        PgType::OID => <u32 as FromSql>::from_sql(ty, raw)
            .ok()
            .map(|v| JsonValue::Number(u64::from(v).into())),
        PgType::FLOAT4 => <f32 as FromSql>::from_sql(ty, raw)
            .ok()
            .and_then(|v| serde_json::Number::from_f64(f64::from(v)))
            .map(JsonValue::Number),
        PgType::FLOAT8 => <f64 as FromSql>::from_sql(ty, raw)
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(JsonValue::Number),
        PgType::NUMERIC => PgNumeric::from_sql(ty, raw)
            .ok()
            .map(|v| JsonValue::String(v.0)),
        PgType::MONEY => PgMoney::from_sql(ty, raw)
            .ok()
            .map(|v| JsonValue::String(v.0)),
        PgType::JSON | PgType::JSONB => <JsonValue as FromSql>::from_sql(ty, raw).ok(),
        PgType::UUID => <Uuid as FromSql>::from_sql(ty, raw)
            .ok()
            .map(|v| JsonValue::String(v.to_string())),
        PgType::TIMESTAMPTZ => <OffsetDateTime as FromSql>::from_sql(ty, raw)
            .ok()
            .map(|v| JsonValue::String(v.format(&Rfc3339).unwrap_or_else(|_| v.to_string()))),
        PgType::TIMESTAMP => <PrimitiveDateTime as FromSql>::from_sql(ty, raw)
            .ok()
            .map(|v| JsonValue::String(v.to_string())),
        PgType::DATE => <Date as FromSql>::from_sql(ty, raw)
            .ok()
            .map(|v| JsonValue::String(v.to_string())),
        PgType::TIME => <Time as FromSql>::from_sql(ty, raw)
            .ok()
            .map(|v| JsonValue::String(v.to_string())),
        PgType::TIMETZ => PgTimeTz::from_sql(ty, raw)
            .ok()
            .map(|v| JsonValue::String(v.0)),
        PgType::INTERVAL => PgInterval::from_sql(ty, raw)
            .ok()
            .map(|v| JsonValue::String(v.0)),
        PgType::BIT | PgType::VARBIT => PgBits::from_sql(ty, raw)
            .ok()
            .map(|v| JsonValue::String(v.0)),
        PgType::INET | PgType::CIDR => PgInet::from_sql(ty, raw)
            .ok()
            .map(|v| JsonValue::String(v.0)),
        PgType::MACADDR | PgType::MACADDR8 => PgMacAddr::from_sql(ty, raw)
            .ok()
            .map(|v| JsonValue::String(v.0)),
        PgType::XID => PgXid::from_sql(ty, raw)
            .ok()
            .map(|v| JsonValue::Number(u64::from(v.0).into())),
        PgType::XID8 => PgXid8::from_sql(ty, raw)
            .ok()
            .map(|v| JsonValue::Number(v.0.into())),
        PgType::POINT
        | PgType::LSEG
        | PgType::BOX
        | PgType::LINE
        | PgType::CIRCLE
        | PgType::PATH
        | PgType::POLYGON => PgGeometry::from_sql(ty, raw)
            .ok()
            .map(|v| JsonValue::String(v.0)),
        // Only reachable nested (a bare BYTEA column is handled by the envelope
        // arm in `cell_to_json`); `\x…` is Postgres' own text form for it.
        PgType::BYTEA => Some(JsonValue::String(format!("\\x{}", hex(raw, raw.len())))),
        PgType::TEXT | PgType::VARCHAR | PgType::BPCHAR | PgType::NAME | PgType::UNKNOWN => {
            utf8_json(raw)
        }
        _ => match ty.kind() {
            // A domain shares its base type's wire format exactly, so this is a
            // pure delegation — and it is why a domain over `text` (which
            // `FromSql for String` rejects) starts working too.
            PgKind::Domain(inner) => decode_raw(inner, raw, depth + 1),
            PgKind::Array(elem) => decode_array(elem, raw, depth + 1),
            PgKind::Range(base) => decode_range(base, raw, depth + 1).map(JsonValue::String),
            PgKind::Multirange(base) => decode_multirange(base, raw, depth + 1),
            PgKind::Enum(_) => utf8_json(raw),
            _ => None,
        },
    }
}

/// `Some(JsonValue::String)` when the bytes are valid UTF-8. Used for types we
/// already know are text-shaped (`text`, `varchar`, enum labels).
fn utf8_json(raw: &[u8]) -> Option<JsonValue> {
    std::str::from_utf8(raw)
        .ok()
        .map(|s| JsonValue::String(s.to_string()))
}

/// Last-resort text read for a type nothing else claimed: valid UTF-8 AND free
/// of control characters beyond tab/newline/CR. The control-character guard is
/// what separates a genuinely text-shaped payload (`xml`, `ltree`, `pg_lsn`,
/// unrecognised extension text types) from a structured binary one that merely
/// happens to be valid UTF-8 — `tsvector` is length-prefixed, so without this
/// it would render as a run of ` ` escapes instead of falling through to
/// the honest hex envelope. Postgres `text` cannot contain a NUL byte, so this
/// never rejects a real text value.
fn printable_utf8_json(raw: &[u8]) -> Option<JsonValue> {
    let s = std::str::from_utf8(raw).ok()?;
    if s.chars()
        .any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r'))
    {
        return None;
    }
    Some(JsonValue::String(s.to_string()))
}

/// Postgres `array_send`: i32 ndim, i32 has_null, i32 element oid, then
/// ndim × (i32 dim_len, i32 lower_bound), then per element an i32 byte length
/// (-1 for SQL NULL) followed by that many bytes.
///
/// An element whose own decode fails becomes `null` rather than failing the
/// whole cell — one bad value should not hide the other 999.
fn decode_array(elem: &PgType, raw: &[u8], depth: usize) -> Option<JsonValue> {
    let mut r = Reader::new(raw);
    let ndim = r.i32()?;
    let _has_null = r.i32()?;
    let _elem_oid = r.i32()?;
    if ndim < 0 || ndim as usize > MAX_ARRAY_DIMS {
        return None;
    }
    if ndim == 0 {
        return Some(JsonValue::Array(Vec::new()));
    }
    let mut dims = Vec::with_capacity(ndim as usize);
    for _ in 0..ndim {
        let len = r.i32()?;
        let _lower_bound = r.i32()?;
        if len < 0 {
            return None;
        }
        dims.push(len as usize);
    }
    let total: usize = dims.iter().try_fold(1usize, |a, d| a.checked_mul(*d))?;

    // Grown by pushing rather than pre-allocated: `total` comes off the wire,
    // so a malformed header must not get to request an arbitrary allocation.
    let mut flat: Vec<JsonValue> = Vec::new();
    for _ in 0..total {
        let len = r.i32()?;
        if len < 0 {
            flat.push(JsonValue::Null);
            continue;
        }
        let bytes = r.take(len as usize)?;
        flat.push(decode_raw(elem, bytes, depth).unwrap_or(JsonValue::Null));
    }
    Some(fold_dims(&flat, &dims))
}

/// Fold a flat element list back into nested arrays per the dimension lengths,
/// so `int4[][]` reads as `[[1,2],[3,4]]` rather than `[1,2,3,4]`.
fn fold_dims(values: &[JsonValue], dims: &[usize]) -> JsonValue {
    if dims.len() <= 1 {
        return JsonValue::Array(values.to_vec());
    }
    let inner: usize = dims[1..].iter().product();
    if inner == 0 {
        return JsonValue::Array(Vec::new());
    }
    JsonValue::Array(
        values
            .chunks(inner)
            .map(|c| fold_dims(c, &dims[1..]))
            .collect(),
    )
}

// Flag bits from Postgres' `rangetypes.h`. Note the ordering: inclusivity comes
// before infinity, NOT the other way round.
const RANGE_EMPTY: u8 = 0x01;
const RANGE_LB_INC: u8 = 0x02;
const RANGE_UB_INC: u8 = 0x04;
const RANGE_LB_INF: u8 = 0x08;
const RANGE_UB_INF: u8 = 0x10;

/// Postgres `range_send`: a u8 flags byte, then each finite bound as an i32
/// byte length followed by that many bytes. Rendered in Postgres' own text form
/// (`empty`, `[1,5)`, `[1,)`), with each bound decoded as the base type.
fn decode_range(base: &PgType, raw: &[u8], depth: usize) -> Option<String> {
    let mut r = Reader::new(raw);
    let flags = r.u8()?;
    if flags & RANGE_EMPTY != 0 {
        return Some("empty".to_string());
    }
    let bound = |r: &mut Reader<'_>| -> Option<String> {
        let len = r.i32()?;
        if len < 0 {
            return None;
        }
        let bytes = r.take(len as usize)?;
        Some(render_bound(base, bytes, depth))
    };
    let lower = if flags & RANGE_LB_INF != 0 {
        String::new()
    } else {
        bound(&mut r)?
    };
    let upper = if flags & RANGE_UB_INF != 0 {
        String::new()
    } else {
        bound(&mut r)?
    };
    let open = if flags & RANGE_LB_INC != 0 { '[' } else { '(' };
    let close = if flags & RANGE_UB_INC != 0 { ']' } else { ')' };
    Some(format!("{}{},{}{}", open, lower, upper, close))
}

/// Postgres `multirange_send`: i32 range count, then each range as an i32 byte
/// length followed by a `range_send` payload. Rendered `{[a,b),[c,d)}`.
fn decode_multirange(base: &PgType, raw: &[u8], depth: usize) -> Option<JsonValue> {
    let mut r = Reader::new(raw);
    let count = r.i32()?;
    if count < 0 {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    for _ in 0..count {
        let len = r.i32()?;
        if len < 0 {
            return None;
        }
        let bytes = r.take(len as usize)?;
        parts.push(decode_range(base, bytes, depth)?);
    }
    Some(JsonValue::String(format!("{{{}}}", parts.join(","))))
}

/// A range bound as bare text: strings unquoted, numbers/bools via their JSON
/// form, and an undecodable bound as the empty string (Postgres' own rendering
/// for a bound it cannot print).
fn render_bound(base: &PgType, raw: &[u8], depth: usize) -> String {
    match decode_raw(base, raw, depth) {
        Some(JsonValue::String(s)) => s,
        Some(v) => v.to_string(),
        None => String::new(),
    }
}

/// Lowercase hex of the first `max` bytes.
fn hex(bytes: &[u8], max: usize) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len().min(max) * 2);
    for b in bytes.iter().take(max) {
        let _ = write!(&mut out, "{:02x}", b);
    }
    out
}

/// Record `column_name` once in the response's `truncated_columns` list.
fn mark_truncated(column_name: &str, truncated_columns: &mut Vec<String>) {
    if !truncated_columns.iter().any(|n| n == column_name) {
        truncated_columns.push(column_name.to_string());
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
        // Exact decimal text, never an f64 round-trip — see `PgNumeric`.
        PgType::NUMERIC => match row.try_get::<_, Option<PgNumeric>>(idx) {
            Ok(Some(v)) => return JsonValue::String(v.0),
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        PgType::MONEY => match row.try_get::<_, Option<PgMoney>>(idx) {
            Ok(Some(v)) => return JsonValue::String(v.0),
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
                mark_truncated(column_name, truncated_columns);
                return binary_envelope(hex(&bytes, 64), bytes.len());
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
        PgType::TIMETZ => match row.try_get::<_, Option<PgTimeTz>>(idx) {
            Ok(Some(v)) => return JsonValue::String(v.0),
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        PgType::BIT | PgType::VARBIT => match row.try_get::<_, Option<PgBits>>(idx) {
            Ok(Some(v)) => return JsonValue::String(v.0),
            Ok(None) => return JsonValue::Null,
            Err(_) => {}
        },
        PgType::POINT
        | PgType::LSEG
        | PgType::BOX
        | PgType::LINE
        | PgType::CIRCLE
        | PgType::PATH
        | PgType::POLYGON => match row.try_get::<_, Option<PgGeometry>>(idx) {
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
                    mark_truncated(column_name, truncated_columns);
                    truncated_envelope(preview, s.len())
                } else {
                    JsonValue::String(s)
                }
            }
            None => JsonValue::Null,
        };
    }
    // Last resort: pull the raw wire bytes and run them through the recursive
    // decoder. `PgRaw::accepts` is total, so this reaches the types
    // `tokio-postgres` has no `FromSql` for at all — arrays, ranges, domains,
    // geometry — and recurses into their element/base type.
    let raw = match row.try_get::<_, Option<PgRaw>>(idx) {
        Ok(Some(PgRaw(raw))) => raw,
        // NULL, or — unreachable, since `accepts` is total — a decode failure.
        Ok(None) | Err(_) => return JsonValue::Null,
    };
    let decoded = decode_raw(pg_type, raw, 0).unwrap_or_else(|| {
        // Nothing knows this type. Prefer Postgres' own text when the binary
        // representation happens to BE the text one (`xml`, `ltree`, `pg_lsn`,
        // unrecognised extension text types); otherwise hand back the bytes in
        // the same envelope the grid already renders for `bytea`. A
        // `<typename>` placeholder only repeats the column header while hiding
        // the value, so it is never a useful cell.
        printable_utf8_json(raw).unwrap_or_else(|| {
            mark_truncated(column_name, truncated_columns);
            binary_envelope(hex(raw, 64), raw.len())
        })
    });
    size_guard(decoded, column_name, truncated_columns)
}

/// Apply the inline size limit to a value produced by the raw path, mirroring
/// what the `String` path does. Containers are measured by their serialized
/// length, which bounds a pathological `text[]` without making `decode_raw`
/// impure or truncating every element individually.
fn size_guard(
    value: JsonValue,
    column_name: &str,
    truncated_columns: &mut Vec<String>,
) -> JsonValue {
    let (preview, len) = match &value {
        JsonValue::String(s) if s.len() > INLINE_TRUNCATE_BYTES => (s.clone(), s.len()),
        JsonValue::Array(_) | JsonValue::Object(_) => {
            let serialized = serde_json::to_string(&value).unwrap_or_default();
            if serialized.len() <= INLINE_TRUNCATE_BYTES {
                return value;
            }
            let len = serialized.len();
            (serialized, len)
        }
        _ => return value,
    };
    mark_truncated(column_name, truncated_columns);
    truncated_envelope(preview.chars().take(2048).collect(), len)
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
///
/// `cap`/`cap_source` are the effective row cap already resolved (per
/// statement) by [`resolve_cap`]. Rows are pulled incrementally via
/// `query_raw` and fetching stops as soon as `cap + 1` rows have been seen —
/// peak memory is bounded by the cap, not by the query's true cardinality.
async fn run_one(
    client: &PgObject,
    sql: &str,
    is_read_only: bool,
    cap: u64,
    cap_source: RowCapSource,
) -> AppResult<RunSqlResult> {
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
    // Rows path. Stream via `query_raw` so we never materialize more than
    // `cap + 1` rows server-side, regardless of the query's true cardinality.
    let columns = columns_from_row_meta(stmt.columns());
    let mut truncated_columns: Vec<String> = Vec::new();

    // An explicitly-typed empty iterator resolves the `BorrowToSql` inference
    // for the no-parameter case. `&dyn ToSql` implements `BorrowToSql`.
    let stream = client
        .query_raw(
            &stmt,
            std::iter::empty::<&dyn tokio_postgres::types::ToSql>(),
        )
        .await?;
    futures::pin_mut!(stream);

    let budget = row_cap::fetch_budget(cap);
    let mut out_rows: Vec<Vec<JsonValue>> = Vec::new();
    while (out_rows.len() as u64) < budget {
        let Some(row) = stream.try_next().await? else {
            break;
        };
        let mut cells: Vec<JsonValue> = Vec::with_capacity(columns.len());
        for (i, col) in columns.iter().enumerate() {
            cells.push(cell_to_json(&row, i, &col.name, &mut truncated_columns));
        }
        out_rows.push(cells);
    }
    let truncated = out_rows.len() as u64 > cap;
    if truncated {
        out_rows.truncate(cap as usize);
    }
    let query_ms = started.elapsed().as_millis() as u64;
    Ok(RunSqlResult::Rows {
        columns,
        rows: out_rows,
        truncated_columns,
        truncated,
        query_ms,
        row_cap: cap,
        row_cap_source: cap_source,
    })
}

/// Map a `tauri::Error` from a channel send into an `AppError` so the `?`
/// operator works within `AppResult`-returning streaming helpers.
fn channel_err(e: tauri::Error) -> AppError {
    AppError::Internal(format!("channel send failed: {e}"))
}

/// Streaming variant of `run_one`. Sends `StreamEvent`s over `on_event` and
/// returns a `StreamOutcome` summarising the run for activity-log + history.
///
/// Errors propagate as `Err(AppError)` — the caller (command) maps them to a
/// `StreamEvent::Error` terminal event so the channel always has exactly one
/// terminal event regardless of failure mode.
async fn run_one_stream(
    client: &PgObject,
    sql: &str,
    is_read_only: bool,
    cap: u64,
    cap_source: RowCapSource,
    on_event: &tauri::ipc::Channel<StreamEvent>,
) -> AppResult<StreamOutcome> {
    if is_read_only && is_mutating_sql(sql) {
        return Err(AppError::Validation("connection is read-only".into()));
    }

    let started = Instant::now();

    // `prepare` first so we can inspect the result columns before fetching.
    let stmt = client.prepare(sql).await?;

    if stmt.columns().is_empty() {
        // DML / DDL path — no row streaming.
        let affected = client.execute(&stmt, &[]).await?;
        let query_ms = started.elapsed().as_millis() as u64;
        let tag = synthesize_command_tag(sql, affected);
        on_event
            .send(StreamEvent::Affected {
                command_tag: tag.clone(),
                affected_rows: affected,
                query_ms,
            })
            .map_err(channel_err)?;
        return Ok(StreamOutcome {
            row_count: 0,
            affected: Some(affected),
            command_tag: Some(tag),
        });
    }

    // SELECT-shape path — stream rows via `query_raw`.
    let columns = columns_from_row_meta(stmt.columns());
    on_event
        .send(StreamEvent::Columns {
            columns: columns.clone(),
        })
        .map_err(channel_err)?;

    // An explicitly-typed empty iterator resolves the `BorrowToSql` inference
    // for the no-parameter case. `&dyn ToSql` implements `BorrowToSql`.
    let stream = client
        .query_raw(
            &stmt,
            std::iter::empty::<&dyn tokio_postgres::types::ToSql>(),
        )
        .await?;
    futures::pin_mut!(stream);

    let mut buffer: Vec<Vec<JsonValue>> = Vec::with_capacity(BATCH_ROWS);
    let mut truncated_columns: Vec<String> = Vec::new();
    let mut row_count: u64 = 0;
    let mut truncated = false;
    let mut last_flush = Instant::now();
    let budget = row_cap::fetch_budget(cap);

    while row_count < budget {
        let Some(row) = stream.try_next().await? else {
            break;
        };
        if row_count == cap {
            // This is the (cap+1)-th row pulled from the server — it only
            // ever serves as a truncation signal and MUST NOT be decoded or
            // sent in a `Batch` event.
            truncated = true;
            break;
        }
        // Convert the row using the same helper as `run_one`.
        let mut cells: Vec<JsonValue> = Vec::with_capacity(columns.len());
        for (i, col) in columns.iter().enumerate() {
            cells.push(cell_to_json(&row, i, &col.name, &mut truncated_columns));
        }
        buffer.push(cells);
        row_count += 1;

        // Flush on size or time, whichever comes first.
        let flush = buffer.len() >= BATCH_ROWS || last_flush.elapsed() >= BATCH_INTERVAL;
        if flush {
            on_event
                .send(StreamEvent::Batch {
                    rows: std::mem::take(&mut buffer),
                })
                .map_err(channel_err)?;
            last_flush = Instant::now();
        }
    }

    // Flush any remaining buffered rows before the terminal event.
    if !buffer.is_empty() {
        on_event
            .send(StreamEvent::Batch {
                rows: std::mem::take(&mut buffer),
            })
            .map_err(channel_err)?;
    }

    let query_ms = started.elapsed().as_millis() as u64;
    on_event
        .send(StreamEvent::Done {
            row_count,
            truncated,
            query_ms,
            truncated_columns: truncated_columns.clone(),
            row_cap: cap,
            row_cap_source: cap_source,
        })
        .map_err(channel_err)?;

    Ok(StreamOutcome {
        row_count,
        affected: None,
        command_tag: None,
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
    let (cap, cap_source) = resolve_cap(&app, &sql);

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

        let result = match timeout(
            RUN_SQL_TIMEOUT,
            run_one(&client, &sql, is_read_only, cap, cap_source),
        )
        .await
        {
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

/// Build the activity metric directly from a `StreamOutcome` (avoids
/// materialising a dummy `Vec<Row>` just to call `.len()`).
fn metric_for_stream_outcome(outcome: &StreamOutcome) -> Metric {
    if let Some(affected) = outcome.affected {
        Metric::Affected {
            value: affected as i64,
        }
    } else {
        Metric::Rows {
            value: outcome.row_count,
        }
    }
}

/// Build a success history entry from a `StreamOutcome`.
fn build_history_entry_ok_stream(
    connection_id: Uuid,
    connection_name: &str,
    sql: &str,
    origin: Origin,
    started_at_ms: i64,
    duration_ms: u64,
    outcome: &StreamOutcome,
) -> NewEntry {
    let (row_count, command_tag) = if let Some(ref tag) = outcome.command_tag {
        (outcome.affected.map(|a| a as i64), Some(tag.clone()))
    } else {
        (Some(outcome.row_count as i64), None)
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

/// Streaming single-statement SQL command. Delivers results incrementally
/// over `on_event` (`Channel<StreamEvent>`) instead of returning a single
/// `RunSqlResult`. Exactly one terminal event (`done`, `affected`, or `error`)
/// ends the stream. The `invoke` promise resolves to `()` after the terminal
/// event has been sent.
///
/// Mirrors `postgres_run_sql` for connection acquisition, read-only
/// enforcement, timeout (60s), cancellation registration, and
/// activity-log / history recording.
#[tauri::command]
pub async fn postgres_run_sql_stream(
    app: AppHandle,
    pools: State<'_, PgPoolRegistry>,
    registry: State<'_, RunningQueryRegistry>,
    id: String,
    sql: String,
    origin: Option<Origin>,
    run_token: Option<String>,
    on_event: tauri::ipc::Channel<StreamEvent>,
) -> AppResult<()> {
    let started_wall_ms = now_unix_ms();
    let started = Instant::now();
    let activity_origin = origin.unwrap_or(Origin::User);
    let parsed = parse_id(&id)?;

    if sql.trim().is_empty() {
        // Return an Err here — no channel events expected before streaming
        // began, so we let the command promise reject normally.
        return Err(AppError::Validation("empty SQL".into()));
    }

    let connection_name = fetch_connection_name(&app, parsed);
    let (cap, cap_source) = resolve_cap(&app, &sql);

    // Resolve the pool entry, acquire a client, and register with the cancel
    // registry — identical scaffolding to `postgres_run_sql`.
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

    let run_result = timeout(
        RUN_SQL_TIMEOUT,
        run_one_stream(&client, &sql, is_read_only, cap, cap_source, &on_event),
    )
    .await;

    let total_ms = started.elapsed().as_millis() as u64;

    // Check cancel BEFORE mapping errors — a cancel often surfaces as a
    // stream error, and that must resolve as cancelled (neutral), not error.
    if _guard.as_ref().map_or(false, |g| g.cancelled()) {
        // Neutral cancelled state: keep partial rows that already shipped,
        // do NOT send an Error event. Record as cancelled in activity/history.
        let cancel_err = AppError::cancelled();
        let builder = ActivityLogEntryBuilder::new(ActivityKind::RunSql, activity_origin, total_ms)
            .connection(parsed)
            .sql(sql.clone());
        emit_activity(&app, builder.err(&cancel_err));
        record_history_err(
            &app,
            parsed,
            &connection_name,
            &sql,
            activity_origin,
            started_wall_ms,
            total_ms,
            &cancel_err,
        );
        return Ok(());
    }

    let builder = ActivityLogEntryBuilder::new(ActivityKind::RunSql, activity_origin, total_ms)
        .connection(parsed)
        .sql(sql.clone());

    match run_result {
        Ok(Ok(outcome)) => {
            // Terminal event already sent by `run_one_stream` — record success.
            emit_activity(&app, builder.ok(Some(metric_for_stream_outcome(&outcome))));
            let entry = build_history_entry_ok_stream(
                parsed,
                &connection_name,
                &sql,
                activity_origin,
                started_wall_ms,
                total_ms,
                &outcome,
            );
            let db = app.state::<crate::platform::DbState>();
            let conn = db.0.lock().expect("db poisoned");
            crate::modules::query_history::insert_entry(&conn, entry);
        }
        Ok(Err(app_err)) => {
            // Application error (prepare fail, read-only, mid-stream row error…)
            // — send a terminal Error event then record in activity + history.
            let (message, code, position) = match &app_err {
                AppError::Postgres(b) => (b.message.clone(), b.code.clone(), b.position),
                other => (other.to_string(), None, None),
            };
            // Best-effort — if the channel is already closed we swallow the error.
            let _ = on_event.send(StreamEvent::Error {
                message,
                code,
                position,
            });
            emit_activity(&app, builder.err(&app_err));
            record_history_err(
                &app,
                parsed,
                &connection_name,
                &sql,
                activity_origin,
                started_wall_ms,
                total_ms,
                &app_err,
            );
        }
        Err(_timeout) => {
            // Hard 60-second timeout — fire the Postgres cancel request and
            // send an Error terminal event so the frontend can show a message.
            fire_cancel(cancel_token, sslmode).await;
            drop(client);
            let timeout_err = AppError::postgres_with_code(
                "57014",
                format!("run-sql timed out ({}s)", RUN_SQL_TIMEOUT.as_secs()),
            );
            let _ = on_event.send(StreamEvent::Error {
                message: format!("run-sql timed out ({}s)", RUN_SQL_TIMEOUT.as_secs()),
                code: Some("57014".to_string()),
                position: None,
            });
            emit_activity(&app, builder.err(&timeout_err));
            record_history_err(
                &app,
                parsed,
                &connection_name,
                &sql,
                activity_origin,
                started_wall_ms,
                total_ms,
                &timeout_err,
            );
        }
    }

    Ok(())
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
        let (cap, cap_source) = resolve_cap(&app, sql);
        let started_wall_ms = now_unix_ms();
        let started = Instant::now();
        let result = timeout(
            RUN_SQL_TIMEOUT,
            run_one(&client, sql, is_read_only, cap, cap_source),
        )
        .await;
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
    fn cap_resolution_unbounded_query_uses_configured() {
        assert_eq!(
            resolve_cap_from(10_000, "SELECT * FROM big_table"),
            (10_000, RowCapSource::Setting)
        );
    }

    #[test]
    fn cap_resolution_explicit_limit_raises_cap() {
        // The bug in issue #276: LIMIT 30000 must not be capped at 10,000.
        assert_eq!(
            resolve_cap_from(10_000, "SELECT * FROM some_big_table LIMIT 30000"),
            (30_000, RowCapSource::Setting)
        );
    }

    #[test]
    fn cap_resolution_explicit_limit_never_lowers_cap() {
        assert_eq!(
            resolve_cap_from(10_000, "SELECT * FROM t LIMIT 5"),
            (10_000, RowCapSource::Setting)
        );
    }

    #[test]
    fn cap_resolution_beyond_hard_ceiling_clamps() {
        assert_eq!(
            resolve_cap_from(10_000, "SELECT * FROM t LIMIT 5000000"),
            (row_cap::HARD_ROW_CAP, RowCapSource::HardCeiling)
        );
    }

    #[test]
    fn cap_resolution_ignores_subquery_limit() {
        assert_eq!(
            resolve_cap_from(
                10_000,
                "SELECT * FROM t WHERE id IN (SELECT id FROM u LIMIT 50000)"
            ),
            (10_000, RowCapSource::Setting)
        );
    }

    #[test]
    fn cap_resolution_ignores_limit_in_string_or_comment() {
        assert_eq!(
            resolve_cap_from(10_000, "SELECT 'limit 30000' AS note FROM t"),
            (10_000, RowCapSource::Setting)
        );
        assert_eq!(
            resolve_cap_from(10_000, "SELECT * FROM t -- LIMIT 99999"),
            (10_000, RowCapSource::Setting)
        );
    }

    #[test]
    fn cap_resolution_honours_fetch_first() {
        assert_eq!(
            resolve_cap_from(10_000, "SELECT * FROM t FETCH FIRST 25000 ROWS ONLY"),
            (25_000, RowCapSource::Setting)
        );
    }

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
            row_cap: 10_000,
            row_cap_source: RowCapSource::Setting,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v.get("kind").unwrap(), "rows");
        assert_eq!(v.get("query_ms").unwrap(), 5);
        assert_eq!(v.get("row_cap").unwrap(), 10_000);
        assert_eq!(v.get("row_cap_source").unwrap(), "setting");

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
    fn stream_event_serializes_with_event_tag() {
        // Guards the wire contract the frontend `StreamEvent` type relies on:
        // an `event` discriminant plus snake_case fields.
        let cols = StreamEvent::Columns { columns: vec![] };
        let v = serde_json::to_value(&cols).unwrap();
        assert_eq!(v.get("event").unwrap(), "columns");

        let batch = StreamEvent::Batch {
            rows: vec![vec![JsonValue::from(1)]],
        };
        let v = serde_json::to_value(&batch).unwrap();
        assert_eq!(v.get("event").unwrap(), "batch");
        assert_eq!(v.get("rows").unwrap()[0][0], JsonValue::from(1));

        let done = StreamEvent::Done {
            row_count: 10_000,
            truncated: true,
            query_ms: 42,
            truncated_columns: vec!["blob".into()],
            row_cap: 10_000,
            row_cap_source: RowCapSource::Setting,
        };
        let v = serde_json::to_value(&done).unwrap();
        assert_eq!(v.get("event").unwrap(), "done");
        assert_eq!(v.get("row_count").unwrap(), 10_000);
        assert_eq!(v.get("truncated").unwrap(), true);
        assert_eq!(v.get("query_ms").unwrap(), 42);
        assert_eq!(v.get("truncated_columns").unwrap()[0], "blob");
        assert_eq!(v.get("row_cap").unwrap(), 10_000);
        assert_eq!(v.get("row_cap_source").unwrap(), "setting");

        let affected = StreamEvent::Affected {
            command_tag: "UPDATE 2".into(),
            affected_rows: 2,
            query_ms: 3,
        };
        let v = serde_json::to_value(&affected).unwrap();
        assert_eq!(v.get("event").unwrap(), "affected");
        assert_eq!(v.get("affected_rows").unwrap(), 2);
        assert_eq!(v.get("command_tag").unwrap(), "UPDATE 2");

        let err = StreamEvent::Error {
            message: "boom".into(),
            code: Some("42601".into()),
            position: Some(7),
        };
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v.get("event").unwrap(), "error");
        assert_eq!(v.get("message").unwrap(), "boom");
        assert_eq!(v.get("code").unwrap(), "42601");
        assert_eq!(v.get("position").unwrap(), 7);
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
            row_cap: row_cap::DEFAULT_ROW_CAP,
            row_cap_source: RowCapSource::Setting,
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

    // ---- NUMERIC ---------------------------------------------------------

    fn numeric_bytes(weight: i16, sign: u16, dscale: i16, digits: &[u16]) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&(digits.len() as i16).to_be_bytes());
        b.extend_from_slice(&weight.to_be_bytes());
        b.extend_from_slice(&sign.to_be_bytes());
        b.extend_from_slice(&dscale.to_be_bytes());
        for d in digits {
            b.extend_from_slice(&d.to_be_bytes());
        }
        b
    }

    fn numeric(weight: i16, sign: u16, dscale: i16, digits: &[u16]) -> String {
        let raw = numeric_bytes(weight, sign, dscale, digits);
        PgNumeric::from_sql(&PgType::NUMERIC, &raw).unwrap().0
    }

    #[test]
    fn numeric_basic() {
        // 1234.56 → digits [1234, 5600], weight 0, dscale 2
        assert_eq!(numeric(0, NUMERIC_POS, 2, &[1234, 5600]), "1234.56");
    }

    #[test]
    fn numeric_declared_scale_is_padded() {
        // numeric(10,4) keeps the trailing zeros the column declares.
        assert_eq!(numeric(0, NUMERIC_POS, 4, &[1234, 5600]), "1234.5600");
    }

    #[test]
    fn numeric_zero_scale_has_no_decimal_point() {
        assert_eq!(numeric(0, NUMERIC_POS, 0, &[42]), "42");
    }

    #[test]
    fn numeric_zero_with_scale() {
        // Postgres sends ndigits = 0 for a zero value; dscale still applies.
        assert_eq!(numeric(0, NUMERIC_POS, 2, &[]), "0.00");
    }

    #[test]
    fn numeric_leading_zero_groups() {
        // 0.00001 = 1000 × 10000^-2 → weight -2, one digit group, dscale 5.
        // Exercises the `weight < -1` path where the first fractional group
        // sits at a negative index and must read as an implicit zero.
        assert_eq!(numeric(-2, NUMERIC_POS, 5, &[1000]), "0.00001");
    }

    #[test]
    fn numeric_trailing_group_beyond_ndigits() {
        // 1.10 → digits [1, 1000]; the scale asks for 2 of the group's 4 digits.
        assert_eq!(numeric(0, NUMERIC_POS, 2, &[1, 1000]), "1.10");
    }

    #[test]
    fn numeric_arbitrary_precision_survives() {
        // -12345678901234567890.123456789 — far beyond f64 and beyond i64.
        let s = numeric(
            4,
            NUMERIC_NEG,
            9,
            &[1234, 5678, 9012, 3456, 7890, 1234, 5678, 9000],
        );
        assert_eq!(s, "-12345678901234567890.123456789");
    }

    #[test]
    fn numeric_non_finite_signs() {
        assert_eq!(numeric(0, NUMERIC_NAN, 0, &[]), "NaN");
        assert_eq!(numeric(0, NUMERIC_PINF, 0, &[]), "Infinity");
        assert_eq!(numeric(0, NUMERIC_NINF, 0, &[]), "-Infinity");
    }

    #[test]
    fn numeric_bad_length_is_err() {
        // Header alone is too short.
        assert!(PgNumeric::from_sql(&PgType::NUMERIC, &[0u8; 4]).is_err());
        // Header claims 3 digit groups but carries none.
        let mut raw = numeric_bytes(0, NUMERIC_POS, 0, &[]);
        raw[0..2].copy_from_slice(&3i16.to_be_bytes());
        assert!(PgNumeric::from_sql(&PgType::NUMERIC, &raw).is_err());
    }

    // ---- MONEY / TIMETZ / VARBIT ----------------------------------------

    #[test]
    fn money_negative_and_positive() {
        let raw = (-1_234_567i64).to_be_bytes();
        assert_eq!(
            PgMoney::from_sql(&PgType::MONEY, &raw).unwrap().0,
            "-12345.67"
        );
        let raw = 1_234_567i64.to_be_bytes();
        assert_eq!(
            PgMoney::from_sql(&PgType::MONEY, &raw).unwrap().0,
            "12345.67"
        );
        // Sub-unit amounts keep the leading zero.
        let raw = 5i64.to_be_bytes();
        assert_eq!(PgMoney::from_sql(&PgType::MONEY, &raw).unwrap().0, "0.05");
    }

    #[test]
    fn money_bad_length_is_err() {
        assert!(PgMoney::from_sql(&PgType::MONEY, &[0u8; 4]).is_err());
    }

    fn timetz_bytes(micros: i64, zone: i32) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&micros.to_be_bytes());
        b.extend_from_slice(&zone.to_be_bytes());
        b
    }

    #[test]
    fn timetz_positive_offset() {
        // 12:34:56.789+02 — the wire zone is seconds WEST, so +02:00 is -7200.
        let micros = (12 * 3600 + 34 * 60 + 56) * 1_000_000 + 789_000;
        let raw = timetz_bytes(micros, -7200);
        let s = PgTimeTz::from_sql(&PgType::TIMETZ, &raw).unwrap().0;
        assert_eq!(s, "12:34:56.789000+02:00");
    }

    #[test]
    fn timetz_negative_offset_and_no_fraction() {
        let raw = timetz_bytes(0, 18_000);
        let s = PgTimeTz::from_sql(&PgType::TIMETZ, &raw).unwrap().0;
        assert_eq!(s, "00:00:00-05:00");
    }

    #[test]
    fn timetz_bad_length_is_err() {
        assert!(PgTimeTz::from_sql(&PgType::TIMETZ, &[0u8; 8]).is_err());
    }

    fn varbit_bytes(bit_len: i32, bytes: &[u8]) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&bit_len.to_be_bytes());
        b.extend_from_slice(bytes);
        b
    }

    #[test]
    fn varbit_drops_pad_bits() {
        // B'1011' → 4 bits in one byte; the low nibble is padding.
        let raw = varbit_bytes(4, &[0b1011_0000]);
        assert_eq!(PgBits::from_sql(&PgType::VARBIT, &raw).unwrap().0, "1011");
    }

    #[test]
    fn varbit_spans_bytes() {
        let raw = varbit_bytes(9, &[0b1010_1010, 0b1000_0000]);
        assert_eq!(
            PgBits::from_sql(&PgType::VARBIT, &raw).unwrap().0,
            "101010101"
        );
    }

    #[test]
    fn varbit_bad_length_is_err() {
        // Claims 16 bits but carries one byte.
        let raw = varbit_bytes(16, &[0xFF]);
        assert!(PgBits::from_sql(&PgType::VARBIT, &raw).is_err());
        assert!(PgBits::from_sql(&PgType::VARBIT, &[0u8; 2]).is_err());
    }

    // ---- Geometry --------------------------------------------------------

    fn f8s(vals: &[f64]) -> Vec<u8> {
        vals.iter().flat_map(|v| v.to_be_bytes()).collect()
    }

    #[test]
    fn geometry_point_and_circle() {
        let raw = f8s(&[1.0, 2.0]);
        assert_eq!(
            PgGeometry::from_sql(&PgType::POINT, &raw).unwrap().0,
            "(1,2)"
        );
        let raw = f8s(&[1.0, 2.0, 3.5]);
        assert_eq!(
            PgGeometry::from_sql(&PgType::CIRCLE, &raw).unwrap().0,
            "<(1,2),3.5>"
        );
    }

    #[test]
    fn geometry_path_open_vs_closed() {
        let mut closed = vec![1u8];
        closed.extend_from_slice(&2i32.to_be_bytes());
        closed.extend_from_slice(&f8s(&[1.0, 2.0, 3.0, 4.0]));
        assert_eq!(
            PgGeometry::from_sql(&PgType::PATH, &closed).unwrap().0,
            "((1,2),(3,4))"
        );

        let mut open = vec![0u8];
        open.extend_from_slice(&2i32.to_be_bytes());
        open.extend_from_slice(&f8s(&[1.0, 2.0, 3.0, 4.0]));
        assert_eq!(
            PgGeometry::from_sql(&PgType::PATH, &open).unwrap().0,
            "[(1,2),(3,4)]"
        );
    }

    #[test]
    fn geometry_bad_length_is_err() {
        assert!(PgGeometry::from_sql(&PgType::POINT, &f8s(&[1.0])).is_err());
        // Path header claims 4 points but carries one.
        let mut raw = vec![1u8];
        raw.extend_from_slice(&4i32.to_be_bytes());
        raw.extend_from_slice(&f8s(&[1.0, 2.0]));
        assert!(PgGeometry::from_sql(&PgType::PATH, &raw).is_err());
    }

    // ---- decode_raw: arrays, ranges, domains -----------------------------

    fn array_bytes(elem_oid: i32, dims: &[i32], elems: &[Option<Vec<u8>>]) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&(dims.len() as i32).to_be_bytes());
        b.extend_from_slice(&0i32.to_be_bytes()); // has_null (advisory only)
        b.extend_from_slice(&elem_oid.to_be_bytes());
        for d in dims {
            b.extend_from_slice(&d.to_be_bytes());
            b.extend_from_slice(&1i32.to_be_bytes()); // lower bound
        }
        for e in elems {
            match e {
                None => b.extend_from_slice(&(-1i32).to_be_bytes()),
                Some(bytes) => {
                    b.extend_from_slice(&(bytes.len() as i32).to_be_bytes());
                    b.extend_from_slice(bytes);
                }
            }
        }
        b
    }

    fn i4(v: i32) -> Option<Vec<u8>> {
        Some(v.to_be_bytes().to_vec())
    }

    #[test]
    fn array_of_int4_with_null_element() {
        let raw = array_bytes(23, &[3], &[i4(1), i4(2), None]);
        let v = decode_raw(&PgType::INT4_ARRAY, &raw, 0).unwrap();
        assert_eq!(v, serde_json::json!([1, 2, null]));
    }

    #[test]
    fn array_of_text() {
        let raw = array_bytes(25, &[2], &[Some(b"a".to_vec()), Some(b"b".to_vec())]);
        let v = decode_raw(&PgType::TEXT_ARRAY, &raw, 0).unwrap();
        assert_eq!(v, serde_json::json!(["a", "b"]));
    }

    #[test]
    fn array_of_numeric_reuses_the_scalar_decoder() {
        let raw = array_bytes(
            1700,
            &[2],
            &[
                Some(numeric_bytes(0, NUMERIC_POS, 2, &[1, 1000])),
                Some(numeric_bytes(0, NUMERIC_POS, 2, &[2, 2000])),
            ],
        );
        let v = decode_raw(&PgType::NUMERIC_ARRAY, &raw, 0).unwrap();
        assert_eq!(v, serde_json::json!(["1.10", "2.20"]));
    }

    #[test]
    fn array_empty() {
        let raw = array_bytes(23, &[], &[]);
        let v = decode_raw(&PgType::INT4_ARRAY, &raw, 0).unwrap();
        assert_eq!(v, serde_json::json!([]));
    }

    #[test]
    fn array_two_dimensional_nests() {
        let raw = array_bytes(23, &[2, 2], &[i4(1), i4(2), i4(3), i4(4)]);
        let v = decode_raw(&PgType::INT4_ARRAY, &raw, 0).unwrap();
        assert_eq!(v, serde_json::json!([[1, 2], [3, 4]]));
    }

    #[test]
    fn array_truncated_payload_is_none() {
        // Header promises 3 elements, only 2 follow.
        let raw = array_bytes(23, &[3], &[i4(1), i4(2)]);
        assert!(decode_raw(&PgType::INT4_ARRAY, &raw, 0).is_none());
    }

    fn range_bytes(flags: u8, bounds: &[Vec<u8>]) -> Vec<u8> {
        let mut b = vec![flags];
        for bound in bounds {
            b.extend_from_slice(&(bound.len() as i32).to_be_bytes());
            b.extend_from_slice(bound);
        }
        b
    }

    // The flag bytes below are written as literals on purpose. Naming them via
    // the module's own constants would make these tests tautological — exactly
    // how an earlier LB_INC/LB_INF mix-up passed the unit suite while producing
    // "(,1)" for `[1,5)` against a real server.
    const WIRE_LB_INC: u8 = 0x02;
    const WIRE_UB_INF: u8 = 0x10;

    #[test]
    fn range_lower_inclusive_upper_exclusive() {
        let raw = range_bytes(
            WIRE_LB_INC,
            &[1i32.to_be_bytes().to_vec(), 5i32.to_be_bytes().to_vec()],
        );
        let v = decode_raw(&PgType::INT4_RANGE, &raw, 0).unwrap();
        assert_eq!(v, JsonValue::String("[1,5)".to_string()));
    }

    #[test]
    fn range_empty() {
        let raw = range_bytes(0x01, &[]);
        let v = decode_raw(&PgType::INT4_RANGE, &raw, 0).unwrap();
        assert_eq!(v, JsonValue::String("empty".to_string()));
    }

    #[test]
    fn range_unbounded_upper_renders_empty_bound() {
        let raw = range_bytes(WIRE_LB_INC | WIRE_UB_INF, &[1i32.to_be_bytes().to_vec()]);
        let v = decode_raw(&PgType::INT4_RANGE, &raw, 0).unwrap();
        assert_eq!(v, JsonValue::String("[1,)".to_string()));
    }

    #[test]
    fn multirange_wraps_its_ranges() {
        let r1 = range_bytes(
            WIRE_LB_INC,
            &[1i32.to_be_bytes().to_vec(), 5i32.to_be_bytes().to_vec()],
        );
        let r2 = range_bytes(
            WIRE_LB_INC,
            &[8i32.to_be_bytes().to_vec(), 9i32.to_be_bytes().to_vec()],
        );
        let mut raw = 2i32.to_be_bytes().to_vec();
        for r in [r1, r2] {
            raw.extend_from_slice(&(r.len() as i32).to_be_bytes());
            raw.extend_from_slice(&r);
        }
        let v = decode_raw(&PgType::INT4MULTI_RANGE, &raw, 0).unwrap();
        assert_eq!(v, JsonValue::String("{[1,5),[8,9)}".to_string()));
    }

    fn domain_over(base: PgType, oid: u32) -> PgType {
        PgType::new(
            format!("dom_{}", oid),
            oid,
            PgKind::Domain(base),
            "public".to_string(),
        )
    }

    #[test]
    fn domain_decodes_as_its_base_type() {
        let ty = domain_over(PgType::NUMERIC, 90_001);
        let raw = numeric_bytes(0, NUMERIC_POS, 2, &[1, 5000]);
        let v = decode_raw(&ty, &raw, 0).unwrap();
        assert_eq!(v, JsonValue::String("1.50".to_string()));
    }

    #[test]
    fn domain_over_text_decodes_as_text() {
        // `FromSql for String` rejects domains, which is why this needed the
        // raw path at all.
        let ty = domain_over(PgType::TEXT, 90_002);
        let v = decode_raw(&ty, b"abc", 0).unwrap();
        assert_eq!(v, JsonValue::String("abc".to_string()));
    }

    #[test]
    fn nested_domains_within_depth_cap_still_decode() {
        let mut ty = PgType::INT4;
        for i in 0..3u32 {
            ty = domain_over(ty, 90_100 + i);
        }
        let v = decode_raw(&ty, &7i32.to_be_bytes(), 0).unwrap();
        assert_eq!(v, serde_json::json!(7));
    }

    #[test]
    fn recursion_past_the_depth_cap_is_none() {
        let mut ty = PgType::INT4;
        for i in 0..(MAX_DECODE_DEPTH as u32 + 2) {
            ty = domain_over(ty, 90_200 + i);
        }
        assert!(decode_raw(&ty, &7i32.to_be_bytes(), 0).is_none());
    }

    #[test]
    fn unknown_type_yields_none_so_the_fallback_chain_runs() {
        let ty = PgType::new(
            "weird".to_string(),
            90_300,
            PgKind::Simple,
            "public".to_string(),
        );
        assert!(decode_raw(&ty, &[0x00, 0x01], 0).is_none());
    }
}
