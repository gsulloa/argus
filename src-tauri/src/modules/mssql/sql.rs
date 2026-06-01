//! MS SQL Server SQL editor commands.
//!
//! - `is_mutating_sql_mssql(sql)` — classify a statement as mutating or not.
//! - `split_statements(sql)` — two-level splitter: GO batch separator + `;`-level.
//! - `mssql_run_sql(app, id, sql, origin?)` — execute a single statement.
//! - `mssql_run_sql_many(app, id, statements, origin?)` — run pre-split statements.
//! - `mssql_run_sql_batch(app, id, sql, origin?)` — split then run.

use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value as JsonValue;
use tauri::{AppHandle, Manager as _, State};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::{AppError, AppResult, MssqlErrorBody};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::mssql::binding::{bind_kind_for_type, decode_row_value, BindKind};
use crate::modules::mssql::errors::map_tiberius_error;
use crate::modules::mssql::pool::MssqlPoolRegistry;
use crate::modules::query_history::{self, HistoryOrigin, HistoryStatus, NewEntry};
use crate::platform::DbState;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Per-statement hard cap.
const RUN_SQL_TIMEOUT: Duration = Duration::from_secs(15);
/// Total budget for `mssql_run_sql_many`.
const MANY_TOTAL_TIMEOUT: Duration = Duration::from_secs(30);
/// Maximum rows returned per SELECT.
const RESULT_ROW_CAP: usize = 10_000;
/// Per-cell truncation threshold (1 MiB).
const INLINE_TRUNCATE_BYTES: usize = 1_048_576;

// ---------------------------------------------------------------------------
// §11.1 — Mutation classifier
// ---------------------------------------------------------------------------

/// Skip leading whitespace and T-SQL comments (`-- ...`, `/* ... */`).
/// Returns a slice starting at the first non-comment, non-whitespace byte.
pub fn skip_leading_comments_tsql(sql: &str) -> &str {
    let bytes = sql.as_bytes();
    let mut i = 0;
    loop {
        // Skip whitespace.
        while i < bytes.len()
            && (bytes[i] == b' '
                || bytes[i] == b'\t'
                || bytes[i] == b'\n'
                || bytes[i] == b'\r')
        {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        // `-- ` line comment (any `--` followed by end or non-`-` is fine; be lenient).
        if i + 1 < bytes.len() && bytes[i] == b'-' && bytes[i + 1] == b'-' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // `/* ... */` block comment (non-nested for skip purposes).
        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            if i + 1 < bytes.len() {
                i += 2;
            }
            continue;
        }
        break;
    }
    &sql[i.min(sql.len())..]
}

/// Extract the first alphabetic keyword from `text` (already stripped of comments).
fn first_keyword_tsql(text: &str) -> String {
    let mut word = String::new();
    for c in text.chars() {
        if c.is_alphabetic() || c == '_' {
            word.push(c.to_ascii_uppercase());
        } else if word.is_empty() {
            // skip leading non-alpha (e.g. whitespace, but comments already stripped)
        } else {
            break;
        }
    }
    word
}

/// Returns `true` when the SQL statement appears to mutate server state.
///
/// Mutating set (conservative — stored procedure calls treated as mutating):
/// `INSERT, UPDATE, DELETE, MERGE, TRUNCATE, CREATE, ALTER, DROP, GRANT,
/// REVOKE, DENY, EXEC, EXECUTE, SP_*`.
pub fn is_mutating_sql_mssql(sql: &str) -> bool {
    let stripped = skip_leading_comments_tsql(sql);
    let first = first_keyword_tsql(stripped);
    if first.is_empty() {
        return false;
    }
    // Stored procedure calls starting with sp_ are treated as mutating.
    if first.starts_with("SP_") {
        return true;
    }
    matches!(
        first.as_str(),
        "INSERT"
            | "UPDATE"
            | "DELETE"
            | "MERGE"
            | "TRUNCATE"
            | "CREATE"
            | "ALTER"
            | "DROP"
            | "GRANT"
            | "REVOKE"
            | "DENY"
            | "EXEC"
            | "EXECUTE"
            | "USE"
            | "SET"
            | "DECLARE"
            | "BEGIN"
            | "COMMIT"
            | "ROLLBACK"
            | "BACKUP"
            | "RESTORE"
            | "DBCC"
            | "BULK"
    )
}

// ---------------------------------------------------------------------------
// §11.8 — Command tag extraction
// ---------------------------------------------------------------------------

/// Two-word tag pairs recognized for command tags.
const TWO_TOKEN_TAGS: &[(&str, &str)] = &[
    ("CREATE", "TABLE"),
    ("ALTER", "TABLE"),
    ("DROP", "TABLE"),
    ("CREATE", "INDEX"),
    ("DROP", "INDEX"),
    ("CREATE", "VIEW"),
    ("ALTER", "VIEW"),
    ("DROP", "VIEW"),
    ("CREATE", "PROCEDURE"),
    ("ALTER", "PROCEDURE"),
    ("DROP", "PROCEDURE"),
    ("CREATE", "FUNCTION"),
    ("ALTER", "FUNCTION"),
    ("DROP", "FUNCTION"),
    ("CREATE", "TRIGGER"),
    ("DROP", "TRIGGER"),
    ("TRUNCATE", "TABLE"),
    ("BEGIN", "TRAN"),
    ("BEGIN", "TRANSACTION"),
];

