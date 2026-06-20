/// DynamoDB PartiQL execution: `dynamo_run_partiql` and `dynamo_run_partiql_many`.
///
/// Tasks 1.1–1.5: is_mutating_partiql helper, request/response types,
/// single-statement command with NextToken pagination, multi-statement command.
use std::collections::HashMap;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use uuid::Uuid;

use aws_sdk_dynamodb::types::ReturnConsumedCapacity;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::dynamo::client::DynamoClientRegistry;
use crate::modules::dynamo::items::{sdk_scan_err, AttrValue};

// ---------------------------------------------------------------------------
// §1.1  is_mutating_partiql — classify by first significant keyword
// ---------------------------------------------------------------------------

/// Skip leading whitespace and `--` line comments.
///
/// Returns a slice into `stmt` starting at the first non-whitespace,
/// non-comment character.
fn skip_partiql_leading(stmt: &str) -> &str {
    let bytes = stmt.as_bytes();
    let mut i = 0;
    loop {
        // Skip whitespace.
        while i < bytes.len()
            && matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r')
        {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        // `--` line comment: skip to end of line.
        if i + 1 < bytes.len() && bytes[i] == b'-' && bytes[i + 1] == b'-' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        break;
    }
    &stmt[i..]
}

/// Extract the first keyword (ASCII alpha + underscore, uppercased).
fn first_partiql_keyword(text: &str) -> String {
    let mut word = String::new();
    for c in text.chars() {
        if c.is_ascii_alphabetic() || c == '_' {
            word.push(c.to_ascii_uppercase());
        } else if word.is_empty() {
            // skip leading non-alpha (e.g. whitespace that slipped through)
        } else {
            break;
        }
    }
    word
}

/// Returns `true` if `statement` is a mutating PartiQL statement
/// (`INSERT`, `UPDATE`, or `DELETE`); returns `false` for `SELECT` and
/// anything unrecognized.
///
/// Classification is case-insensitive. Leading whitespace and `--` line
/// comments are skipped before examining the first keyword.
pub fn is_mutating_partiql(statement: &str) -> bool {
    let stripped = skip_partiql_leading(statement);
    let kw = first_partiql_keyword(stripped);
    matches!(kw.as_str(), "INSERT" | "UPDATE" | "DELETE")
}

// ---------------------------------------------------------------------------
// §1.2  Request / Response types
// ---------------------------------------------------------------------------

/// IPC request for `dynamo.runPartiql`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PartiQLRequest {
    pub connection_id: Uuid,
    pub statement: String,
    pub origin: Option<Origin>,
}

/// IPC request for `dynamo.runPartiqlMany`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PartiQLManyRequest {
    pub connection_id: Uuid,
    pub statements: Vec<String>,
    pub origin: Option<Origin>,
}

/// Tagged result envelope returned by `dynamo_run_partiql`.
///
/// Wire shape (serde tag `"kind"`):
/// - `{ "kind": "rows", "items": [...], "count": n, "query_ms": n, "truncated": bool, "consumed_capacity": ... }`
/// - `{ "kind": "succeeded", "statement_type": "INSERT"|"UPDATE"|"DELETE", "query_ms": n, "consumed_capacity": ... }`
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RunPartiQLResult {
    Rows {
        items: Vec<HashMap<String, AttrValue>>,
        count: usize,
        query_ms: u64,
        truncated: bool,
        consumed_capacity: Option<serde_json::Value>,
    },
    Succeeded {
        statement_type: String,
        query_ms: u64,
        consumed_capacity: Option<serde_json::Value>,
    },
}

/// Per-statement error envelope for multi-statement runs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
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

/// Per-statement outcome in a multi-statement run.
///
/// Wire shape (serde tag `"outcome"`):
/// - `{ "outcome": "ok", "index": n, "statement": "...", "result": {...} }`
/// - `{ "outcome": "err", "index": n, "statement": "...", "error": {...} }`
/// - `{ "outcome": "skipped", "index": n, "statement": "..." }`
#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum StatementOutcome {
    Ok {
        index: usize,
        statement: String,
        result: RunPartiQLResult,
    },
    Err {
        index: usize,
        statement: String,
        error: StatementError,
    },
    Skipped {
        index: usize,
        statement: String,
    },
}

/// Envelope returned by `dynamo_run_partiql_many`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct MultiPartiQLResult {
    pub outcomes: Vec<StatementOutcome>,
}

// ---------------------------------------------------------------------------
// §1.3 + 1.4  Internal: run a single statement with NextToken pagination
// ---------------------------------------------------------------------------

