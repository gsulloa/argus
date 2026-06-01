//! MySQL bulk columns cache command.
//!
//! `mysql_list_columns_bulk` — fetches all column metadata for every browsable
//! relation in a schema in a single round-trip and returns them grouped by
//! table name.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, State};
use tokio::time::timeout;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::mysql::errors::map_sqlx_error;
use crate::modules::mysql::pool::MysqlPoolRegistry;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BULK_TIMEOUT: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// §13.1 — DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct BulkColumn {
    pub name: String,
    pub data_type: String,
    pub full_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ColumnsBulkResult {
    pub schema: String,
    pub columns_by_relation: BTreeMap<String, Vec<BulkColumn>>,
}

// ---------------------------------------------------------------------------
// §13.1 — Row grouping helper (pure, testable)
// ---------------------------------------------------------------------------

/// Group raw column rows `(table_name, col_name, data_type, full_type,
/// is_nullable, default, comment, ordinal)` into a `BTreeMap` of
/// `Vec<BulkColumn>` ordered by `ORDINAL_POSITION`.
pub fn group_bulk_columns(
    rows: Vec<(
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        String,
        u32,
    )>,
) -> BTreeMap<String, Vec<BulkColumn>> {
    let mut map: BTreeMap<String, Vec<BulkColumn>> = BTreeMap::new();
    for (table_name, col_name, data_type, full_type, is_nullable, default, comment, _ordinal) in
        rows
    {
        let col = BulkColumn {
            name: col_name,
            data_type,
            full_type,
            nullable: is_nullable.eq_ignore_ascii_case("YES"),
            default,
            comment: if comment.is_empty() {
                None
            } else {
                Some(comment)
            },
        };
        map.entry(table_name).or_default().push(col);
    }
    map
}

// ---------------------------------------------------------------------------
// §13.1 — mysql_list_columns_bulk command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mysql_list_columns_bulk(
    app: AppHandle,
    registry: State<'_, MysqlPoolRegistry>,
    id: Uuid,
    schema: String,
    origin: Option<Origin>,
) -> AppResult<ColumnsBulkResult> {
    let started = Instant::now();
    let activity_origin = origin.unwrap_or(Origin::Auto);

    let pool = registry.acquire(id)?;

    let result = timeout(BULK_TIMEOUT, async {
        // (TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE,
        //  COLUMN_DEFAULT, COLUMN_COMMENT, ORDINAL_POSITION)
        let rows: Vec<(
            String,
            String,
            String,
            String,
            String,
            Option<String>,
            String,
            u32,
        )> = sqlx::query_as(
            "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, \
                 COLUMN_DEFAULT, COLUMN_COMMENT, ORDINAL_POSITION \
                 FROM information_schema.COLUMNS \
                 WHERE TABLE_SCHEMA = ? \
                 ORDER BY TABLE_NAME, ORDINAL_POSITION",
        )
        .bind(&schema)
        .fetch_all(&pool)
        .await
        .map_err(map_sqlx_error)?;

        let columns_by_relation = group_bulk_columns(rows);
        Ok::<ColumnsBulkResult, AppError>(ColumnsBulkResult {
            schema: schema.clone(),
            columns_by_relation,
        })
    })
    .await;

    let duration_ms = started.elapsed().as_millis() as u64;

    let result: AppResult<ColumnsBulkResult> = match result {
        Ok(Ok(r)) => Ok(r),
        Ok(Err(e)) => Err(e),
        Err(_elapsed) => Err(AppError::mysql_with_code(
            "70100",
            format!("list_columns_bulk timed out ({}s)", BULK_TIMEOUT.as_secs()),
        )),
    };

    let builder =
        ActivityLogEntryBuilder::new(ActivityKind::ListColumnsBulk, activity_origin, duration_ms)
            .connection(id);

    match &result {
        Ok(r) => {
            let total: u32 = r.columns_by_relation.values().map(|v| v.len() as u32).sum();
            let entry = builder.ok(Some(Metric::Items { value: total }));
            emit_activity(&app, entry);
        }
        Err(e) => {
            let entry = builder.err(e);
            emit_activity(&app, entry);
        }
    }

    result
}

// ---------------------------------------------------------------------------
// §13.2 — Unit tests for row-grouping helper
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_row(
        table: &str,
        col: &str,
        data_type: &str,
        full_type: &str,
        nullable: &str,
        default: Option<&str>,
        comment: &str,
        ordinal: u32,
    ) -> (
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        String,
        u32,
    ) {
        (
            table.to_string(),
            col.to_string(),
            data_type.to_string(),
            full_type.to_string(),
            nullable.to_string(),
            default.map(|s| s.to_string()),
            comment.to_string(),
            ordinal,
        )
    }

    #[test]
    fn group_single_table_two_columns() {
        let rows = vec![
            make_row(
                "users",
                "id",
                "bigint",
                "bigint unsigned",
                "NO",
                None,
                "",
                1,
            ),
            make_row(
                "users",
                "email",
                "varchar",
                "varchar(255)",
                "YES",
                None,
                "user email",
                2,
            ),
        ];
        let result = group_bulk_columns(rows);
        assert_eq!(result.len(), 1);
        let cols = result.get("users").unwrap();
        assert_eq!(cols.len(), 2);
        assert_eq!(cols[0].name, "id");
        assert_eq!(cols[0].nullable, false);
        assert_eq!(cols[1].name, "email");
        assert_eq!(cols[1].nullable, true);
        assert_eq!(cols[1].comment.as_deref(), Some("user email"));
    }

    #[test]
    fn group_multiple_tables() {
        let rows = vec![
            make_row("orders", "id", "int", "int(11)", "NO", None, "", 1),
            make_row(
                "users",
                "id",
                "bigint",
                "bigint unsigned",
                "NO",
                None,
                "",
                1,
            ),
            make_row(
                "users",
                "name",
                "varchar",
                "varchar(100)",
                "YES",
                Some("NULL"),
                "",
                2,
            ),
        ];
        let result = group_bulk_columns(rows);
        assert_eq!(result.len(), 2);
        assert!(result.contains_key("orders"));
        assert!(result.contains_key("users"));
        assert_eq!(result["users"].len(), 2);
    }

    #[test]
    fn empty_comment_becomes_none() {
        let rows = vec![make_row("t", "col", "int", "int", "NO", None, "", 1)];
        let result = group_bulk_columns(rows);
        assert!(result["t"][0].comment.is_none());
    }

    #[test]
    fn default_value_preserved() {
        let rows = vec![make_row(
            "t",
            "created_at",
            "datetime",
            "datetime(6)",
            "NO",
            Some("CURRENT_TIMESTAMP(6)"),
            "row insertion timestamp",
            1,
        )];
        let result = group_bulk_columns(rows);
        let col = &result["t"][0];
        assert_eq!(col.default.as_deref(), Some("CURRENT_TIMESTAMP(6)"));
        assert_eq!(col.comment.as_deref(), Some("row insertion timestamp"));
        assert_eq!(col.full_type, "datetime(6)");
        assert_eq!(col.data_type, "datetime");
    }
}