/// Extract the command tag from the leading keyword(s) of a SQL statement.
/// Skips T-SQL comments. Returns e.g. `"INSERT"`, `"CREATE TABLE"`.
pub fn extract_command_tag(sql: &str) -> String {
    let stripped = skip_leading_comments_tsql(sql);
    let mut tokens: Vec<String> = Vec::new();
    let mut chars = stripped.chars().peekable();
    while tokens.len() < 2 {
        while chars.peek().map(|c| c.is_whitespace()).unwrap_or(false) {
            chars.next();
        }
        if chars.peek().is_none() {
            break;
        }
        let mut word = String::new();
        while let Some(&c) = chars.peek() {
            if c.is_alphabetic() || c == '_' {
                word.push(c.to_ascii_uppercase());
                chars.next();
            } else {
                break;
            }
        }
        if word.is_empty() {
            break;
        }
        tokens.push(word);
    }

    if tokens.is_empty() {
        return String::new();
    }
    if tokens.len() >= 2 {
        let t0 = tokens[0].as_str();
        let t1 = tokens[1].as_str();
        for (a, b) in TWO_TOKEN_TAGS {
            if t0 == *a && t1 == *b {
                return format!("{t0} {t1}");
            }
        }
    }
    tokens[0].clone()
}

// ---------------------------------------------------------------------------
// §11.2 — RunSqlResult
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RunSqlResult {
    Rows {
        columns: Vec<ColumnMeta>,
        rows: Vec<Vec<JsonValue>>,
        truncated_columns: Vec<String>,
        truncated: bool,
        query_ms: u64,
    },
    Affected {
        command_tag: String,
        affected_rows: i64,
        query_ms: u64,
    },
}

// ---------------------------------------------------------------------------
// §11.6 — Multi-statement result
// ---------------------------------------------------------------------------

/// Per-statement error surfaced in `RunSqlOutcome`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct MssqlStatementError {
    pub message: String,
    pub code: Option<i32>,
    pub line: Option<u32>,
    pub procedure: Option<String>,
}

impl MssqlStatementError {
    fn from_app(err: &AppError) -> Self {
        match err {
            AppError::Mssql(body) => Self {
                message: body.message.clone(),
                code: body.code,
                line: body.line,
                procedure: body.procedure.clone(),
            },
            other => Self {
                message: other.to_string(),
                code: None,
                line: None,
                procedure: None,
            },
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RunSqlOutcome {
    pub statement_index: u32,
    pub result: Option<RunSqlResult>,
    pub error: Option<MssqlStatementError>,
    pub skipped: bool,
}

// ---------------------------------------------------------------------------
// §11.3 — Statement splitter types
// ---------------------------------------------------------------------------

/// A batch produced by GO-level splitting.
#[derive(Debug)]
pub struct Batch {
    pub statements: Vec<Statement>,
    /// 1 by default; >1 when followed by `GO N`.
    pub repeat_count: u32,
}

/// A single statement within a batch.
#[derive(Debug)]
pub struct Statement {
    pub text: String,
    /// 0-based character offset in the original SQL string.
    pub offset: usize,
    /// 1-based line number of the first character.
    pub line: u32,
}

// ---------------------------------------------------------------------------
// §11.3 — split_statements (two-level splitter)
// ---------------------------------------------------------------------------

/// Check if a line is a GO separator (case-insensitive). Returns the optional
/// repeat count (1 if bare GO).
///
/// A GO line is: optional leading whitespace, `GO`, optional whitespace, optional
/// integer, optional trailing whitespace. Nothing else on the line.
fn parse_go_line(line: &str) -> Option<u32> {
    let trimmed = line.trim();
    // Must start with GO (case-insensitive).
    if trimmed.len() < 2 {
        return None;
    }
    if !trimmed[..2].eq_ignore_ascii_case("GO") {
        return None;
    }
    let rest = trimmed[2..].trim();
    if rest.is_empty() {
        return Some(1);
    }
    // Optional integer after GO.
    if rest.chars().all(|c| c.is_ascii_digit()) {
        let n: u32 = rest.parse().ok()?;
        // GO 0 means run 0 times — treat as "don't run"; but we still return Some.
        return Some(n);
    }
    None
}

/// Split `sql` into `Vec<Batch>` using GO separators (level 1) and `;` within
/// each batch (level 2).
pub fn split_statements(sql: &str) -> Result<Vec<Batch>, AppError> {
    // --- Level 1: split on GO lines. ---
    let mut raw_batches: Vec<(String, u32)> = Vec::new(); // (text, repeat_count)
    let mut current_batch = String::new();
    let _current_line_start = 0usize; // byte offset of start of current_batch in sql (tracked per-batch)

    for line in sql.lines() {
        if let Some(repeat) = parse_go_line(line) {
            // This is a GO line.
            let trimmed = current_batch.trim();
            if !trimmed.is_empty() {
                raw_batches.push((current_batch.clone(), repeat));
            }
            current_batch = String::new();
        } else {
            current_batch.push_str(line);
            current_batch.push('\n');
        }
    }
    // Remaining text after the last GO (or the whole thing if no GO).
    let trimmed = current_batch.trim();
    if !trimmed.is_empty() {
        raw_batches.push((current_batch.clone(), 1));
    }

    // --- Level 2: split each batch on `;`, respecting quoting and comments. ---
    let mut batches: Vec<Batch> = Vec::new();

    for (batch_text, repeat_count) in raw_batches {
        let statements = split_batch_statements(&batch_text, sql)?;
        if !statements.is_empty() {
            batches.push(Batch {
                statements,
                repeat_count,
            });
        }
    }

    Ok(batches)
}

/// Split a single batch string into statements on `;`, honoring:
/// - `'...'` strings with `''` escape (no backslash escape in T-SQL)
/// - `"..."` quoted identifiers with `""` escape
/// - `[...]` bracket identifiers with `]]` escape
/// - `--` line comments (to EOL)
/// - `/* ... */` block comments with nesting depth tracking
fn split_batch_statements(
    batch: &str,
    _original_sql: &str,
) -> Result<Vec<Statement>, AppError> {
    let bytes = batch.as_bytes();
    let mut statements: Vec<Statement> = Vec::new();
    let mut current = String::new();
    let mut stmt_start_char_offset = 0usize;
    let mut stmt_start_line: u32 = 1;
    let mut current_char_offset = 0usize;
    let mut current_line: u32 = 1;

    // Parser state.
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut in_bracket = false;
    let mut in_line_comment = false;
    let mut block_comment_depth: u32 = 0;

    let mut i = 0usize;

    while i < bytes.len() {
        let b = bytes[i];

        // Track line numbers.
        if b == b'\n' {
            current_line += 1;
        }

        // Handle line-comment end.
        if in_line_comment {
            current.push(b as char);
            if b == b'\n' {
                in_line_comment = false;
            }
            i += 1;
            current_char_offset += 1;
            continue;
        }

        // Handle block comments (with nesting depth).
        if block_comment_depth > 0 {
            current.push(b as char);
            if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
                block_comment_depth += 1;
                current.push('*');
                i += 2;
                current_char_offset += 2;
                continue;
            }
            if b == b'*' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
                block_comment_depth -= 1;
                current.push('/');
                i += 2;
                current_char_offset += 2;
                continue;
            }
            i += 1;
            current_char_offset += 1;
            continue;
        }

        // Handle single-quote string ('...' with '' escape).
        if in_single_quote {
            current.push(b as char);
            if b == b'\'' {
                // Possible '' escape.
                if i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                    current.push('\'');
                    i += 2;
                    current_char_offset += 2;
                    continue;
                }
                in_single_quote = false;
            }
            i += 1;
            current_char_offset += 1;
            continue;
        }

        // Handle double-quote string ("..." with "" escape).
        if in_double_quote {
            current.push(b as char);
            if b == b'"' {
                if i + 1 < bytes.len() && bytes[i + 1] == b'"' {
                    current.push('"');
                    i += 2;
                    current_char_offset += 2;
                    continue;
                }
                in_double_quote = false;
            }
            i += 1;
            current_char_offset += 1;
            continue;
        }

        // Handle bracket identifier ([...] with ]] escape).
        if in_bracket {
            current.push(b as char);
            if b == b']' {
                if i + 1 < bytes.len() && bytes[i + 1] == b']' {
                    current.push(']');
                    i += 2;
                    current_char_offset += 2;
                    continue;
                }
                in_bracket = false;
            }
            i += 1;
            current_char_offset += 1;
            continue;
        }

        // --- None of the above states are active. ---

        // Start of single-quote string.
        if b == b'\'' {
            in_single_quote = true;
            current.push('\'');
            i += 1;
            current_char_offset += 1;
            continue;
        }

        // Start of double-quote identifier.
        if b == b'"' {
            in_double_quote = true;
            current.push('"');
            i += 1;
            current_char_offset += 1;
            continue;
        }

        // Start of bracket identifier.
        if b == b'[' {
            in_bracket = true;
            current.push('[');
            i += 1;
            current_char_offset += 1;
            continue;
        }

        // Start of line comment.
        if b == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-' {
            in_line_comment = true;
            current.push('-');
            current.push('-');
            i += 2;
            current_char_offset += 2;
            continue;
        }

