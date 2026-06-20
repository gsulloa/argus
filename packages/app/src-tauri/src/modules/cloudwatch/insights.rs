//! CloudWatch Logs Insights execution.
//!
//! Implements the StartQuery → poll GetQueryResults → terminal state lifecycle,
//! mirroring the Athena sql.rs Start → poll → fetch pattern.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use regex::Regex;
use serde::Serialize;
use serde_json::Value as JsonValue;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::cloudwatch::client::CloudwatchClientRegistry;
use crate::modules::cloudwatch::errors::sdk_err_to_app;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum rows accumulated per query (matches frontend expectation).
const RESULT_ROW_CAP: usize = 10_000;

/// Total polling timeout per query.
const QUERY_POLL_TIMEOUT: Duration = Duration::from_secs(300); // 5 minutes

/// Initial polling interval; doubles up to MAX_POLL_INTERVAL.
const INITIAL_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Maximum polling interval.
const MAX_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Event emitted after StartQuery to enable frontend cancellation.
const QUERY_STARTED_EVENT: &str = "cloudwatch:query-started";

// ---------------------------------------------------------------------------
// 4.1 — Result envelope
// ---------------------------------------------------------------------------

/// Column metadata returned to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
}

/// Result from a successful Insights query.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InsightsResult {
    Rows {
        columns: Vec<ColumnInfo>,
        rows: Vec<Vec<JsonValue>>,
        query_ms: u64,
        truncated: bool,
        records_matched: f64,
        records_scanned: f64,
        bytes_scanned: f64,
    },
}

// ---------------------------------------------------------------------------
// 4.3 — Dynamic column building helpers (pure, testable without AWS)
// ---------------------------------------------------------------------------

/// Synthetic field names that always appear first/last in the column order.
const SYNTHETIC_FIRST: &[&str] = &["@timestamp", "@message"];
const SYNTHETIC_LAST: &[&str] = &["@ptr"];

/// Build the ordered column list from all field names returned across rows.
///
/// Order: `@timestamp`, `@message`, … user fields (first-appearance order) …, `@ptr`.
/// All types are "string" per the CloudWatch Logs Insights API contract.
pub fn build_column_order(all_field_names: &[&str]) -> Vec<String> {
    let mut first_cols: Vec<String> = Vec::new();
    let mut middle_cols: Vec<String> = Vec::new();
    let mut last_cols: Vec<String> = Vec::new();

    // Collect all names in first-appearance order (deduped).
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut ordered: Vec<&str> = Vec::new();
    for name in all_field_names {
        if seen.insert(name) {
            ordered.push(name);
        }
    }

    // Partition by synthetic-first, synthetic-last, user.
    let synthetic_first_set: std::collections::HashSet<&str> =
        SYNTHETIC_FIRST.iter().copied().collect();
    let synthetic_last_set: std::collections::HashSet<&str> =
        SYNTHETIC_LAST.iter().copied().collect();

    // Add synthetic-first in canonical order (if present in the data).
    for name in SYNTHETIC_FIRST {
        if seen.contains(name) {
            first_cols.push(name.to_string());
        }
    }

    // User fields: everything not synthetic.
    for name in &ordered {
        if !synthetic_first_set.contains(name) && !synthetic_last_set.contains(name) {
            middle_cols.push(name.to_string());
        }
    }

    // Synthetic-last in canonical order (if present).
    for name in SYNTHETIC_LAST {
        if seen.contains(name) {
            last_cols.push(name.to_string());
        }
    }

    first_cols.extend(middle_cols);
    first_cols.extend(last_cols);
    first_cols
}