/// Maximum items accumulated across all ExecuteStatement pages — mirrors Athena.
const RESULT_ROW_CAP: usize = 10_000;

/// Run a single PartiQL statement via `ExecuteStatement`, paging through
/// `NextToken` up to `RESULT_ROW_CAP` items.
///
/// The read-only gate MUST be enforced by the caller before invoking this.
async fn run_partiql_statement(
    client: &aws_sdk_dynamodb::Client,
    statement: &str,
) -> AppResult<RunPartiQLResult> {
    let started = Instant::now();
    let mutating = is_mutating_partiql(statement);

    let mut items: Vec<HashMap<String, AttrValue>> = Vec::new();
    let mut truncated = false;
    let mut next_token: Option<String> = None;

    // Aggregate consumed capacity (sum CapacityUnits across pages).
    let mut total_capacity: Option<f64> = None;

    loop {
        let mut req = client
            .execute_statement()
            .statement(statement)
            .return_consumed_capacity(ReturnConsumedCapacity::Total);

        if let Some(ref tok) = next_token {
            req = req.next_token(tok);
        }

        let resp = req.send().await.map_err(|e| sdk_scan_err(&e))?;

        // Aggregate consumed capacity (sum across pages).
        if let Some(cc) = resp.consumed_capacity() {
            if let Some(units) = cc.capacity_units() {
                let prev = total_capacity.unwrap_or(0.0);
                total_capacity = Some(prev + units);
            }
        }

        // Collect items.
        for raw_item in resp.items() {
            if items.len() >= RESULT_ROW_CAP {
                truncated = true;
                break;
            }
            let mapped: HashMap<String, AttrValue> = raw_item
                .iter()
                .map(|(k, v)| (k.clone(), AttrValue::from(v.clone())))
                .collect();
            items.push(mapped);
        }

        if truncated {
            break;
        }

        next_token = resp.next_token().map(str::to_string);
        if next_token.is_none() {
            break;
        }
    }

    let query_ms = started.elapsed().as_millis() as u64;

    // Serialize consumed capacity as a simple JSON value.
    let consumed_capacity = total_capacity.map(|units| serde_json::json!({ "capacity_units": units }));

    if mutating {
        let stmt_type = first_partiql_keyword(skip_partiql_leading(statement));
        Ok(RunPartiQLResult::Succeeded {
            statement_type: stmt_type,
            query_ms,
            consumed_capacity,
        })
    } else {
        let count = items.len();
        Ok(RunPartiQLResult::Rows {
            items,
            count,
            query_ms,
            truncated,
            consumed_capacity,
        })
    }
}

// ---------------------------------------------------------------------------
// §1.3  dynamo_run_partiql Tauri command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn dynamo_run_partiql(
    app: AppHandle,
    registry: State<'_, DynamoClientRegistry>,
    req: PartiQLRequest,
) -> AppResult<RunPartiQLResult> {
    let origin = req.origin.unwrap_or_default();
    let started = Instant::now();

    // Acquire the client first so we can check read_only.
    // We use snapshot() to read read_only without holding the lock through
    // the async AWS call.
    let snapshot = match registry.snapshot(&req.connection_id).await {
        Some(s) => s,
        None => {
            let e = AppError::NotFound(format!(
                "dynamo client {} not active",
                req.connection_id
            ));
            let duration_ms = started.elapsed().as_millis() as u64;
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::RunSql, origin, duration_ms)
                    .connection(req.connection_id)
                    .sql(&req.statement)
                    .err(&e),
            );
            return Err(e);
        }
    };

    // Read-only gate BEFORE any AWS call.
    if snapshot.read_only && is_mutating_partiql(&req.statement) {
        let e = AppError::Validation("connection is read-only".into());
        let duration_ms = started.elapsed().as_millis() as u64;
        emit_activity(
            &app,
            ActivityLogEntryBuilder::new(ActivityKind::RunSql, origin, duration_ms)
                .connection(req.connection_id)
                .sql(&req.statement)
                .err(&e),
        );
        return Err(e);
    }

    // Acquire the actual DynamoDB client.
    let client = match registry.acquire(&req.connection_id).await {
        Ok(c) => c,
        Err(e) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::RunSql, origin, duration_ms)
                    .connection(req.connection_id)
                    .sql(&req.statement)
                    .err(&e),
            );
            return Err(e);
        }
    };

    let result = run_partiql_statement(&client, &req.statement).await;
    let duration_ms = started.elapsed().as_millis() as u64;

    let builder = ActivityLogEntryBuilder::new(ActivityKind::RunSql, origin, duration_ms)
        .connection(req.connection_id)
        .sql(&req.statement);

    match &result {
        Ok(RunPartiQLResult::Rows { count, .. }) => {
            emit_activity(
                &app,
                builder.ok(Some(Metric::Items {
                    value: *count as u32,
                })),
            );
        }
        Ok(RunPartiQLResult::Succeeded { .. }) => {
            emit_activity(&app, builder.ok(Some(Metric::Items { value: 0 })));
        }
        Err(e) => {
            emit_activity(&app, builder.err(e));
        }
    }

    result
}