        // Start of block comment.
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            block_comment_depth += 1;
            current.push('/');
            current.push('*');
            i += 2;
            current_char_offset += 2;
            continue;
        }

        // Semicolon — statement separator when not in any quoting/comment state.
        if b == b';' {
            let text = current.trim().to_string();
            if !text.is_empty() {
                statements.push(Statement {
                    text,
                    offset: stmt_start_char_offset,
                    line: stmt_start_line,
                });
            }
            current = String::new();
            i += 1;
            current_char_offset += 1;
            // Skip whitespace to find start of next statement.
            while i < bytes.len()
                && (bytes[i] == b' '
                    || bytes[i] == b'\t'
                    || bytes[i] == b'\n'
                    || bytes[i] == b'\r')
            {
                if bytes[i] == b'\n' {
                    current_line += 1;
                }
                i += 1;
                current_char_offset += 1;
            }
            stmt_start_char_offset = current_char_offset;
            stmt_start_line = current_line;
            continue;
        }

        current.push(b as char);
        i += 1;
        current_char_offset += 1;
    }

    // Remaining text (no trailing semicolon).
    let text = current.trim().to_string();
    if !text.is_empty() {
        statements.push(Statement {
            text,
            offset: stmt_start_char_offset,
            line: stmt_start_line,
        });
    }

    // §11.4 — Validate: CREATE PROCEDURE/FUNCTION/TRIGGER/VIEW must be first.
    if statements.len() >= 2 {
        for stmt in statements.iter().skip(1) {
            let upper = skip_leading_comments_tsql(&stmt.text).to_ascii_uppercase();
            if upper.starts_with("CREATE PROCEDURE")
                || upper.starts_with("CREATE FUNCTION")
                || upper.starts_with("CREATE TRIGGER")
                || upper.starts_with("CREATE VIEW")
            {
                return Err(AppError::Validation(
                    "CREATE PROCEDURE/FUNCTION/TRIGGER/VIEW must be the first statement in its batch; insert a 'GO' separator before it".into(),
                ));
            }
        }
    }

    Ok(statements)
}

// ---------------------------------------------------------------------------
// §11.2 — Core execution (single SQL string, one statement)
// ---------------------------------------------------------------------------

