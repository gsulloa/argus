//! Athena SQL execution.
//!
//! Implements the StartQueryExecution → poll GetQueryExecution → GetQueryResults lifecycle.

use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value as JsonValue;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::athena::errors::sdk_err_to_app;
use crate::modules::athena::pool::AthenaClientRegistry;
use crate::modules::mysql::sql::is_mutating_sql;
use crate::platform::row_cap::{self, RowCapSource};
use crate::platform::sql_limit::{self, Dialect};
use crate::platform::DbState;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Total polling timeout per query.
const QUERY_POLL_TIMEOUT: Duration = Duration::from_secs(300); // 5 minutes

/// Initial polling interval; doubles each iteration up to MAX_POLL_INTERVAL.
const INITIAL_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Maximum polling interval.
const MAX_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Event emitted after StartQueryExecution to enable frontend cancellation.
const QUERY_STARTED_EVENT: &str = "athena:query-started";

// ---------------------------------------------------------------------------
// Result envelopes
// ---------------------------------------------------------------------------

/// Column metadata returned to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RunSqlResult {
    Rows {
        columns: Vec<ColumnInfo>,
        rows: Vec<Vec<JsonValue>>,
        query_ms: u64,
        truncated: bool,
        data_scanned_bytes: i64,
        row_cap: u64,
        row_cap_source: RowCapSource,
    },
    Succeeded {
        statement_type: String,
        query_ms: u64,
        data_scanned_bytes: i64,
    },
}

/// Per-statement error for multi-statement runs.
#[derive(Debug, Clone, Serialize)]
pub struct StatementError {
    pub message: String,
    pub code: Option<String>,
}

