//! Persistent log of every SQL statement run via `postgres_run_sql` /
//! `postgres_run_sql_many`. Backed by the `query_history` SQLite table created
//! in migration `0002_query_history.sql`.
//!
//! The contract: one row per emitted `argus:activity-log` event of kind
//! `run_sql` (skipped statements in a multi-run produce no row). Inserts must
//! never fail the calling SQL command — `insert_entry` swallows rusqlite
//! errors after logging.

pub mod commands;

use rusqlite::{params, params_from_iter};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// Status of a recorded statement. Mirrors `activity_log::Status` but is owned
/// by this module so the column values are stable independently of the
/// activity-log schema.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HistoryStatus {
    Ok,
    Err,
}

impl HistoryStatus {
    fn as_db(&self) -> &'static str {
        match self {
            HistoryStatus::Ok => "ok",
            HistoryStatus::Err => "err",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HistoryOrigin {
    User,
    Auto,
}

impl HistoryOrigin {
    fn as_db(&self) -> &'static str {
        match self {
            HistoryOrigin::User => "user",
            HistoryOrigin::Auto => "auto",
        }
    }
}

/// One persisted history row.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistoryEntry {
    pub id: String,
    pub connection_id: Uuid,
    pub connection_name: String,
    pub sql: String,
    pub origin: HistoryOrigin,
    pub status: HistoryStatus,
    pub started_at: i64,
    pub duration_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

/// Inputs for `insert_entry` — fields the caller knows at run time. The id and
/// row are constructed inside `insert_entry`.
#[derive(Debug, Clone)]
pub struct NewEntry {
    pub connection_id: Uuid,
    pub connection_name: String,
    pub sql: String,
    pub origin: HistoryOrigin,
    pub status: HistoryStatus,
    pub started_at: i64,
    pub duration_ms: i64,
    pub row_count: Option<i64>,
    pub command_tag: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct HistoryFilters {
    pub connection_ids: Option<Vec<String>>,
    pub since: Option<i64>,
    pub until: Option<i64>,
    pub search: Option<String>,
    pub status: Option<HistoryStatus>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ListRequest {
    #[serde(flatten)]
    pub filters: HistoryFilters,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

impl Default for ListRequest {
    fn default() -> Self {
        Self {
            filters: HistoryFilters::default(),
            limit: None,
            offset: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ListResponse {
    pub entries: Vec<HistoryEntry>,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClearResponse {
    pub deleted: u64,
}

const DEFAULT_LIMIT: u32 = 200;
const MAX_LIMIT: u32 = 1000;

/// Insert one row. rusqlite errors are logged but NOT propagated — the calling
/// SQL command must keep its outcome regardless of whether persistence
/// succeeded. Every row gets a fresh UUID id.
pub fn insert_entry(conn: &rusqlite::Connection, entry: NewEntry) {
    let id = Uuid::new_v4().to_string();
    let res = conn.execute(
        "INSERT INTO query_history (
            id, connection_id, connection_name, sql, origin, status,
            started_at, duration_ms, row_count, command_tag, error_code, error_message
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            id,
            entry.connection_id.as_bytes().to_vec(),
            entry.connection_name,
            entry.sql,
            entry.origin.as_db(),
            entry.status.as_db(),
            entry.started_at,
            entry.duration_ms,
            entry.row_count,
            entry.command_tag,
            entry.error_code,
            entry.error_message,
        ],
    );
    if let Err(e) = res {
        tracing::error!("query_history: insert failed: {e}");
    }
}

fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryEntry> {
    let id: String = row.get(0)?;
    let conn_id_bytes: Vec<u8> = row.get(1)?;
    let connection_id = Uuid::from_slice(&conn_id_bytes).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Blob, Box::new(e))
    })?;
    let connection_name: String = row.get(2)?;
    let sql: String = row.get(3)?;
    let origin_s: String = row.get(4)?;
    let origin = match origin_s.as_str() {
        "user" => HistoryOrigin::User,
        _ => HistoryOrigin::Auto,
    };
    let status_s: String = row.get(5)?;
    let status = match status_s.as_str() {
        "ok" => HistoryStatus::Ok,
        _ => HistoryStatus::Err,
    };
    let started_at: i64 = row.get(6)?;
    let duration_ms: i64 = row.get(7)?;
    let row_count: Option<i64> = row.get(8)?;
    let command_tag: Option<String> = row.get(9)?;
    let error_code: Option<String> = row.get(10)?;
    let error_message: Option<String> = row.get(11)?;
    Ok(HistoryEntry {
        id,
        connection_id,
        connection_name,
        sql,
        origin,
        status,
        started_at,
        duration_ms,
        row_count,
        command_tag,
        error_code,
        error_message,
    })
}

/// Build the WHERE clause + values for a filter set. Returned values are
/// `Box<dyn ToSql>` because the IN-list arity is dynamic.
fn build_where(
    filters: &HistoryFilters,
) -> AppResult<(String, Vec<Box<dyn rusqlite::ToSql>>)> {
    let mut clauses: Vec<String> = Vec::new();
    let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(ids) = filters.connection_ids.as_ref() {
        if !ids.is_empty() {
            let placeholders: Vec<String> = (1..=ids.len()).map(|i| format!("?{}", values.len() + i)).collect();
            clauses.push(format!("connection_id IN ({})", placeholders.join(", ")));
            for id_str in ids {
                let parsed = Uuid::parse_str(id_str)
                    .map_err(|e| AppError::Validation(format!("bad connection_id uuid: {e}")))?;
                values.push(Box::new(parsed.as_bytes().to_vec()));
            }
        }
    }

    if let Some(since) = filters.since {
        clauses.push(format!("started_at >= ?{}", values.len() + 1));
        values.push(Box::new(since));
    }
    if let Some(until) = filters.until {
        clauses.push(format!("started_at <= ?{}", values.len() + 1));
        values.push(Box::new(until));
    }
    if let Some(search) = filters.search.as_deref() {
        let trimmed = search.trim();
        if !trimmed.is_empty() {
            clauses.push(format!("LOWER(sql) LIKE ?{}", values.len() + 1));
            let pattern = format!("%{}%", trimmed.to_lowercase());
            values.push(Box::new(pattern));
        }
    }
    if let Some(status) = filters.status {
        clauses.push(format!("status = ?{}", values.len() + 1));
        values.push(Box::new(status.as_db().to_string()));
    }

    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };
    Ok((where_sql, values))
}

pub fn list_entries(
    conn: &rusqlite::Connection,
    request: ListRequest,
) -> AppResult<ListResponse> {
    let limit = request.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = request.offset.unwrap_or(0);
    let (where_sql, values) = build_where(&request.filters)?;

    let count_sql = format!("SELECT COUNT(*) FROM query_history{}", where_sql);
    let mut count_stmt = conn.prepare(&count_sql)?;
    let total: i64 = count_stmt
        .query_row(params_from_iter(values.iter().map(|v| v.as_ref())), |r| r.get(0))?;

    let list_sql = format!(
        "SELECT id, connection_id, connection_name, sql, origin, status,
                started_at, duration_ms, row_count, command_tag, error_code, error_message
         FROM query_history{}
         ORDER BY started_at DESC, id DESC
         LIMIT ?{} OFFSET ?{}",
        where_sql,
        values.len() + 1,
        values.len() + 2,
    );
    let mut list_stmt = conn.prepare(&list_sql)?;
    let mut all_values: Vec<Box<dyn rusqlite::ToSql>> = values;
    all_values.push(Box::new(limit as i64));
    all_values.push(Box::new(offset as i64));
    let rows = list_stmt
        .query_map(params_from_iter(all_values.iter().map(|v| v.as_ref())), row_to_entry)?;
    let mut entries: Vec<HistoryEntry> = Vec::new();
    for r in rows {
        entries.push(r?);
    }
    Ok(ListResponse { entries, total })
}

pub fn delete_one(conn: &rusqlite::Connection, id: &str) -> AppResult<()> {
    let affected = conn.execute("DELETE FROM query_history WHERE id = ?1", params![id])?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("history entry {id} not found")));
    }
    Ok(())
}