/// Decode all rows from a `tiberius` query result, applying per-cell truncation.
fn decode_tiberius_rows(
    rows: &[tiberius::Row],
) -> (Vec<ColumnMeta>, Vec<Vec<JsonValue>>, Vec<String>, bool) {
    if rows.is_empty() {
        return (Vec::new(), Vec::new(), Vec::new(), false);
    }
    let first_row = &rows[0];
    let col_metas: Vec<ColumnMeta> = first_row
        .columns()
        .iter()
        .map(|c| ColumnMeta {
            name: c.name().to_string(),
            data_type: format!("{:?}", c.column_type()).to_lowercase(),
        })
        .collect();
    let bind_kinds: Vec<BindKind> = first_row
        .columns()
        .iter()
        .map(|c| {
            let type_name = format!("{:?}", c.column_type());
            // Map tiberius ColumnType debug repr to a type name.
            let mapped = map_column_type_name(&type_name);
            bind_kind_for_type(mapped, None, None, None)
        })
        .collect();

    let mut result_rows: Vec<Vec<JsonValue>> = Vec::with_capacity(rows.len());
    let mut truncated_cols: Vec<String> = Vec::new();
    let mut any_truncated = false;

    for row in rows {
        let mut row_vals: Vec<JsonValue> = Vec::with_capacity(col_metas.len());
        for (col_idx, (meta, bk)) in col_metas.iter().zip(bind_kinds.iter()).enumerate() {
            let val = decode_row_value(row, col_idx, *bk).unwrap_or(JsonValue::Null);
            if let JsonValue::String(ref s) = val {
                if s.len() > INLINE_TRUNCATE_BYTES {
                    let preview: String = s.chars().take(256).collect();
                    row_vals.push(serde_json::json!({
                        "kind": "truncated",
                        "preview": preview,
                        "byte_length": s.len(),
                    }));
                    if !truncated_cols.iter().any(|n| n == &meta.name) {
                        truncated_cols.push(meta.name.clone());
                    }
                    any_truncated = true;
                    continue;
                }
            }
            row_vals.push(val);
        }
        result_rows.push(row_vals);
    }
    (col_metas, result_rows, truncated_cols, any_truncated)
}

/// Map tiberius `ColumnType` debug name to a sys.types name for BindKind lookup.
fn map_column_type_name(type_debug: &str) -> &str {
    // tiberius ColumnType debug names (approximate): "Bit", "Int1" (tinyint),
    // "Int2" (smallint), "Int4" (int), "Int8" (bigint), "Float4" (real),
    // "Float8" (float), "Money", "Money4" (smallmoney), "Decimaln" / "Numericn",
    // "NVarchar" / "NChar" / "BigVarChar" / "BigChar" / "NText" / "BigText",
    // "BigVarBin" (varbinary) / "BigBinary" (binary) / "Image",
    // "Datetime" / "Datetime2" / "Datetimen" / "Datetime4" (smalldatetime),
    // "DatetimeOffsetn", "Daten", "Timen",
    // "Guid" (uniqueidentifier), "Xml", "Text", "NText",
    // "Timestamp" (rowversion), "Udt", "SSVariant"
    let lower = type_debug.to_ascii_lowercase();
    if lower.starts_with("bit") {
        return "bit";
    }
    if lower == "int1" || lower.starts_with("tinyint") {
        return "tinyint";
    }
    if lower == "int2" || lower.starts_with("smallint") {
        return "smallint";
    }
    if lower == "int4" || lower == "intn" || lower == "int" {
        return "int";
    }
    if lower == "int8" || lower.starts_with("bigint") {
        return "bigint";
    }
    if lower.starts_with("float8") || lower == "float" {
        return "float";
    }
    if lower.starts_with("float4") || lower == "real" {
        return "real";
    }
    if lower == "money4" || lower.starts_with("smallmoney") {
        return "smallmoney";
    }
    if lower.starts_with("money") {
        return "money";
    }
    if lower.starts_with("decimaln") || lower.starts_with("decimal") {
        return "decimal";
    }
    if lower.starts_with("numericn") || lower.starts_with("numeric") {
        return "numeric";
    }
    if lower.starts_with("nvarchar") || lower.starts_with("bigvarwchar") {
        return "nvarchar";
    }
    if lower.starts_with("nchar") || lower.starts_with("ncharwchar") {
        return "nchar";
    }
    if lower.starts_with("ntext") {
        return "ntext";
    }
    if lower.starts_with("bigvarchar") {
        return "varchar";
    }
    if lower.starts_with("bigchar") || lower.starts_with("char") {
        return "char";
    }
    if lower.starts_with("bigtext") || lower.starts_with("text") {
        return "text";
    }
    if lower.starts_with("bigvarbinary") || lower.starts_with("bigvarbin") {
        return "varbinary";
    }
    if lower.starts_with("bigbinary") || lower.starts_with("binary") {
        return "binary";
    }
    if lower.starts_with("image") {
        return "image";
    }
    if lower.starts_with("timestamp") || lower.starts_with("rowversion") {
        return "rowversion";
    }
    if lower.starts_with("datetimeoffset") {
        return "datetimeoffset";
    }
    if lower.starts_with("datetime2") {
        return "datetime2";
    }
    if lower.starts_with("datetime4") || lower.starts_with("smalldatetime") {
        return "smalldatetime";
    }
    if lower.starts_with("datetime") {
        return "datetime";
    }
    if lower.starts_with("date") {
        return "date";
    }
    if lower.starts_with("time") {
        return "time";
    }
    if lower.starts_with("guid") || lower.starts_with("uniqueidentifier") {
        return "uniqueidentifier";
    }
    if lower.starts_with("xml") {
        return "xml";
    }
    if lower.starts_with("udt") || lower.starts_with("ssudt") {
        return "hierarchyid"; // most common UDT
    }
    if lower.starts_with("ssvariant") || lower.starts_with("sql_variant") {
        return "sql_variant";
    }
    "varchar" // safe fallback
}