impl StatementError {
    fn from_app(err: &AppError) -> Self {
        match err {
            AppError::Aws(body) => Self {
                message: body.message.clone(),
                code: Some(body.code.clone()),
            },
            other => Self {
                message: other.to_string(),
                code: None,
            },
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum StatementOutcome {
    Ok {
        index: usize,
        sql: String,
        result: RunSqlResult,
    },
    Err {
        index: usize,
        sql: String,
        error: StatementError,
    },
    Skipped {
        index: usize,
        sql: String,
    },
}

#[derive(Debug, Serialize)]
pub struct MultiSqlResult {
    pub outcomes: Vec<StatementOutcome>,
}

// ---------------------------------------------------------------------------
// Row cap resolution
// ---------------------------------------------------------------------------

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
/// cap with whatever explicit limit `sql` carries under Presto/Athena syntax.
fn resolve_cap_from(configured: u64, sql: &str) -> (u64, RowCapSource) {
    let explicit = sql_limit::explicit_row_limit(sql, Dialect::Presto);
    row_cap::effective_cap(configured, explicit, row_cap::HARD_ROW_CAP)
}

// ---------------------------------------------------------------------------
// Type coercion helpers
// ---------------------------------------------------------------------------

/// Coerce a raw string cell value to a typed JSON value based on the Athena
/// column type string.
///
/// This is the only place that depends on Athena/Presto type names; all other
/// code is type-agnostic.
pub fn coerce_cell(raw: Option<&str>, col_type: &str) -> JsonValue {
    match raw {
        None => JsonValue::Null,
        Some(s) => {
            let lower = col_type.to_ascii_lowercase();
            // Numeric types → JSON number
            if matches!(
                lower.as_str(),
                "tinyint" | "smallint" | "integer" | "int" | "bigint" | "float" | "double" | "real"
            ) || lower.starts_with("decimal")
            {
                if let Ok(n) = s.parse::<i64>() {
                    return JsonValue::Number(n.into());
                }
                if let Ok(f) = s.parse::<f64>() {
                    if let Some(num) = serde_json::Number::from_f64(f) {
                        return JsonValue::Number(num);
                    }
                }
                // Fallback to string if parse fails.
                return JsonValue::String(s.to_string());
            }
            // Boolean
            if lower == "boolean" {
                return match s.to_ascii_lowercase().as_str() {
                    "true" | "1" => JsonValue::Bool(true),
                    "false" | "0" => JsonValue::Bool(false),
                    _ => JsonValue::String(s.to_string()),
                };
            }
            // Everything else (varchar, string, char, date, timestamp, binary, …)
            JsonValue::String(s.to_string())
        }
    }
}

// ---------------------------------------------------------------------------
// Internal: run a single Athena query through the full lifecycle
// ---------------------------------------------------------------------------

async fn run_athena_query(
    app: &AppHandle,
    connection_id: Uuid,
    athena: &aws_sdk_athena::Client,
    workgroup: &str,
    output_location: Option<&str>,
    sql: &str,
    row_cap: (u64, RowCapSource),
) -> AppResult<RunSqlResult> {
    let (cap, cap_source) = row_cap;
    let poll_start = Instant::now();

    // --- StartQueryExecution ---
    let mut start_req = athena
        .start_query_execution()
        .query_string(sql)
        .work_group(workgroup);

    if let Some(loc) = output_location {
        if !loc.is_empty() {
            start_req = start_req.result_configuration(
                aws_sdk_athena::types::ResultConfiguration::builder()
                    .output_location(loc)
                    .build(),
            );
        }
    }

    let start_resp = start_req.send().await.map_err(|e| sdk_err_to_app(&e))?;

    let query_execution_id = start_resp
        .query_execution_id
        .ok_or_else(|| AppError::Internal("Athena did not return a query_execution_id".into()))?;

    // Notify frontend so it can cancel if needed.
    let _ = app.emit(
        QUERY_STARTED_EVENT,
        serde_json::json!({
            "connection_id": connection_id.to_string(),
            "query_execution_id": query_execution_id,
        }),
    );

    // --- Poll GetQueryExecution ---
    let mut interval = INITIAL_POLL_INTERVAL;
    let execution = loop {
        if poll_start.elapsed() >= QUERY_POLL_TIMEOUT {
            return Err(AppError::aws(
                "QueryTimeout",
                format!(
                    "Query exceeded {} second timeout",
                    QUERY_POLL_TIMEOUT.as_secs()
                ),
                true,
            ));
        }

        tokio::time::sleep(interval).await;
        interval = (interval * 2).min(MAX_POLL_INTERVAL);

        let resp = athena
            .get_query_execution()
            .query_execution_id(&query_execution_id)
            .send()
            .await
            .map_err(|e| sdk_err_to_app(&e))?;

        let exec = resp
            .query_execution
            .ok_or_else(|| AppError::Internal("GetQueryExecution returned no execution".into()))?;

        let state = exec
            .status
            .as_ref()
            .and_then(|s| s.state.as_ref())
            .map(|s| s.as_str())
            .unwrap_or("UNKNOWN");

        match state {
            "SUCCEEDED" => break exec,
            "FAILED" | "CANCELLED" => {
                let reason = exec
                    .status
                    .as_ref()
                    .and_then(|s| s.state_change_reason.as_deref())
                    .unwrap_or("Unknown error")
                    .to_string();
                return Err(AppError::aws("QueryFailed", reason, false));
            }
            // QUEUED | RUNNING → keep polling
            _ => {}
        }
    };

    let query_ms = poll_start.elapsed().as_millis() as u64;

    // Read bytes scanned from statistics.
    let data_scanned_bytes = execution
        .statistics
        .as_ref()
        .and_then(|s| s.data_scanned_in_bytes)
        .unwrap_or(0);

    // Read statement type.
    let statement_type = execution
        .statement_type
        .as_ref()
        .map(|t| t.as_str().to_string())
        .unwrap_or_else(|| "DML".to_string());

    // --- GetQueryResults ---
    // Fetch the result set metadata first from one call.
    let first_page = athena
        .get_query_results()
        .query_execution_id(&query_execution_id)
        .max_results(1000)
        .send()
        .await
        .map_err(|e| sdk_err_to_app(&e))?;

    // Extract column metadata.
    let col_infos: Vec<ColumnInfo> = first_page
        .result_set()
        .and_then(|rs| rs.result_set_metadata())
        .map(|meta| {
            meta.column_info()
                .iter()
                .map(|ci| ColumnInfo {
                    name: ci.name().to_string(),
                    ty: ci.r#type().to_string(),
                })
                .collect()
        })
        .unwrap_or_default();

    // Check whether there's a result set (DDL/DML with no result set have 0 columns).
    if col_infos.is_empty() && statement_type != "DQL" {
        // Non-SELECT or DDL: return Succeeded.
        return Ok(RunSqlResult::Succeeded {
            statement_type,
            query_ms,
            data_scanned_bytes,
        });
    }

    // --- Collect rows across pages ---
    let col_names: Vec<String> = col_infos.iter().map(|c| c.name.clone()).collect();
    let col_types: Vec<String> = col_infos.iter().map(|c| c.ty.clone()).collect();

    let mut all_rows: Vec<Vec<JsonValue>> = Vec::new();
    let mut budget_reached = false;
    // One more than the effective cap — the extra row lets us tell "exactly
    // at the cap" apart from "truncated" without another round trip.
    let budget = row_cap::fetch_budget(cap) as usize;

    // Process first page rows.
    process_page_rows(
        first_page.result_set().map(|rs| rs.rows()).unwrap_or(&[]),
        &col_names,
        &col_types,
        &mut all_rows,
        &mut budget_reached,
        true, // first page: may have header row
        budget,
    );

    // Fetch subsequent pages if needed and not yet at budget.
    let mut next_token: Option<String> = first_page.next_token().map(str::to_string);
    while !budget_reached && next_token.is_some() {
        let page = athena
            .get_query_results()
            .query_execution_id(&query_execution_id)
            .max_results(1000)
            .set_next_token(next_token)
            .send()
            .await
            .map_err(|e| sdk_err_to_app(&e))?;

        process_page_rows(
            page.result_set().map(|rs| rs.rows()).unwrap_or(&[]),
            &col_names,
            &col_types,
            &mut all_rows,
            &mut budget_reached,
            false,
            budget,
        );

        next_token = page.next_token().map(str::to_string);
    }

    let truncated = all_rows.len() as u64 > cap;
    if truncated {
        all_rows.truncate(cap as usize);
    }

    Ok(RunSqlResult::Rows {
        columns: col_infos,
        rows: all_rows,
        query_ms,
        truncated,
        data_scanned_bytes,
        row_cap: cap,
        row_cap_source: cap_source,
    })
}

/// Process a page of `Row` values into `all_rows`, detecting and dropping the
/// header row on the first page. Stops accumulating once `budget` rows have
/// been collected, setting `budget_reached` — the caller derives the real
/// `truncated` flag (and trims back down to the effective cap) once all
/// pages have been visited, since `budget` is deliberately one row past the
/// cap (see [`row_cap::fetch_budget`]).
fn process_page_rows(
    rows: &[aws_sdk_athena::types::Row],
    col_names: &[String],
    col_types: &[String],
    all_rows: &mut Vec<Vec<JsonValue>>,
    budget_reached: &mut bool,
    is_first_page: bool,
    budget: usize,
) {
    let mut skip_first = false;

    if is_first_page && !rows.is_empty() {
        // Check if the first row is a header row (values match column names).
        let first = &rows[0];
        let is_header = first
            .data()
            .iter()
            .zip(col_names.iter())
            .all(|(datum, name)| datum.var_char_value() == Some(name.as_str()));
        if is_header {
            skip_first = true;
        }
    }

    for (i, row) in rows.iter().enumerate() {
        if is_first_page && skip_first && i == 0 {
            continue;
        }
        if all_rows.len() >= budget {
            *budget_reached = true;
            return;
        }
        let cells: Vec<JsonValue> = row
            .data()
            .iter()
            .zip(col_types.iter())
            .map(|(datum, ty)| coerce_cell(datum.var_char_value(), ty))
            .collect();
        all_rows.push(cells);
    }
}

// ---------------------------------------------------------------------------
// athena_run_sql Tauri command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn athena_run_sql(
    app: AppHandle,
    registry: State<'_, AthenaClientRegistry>,
    id: Uuid,
    sql: String,
    origin: Option<Origin>,
) -> AppResult<RunSqlResult> {
    let started = Instant::now();
    let activity_origin = origin.unwrap_or(Origin::User);

    let acquired = registry.acquire(&id).await?;

    // Read-only gate BEFORE StartQueryExecution.
    if acquired.read_only && is_mutating_sql(&sql) {
        let err = AppError::Validation("connection is read-only".into());
        let duration_ms = started.elapsed().as_millis() as u64;
        emit_activity(
            &app,
            ActivityLogEntryBuilder::new(ActivityKind::RunSql, activity_origin, duration_ms)
                .connection(id)
                .sql(&sql)
                .err(&err),
        );
        return Err(err);
    }

    let row_cap = resolve_cap(&app, &sql);

    let result = run_athena_query(
        &app,
        id,
        &acquired.athena,
        &acquired.workgroup,
        acquired.output_location.as_deref(),
        &sql,
        row_cap,
    )
    .await;

    let duration_ms = started.elapsed().as_millis() as u64;

    let builder = ActivityLogEntryBuilder::new(ActivityKind::RunSql, activity_origin, duration_ms)
        .connection(id)
        .sql(&sql);

    match &result {
        Ok(RunSqlResult::Rows { rows, .. }) => {
            emit_activity(
                &app,
                builder.ok(Some(Metric::Items {
                    value: rows.len() as u32,
                })),
            );
        }
        Ok(RunSqlResult::Succeeded { .. }) => {
            emit_activity(&app, builder.ok(Some(Metric::Items { value: 0 })));
        }
        Err(e) => {
            emit_activity(&app, builder.err(e));
        }
    }

    result
}

// ---------------------------------------------------------------------------
// athena_run_sql_many Tauri command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn athena_run_sql_many(
    app: AppHandle,
    registry: State<'_, AthenaClientRegistry>,
    id: Uuid,
    statements: Vec<String>,
    origin: Option<Origin>,
) -> AppResult<MultiSqlResult> {
    use crate::modules::mysql::sql::split_statements;

    let started = Instant::now();
    let activity_origin = origin.unwrap_or(Origin::User);

    let acquired = registry.acquire(&id).await?;

    // Split if a single raw SQL string is passed.
    let stmts: Vec<String> = if statements.len() == 1 {
        match split_statements(&statements[0]) {
            Ok(v) => v,
            Err(e) => return Err(e),
        }
    } else {
        statements
    };

    let mut outcomes: Vec<StatementOutcome> = Vec::with_capacity(stmts.len());
    let mut errored = false;

    for (idx, stmt) in stmts.iter().enumerate() {
        if errored {
            outcomes.push(StatementOutcome::Skipped {
                index: idx,
                sql: stmt.clone(),
            });
            continue;
        }

        // Read-only gate per-statement.
        if acquired.read_only && is_mutating_sql(stmt) {
            outcomes.push(StatementOutcome::Err {
                index: idx,
                sql: stmt.clone(),
                error: StatementError {
                    message: "connection is read-only".into(),
                    code: None,
                },
            });
            errored = true;
            continue;
        }

        let row_cap = resolve_cap(&app, stmt);

        let stmt_result = run_athena_query(
            &app,
            id,
            &acquired.athena,
            &acquired.workgroup,
            acquired.output_location.as_deref(),
            stmt,
            row_cap,
        )
        .await;

        match stmt_result {
            Ok(result) => {
                outcomes.push(StatementOutcome::Ok {
                    index: idx,
                    sql: stmt.clone(),
                    result,
                });
            }
            Err(e) => {
                outcomes.push(StatementOutcome::Err {
                    index: idx,
                    sql: stmt.clone(),
                    error: StatementError::from_app(&e),
                });
                errored = true;
            }
        }
    }

    let duration_ms = started.elapsed().as_millis() as u64;
    let joined_sql = stmts.join(";\n");

    let builder =
        ActivityLogEntryBuilder::new(ActivityKind::RunSqlMany, activity_origin, duration_ms)
            .connection(id)
            .sql(&joined_sql);

    if errored {
        let err = AppError::aws("BatchFailed", "one or more statements failed", false);
        emit_activity(&app, builder.err(&err));
    } else {
        emit_activity(&app, builder.ok(None));
    }

    Ok(MultiSqlResult { outcomes })
}

// ---------------------------------------------------------------------------
// athena_cancel_query Tauri command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn athena_cancel_query(
    registry: State<'_, AthenaClientRegistry>,
    id: Uuid,
    query_execution_id: String,
) -> AppResult<()> {
    let acquired = registry.acquire(&id).await?;
    acquired
        .athena
        .stop_query_execution()
        .query_execution_id(&query_execution_id)
        .send()
        .await
        .map_err(|e| sdk_err_to_app(&e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Unit tests — coercion + header-row drop (pure, no AWS calls)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---- coerce_cell ----

    #[test]
    fn coerce_null_cell() {
        assert_eq!(coerce_cell(None, "varchar"), JsonValue::Null);
    }

    #[test]
    fn coerce_integer_cell() {
        assert_eq!(
            coerce_cell(Some("42"), "integer"),
            JsonValue::Number(42.into())
        );
    }

    #[test]
    fn coerce_bigint_cell() {
        assert_eq!(
            coerce_cell(Some("9999999999"), "bigint"),
            JsonValue::Number(9_999_999_999i64.into())
        );
    }

    #[test]
    fn coerce_double_cell() {
        let v = coerce_cell(Some("2.5"), "double");
        match v {
            JsonValue::Number(n) => {
                let f = n.as_f64().unwrap();
                assert!((f - 2.5_f64).abs() < 1e-10);
            }
            other => panic!("expected number, got {other:?}"),
        }
    }

    #[test]
    fn coerce_decimal_cell() {
        let v = coerce_cell(Some("1.23"), "decimal(10,2)");
        match &v {
            JsonValue::Number(_) => {}
            other => panic!("expected number for decimal, got {other:?}"),
        }
    }

    #[test]
    fn coerce_boolean_true() {
        assert_eq!(coerce_cell(Some("true"), "boolean"), JsonValue::Bool(true));
    }

    #[test]
    fn coerce_boolean_false() {
        assert_eq!(
            coerce_cell(Some("false"), "boolean"),
            JsonValue::Bool(false)
        );
    }

    #[test]
    fn coerce_varchar_cell() {
        assert_eq!(
            coerce_cell(Some("hello"), "varchar"),
            JsonValue::String("hello".into())
        );
    }

    #[test]
    fn coerce_date_cell_is_string() {
        assert_eq!(
            coerce_cell(Some("2024-01-15"), "date"),
            JsonValue::String("2024-01-15".into())
        );
    }

    #[test]
    fn coerce_unknown_type_is_string() {
        assert_eq!(
            coerce_cell(Some("blob_data"), "varbinary"),
            JsonValue::String("blob_data".into())
        );
    }

    // ---- process_page_rows + header-drop ----

    fn make_row(values: &[&str]) -> aws_sdk_athena::types::Row {
        let data: Vec<aws_sdk_athena::types::Datum> = values
            .iter()
            .map(|v| {
                aws_sdk_athena::types::Datum::builder()
                    .var_char_value(v.to_string())
                    .build()
            })
            .collect();
        aws_sdk_athena::types::Row::builder()
            .set_data(Some(data))
            .build()
    }

    #[test]
    fn header_row_is_dropped_on_first_page() {
        let col_names = vec!["id".to_string(), "name".to_string()];
        let col_types = vec!["integer".to_string(), "varchar".to_string()];

        // First row: header (column names as values).
        // Second row: real data.
        let rows = vec![
            make_row(&["id", "name"]), // header
            make_row(&["1", "Alice"]), // data
            make_row(&["2", "Bob"]),   // data
        ];

        let mut all_rows: Vec<Vec<JsonValue>> = Vec::new();
        let mut budget_reached = false;

        process_page_rows(
            &rows,
            &col_names,
            &col_types,
            &mut all_rows,
            &mut budget_reached,
            true,
            usize::MAX,
        );

        assert_eq!(all_rows.len(), 2, "header should be dropped");
        assert_eq!(all_rows[0][0], JsonValue::Number(1.into()));
        assert_eq!(all_rows[0][1], JsonValue::String("Alice".into()));
        assert_eq!(all_rows[1][0], JsonValue::Number(2.into()));
        assert!(!budget_reached);
    }

    #[test]
    fn no_header_drop_on_subsequent_pages() {
        let col_names = vec!["id".to_string()];
        let col_types = vec!["integer".to_string()];

        // Rows that look like a header but are on page 2.
        let rows = vec![make_row(&["id"]), make_row(&["3"])];

        let mut all_rows: Vec<Vec<JsonValue>> = Vec::new();
        let mut budget_reached = false;

        process_page_rows(
            &rows,
            &col_names,
            &col_types,
            &mut all_rows,
            &mut budget_reached,
            false,
            usize::MAX,
        );

        // Both rows should be kept since it's not the first page.
        assert_eq!(all_rows.len(), 2);
    }

    #[test]
    fn process_page_rows_stops_at_budget() {
        // Budget already reached before this page is processed.
        let col_names = vec!["x".to_string()];
        let col_types = vec!["integer".to_string()];

        let mut all_rows: Vec<Vec<JsonValue>> = vec![vec![]; 10_001];
        let mut budget_reached = false;

        let rows = vec![make_row(&["1"])];
        process_page_rows(
            &rows,
            &col_names,
            &col_types,
            &mut all_rows,
            &mut budget_reached,
            false,
            10_001,
        );

        assert!(budget_reached);
        assert_eq!(all_rows.len(), 10_001, "no extra row past budget accepted");
    }

    #[test]
    fn non_header_first_row_is_not_dropped() {
        let col_names = vec!["id".to_string(), "val".to_string()];
        let col_types = vec!["integer".to_string(), "varchar".to_string()];

        // First row is NOT a header (different values).
        let rows = vec![make_row(&["100", "something"]), make_row(&["200", "other"])];

        let mut all_rows: Vec<Vec<JsonValue>> = Vec::new();
        let mut budget_reached = false;

        process_page_rows(
            &rows,
            &col_names,
            &col_types,
            &mut all_rows,
            &mut budget_reached,
            true,
            usize::MAX,
        );

        assert_eq!(all_rows.len(), 2, "no row should be dropped");
    }

    // ---- accumulation → truncated semantics (accumulate to fetch_budget,
    // return at most cap, truncated = accumulated > cap) ----

    /// Simulates the accumulate-then-trim logic in `run_athena_query`
    /// directly against `process_page_rows`, without any AWS calls: build
    /// `total` synthetic rows across pages of `page_size`, honouring
    /// `row_cap::fetch_budget(cap)`, then apply the same post-loop truncation
    /// rule the real function does.
    fn simulate_pagination(total: usize, cap: u64, page_size: usize) -> (usize, bool) {
        let col_names = vec!["x".to_string()];
        let col_types = vec!["integer".to_string()];
        let budget = row_cap::fetch_budget(cap) as usize;

        let mut all_rows: Vec<Vec<JsonValue>> = Vec::new();
        let mut budget_reached = false;
        let mut remaining = total;
        let mut is_first_page = true;

        while !budget_reached && remaining > 0 {
            let this_page = remaining.min(page_size);
            let rows: Vec<aws_sdk_athena::types::Row> =
                (0..this_page).map(|_| make_row(&["1"])).collect();
            process_page_rows(
                &rows,
                &col_names,
                &col_types,
                &mut all_rows,
                &mut budget_reached,
                is_first_page,
                budget,
            );
            is_first_page = false;
            remaining -= this_page;
        }

        let truncated = all_rows.len() as u64 > cap;
        if truncated {
            all_rows.truncate(cap as usize);
        }
        (all_rows.len(), truncated)
    }

    #[test]
    fn accumulation_exactly_at_cap_is_not_truncated() {
        let (len, truncated) = simulate_pagination(10_000, 10_000, 1_000);
        assert_eq!(len, 10_000);
        assert!(!truncated, "landing exactly on the cap must not truncate");
    }

    #[test]
    fn accumulation_one_over_cap_is_truncated() {
        let (len, truncated) = simulate_pagination(10_001, 10_000, 1_000);
        assert_eq!(len, 10_000, "returned rows must not exceed the cap");
        assert!(truncated);
    }

    #[test]
    fn accumulation_far_over_cap_is_truncated_and_bounded() {
        let (len, truncated) = simulate_pagination(50_000, 10_000, 1_000);
        assert_eq!(len, 10_000);
        assert!(truncated);
    }

    // ---- cap resolution ----

    #[test]
    fn cap_resolution_unbounded_query_uses_configured() {
        assert_eq!(
            resolve_cap_from(10_000, "SELECT * FROM big_table"),
            (10_000, RowCapSource::Setting)
        );
    }

    #[test]
    fn cap_resolution_explicit_limit_raises_cap() {
        assert_eq!(
            resolve_cap_from(10_000, "SELECT * FROM events LIMIT 30000"),
            (30_000, RowCapSource::Setting)
        );
    }

    #[test]
    fn cap_resolution_limit_all_does_not_raise_cap() {
        assert_eq!(
            resolve_cap_from(10_000, "SELECT * FROM events LIMIT ALL"),
            (10_000, RowCapSource::Setting)
        );
    }

    #[test]
    fn cap_resolution_beyond_hard_ceiling_clamps() {
        assert_eq!(
            resolve_cap_from(10_000, "SELECT * FROM events LIMIT 5000000"),
            (row_cap::HARD_ROW_CAP, RowCapSource::HardCeiling)
        );
    }

    // ---- serialization ----

    #[test]
    fn run_sql_result_serializes_row_cap_fields() {
        let r = RunSqlResult::Rows {
            columns: vec![],
            rows: vec![],
            query_ms: 5,
            truncated: false,
            data_scanned_bytes: 0,
            row_cap: 10_000,
            row_cap_source: RowCapSource::Setting,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v.get("kind").unwrap(), "rows");
        assert_eq!(v.get("row_cap").unwrap(), 10_000);
        assert_eq!(v.get("row_cap_source").unwrap(), "setting");
    }
}