// ---------------------------------------------------------------------------
// §1.5  dynamo_run_partiql_many Tauri command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn dynamo_run_partiql_many(
    app: AppHandle,
    registry: State<'_, DynamoClientRegistry>,
    req: PartiQLManyRequest,
) -> AppResult<MultiPartiQLResult> {
    let origin = req.origin.unwrap_or_default();
    let started = Instant::now();

    // Acquire snapshot for read_only check.
    let snapshot = match registry.snapshot(&req.connection_id).await {
        Some(s) => s,
        None => {
            let e = AppError::NotFound(format!(
                "dynamo client {} not active",
                req.connection_id
            ));
            let duration_ms = started.elapsed().as_millis() as u64;
            let joined = req.statements.join(";\n");
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::RunSqlMany, origin, duration_ms)
                    .connection(req.connection_id)
                    .sql(&joined)
                    .err(&e),
            );
            return Err(e);
        }
    };

    // Acquire the actual DynamoDB client.
    let client = match registry.acquire(&req.connection_id).await {
        Ok(c) => c,
        Err(e) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            let joined = req.statements.join(";\n");
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::RunSqlMany, origin, duration_ms)
                    .connection(req.connection_id)
                    .sql(&joined)
                    .err(&e),
            );
            return Err(e);
        }
    };

    let mut outcomes: Vec<StatementOutcome> = Vec::with_capacity(req.statements.len());
    let mut errored = false;

    for (idx, stmt) in req.statements.iter().enumerate() {
        if errored {
            outcomes.push(StatementOutcome::Skipped {
                index: idx,
                statement: stmt.clone(),
            });
            continue;
        }

        // Read-only gate per statement.
        if snapshot.read_only && is_mutating_partiql(stmt) {
            outcomes.push(StatementOutcome::Err {
                index: idx,
                statement: stmt.clone(),
                error: StatementError {
                    message: "connection is read-only".into(),
                    code: None,
                },
            });
            errored = true;
            continue;
        }

        match run_partiql_statement(&client, stmt).await {
            Ok(result) => {
                outcomes.push(StatementOutcome::Ok {
                    index: idx,
                    statement: stmt.clone(),
                    result,
                });
            }
            Err(e) => {
                outcomes.push(StatementOutcome::Err {
                    index: idx,
                    statement: stmt.clone(),
                    error: StatementError::from_app(&e),
                });
                errored = true;
            }
        }
    }

    let duration_ms = started.elapsed().as_millis() as u64;
    let joined_sql = req.statements.join(";\n");

    let builder =
        ActivityLogEntryBuilder::new(ActivityKind::RunSqlMany, origin, duration_ms)
            .connection(req.connection_id)
            .sql(&joined_sql);

    if errored {
        let err = AppError::aws("BatchFailed", "one or more statements failed", false);
        emit_activity(&app, builder.err(&err));
    } else {
        emit_activity(&app, builder.ok(None));
    }

    Ok(MultiPartiQLResult { outcomes })
}