/// Core: run a single SQL statement using an already-acquired client.
/// Returns `RunSqlResult`.
///
/// NOTE: The `line` in errors from tiberius refers to the line within the
/// submitted batch, NOT the line in the user's original SQL buffer.
async fn run_single_sql_inner(
    client: &mut bb8::PooledConnection<'static, bb8_tiberius::ConnectionManager>,
    sql: &str,
    read_only: bool,
) -> AppResult<RunSqlResult> {
    let started = Instant::now();
    let mutating = is_mutating_sql_mssql(sql);

    if mutating && read_only {
        return Err(AppError::Validation("connection is read-only".into()));
    }

    if !mutating {
        // Row-returning path: use `simple_query` + `into_first_result`.
        let rows = client
            .simple_query(sql)
            .await
            .map_err(map_tiberius_error)?
            .into_first_result()
            .await
            .map_err(map_tiberius_error)?;

        let query_ms = started.elapsed().as_millis() as u64;

        // Cap rows.
        let (rows_to_use, result_truncated) = if rows.len() > RESULT_ROW_CAP {
            (&rows[..RESULT_ROW_CAP], true)
        } else {
            (&rows[..], false)
        };

        let (col_metas, result_rows, truncated_columns, any_truncated) =
            decode_tiberius_rows(rows_to_use);

        Ok(RunSqlResult::Rows {
            columns: col_metas,
            rows: result_rows,
            truncated_columns,
            truncated: result_truncated || any_truncated,
            query_ms,
        })
    } else {
        // Mutating path: use `execute`.
        let exec_result = client
            .execute(sql, &[])
            .await
            .map_err(map_tiberius_error)?;

        let query_ms = started.elapsed().as_millis() as u64;
        // `rows_affected()` returns total rows affected across all result sets.
        let affected_rows: i64 = exec_result.rows_affected().iter().map(|&n| n as i64).sum();
        let command_tag = extract_command_tag(sql);

        Ok(RunSqlResult::Affected {
            command_tag,
            affected_rows,
            query_ms,
        })
    }
}

// ---------------------------------------------------------------------------
// §23.2 — Query history helpers
// ---------------------------------------------------------------------------

fn now_unix_ms() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp_nanos() as i64 / 1_000_000
}

fn origin_to_history(o: Origin) -> HistoryOrigin {
    match o {
        Origin::User => HistoryOrigin::User,
        Origin::Auto => HistoryOrigin::Auto,
    }
}

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

fn record_mssql_history_ok(
    app: &AppHandle,
    connection_id: Uuid,
    connection_name: &str,
    sql: &str,
    origin: Origin,
    started_at_ms: i64,
    duration_ms: u64,
    result: &RunSqlResult,
) {
    let (row_count, command_tag) = match result {
        RunSqlResult::Rows { rows, .. } => (Some(rows.len() as i64), None),
        RunSqlResult::Affected {
            affected_rows,
            command_tag,
            ..
        } => (Some(*affected_rows), Some(command_tag.clone())),
    };
    let entry = NewEntry {
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
    };
    let db = app.state::<DbState>();
    let conn = db.0.lock().expect("db poisoned");
    query_history::insert_entry(&conn, entry);
}

fn record_mssql_history_err(
    app: &AppHandle,
    connection_id: Uuid,
    connection_name: &str,
    sql: &str,
    origin: Origin,
    started_at_ms: i64,
    duration_ms: u64,
    err: &AppError,
) {
    let (code, message) = match err {
        AppError::Mssql(b) => (b.code.map(|c| c.to_string()), b.message.clone()),
        other => (None, other.to_string()),
    };
    let entry = NewEntry {
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
    };
    let db = app.state::<DbState>();
    let conn = db.0.lock().expect("db poisoned");
    query_history::insert_entry(&conn, entry);
}

// ---------------------------------------------------------------------------
// §11.2 — mssql_run_sql Tauri command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mssql_run_sql(
    app: AppHandle,
    registry: State<'_, MssqlPoolRegistry>,
    id: Uuid,
    sql: String,
    origin: Option<Origin>,
) -> AppResult<RunSqlResult> {
    let started_wall_ms = now_unix_ms();
    let started = Instant::now();
    let activity_origin = origin.unwrap_or(Origin::User);

    if sql.trim().is_empty() {
        return Err(AppError::Validation("empty SQL".into()));
    }

    let mut client = registry.acquire(id).await?;
    let read_only = registry.read_only_for(id).unwrap_or(false);
    let connection_name = fetch_connection_name(&app, id);

    let result =
        tokio::time::timeout(RUN_SQL_TIMEOUT, run_single_sql_inner(&mut client, &sql, read_only))
            .await
            .map_err(|_| {
                AppError::Mssql(MssqlErrorBody {
                    code: None,
                    message: format!("query timed out ({}s)", RUN_SQL_TIMEOUT.as_secs()),
                    line: None,
                    procedure: None,
                })
            })
            .and_then(|r| r);

    let duration_ms = started.elapsed().as_millis() as u64;

    let builder = ActivityLogEntryBuilder::new(ActivityKind::RunSql, activity_origin, duration_ms)
        .connection(id)
        .sql(&sql);

    match &result {
        Ok(RunSqlResult::Rows { rows, .. }) => {
            let entry = builder.ok(Some(Metric::Items {
                value: rows.len() as u32,
            }));
            emit_activity(&app, entry);
            record_mssql_history_ok(
                &app,
                id,
                &connection_name,
                &sql,
                activity_origin,
                started_wall_ms,
                duration_ms,
                result.as_ref().unwrap(),
            );
        }
        Ok(RunSqlResult::Affected { affected_rows, .. }) => {
            let entry = builder.ok(Some(Metric::Items {
                value: *affected_rows as u32,
            }));
            emit_activity(&app, entry);
            record_mssql_history_ok(
                &app,
                id,
                &connection_name,
                &sql,
                activity_origin,
                started_wall_ms,
                duration_ms,
                result.as_ref().unwrap(),
            );
        }
        Err(e) => {
            let entry = builder.err(e);
            emit_activity(&app, entry);
            record_mssql_history_err(
                &app,
                id,
                &connection_name,
                &sql,
                activity_origin,
                started_wall_ms,
                duration_ms,
                e,
            );
        }
    }

    result
}

