//! CloudWatch Logs browser commands.
//!
//! Implements log-group listing, log-stream listing, and raw event fetching.

use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::cloudwatch::client::CloudwatchClientRegistry;
use crate::modules::cloudwatch::errors::sdk_err_to_app;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct LogGroupItem {
    pub name: String,
    pub arn: String,
    pub stored_bytes: Option<i64>,
    pub retention_in_days: Option<i32>,
}

#[derive(Debug, Serialize)]
pub struct ListLogGroupsResponse {
    pub groups: Vec<LogGroupItem>,
    pub next_token: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LogStreamItem {
    pub name: String,
    pub last_event_ts: Option<i64>,
    pub first_event_ts: Option<i64>,
    pub stored_bytes: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct ListLogStreamsResponse {
    pub streams: Vec<LogStreamItem>,
    pub next_token: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LogEventItem {
    pub ts: Option<i64>,
    pub ingestion_ts: Option<i64>,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct GetLogEventsResponse {
    pub events: Vec<LogEventItem>,
    pub next_forward_token: Option<String>,
    pub next_backward_token: Option<String>,
}

// ---------------------------------------------------------------------------
// 3.1 — cloudwatch_list_log_groups
// ---------------------------------------------------------------------------

/// Normalize an optional log-group search pattern: trim whitespace and treat
/// an empty result as "no pattern" (`None`), so the listing falls back to its
/// plain first-page behavior.
fn normalize_name_pattern(pattern: Option<String>) -> Option<String> {
    pattern
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
}

/// List log groups for the connection, with optional pagination and an
/// optional server-side name search (`logGroupNamePattern`, case-sensitive
/// substring match across the whole account).
#[tauri::command]
pub async fn cloudwatch_list_log_groups(
    registry: State<'_, CloudwatchClientRegistry>,
    connection_id: String,
    next_token: Option<String>,
    limit: Option<i32>,
    name_pattern: Option<String>,
) -> AppResult<ListLogGroupsResponse> {
    let id = Uuid::parse_str(&connection_id)
        .map_err(|e| AppError::Validation(format!("invalid uuid: {e}")))?;

    let client = registry.acquire(&id).await?;

    let limit = limit.unwrap_or(50).clamp(1, 50);

    let mut req = client
        .describe_log_groups()
        .limit(limit);

    // Server-side substring search. Empty/whitespace patterns are ignored so
    // the call keeps its plain first-page behavior. `logGroupNamePattern`
    // cannot be combined with a prefix, so we never set a prefix here.
    if let Some(pattern) = normalize_name_pattern(name_pattern) {
        req = req.log_group_name_pattern(pattern);
    }

    if let Some(token) = next_token {
        req = req.next_token(token);
    }

    let resp = req.send().await.map_err(|e| sdk_err_to_app(&e))?;

    let groups = resp
        .log_groups()
        .iter()
        .map(|g| LogGroupItem {
            name: g.log_group_name().unwrap_or_default().to_string(),
            arn: g.arn().unwrap_or_default().to_string(),
            stored_bytes: g.stored_bytes(),
            retention_in_days: g.retention_in_days(),
        })
        .collect();

    Ok(ListLogGroupsResponse {
        groups,
        next_token: resp.next_token().map(str::to_string),
    })
}

// ---------------------------------------------------------------------------
// 3.2 — cloudwatch_list_log_streams
// ---------------------------------------------------------------------------

/// List log streams in a log group, ordered by last event time (newest first).
#[tauri::command]
pub async fn cloudwatch_list_log_streams(
    registry: State<'_, CloudwatchClientRegistry>,
    connection_id: String,
    group_name: String,
    next_token: Option<String>,
    limit: Option<i32>,
) -> AppResult<ListLogStreamsResponse> {
    let id = Uuid::parse_str(&connection_id)
        .map_err(|e| AppError::Validation(format!("invalid uuid: {e}")))?;

    let client = registry.acquire(&id).await?;

    let limit = limit.unwrap_or(50).clamp(1, 50);

    let mut req = client
        .describe_log_streams()
        .log_group_name(&group_name)
        .order_by(aws_sdk_cloudwatchlogs::types::OrderBy::LastEventTime)
        .descending(true)
        .limit(limit);

    if let Some(token) = next_token {
        req = req.next_token(token);
    }

    let resp = req.send().await.map_err(|e| sdk_err_to_app(&e))?;

    let streams = resp
        .log_streams()
        .iter()
        .map(|s| LogStreamItem {
            name: s.log_stream_name().unwrap_or_default().to_string(),
            last_event_ts: s.last_event_timestamp(),
            first_event_ts: s.first_event_timestamp(),
            // stored_bytes on LogStream is deprecated by AWS (always zero since 2019).
            // We keep the field in the struct for API compatibility but populate None.
            stored_bytes: None,
        })
        .collect();

    Ok(ListLogStreamsResponse {
        streams,
        next_token: resp.next_token().map(str::to_string),
    })
}

// ---------------------------------------------------------------------------
// 3.3 — cloudwatch_get_log_events
// ---------------------------------------------------------------------------

/// Fetch log events from a stream, supporting forward and backward paging.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn cloudwatch_get_log_events(
    registry: State<'_, CloudwatchClientRegistry>,
    connection_id: String,
    group_name: String,
    stream_name: String,
    forward_token: Option<String>,
    backward_token: Option<String>,
    start_from_head: Option<bool>,
    limit: Option<i32>,
) -> AppResult<GetLogEventsResponse> {
    let id = Uuid::parse_str(&connection_id)
        .map_err(|e| AppError::Validation(format!("invalid uuid: {e}")))?;

    let client = registry.acquire(&id).await?;

    let limit = limit.unwrap_or(200).clamp(1, 10_000);

    // Build the request; forward_token takes precedence over backward_token.
    let mut req = client
        .get_log_events()
        .log_group_name(&group_name)
        .log_stream_name(&stream_name)
        .limit(limit)
        .start_from_head(start_from_head.unwrap_or(false));

    if let Some(token) = forward_token {
        req = req.next_token(token);
    } else if let Some(token) = backward_token {
        req = req.next_token(token);
    }

    let resp = req.send().await.map_err(|e| sdk_err_to_app(&e))?;

    let events = resp
        .events()
        .iter()
        .map(|e| LogEventItem {
            ts: e.timestamp(),
            ingestion_ts: e.ingestion_time(),
            message: e.message().unwrap_or_default().to_string(),
        })
        .collect();

    Ok(GetLogEventsResponse {
        events,
        next_forward_token: resp.next_forward_token().map(str::to_string),
        next_backward_token: resp.next_backward_token().map(str::to_string),
    })
}

// ---------------------------------------------------------------------------
// 3.4 — Unit tests (pure-data, no AWS calls)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    // Verify GetLogEventsResponse serialization shape matches the spec.
    #[test]
    fn get_log_events_response_serialization_shape() {
        let resp = GetLogEventsResponse {
            events: vec![
                LogEventItem {
                    ts: Some(1_700_000_000_000),
                    ingestion_ts: Some(1_700_000_001_000),
                    message: "hello world".into(),
                },
                LogEventItem {
                    ts: None,
                    ingestion_ts: None,
                    message: "".into(),
                },
            ],
            next_forward_token: Some("fwd-token-xyz".into()),
            next_backward_token: Some("bwd-token-abc".into()),
        };

        let json = serde_json::to_value(&resp).unwrap();

        let events = json["events"].as_array().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["ts"], 1_700_000_000_000i64);
        assert_eq!(events[0]["ingestion_ts"], 1_700_000_001_000i64);
        assert_eq!(events[0]["message"], "hello world");
        assert_eq!(events[1]["ts"], serde_json::Value::Null);

        assert_eq!(json["next_forward_token"], "fwd-token-xyz");
        assert_eq!(json["next_backward_token"], "bwd-token-abc");
    }

    // Verify pagination tokens are nullable in the response.
    #[test]
    fn get_log_events_response_no_tokens() {
        let resp = GetLogEventsResponse {
            events: vec![],
            next_forward_token: None,
            next_backward_token: None,
        };

        let json = serde_json::to_value(&resp).unwrap();
        assert!(json["next_forward_token"].is_null());
        assert!(json["next_backward_token"].is_null());
    }

    // Verify log group shape serialization.
    #[test]
    fn list_log_groups_response_shape() {
        let resp = ListLogGroupsResponse {
            groups: vec![LogGroupItem {
                name: "/aws/lambda/my-fn".into(),
                arn: "arn:aws:logs:us-east-1:123:log-group:/aws/lambda/my-fn".into(),
                stored_bytes: Some(1024),
                retention_in_days: Some(30),
            }],
            next_token: Some("tok".into()),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["groups"][0]["name"], "/aws/lambda/my-fn");
        assert_eq!(json["groups"][0]["stored_bytes"], 1024);
        assert_eq!(json["groups"][0]["retention_in_days"], 30);
        assert_eq!(json["next_token"], "tok");
    }

    // Server-side search pattern normalization: trim + empty → None.
    #[test]
    fn name_pattern_normalization() {
        assert_eq!(normalize_name_pattern(None), None);
        assert_eq!(normalize_name_pattern(Some("".into())), None);
        assert_eq!(normalize_name_pattern(Some("   ".into())), None);
        assert_eq!(
            normalize_name_pattern(Some("  checkout ".into())),
            Some("checkout".into())
        );
        assert_eq!(
            normalize_name_pattern(Some("/aws/lambda".into())),
            Some("/aws/lambda".into())
        );
    }

    // Test that the registry acquire returns NotFound for an unknown id.
    #[tokio::test]
    async fn registry_acquire_unknown_returns_not_found() {
        let reg = CloudwatchClientRegistry::new();
        let id = Uuid::new_v4();
        let err = reg.acquire(&id).await.unwrap_err();
        assert!(
            matches!(err, AppError::NotFound(_)),
            "expected NotFound, got {err:?}"
        );
    }
}