// ---------------------------------------------------------------------------
// §1.1  Unit tests for is_mutating_partiql
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---- SELECT is never mutating ----

    #[test]
    fn select_is_not_mutating() {
        assert!(!is_mutating_partiql("SELECT * FROM \"events\""));
    }

    #[test]
    fn select_lowercase_is_not_mutating() {
        assert!(!is_mutating_partiql("select * from \"events\""));
    }

    #[test]
    fn select_mixed_case_is_not_mutating() {
        assert!(!is_mutating_partiql("Select * FROM \"t\""));
    }

    #[test]
    fn select_with_leading_whitespace_is_not_mutating() {
        assert!(!is_mutating_partiql("  \t  select * from \"t\""));
    }

    #[test]
    fn select_after_line_comment_is_not_mutating() {
        assert!(!is_mutating_partiql(
            "-- find all events\nSELECT * FROM \"events\""
        ));
    }

    #[test]
    fn select_after_multiple_comments_and_whitespace_is_not_mutating() {
        assert!(!is_mutating_partiql(
            "  -- first comment\n  -- second comment\n  SELECT 1"
        ));
    }

    // ---- INSERT is mutating ----

    #[test]
    fn insert_is_mutating() {
        assert!(is_mutating_partiql(
            "INSERT INTO \"events\" VALUE {'id': 'e_1'}"
        ));
    }

    #[test]
    fn insert_lowercase_is_mutating() {
        assert!(is_mutating_partiql("insert into \"t\" value {'k': 'v'}"));
    }

    #[test]
    fn insert_with_leading_whitespace_is_mutating() {
        assert!(is_mutating_partiql("  INSERT INTO \"t\" VALUE {'k': 'v'}"));
    }

    // ---- UPDATE is mutating ----

    #[test]
    fn update_is_mutating() {
        assert!(is_mutating_partiql(
            "UPDATE \"events\" SET a = 1 WHERE id = 'e_1'"
        ));
    }

    #[test]
    fn update_lowercase_is_mutating() {
        assert!(is_mutating_partiql("update \"t\" set a = 1 WHERE k = 'x'"));
    }

    // ---- DELETE is mutating ----

    #[test]
    fn delete_is_mutating() {
        assert!(is_mutating_partiql(
            "DELETE FROM \"events\" WHERE id = 'e_1'"
        ));
    }

    #[test]
    fn delete_lowercase_is_mutating() {
        assert!(is_mutating_partiql("delete from \"t\" where k = 'v'"));
    }

    #[test]
    fn delete_after_comment_is_mutating() {
        assert!(is_mutating_partiql(
            "-- remove old record\nDELETE FROM \"events\" WHERE id = 'e_1'"
        ));
    }

    // ---- Edge cases ----

    #[test]
    fn empty_string_is_not_mutating() {
        assert!(!is_mutating_partiql(""));
    }

    #[test]
    fn whitespace_only_is_not_mutating() {
        assert!(!is_mutating_partiql("   \t\n  "));
    }

    #[test]
    fn comment_only_is_not_mutating() {
        assert!(!is_mutating_partiql("-- just a comment\n"));
    }

    // ---- Wire shape tests ----

    #[test]
    fn run_partiql_result_rows_serializes_with_kind_tag() {
        let result = RunPartiQLResult::Rows {
            items: vec![],
            count: 0,
            query_ms: 42,
            truncated: false,
            consumed_capacity: None,
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["kind"], "rows");
        assert_eq!(v["count"], 0);
        assert_eq!(v["query_ms"], 42);
        assert_eq!(v["truncated"], false);
        assert!(v["consumed_capacity"].is_null());
    }

    #[test]
    fn run_partiql_result_succeeded_serializes_with_kind_tag() {
        let result = RunPartiQLResult::Succeeded {
            statement_type: "INSERT".into(),
            query_ms: 10,
            consumed_capacity: Some(serde_json::json!({"capacity_units": 1.0})),
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["kind"], "succeeded");
        assert_eq!(v["statement_type"], "INSERT");
        assert_eq!(v["query_ms"], 10);
        assert!(!v["consumed_capacity"].is_null());
    }

    #[test]
    fn statement_outcome_ok_serializes_with_outcome_tag() {
        let outcome = StatementOutcome::Ok {
            index: 0,
            statement: "SELECT * FROM \"t\"".into(),
            result: RunPartiQLResult::Rows {
                items: vec![],
                count: 0,
                query_ms: 5,
                truncated: false,
                consumed_capacity: None,
            },
        };
        let v = serde_json::to_value(&outcome).unwrap();
        assert_eq!(v["outcome"], "ok");
        assert_eq!(v["index"], 0);
        assert_eq!(v["result"]["kind"], "rows");
    }

    #[test]
    fn statement_outcome_err_serializes_with_outcome_tag() {
        let outcome = StatementOutcome::Err {
            index: 1,
            statement: "DELETE FROM \"t\"".into(),
            error: StatementError {
                message: "connection is read-only".into(),
                code: None,
            },
        };
        let v = serde_json::to_value(&outcome).unwrap();
        assert_eq!(v["outcome"], "err");
        assert_eq!(v["error"]["message"], "connection is read-only");
        assert!(v["error"]["code"].is_null());
    }

    #[test]
    fn statement_outcome_skipped_serializes_with_outcome_tag() {
        let outcome = StatementOutcome::Skipped {
            index: 2,
            statement: "UPDATE \"t\" SET a = 1".into(),
        };
        let v = serde_json::to_value(&outcome).unwrap();
        assert_eq!(v["outcome"], "skipped");
        assert_eq!(v["index"], 2);
    }
}