pub fn clear(
    conn: &rusqlite::Connection,
    filters: HistoryFilters,
) -> AppResult<ClearResponse> {
    let (where_sql, values) = build_where(&filters)?;
    let sql = format!("DELETE FROM query_history{}", where_sql);
    let affected = conn.execute(&sql, params_from_iter(values.iter().map(|v| v.as_ref())))?;
    Ok(ClearResponse {
        deleted: affected as u64,
    })
}

/// Apply both retention bounds in order: by age, then by absolute cap. Runs in
/// a single transaction so a partial sweep never leaves the DB inconsistent.
pub fn prune_for_retention(
    conn: &mut rusqlite::Connection,
    retention_days: u32,
    max_rows: u32,
    now_unix_ms: i64,
) -> AppResult<u64> {
    let cutoff_ms = now_unix_ms.saturating_sub((retention_days as i64) * 86_400_000);
    let tx = conn.transaction()?;
    let by_age = tx.execute(
        "DELETE FROM query_history WHERE started_at < ?1",
        params![cutoff_ms],
    )?;
    let by_cap = tx.execute(
        "DELETE FROM query_history
         WHERE id NOT IN (
             SELECT id FROM query_history
             ORDER BY started_at DESC, id DESC
             LIMIT ?1
         )",
        params![max_rows as i64],
    )?;
    tx.commit()?;
    Ok((by_age + by_cap) as u64)
}