// ---------------------------------------------------------------------------
// §11.6 — mssql_run_sql_many Tauri command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mssql_run_sql_many(
    app: AppHandle,
    registry: State<'_, MssqlPoolRegistry>,
    id: Uuid,
    statements: Vec<String>,
    origin: Option<Origin>,
) -> AppResult<Vec<RunSqlOutcome>> {
    let started_wall_ms = now_unix_ms();
    let started = Instant::now();
    let activity_origin = origin.unwrap_or(Origin::User);
    let connection_name = fetch_connection_name(&app, id);

    let mut client = registry.acquire(id).await?;
    let read_only = registry.read_only_for(id).unwrap_or(false);

    let mut outcomes: Vec<RunSqlOutcome> = Vec::with_capacity(statements.len());
    let mut errored = false;
    let mut total_items: u64 = 0;

    for (idx, stmt) in statements.iter().enumerate() {
        let elapsed = started.elapsed();
        if elapsed >= MANY_TOTAL_TIMEOUT {
            outcomes.push(RunSqlOutcome {
                statement_index: idx as u32,
                result: None,
                error: Some(MssqlStatementError {
                    message: format!("run timeout ({}s)", MANY_TOTAL_TIMEOUT.as_secs()),
                    code: None,
                    line: None,
                    procedure: None,
                }),
                skipped: false,
            });
            errored = true;
            for (i, _) in statements.iter().enumerate().skip(idx + 1) {
                outcomes.push(RunSqlOutcome {
                    statement_index: i as u32,
                    result: None,
                    error: None,
                    skipped: true,
                });
            }
            break;
        }

        if errored {
            outcomes.push(RunSqlOutcome {
                statement_index: idx as u32,
                result: None,
                error: None,
                skipped: true,
            });
            continue;
        }

        let remaining = MANY_TOTAL_TIMEOUT.saturating_sub(elapsed);
        let per_stmt_timeout = remaining.min(RUN_SQL_TIMEOUT);

        let stmt_result = tokio::time::timeout(
            per_stmt_timeout,
            run_single_sql_inner(&mut client, stmt, read_only),
        )
        .await;

        match stmt_result {
            Ok(Ok(res)) => {
                let items = match &res {
                    RunSqlResult::Rows { rows, .. } => rows.len() as u64,
                    RunSqlResult::Affected { affected_rows, .. } => *affected_rows as u64,
                };
                total_items += items;
                outcomes.push(RunSqlOutcome {
                    statement_index: idx as u32,
                    result: Some(res),
                    error: None,
                    skipped: false,
                });
            }
            Ok(Err(e)) => {
                outcomes.push(RunSqlOutcome {
                    statement_index: idx as u32,
                    result: None,
                    error: Some(MssqlStatementError::from_app(&e)),
                    skipped: false,
                });
                errored = true;
            }
            Err(_elapsed) => {
                outcomes.push(RunSqlOutcome {
                    statement_index: idx as u32,
                    result: None,
                    error: Some(MssqlStatementError {
                        message: format!(
                            "statement timeout ({}s)",
                            per_stmt_timeout.as_secs()
                        ),
                        code: None,
                        line: None,
                        procedure: None,
                    }),
                    skipped: false,
                });
                errored = true;
            }
        }
    }

    let duration_ms = started.elapsed().as_millis() as u64;
    let joined_sql = statements.join(";\n");

    let builder =
        ActivityLogEntryBuilder::new(ActivityKind::RunSqlMany, activity_origin, duration_ms)
            .connection(id)
            .sql(&joined_sql);

    if errored {
        let err = AppError::mssql("one or more statements failed");
        let entry = builder.err(&err);
        emit_activity(&app, entry);
        record_mssql_history_err(
            &app,
            id,
            &connection_name,
            &joined_sql,
            activity_origin,
            started_wall_ms,
            duration_ms,
            &err,
        );
    } else {
        let entry = builder.ok(Some(Metric::Items {
            value: total_items as u32,
        }));
        emit_activity(&app, entry);
        let batch_result = RunSqlResult::Affected {
            command_tag: "BATCH".to_string(),
            affected_rows: total_items as i64,
            query_ms: duration_ms,
        };
        record_mssql_history_ok(
            &app,
            id,
            &connection_name,
            &joined_sql,
            activity_origin,
            started_wall_ms,
            duration_ms,
            &batch_result,
        );
    }

    Ok(outcomes)
}

// ---------------------------------------------------------------------------
// §11.6 — mssql_run_sql_batch: full split-then-run pipeline
// ---------------------------------------------------------------------------

/// Split `sql` into batches/statements (GO + `;`), then run them in sequence
/// with skip-on-first-error semantics and repeat-count expansion.
#[tauri::command]
pub async fn mssql_run_sql_batch(
    app: AppHandle,
    registry: State<'_, MssqlPoolRegistry>,
    id: Uuid,
    sql: String,
    origin: Option<Origin>,
) -> AppResult<Vec<RunSqlOutcome>> {
    if sql.trim().is_empty() {
        return Err(AppError::Validation("empty SQL".into()));
    }

    // Split into batches.
    let batches = split_statements(&sql)?;

    // Flatten batches with repeat-count expansion into a flat statement list.
    let mut flat_stmts: Vec<String> = Vec::new();
    for batch in batches {
        for _ in 0..batch.repeat_count {
            for stmt in &batch.statements {
                flat_stmts.push(stmt.text.clone());
            }
        }
    }

    if flat_stmts.is_empty() {
        return Ok(Vec::new());
    }

    mssql_run_sql_many(app, registry, id, flat_stmts, origin).await
}

