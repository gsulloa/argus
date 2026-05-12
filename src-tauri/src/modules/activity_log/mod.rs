use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use time::OffsetDateTime;
use tokio_postgres::types::ToSql;
use uuid::Uuid;

use crate::error::AppError;

const SCHEMA_VERSION: u8 = 1;
const PARAM_TRUNCATE_CHARS: usize = 200;
const PARAM_TRUNCATE_MARKER: char = '…';

pub const ACTIVITY_LOG_EVENT: &str = "argus:activity-log";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActivityKind {
    TestConnection,
    Connect,
    Disconnect,
    UpdateCredentials,
    ListSchemas,
    ListRelations,
    ListStructure,
    ListTableExtras,
    ListColumnsBulk,
    QueryTable,
    CountTable,
    ApplyEdits,
    RunSql,
    TableStructure,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    #[default]
    Auto,
    User,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Ok,
    Err,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Metric {
    Rows { value: u64 },
    Count { value: i64 },
    Affected { value: i64 },
    ServerVersion { value: String },
    Items { value: u32 },
    AwsIdentity { value: String },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ActivityError {
    pub message: String,
    pub code: Option<String>,
}

impl ActivityError {
    pub fn from_app(err: &AppError) -> Self {
        match err {
            AppError::Postgres(body) => Self {
                message: body.message.clone(),
                code: body.code.clone(),
            },
            other => Self {
                message: other.to_string(),
                code: None,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivityLogEntry {
    pub v: u8,
    pub id: Uuid,
    pub timestamp_unix_ms: i64,
    pub connection_id: Option<Uuid>,
    pub kind: ActivityKind,
    pub origin: Origin,
    pub duration_ms: u64,
    pub status: Status,
    pub sql: Option<String>,
    pub params: Option<Vec<String>>,
    pub metric: Option<Metric>,
    pub error: Option<ActivityError>,
}

pub struct ActivityLogEntryBuilder {
    connection_id: Option<Uuid>,
    kind: ActivityKind,
    origin: Origin,
    duration_ms: u64,
    sql: Option<String>,
    params: Option<Vec<String>>,
}

impl ActivityLogEntryBuilder {
    pub fn new(kind: ActivityKind, origin: Origin, duration_ms: u64) -> Self {
        Self {
            connection_id: None,
            kind,
            origin,
            duration_ms,
            sql: None,
            params: None,
        }
    }

    pub fn connection(mut self, id: Uuid) -> Self {
        self.connection_id = Some(id);
        self
    }

    pub fn sql(mut self, sql: impl Into<String>) -> Self {
        self.sql = Some(sql.into());
        self
    }

    pub fn params(mut self, params: Vec<String>) -> Self {
        self.params = Some(params);
        self
    }

    pub fn ok(self, metric: Option<Metric>) -> ActivityLogEntry {
        self.finish(Status::Ok, metric, None)
    }

    pub fn err(self, error: &AppError) -> ActivityLogEntry {
        self.finish(Status::Err, None, Some(ActivityError::from_app(error)))
    }

    fn finish(
        self,
        status: Status,
        metric: Option<Metric>,
        error: Option<ActivityError>,
    ) -> ActivityLogEntry {
        ActivityLogEntry {
            v: SCHEMA_VERSION,
            id: Uuid::new_v4(),
            timestamp_unix_ms: now_unix_ms(),
            connection_id: self.connection_id,
            kind: self.kind,
            origin: self.origin,
            duration_ms: self.duration_ms,
            status,
            sql: self.sql,
            params: self.params,
            metric,
            error,
        }
    }
}

fn now_unix_ms() -> i64 {
    let now = OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    now as i64
}

pub fn emit_activity(app: &AppHandle, entry: ActivityLogEntry) {
    if let Err(e) = app.emit(ACTIVITY_LOG_EVENT, entry) {
        tracing::debug!("activity-log: emit failed: {e}");
    }
}

pub fn format_params(params: &[Box<dyn ToSql + Sync + Send>]) -> Vec<String> {
    params.iter().map(|p| format_param(p.as_ref())).collect()
}

fn format_param(p: &(dyn ToSql + Sync)) -> String {
    let raw = format!("{p:?}");
    truncate_with_marker(&raw, PARAM_TRUNCATE_CHARS)
}

fn truncate_with_marker(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max_chars).collect();
    out.push(PARAM_TRUNCATE_MARKER);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_short_string_unchanged() {
        let s = "hello";
        assert_eq!(truncate_with_marker(s, 200), "hello");
    }

    #[test]
    fn truncate_at_boundary_unchanged() {
        let s: String = std::iter::repeat('a').take(200).collect();
        assert_eq!(truncate_with_marker(&s, 200), s);
    }

    #[test]
    fn truncate_long_string_appends_marker() {
        let s: String = std::iter::repeat('a').take(250).collect();
        let out = truncate_with_marker(&s, 200);
        assert_eq!(out.chars().count(), 201);
        assert!(out.ends_with('…'));
        let body: String = out.chars().take(200).collect();
        assert_eq!(body.chars().count(), 200);
    }

    #[test]
    fn truncate_handles_multibyte_chars() {
        let s: String = std::iter::repeat('é').take(250).collect();
        let out = truncate_with_marker(&s, 200);
        assert_eq!(out.chars().count(), 201);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn format_params_truncates_long_value() {
        let big: String = std::iter::repeat('x').take(300).collect();
        let params: Vec<Box<dyn ToSql + Sync + Send>> = vec![Box::new(big), Box::new(42_i64)];
        let out = format_params(&params);
        assert_eq!(out.len(), 2);
        assert!(out[0].ends_with('…'));
        assert_eq!(out[0].chars().count(), 201);
        assert_eq!(out[1], "42");
    }

    #[test]
    fn entry_serializes_with_snake_case_keys_and_v1() {
        let entry = ActivityLogEntryBuilder::new(ActivityKind::QueryTable, Origin::User, 12)
            .connection(Uuid::nil())
            .sql("SELECT 1")
            .params(vec!["1".to_string()])
            .ok(Some(Metric::Rows { value: 5 }));

        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json.get("v").unwrap(), 1);
        assert_eq!(json.get("kind").unwrap(), "query_table");
        assert_eq!(json.get("origin").unwrap(), "user");
        assert_eq!(json.get("status").unwrap(), "ok");
        assert_eq!(json.get("connection_id").unwrap(), &Uuid::nil().to_string());
        assert_eq!(json.get("duration_ms").unwrap(), 12);
        assert_eq!(json.get("sql").unwrap(), "SELECT 1");
        assert_eq!(json.get("params").unwrap()[0], "1");
        assert!(json.get("timestamp_unix_ms").unwrap().is_i64());
        let metric = json.get("metric").unwrap();
        assert_eq!(metric.get("kind").unwrap(), "rows");
        assert_eq!(metric.get("value").unwrap(), 5);
        assert!(json.get("error").unwrap().is_null());
    }

    #[test]
    fn err_entry_carries_postgres_code() {
        let err = AppError::postgres_with_code("42P01", "relation does not exist");
        let entry = ActivityLogEntryBuilder::new(ActivityKind::QueryTable, Origin::User, 8)
            .connection(Uuid::nil())
            .sql("SELECT * FROM x")
            .err(&err);

        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json.get("status").unwrap(), "err");
        assert!(json.get("metric").unwrap().is_null());
        let error = json.get("error").unwrap();
        assert_eq!(error.get("code").unwrap(), "42P01");
        assert_eq!(error.get("message").unwrap(), "relation does not exist");
    }

    #[test]
    fn kind_discriminants_match_spec() {
        let cases = [
            (ActivityKind::TestConnection, "test_connection"),
            (ActivityKind::Connect, "connect"),
            (ActivityKind::Disconnect, "disconnect"),
            (ActivityKind::ListSchemas, "list_schemas"),
            (ActivityKind::ListRelations, "list_relations"),
            (ActivityKind::ListStructure, "list_structure"),
            (ActivityKind::ListTableExtras, "list_table_extras"),
            (ActivityKind::ListColumnsBulk, "list_columns_bulk"),
            (ActivityKind::QueryTable, "query_table"),
            (ActivityKind::CountTable, "count_table"),
            (ActivityKind::ApplyEdits, "apply_edits"),
            (ActivityKind::RunSql, "run_sql"),
            (ActivityKind::TableStructure, "table_structure"),
        ];
        for (kind, expected) in cases {
            let json = serde_json::to_value(&kind).unwrap();
            assert_eq!(json, expected);
        }
    }

    #[test]
    fn affected_metric_serializes_with_kind_and_value() {
        let m = Metric::Affected { value: 42 };
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(json.get("kind").unwrap(), "affected");
        assert_eq!(json.get("value").unwrap(), 42);
    }
}