/// Look up the latest count of distinct connection ids that have at least one
/// history row. Used by the connections picker to surface deleted connections
/// alongside live ones.
pub fn distinct_connections(
    conn: &rusqlite::Connection,
) -> AppResult<Vec<(Uuid, String)>> {
    // Latest snapshotted name wins (most recent run).
    let mut stmt = conn.prepare(
        "SELECT connection_id, connection_name
         FROM query_history qh
         WHERE started_at = (
            SELECT MAX(started_at) FROM query_history qh2
            WHERE qh2.connection_id = qh.connection_id
         )
         GROUP BY connection_id",
    )?;
    let rows = stmt.query_map([], |r| {
        let id_bytes: Vec<u8> = r.get(0)?;
        let id = Uuid::from_slice(&id_bytes).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Blob, Box::new(e))
        })?;
        let name: String = r.get(1)?;
        Ok((id, name))
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::storage::open_in_memory;

    fn make_entry(
        connection_id: Uuid,
        sql: &str,
        status: HistoryStatus,
        started_at: i64,
    ) -> NewEntry {
        NewEntry {
            connection_id,
            connection_name: "local-pg".to_string(),
            sql: sql.to_string(),
            origin: HistoryOrigin::User,
            status,
            started_at,
            duration_ms: 5,
            row_count: Some(1),
            command_tag: None,
            error_code: None,
            error_message: None,
        }
    }

    #[test]
    fn insert_then_list_round_trip() {
        let c = open_in_memory().unwrap();
        let cid = Uuid::new_v4();
        insert_entry(&c, make_entry(cid, "SELECT 1", HistoryStatus::Ok, 100));
        insert_entry(&c, make_entry(cid, "SELECT 2", HistoryStatus::Ok, 200));

        let resp = list_entries(&c, ListRequest::default()).unwrap();
        assert_eq!(resp.total, 2);
        assert_eq!(resp.entries.len(), 2);
        assert_eq!(resp.entries[0].sql, "SELECT 2");
        assert_eq!(resp.entries[1].sql, "SELECT 1");
    }

    #[test]
    fn list_orders_by_started_then_id_desc() {
        let c = open_in_memory().unwrap();
        let cid = Uuid::new_v4();
        for sql in ["A", "B", "C"] {
            insert_entry(&c, make_entry(cid, sql, HistoryStatus::Ok, 100));
        }
        let resp = list_entries(&c, ListRequest::default()).unwrap();
        assert_eq!(resp.entries.len(), 3);
        // All same started_at; ordering must be stable via id DESC.
        let ids: Vec<&str> = resp.entries.iter().map(|e| e.id.as_str()).collect();
        let mut sorted = ids.clone();
        sorted.sort_by(|a, b| b.cmp(a));
        assert_eq!(ids, sorted);
    }

    #[test]
    fn filter_by_status() {
        let c = open_in_memory().unwrap();
        let cid = Uuid::new_v4();
        insert_entry(&c, make_entry(cid, "SELECT 1", HistoryStatus::Ok, 100));
        let mut e = make_entry(cid, "SELEC 1", HistoryStatus::Err, 200);
        e.error_code = Some("42601".into());
        e.error_message = Some("syntax error".into());
        insert_entry(&c, e);

        let req = ListRequest {
            filters: HistoryFilters {
                status: Some(HistoryStatus::Err),
                ..Default::default()
            },
            ..Default::default()
        };
        let resp = list_entries(&c, req).unwrap();
        assert_eq!(resp.total, 1);
        assert_eq!(resp.entries[0].sql, "SELEC 1");
        assert_eq!(resp.entries[0].error_code.as_deref(), Some("42601"));
    }

    #[test]
    fn filter_by_search_is_case_insensitive() {
        let c = open_in_memory().unwrap();
        let cid = Uuid::new_v4();
        insert_entry(&c, make_entry(cid, "SELECT * FROM Orders", HistoryStatus::Ok, 100));
        insert_entry(&c, make_entry(cid, "SELECT id FROM users", HistoryStatus::Ok, 200));

        let req = ListRequest {
            filters: HistoryFilters {
                search: Some("orders".into()),
                ..Default::default()
            },
            ..Default::default()
        };
        let resp = list_entries(&c, req).unwrap();
        assert_eq!(resp.total, 1);
        assert!(resp.entries[0].sql.contains("Orders"));
    }

    #[test]
    fn filter_by_connection_ids() {
        let c = open_in_memory().unwrap();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        insert_entry(&c, make_entry(a, "SELECT a", HistoryStatus::Ok, 100));
        insert_entry(&c, make_entry(b, "SELECT b", HistoryStatus::Ok, 200));

        let req = ListRequest {
            filters: HistoryFilters {
                connection_ids: Some(vec![a.to_string()]),
                ..Default::default()
            },
            ..Default::default()
        };
        let resp = list_entries(&c, req).unwrap();
        assert_eq!(resp.total, 1);
        assert_eq!(resp.entries[0].connection_id, a);
    }

    #[test]
    fn pagination_returns_correct_slice() {
        let c = open_in_memory().unwrap();
        let cid = Uuid::new_v4();
        for i in 0..50_i64 {
            insert_entry(&c, make_entry(cid, &format!("S{i}"), HistoryStatus::Ok, i * 10));
        }
        let req = ListRequest {
            limit: Some(10),
            offset: Some(20),
            ..Default::default()
        };
        let resp = list_entries(&c, req).unwrap();
        assert_eq!(resp.total, 50);
        assert_eq!(resp.entries.len(), 10);
        // Most recent first; offset 20 means we skip the 20 most recent.
        assert_eq!(resp.entries[0].sql, "S29");
        assert_eq!(resp.entries[9].sql, "S20");
    }

    #[test]
    fn delete_one_removes_row_and_returns_not_found_for_missing() {
        let c = open_in_memory().unwrap();
        let cid = Uuid::new_v4();
        insert_entry(&c, make_entry(cid, "SELECT 1", HistoryStatus::Ok, 100));
        let resp = list_entries(&c, ListRequest::default()).unwrap();
        let id = resp.entries[0].id.clone();
        delete_one(&c, &id).unwrap();
        assert_eq!(list_entries(&c, ListRequest::default()).unwrap().total, 0);

        let err = delete_one(&c, "nonexistent").unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn clear_with_no_filters_removes_everything() {
        let c = open_in_memory().unwrap();
        let cid = Uuid::new_v4();
        for i in 0..5 {
            insert_entry(&c, make_entry(cid, &format!("S{i}"), HistoryStatus::Ok, i));
        }
        let resp = clear(&c, HistoryFilters::default()).unwrap();
        assert_eq!(resp.deleted, 5);
        assert_eq!(list_entries(&c, ListRequest::default()).unwrap().total, 0);
    }

    #[test]
    fn clear_with_filters_scopes_deletion() {
        let c = open_in_memory().unwrap();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        insert_entry(&c, make_entry(a, "Sa", HistoryStatus::Ok, 100));
        insert_entry(&c, make_entry(a, "Sa2", HistoryStatus::Ok, 200));
        insert_entry(&c, make_entry(b, "Sb", HistoryStatus::Ok, 300));
        let resp = clear(
            &c,
            HistoryFilters {
                connection_ids: Some(vec![a.to_string()]),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(resp.deleted, 2);
        let remaining = list_entries(&c, ListRequest::default()).unwrap();
        assert_eq!(remaining.total, 1);
        assert_eq!(remaining.entries[0].connection_id, b);
    }

    #[test]
    fn prune_by_age_removes_old_rows() {
        let mut c = open_in_memory().unwrap();
        let cid = Uuid::new_v4();
        let now = 1_000_000_000_000_i64;
        let day = 86_400_000_i64;
        // 10 fresh entries (within 30 days), 5 ancient (older than 30 days).
        for i in 0..10 {
            insert_entry(&c, make_entry(cid, &format!("fresh-{i}"), HistoryStatus::Ok, now - i * day));
        }
        for i in 0..5 {
            insert_entry(&c, make_entry(cid, &format!("old-{i}"), HistoryStatus::Ok, now - 60 * day - i * day));
        }
        prune_for_retention(&mut c, 30, 10_000, now).unwrap();
        let resp = list_entries(&c, ListRequest::default()).unwrap();
        assert_eq!(resp.total, 10);
        for entry in &resp.entries {
            assert!(entry.sql.starts_with("fresh-"));
        }
    }

    #[test]
    fn prune_by_cap_keeps_most_recent() {
        let mut c = open_in_memory().unwrap();
        let cid = Uuid::new_v4();
        let now = 1_000_000_000_000_i64;
        // Stagger 50 entries all within the last minute so the age sweep is a
        // no-op and only the cap pass kicks in.
        for i in 0..50_i64 {
            insert_entry(
                &c,
                make_entry(cid, &format!("S{i}"), HistoryStatus::Ok, now - (50 - i) * 1000),
            );
        }
        prune_for_retention(&mut c, 30, 10, now).unwrap();
        let resp = list_entries(&c, ListRequest::default()).unwrap();
        assert_eq!(resp.total, 10);
        // Only S40..S49 should remain (most recent ten).
        assert_eq!(resp.entries[0].sql, "S49");
        assert_eq!(resp.entries[9].sql, "S40");
    }

    #[test]
    fn retention_combines_age_and_cap_to_target_count() {
        // Seed: 100 entries older than 7 days + 200 fresh + 600 within-cap = 900 total.
        // With retentionDays=7 and retentionMaxRows=500, we expect exactly 500 to remain.
        let mut c = open_in_memory().unwrap();
        let cid = Uuid::new_v4();
        let now = 1_000_000_000_000_i64;
        let day = 86_400_000_i64;

        for i in 0..100_i64 {
            insert_entry(
                &c,
                make_entry(
                    cid,
                    &format!("old-{i}"),
                    HistoryStatus::Ok,
                    now - 30 * day - i * day,
                ),
            );
        }
        for i in 0..800_i64 {
            insert_entry(
                &c,
                make_entry(
                    cid,
                    &format!("fresh-{i}"),
                    HistoryStatus::Ok,
                    now - i * 1000,
                ),
            );
        }

        prune_for_retention(&mut c, 7, 500, now).unwrap();
        let resp = list_entries(&c, ListRequest::default()).unwrap();
        assert_eq!(resp.total, 500);
        for entry in &resp.entries {
            assert!(entry.started_at >= now - 7 * day);
            assert!(entry.sql.starts_with("fresh-"));
        }
    }

    #[test]
    fn limit_is_clamped() {
        let c = open_in_memory().unwrap();
        let cid = Uuid::new_v4();
        for i in 0..5 {
            insert_entry(&c, make_entry(cid, &format!("S{i}"), HistoryStatus::Ok, i));
        }
        let req = ListRequest {
            limit: Some(0),
            ..Default::default()
        };
        let resp = list_entries(&c, req).unwrap();
        // limit=0 clamps to 1.
        assert_eq!(resp.entries.len(), 1);

        let req = ListRequest {
            limit: Some(99_999),
            ..Default::default()
        };
        let resp = list_entries(&c, req).unwrap();
        assert_eq!(resp.entries.len(), 5);
    }

    #[test]
    fn distinct_connections_returns_latest_name_per_id() {
        let c = open_in_memory().unwrap();
        let a = Uuid::new_v4();
        let mut e1 = make_entry(a, "S1", HistoryStatus::Ok, 100);
        e1.connection_name = "old-name".into();
        insert_entry(&c, e1);
        let mut e2 = make_entry(a, "S2", HistoryStatus::Ok, 200);
        e2.connection_name = "new-name".into();
        insert_entry(&c, e2);
        let res = distinct_connections(&c).unwrap();
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].0, a);
        assert_eq!(res[0].1, "new-name");
    }
}