// ---------------------------------------------------------------------------
// §11.9 — Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // is_mutating_sql_mssql
    // -----------------------------------------------------------------------

    #[test]
    fn select_is_non_mutating() {
        assert!(!is_mutating_sql_mssql("SELECT 1"));
    }

    #[test]
    fn select_with_comment_is_non_mutating() {
        assert!(!is_mutating_sql_mssql("-- comment\nSELECT 1"));
    }

    #[test]
    fn insert_is_mutating() {
        assert!(is_mutating_sql_mssql("INSERT INTO t VALUES (1)"));
    }

    #[test]
    fn update_is_mutating() {
        assert!(is_mutating_sql_mssql("UPDATE t SET x=1"));
    }

    #[test]
    fn delete_is_mutating() {
        assert!(is_mutating_sql_mssql("DELETE FROM t WHERE id=1"));
    }

    #[test]
    fn merge_is_mutating() {
        assert!(is_mutating_sql_mssql("MERGE INTO t USING src ON ..."));
    }

    #[test]
    fn truncate_is_mutating() {
        assert!(is_mutating_sql_mssql("TRUNCATE TABLE t"));
    }

    #[test]
    fn create_is_mutating() {
        assert!(is_mutating_sql_mssql("CREATE TABLE t (id INT)"));
    }

    #[test]
    fn alter_is_mutating() {
        assert!(is_mutating_sql_mssql("ALTER TABLE t ADD COLUMN x INT"));
    }

    #[test]
    fn drop_is_mutating() {
        assert!(is_mutating_sql_mssql("DROP TABLE t"));
    }

    #[test]
    fn grant_is_mutating() {
        assert!(is_mutating_sql_mssql("GRANT SELECT ON t TO user1"));
    }

    #[test]
    fn revoke_is_mutating() {
        assert!(is_mutating_sql_mssql("REVOKE SELECT ON t FROM user1"));
    }

    #[test]
    fn deny_is_mutating() {
        assert!(is_mutating_sql_mssql("DENY SELECT ON t TO user1"));
    }

    #[test]
    fn exec_is_mutating() {
        assert!(is_mutating_sql_mssql("EXEC sp_rename 'old', 'new'"));
    }

    #[test]
    fn execute_is_mutating() {
        assert!(is_mutating_sql_mssql("EXECUTE my_proc"));
    }

    #[test]
    fn sp_prefix_is_mutating() {
        assert!(is_mutating_sql_mssql("sp_helptext 'my_object'"));
    }

    #[test]
    fn empty_is_non_mutating() {
        assert!(!is_mutating_sql_mssql(""));
        assert!(!is_mutating_sql_mssql("   "));
    }

    // -----------------------------------------------------------------------
    // extract_command_tag
    // -----------------------------------------------------------------------

    #[test]
    fn tag_insert() {
        assert_eq!(extract_command_tag("INSERT INTO t VALUES (1)"), "INSERT");
    }

    #[test]
    fn tag_create_table() {
        assert_eq!(
            extract_command_tag("CREATE TABLE t (id INT)"),
            "CREATE TABLE"
        );
    }

    #[test]
    fn tag_alter_table() {
        assert_eq!(
            extract_command_tag("ALTER TABLE t ADD COLUMN x INT"),
            "ALTER TABLE"
        );
    }

    #[test]
    fn tag_drop_table() {
        assert_eq!(extract_command_tag("DROP TABLE users"), "DROP TABLE");
    }

    #[test]
    fn tag_create_view() {
        assert_eq!(
            extract_command_tag("CREATE VIEW v AS SELECT 1"),
            "CREATE VIEW"
        );
    }

    #[test]
    fn tag_truncate_table() {
        assert_eq!(extract_command_tag("TRUNCATE TABLE t"), "TRUNCATE TABLE");
    }

    #[test]
    fn tag_begin_tran() {
        assert_eq!(extract_command_tag("BEGIN TRAN"), "BEGIN TRAN");
    }

    #[test]
    fn tag_begin_transaction() {
        assert_eq!(
            extract_command_tag("BEGIN TRANSACTION"),
            "BEGIN TRANSACTION"
        );
    }

    #[test]
    fn tag_create_procedure() {
        assert_eq!(
            extract_command_tag("CREATE PROCEDURE foo AS BEGIN SELECT 1 END"),
            "CREATE PROCEDURE"
        );
    }

    #[test]
    fn tag_exec() {
        assert_eq!(extract_command_tag("EXEC sp_rename 'old', 'new'"), "EXEC");
    }

    #[test]
    fn tag_strips_comment() {
        assert_eq!(
            extract_command_tag("-- a comment\nINSERT INTO t VALUES (1)"),
            "INSERT"
        );
    }

    #[test]
    fn tag_strips_block_comment() {
        assert_eq!(
            extract_command_tag("/* comment */ SELECT 1"),
            "SELECT"
        );
    }

    // -----------------------------------------------------------------------
    // parse_go_line
    // -----------------------------------------------------------------------

    #[test]
    fn go_bare() {
        assert_eq!(parse_go_line("GO"), Some(1));
        assert_eq!(parse_go_line("go"), Some(1));
        assert_eq!(parse_go_line("Go"), Some(1));
        assert_eq!(parse_go_line("  GO  "), Some(1));
    }

    #[test]
    fn go_with_count() {
        assert_eq!(parse_go_line("GO 5"), Some(5));
        assert_eq!(parse_go_line("go 10"), Some(10));
        assert_eq!(parse_go_line("  GO 3  "), Some(3));
    }

    #[test]
    fn not_go() {
        assert_eq!(parse_go_line("SELECT 1"), None);
        assert_eq!(parse_go_line("GOTO label"), None);
        assert_eq!(parse_go_line(""), None);
    }

    // -----------------------------------------------------------------------
    // split_statements — GO batch separator
    // -----------------------------------------------------------------------

    #[test]
    fn go_splits_into_two_batches() {
        let sql = "SELECT 1\nGO\nSELECT 2";
        let batches = split_statements(sql).unwrap();
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].statements[0].text, "SELECT 1");
        assert_eq!(batches[1].statements[0].text, "SELECT 2");
    }

    #[test]
    fn go_with_repeat_count() {
        let sql = "SELECT 1\nGO 3";
        let batches = split_statements(sql).unwrap();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].repeat_count, 3);
    }

    #[test]
    fn trailing_go_no_empty_batch() {
        let sql = "SELECT 1\nGO\n";
        let batches = split_statements(sql).unwrap();
        assert_eq!(batches.len(), 1);
    }

    #[test]
    fn multiple_gos() {
        let sql = "SELECT 1\nGO\nSELECT 2\nGO\nSELECT 3";
        let batches = split_statements(sql).unwrap();
        assert_eq!(batches.len(), 3);
    }

    #[test]
    fn no_go_is_single_batch() {
        let sql = "SELECT 1; SELECT 2";
        let batches = split_statements(sql).unwrap();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].statements.len(), 2);
    }

    // -----------------------------------------------------------------------
    // split_statements — semicolon within batch
    // -----------------------------------------------------------------------

    #[test]
    fn semicolon_splits_within_batch() {
        let sql = "SELECT 1; SELECT 2";
        let batches = split_statements(sql).unwrap();
        assert_eq!(batches[0].statements.len(), 2);
    }

    #[test]
    fn single_quote_string_with_semicolon_not_split() {
        let sql = "SELECT 'foo;bar'";
        let batches = split_statements(sql).unwrap();
        assert_eq!(batches[0].statements.len(), 1);
        assert_eq!(batches[0].statements[0].text, "SELECT 'foo;bar'");
    }

    #[test]
    fn single_quote_doubled_escape() {
        let sql = "SELECT 'it''s fine'; SELECT 2";
        let batches = split_statements(sql).unwrap();
        assert_eq!(batches[0].statements.len(), 2);
    }

    #[test]
    fn double_quote_identifier_with_semicolon_not_split() {
        let sql = "SELECT \"weird;col\" FROM t";
        let batches = split_statements(sql).unwrap();
        assert_eq!(batches[0].statements.len(), 1);
    }

    #[test]
    fn bracket_identifier_with_semicolon_not_split() {
        let sql = "SELECT * FROM [tbl;name]";
        let batches = split_statements(sql).unwrap();
        assert_eq!(batches[0].statements.len(), 1);
        assert_eq!(batches[0].statements[0].text, "SELECT * FROM [tbl;name]");
    }

    #[test]
    fn bracket_identifier_with_embedded_bracket_escape() {
        // [we]]ird] — the ]] is an escaped ] inside the identifier.
        let sql = "SELECT * FROM [we]]ird]";
        let batches = split_statements(sql).unwrap();
        assert_eq!(batches[0].statements.len(), 1);
    }

    #[test]
    fn line_comment_not_split() {
        let sql = "SELECT 1 -- ; not a separator\nSELECT 2";
        let batches = split_statements(sql).unwrap();
        // Only one statement (the line comment consumes the ; on the same line).
        assert_eq!(batches[0].statements.len(), 1);
    }

    #[test]
    fn block_comment_not_split() {
        let sql = "SELECT /* ; skip */ 1; SELECT 2";
        let batches = split_statements(sql).unwrap();
        assert_eq!(batches[0].statements.len(), 2);
    }

    #[test]
    fn nested_block_comments() {
        // /* /* nested */ */ — the inner comment should not close the outer.
        let sql = "SELECT /* /* nested ; skip */ still in comment */ 1; SELECT 2";
        let batches = split_statements(sql).unwrap();
        // Both statements should be present.
        assert_eq!(batches[0].statements.len(), 2);
    }

    // -----------------------------------------------------------------------
    // §11.4 — CREATE PROCEDURE/FUNCTION/TRIGGER/VIEW not-first rejection
    // -----------------------------------------------------------------------

    #[test]
    fn create_procedure_not_first_in_batch_rejected() {
        let sql = "SELECT 1; CREATE PROCEDURE foo AS BEGIN SELECT 1 END";
        let result = split_statements(sql);
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("CREATE PROCEDURE") || msg.contains("first statement"),
            "msg: {msg}"
        );
    }

    #[test]
    fn create_function_not_first_rejected() {
        let sql = "SELECT 1; CREATE FUNCTION f() RETURNS INT BEGIN RETURN 1 END";
        let result = split_statements(sql);
        assert!(result.is_err());
    }

    #[test]
    fn create_trigger_not_first_rejected() {
        let sql = "SELECT 1; CREATE TRIGGER t AFTER INSERT ON x BEGIN END";
        let result = split_statements(sql);
        assert!(result.is_err());
    }

    #[test]
    fn create_view_not_first_rejected() {
        let sql = "SELECT 1; CREATE VIEW v AS SELECT 2";
        let result = split_statements(sql);
        assert!(result.is_err());
    }

    #[test]
    fn create_procedure_first_in_batch_ok() {
        let sql = "CREATE PROCEDURE foo AS BEGIN SELECT 1 END";
        let result = split_statements(sql);
        assert!(result.is_ok());
    }

    #[test]
    fn create_procedure_first_after_go_ok() {
        // After GO, it is a new batch — create procedure is fine as first stmt.
        let sql = "SELECT 1\nGO\nCREATE PROCEDURE foo AS BEGIN SELECT 1 END";
        let result = split_statements(sql);
        assert!(result.is_ok());
    }

    // -----------------------------------------------------------------------
    // §11.5 — GO N repeat count
    // -----------------------------------------------------------------------

    #[test]
    fn go_n_sets_repeat_count() {
        let sql = "INSERT INTO t VALUES (1)\nGO 5";
        let batches = split_statements(sql).unwrap();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].repeat_count, 5);
    }

    #[test]
    fn go_without_n_is_repeat_count_1() {
        let sql = "SELECT 1\nGO";
        let batches = split_statements(sql).unwrap();
        assert_eq!(batches[0].repeat_count, 1);
    }

    // -----------------------------------------------------------------------
    // Empty input
    // -----------------------------------------------------------------------

    #[test]
    fn empty_sql_produces_empty_batches() {
        let batches = split_statements("").unwrap();
        assert!(batches.is_empty());
    }

    #[test]
    fn whitespace_only_produces_empty_batches() {
        let batches = split_statements("   \n\t  ").unwrap();
        assert!(batches.is_empty());
    }

    #[test]
    fn go_only_produces_empty_batches() {
        let batches = split_statements("GO").unwrap();
        assert!(batches.is_empty());
    }
}