/// Project a single row (map of field name → string value) onto the column order.
/// Missing fields become `null`; present fields become JSON strings.
pub fn project_row(
    fields: &std::collections::HashMap<String, String>,
    column_order: &[String],
) -> Vec<JsonValue> {
    column_order
        .iter()
        .map(|col| {
            fields
                .get(col)
                .map(|v| JsonValue::String(v.clone()))
                .unwrap_or(JsonValue::Null)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 4.2 — Core lifecycle (internal, not a Tauri command)
// ---------------------------------------------------------------------------

/// Whether the Insights query string already contains a `limit` command
/// (e.g. `… | limit 100` or a leading `limit 5`). When it does, we must NOT
/// send a `StartQuery` `limit` parameter, because that parameter overrides the
/// query's own limit. Case-insensitive; matches `limit` at the start of the
/// query or right after a pipe, followed by a number.
fn has_limit_command(query: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE
        .get_or_init(|| Regex::new(r"(?i)(^|\|)\s*limit\s+\d").expect("valid limit-command regex"));
    re.is_match(query)
}

#[allow(clippy::too_many_arguments)]
async fn run_insights_query(
    app: &AppHandle,
    connection_id: Uuid,
    client: &aws_sdk_cloudwatchlogs::Client,
    log_group_identifiers: &[String],
    start_time: i64,
    end_time: i64,
    query_string: &str,
    limit: Option<i32>,
) -> AppResult<InsightsResult> {
    let poll_start = Instant::now();

    // --- StartQuery ---
    // Only set the `limit` parameter when the query has no `limit` command of
    // its own; otherwise the parameter would override the user's `| limit N`.
    let mut req = client
        .start_query()
        .start_time(start_time)
        .end_time(end_time)
        .query_string(query_string)
        .set_limit(limit);

    for group in log_group_identifiers {
        req = req.log_group_identifiers(group);
    }

    let start_resp = req.send().await.map_err(|e| sdk_err_to_app(&e))?;

    let query_id = start_resp
        .query_id
        .ok_or_else(|| AppError::Internal("CloudWatch did not return a query_id".into()))?;

    // Notify frontend so it can cancel if needed.
    let _ = app.emit(
        QUERY_STARTED_EVENT,
        serde_json::json!({
            "connection_id": connection_id.to_string(),
            "query_id": query_id,
        }),
    );

    // --- Poll GetQueryResults ---
    let mut interval = INITIAL_POLL_INTERVAL;

    loop {
        if poll_start.elapsed() >= QUERY_POLL_TIMEOUT {
            return Err(AppError::aws(
                "QueryTimeout",
                format!(
                    "Insights query exceeded {} second timeout",
                    QUERY_POLL_TIMEOUT.as_secs()
                ),
                true,
            ));
        }

        tokio::time::sleep(interval).await;
        interval = (interval * 2).min(MAX_POLL_INTERVAL);

        let resp = client
            .get_query_results()
            .query_id(&query_id)
            .send()
            .await
            .map_err(|e| sdk_err_to_app(&e))?;

        let status = resp.status().map(|s| s.as_str()).unwrap_or("Unknown");

        match status {
            "Complete" => {
                let query_ms = poll_start.elapsed().as_millis() as u64;

                // Read statistics.
                let stats = resp.statistics();
                let records_matched = stats.map(|s| s.records_matched()).unwrap_or(0.0);
                let records_scanned = stats.map(|s| s.records_scanned()).unwrap_or(0.0);
                let bytes_scanned = stats.map(|s| s.bytes_scanned()).unwrap_or(0.0);

                // Collect all rows as maps + accumulate field names.
                let raw_rows: Vec<std::collections::HashMap<String, String>> = resp
                    .results()
                    .iter()
                    .map(|row| {
                        row.iter()
                            .filter_map(|field| {
                                let k = field.field().unwrap_or_default().to_string();
                                let v = field.value().unwrap_or_default().to_string();
                                if k.is_empty() {
                                    None
                                } else {
                                    Some((k, v))
                                }
                            })
                            .collect()
                    })
                    .collect();

                // Build column order from all field names (union, first-appearance).
                let mut all_names: Vec<&str> = Vec::new();
                for row in &raw_rows {
                    for key in row.keys() {
                        all_names.push(key.as_str());
                    }
                }
                let column_order = build_column_order(&all_names);

                let columns: Vec<ColumnInfo> = column_order
                    .iter()
                    .map(|name| ColumnInfo {
                        name: name.clone(),
                        ty: "string".to_string(),
                    })
                    .collect();

                // Project rows, apply row cap.
                let mut rows: Vec<Vec<JsonValue>> = Vec::new();
                let mut truncated = false;

                for row_map in &raw_rows {
                    if rows.len() >= RESULT_ROW_CAP {
                        truncated = true;
                        break;
                    }
                    rows.push(project_row(row_map, &column_order));
                }

                return Ok(InsightsResult::Rows {
                    columns,
                    rows,
                    query_ms,
                    truncated,
                    records_matched,
                    records_scanned,
                    bytes_scanned,
                });
            }
            "Failed" | "Cancelled" | "Timeout" => {
                return Err(AppError::aws(
                    status,
                    format!("Insights query ended with status: {status}"),
                    false,
                ));
            }
            // Running | Scheduled → keep polling
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// 4.4 — cloudwatch_run_insights Tauri command
// ---------------------------------------------------------------------------

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn cloudwatch_run_insights(
    app: AppHandle,
    registry: State<'_, CloudwatchClientRegistry>,
    connection_id: String,
    log_group_identifiers: Vec<String>,
    start_time: i64,
    end_time: i64,
    query_string: String,
    limit: Option<i32>,
    origin: Option<Origin>,
) -> AppResult<InsightsResult> {
    let id = Uuid::parse_str(&connection_id)
        .map_err(|e| AppError::Validation(format!("invalid uuid: {e}")))?;

    let started = Instant::now();
    let activity_origin = origin.unwrap_or(Origin::User);

    // Validate: ≥1 log group.
    if log_group_identifiers.is_empty() {
        let err = AppError::Validation("at least one log group identifier is required".into());
        let duration_ms = started.elapsed().as_millis() as u64;
        emit_activity(
            &app,
            ActivityLogEntryBuilder::new(ActivityKind::RunSql, activity_origin, duration_ms)
                .connection(id)
                .sql(&query_string)
                .err(&err),
        );
        return Err(err);
    }

    // Validate: start_time < end_time.
    if start_time >= end_time {
        let err = AppError::Validation("start_time must be less than end_time".into());
        let duration_ms = started.elapsed().as_millis() as u64;
        emit_activity(
            &app,
            ActivityLogEntryBuilder::new(ActivityKind::RunSql, activity_origin, duration_ms)
                .connection(id)
                .sql(&query_string)
                .err(&err),
        );
        return Err(err);
    }

    // Honor the query's own `| limit`: when present, send no limit param so the
    // query governs. Otherwise apply a default, capped by the client row cap.
    let effective_limit = if has_limit_command(&query_string) {
        None
    } else {
        Some(limit.unwrap_or(1000).clamp(1, RESULT_ROW_CAP as i32))
    };

    let client = registry.acquire(&id).await?;

    // Emit activity log (one, before running).
    let result = run_insights_query(
        &app,
        id,
        &client,
        &log_group_identifiers,
        start_time,
        end_time,
        &query_string,
        effective_limit,
    )
    .await;

    let duration_ms = started.elapsed().as_millis() as u64;
    let builder = ActivityLogEntryBuilder::new(ActivityKind::RunSql, activity_origin, duration_ms)
        .connection(id)
        .sql(&query_string);

    match &result {
        Ok(InsightsResult::Rows { rows, .. }) => {
            emit_activity(
                &app,
                builder.ok(Some(Metric::Items {
                    value: rows.len() as u32,
                })),
            );
        }
        Err(e) => {
            emit_activity(&app, builder.err(e));
        }
    }

    result
}

// ---------------------------------------------------------------------------
// 4.5 — cloudwatch_cancel_insights Tauri command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cloudwatch_cancel_insights(
    registry: State<'_, CloudwatchClientRegistry>,
    connection_id: String,
    query_id: String,
) -> AppResult<()> {
    let id = Uuid::parse_str(&connection_id)
        .map_err(|e| AppError::Validation(format!("invalid uuid: {e}")))?;

    let client = registry.acquire(&id).await?;

    client
        .stop_query()
        .query_id(&query_id)
        .send()
        .await
        .map_err(|e| sdk_err_to_app(&e))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// 4.6 — Unit tests for dynamic-column projection (pure, no AWS)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    // ---- build_column_order ----

    #[test]
    fn synthetic_fields_ordered_correctly() {
        let names = vec!["@ptr", "@message", "level", "@timestamp", "requestId"];
        let cols = build_column_order(&names);
        // @timestamp and @message first, then user fields, then @ptr last.
        assert_eq!(cols[0], "@timestamp");
        assert_eq!(cols[1], "@message");
        // @ptr last
        assert_eq!(cols.last().unwrap(), "@ptr");
        // user fields in first-appearance order among the remaining
        let middle: Vec<_> = cols[2..cols.len() - 1].to_vec();
        assert_eq!(middle, vec!["level", "requestId"]);
    }

    #[test]
    fn no_synthetic_fields_just_user_fields() {
        let names = vec!["level", "requestId", "duration"];
        let cols = build_column_order(&names);
        assert_eq!(cols, vec!["level", "requestId", "duration"]);
    }

    #[test]
    fn only_timestamp_and_ptr() {
        let names = vec!["@ptr", "@timestamp"];
        let cols = build_column_order(&names);
        assert_eq!(cols, vec!["@timestamp", "@ptr"]);
    }

    #[test]
    fn deduplicates_repeated_field_names() {
        let names = vec!["@timestamp", "@message", "@timestamp", "level", "@message"];
        let cols = build_column_order(&names);
        // @timestamp, @message appear only once each; no @ptr; user: level
        assert_eq!(cols, vec!["@timestamp", "@message", "level"]);
    }

    #[test]
    fn empty_field_names_returns_empty() {
        let cols = build_column_order(&[]);
        assert!(cols.is_empty());
    }

    // ---- project_row ----

    #[test]
    fn project_row_fills_missing_as_null() {
        let fields: HashMap<String, String> = [
            ("@timestamp".into(), "2024-01-15T10:00:00Z".into()),
            ("level".into(), "INFO".into()),
        ]
        .into_iter()
        .collect();

        let cols = vec![
            "@timestamp".to_string(),
            "@message".to_string(),
            "level".to_string(),
            "@ptr".to_string(),
        ];

        let row = project_row(&fields, &cols);
        assert_eq!(row[0], JsonValue::String("2024-01-15T10:00:00Z".into()));
        assert_eq!(row[1], JsonValue::Null); // @message absent
        assert_eq!(row[2], JsonValue::String("INFO".into()));
        assert_eq!(row[3], JsonValue::Null); // @ptr absent
    }

    #[test]
    fn project_row_all_present() {
        let fields: HashMap<String, String> = [
            ("@timestamp".into(), "ts".into()),
            ("@message".into(), "msg".into()),
            ("@ptr".into(), "ptr-val".into()),
        ]
        .into_iter()
        .collect();

        let cols = vec![
            "@timestamp".to_string(),
            "@message".to_string(),
            "@ptr".to_string(),
        ];

        let row = project_row(&fields, &cols);
        assert_eq!(row[0], JsonValue::String("ts".into()));
        assert_eq!(row[1], JsonValue::String("msg".into()));
        assert_eq!(row[2], JsonValue::String("ptr-val".into()));
    }

    #[test]
    fn project_row_empty_columns() {
        let fields: HashMap<String, String> =
            [("level".into(), "INFO".into())].into_iter().collect();
        let row = project_row(&fields, &[]);
        assert!(row.is_empty());
    }

    // ---- ragged field sets (different fields per row) ----

    #[test]
    fn ragged_field_sets_union_and_project() {
        // Simulate two rows with different fields:
        // Row 0: @timestamp, @message
        // Row 1: @timestamp, level, @ptr
        let row0: HashMap<String, String> = [
            ("@timestamp".into(), "t0".into()),
            ("@message".into(), "m0".into()),
        ]
        .into_iter()
        .collect();

        let row1: HashMap<String, String> = [
            ("@timestamp".into(), "t1".into()),
            ("level".into(), "INFO".into()),
            ("@ptr".into(), "p1".into()),
        ]
        .into_iter()
        .collect();

        // Collect field names as they appear across rows.
        let mut all_names: Vec<&str> = Vec::new();
        for (k, _) in &row0 {
            all_names.push(k.as_str());
        }
        for (k, _) in &row1 {
            all_names.push(k.as_str());
        }

        let cols = build_column_order(&all_names);

        // @timestamp first, @ptr last
        assert_eq!(cols[0], "@timestamp");
        assert_eq!(cols.last().unwrap(), "@ptr");
        // @message should appear after @timestamp
        let msg_idx = cols.iter().position(|c| c == "@message").unwrap();
        assert_eq!(msg_idx, 1);

        // Project both rows.
        let proj0 = project_row(&row0, &cols);
        let proj1 = project_row(&row1, &cols);

        // row0 should have level=null, @ptr=null
        let level_idx = cols.iter().position(|c| c == "level").unwrap();
        let ptr_idx = cols.iter().position(|c| c == "@ptr").unwrap();
        assert_eq!(proj0[level_idx], JsonValue::Null);
        assert_eq!(proj0[ptr_idx], JsonValue::Null);

        // row1 should have @message=null
        let msg_idx = cols.iter().position(|c| c == "@message").unwrap();
        assert_eq!(proj1[msg_idx], JsonValue::Null);
        assert_eq!(proj1[ptr_idx], JsonValue::String("p1".into()));
    }

    // ---- InsightsResult serialization shape ----

    #[test]
    fn insights_result_rows_serialization_shape() {
        let result = InsightsResult::Rows {
            columns: vec![
                ColumnInfo {
                    name: "@timestamp".into(),
                    ty: "string".into(),
                },
                ColumnInfo {
                    name: "@message".into(),
                    ty: "string".into(),
                },
            ],
            rows: vec![vec![
                JsonValue::String("2024-01-01T00:00:00Z".into()),
                JsonValue::String("hello".into()),
            ]],
            query_ms: 1234,
            truncated: false,
            records_matched: 10.0,
            records_scanned: 100.0,
            bytes_scanned: 4096.0,
        };

        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["kind"], "rows");
        assert_eq!(json["columns"][0]["name"], "@timestamp");
        assert_eq!(json["columns"][0]["type"], "string");
        assert_eq!(json["rows"][0][0], "2024-01-01T00:00:00Z");
        assert_eq!(json["query_ms"], 1234);
        assert_eq!(json["truncated"], false);
        assert_eq!(json["records_matched"], 10.0);
        assert_eq!(json["bytes_scanned"], 4096.0);
    }

    #[test]
    fn detects_limit_command() {
        // Present → true (so we skip the StartQuery limit param).
        assert!(has_limit_command("fields @timestamp, @message | limit 100"));
        assert!(has_limit_command(
            "fields @timestamp\n| sort @timestamp desc\n| limit 50"
        ));
        assert!(has_limit_command("limit 5"));
        assert!(has_limit_command("FIELDS @x | LIMIT 20")); // case-insensitive
        assert!(has_limit_command("fields @x |limit 1"));

        // Absent → false (default limit applies).
        assert!(!has_limit_command("fields @timestamp, @message"));
        assert!(!has_limit_command("stats count(*) by bin(5m)"));
        // "limit" as a bare word with no number / not after a pipe is not a command.
        assert!(!has_limit_command("filter message like /limit/"));
        assert!(!has_limit_command("fields limitValue"));
    }
}
