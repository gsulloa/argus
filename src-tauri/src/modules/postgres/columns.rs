//! Bulk column metadata fetch. Used by the SQL editor's autocomplete to
//! pre-load every relation's columns for a schema in one round-trip, so the
//! user gets canonical schema-aware completion without per-table fetches.
//!
//! Surfaces a single command `postgres_list_columns_bulk(connection_id, schema, origin?)`
//! that returns `{ schema, columns_by_relation: { relname: [BulkColumnInfo, …] } }`.

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
use crate::modules::postgres::data::fire_cancel;
use crate::modules::postgres::pool::PgPoolRegistry;

/// Total timeout for the bulk command. Mirrors the per-query timeout from
/// the multi-kind schema commands; a single schema's columns shouldn't take
/// longer than this even on large catalogs.
const BULK_TIMEOUT: Duration = Duration::from_secs(8);

/// Single column entry in the bulk payload. Richer than the existing
/// `DataColumn` to support autocomplete tooltips: includes the column's
/// default expression and the row-level comment.
#[derive(Debug, Clone, Serialize)]
pub struct BulkColumnInfo {
    pub name: String,
    pub data_type: String,
    pub ordinal_position: i32,
    pub is_nullable: bool,
    pub default_value: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ColumnsBulkResult {
    pub schema: String,
    pub columns_by_relation: BTreeMap<String, Vec<BulkColumnInfo>>,
}

/// SQL: pull every column for every browsable relation in a schema, with
/// default expressions and comments. We filter by `relkind` to include
/// regular tables, views, mat-views, partitioned, and foreign tables —
/// the same set the schema browser surfaces.
const SQL_LIST_COLUMNS_BULK: &str = "\
SELECT
    c.relname,
    a.attname,
    pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
    a.attnum::int4 AS ordinal_position,
    NOT a.attnotnull AS is_nullable,
    pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_value,
    pg_catalog.col_description(c.oid, a.attnum) AS comment
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_attrdef d
    ON d.adrelid = c.oid AND d.adnum = a.attnum
WHERE n.nspname = $1
  AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY c.relname, a.attnum";

#[tauri::command]
pub async fn postgres_list_columns_bulk(
    app: AppHandle,
    pools: State<'_, PgPoolRegistry>,
    id: String,
    schema: String,
    origin: Option<Origin>,
) -> AppResult<ColumnsBulkResult> {
    let started = Instant::now();
    let activity_origin = origin.unwrap_or_default();
    let parsed =
        Uuid::parse_str(&id).map_err(|e| AppError::Validation(format!("bad uuid: {e}")))?;

    tracing::info!("postgres_list_columns_bulk: id={parsed} schema={schema}");

    let inner: AppResult<ColumnsBulkResult> = async {
        let sslmode = pools.sslmode_for(&parsed).await?;
        let client = pools.acquire(&parsed).await?;
        let cancel_token = client.cancel_token();

        let rows = match timeout(
            BULK_TIMEOUT,
            client.query(SQL_LIST_COLUMNS_BULK, &[&schema]),
        )
        .await
        {
            Ok(Ok(rows)) => rows,
            Ok(Err(e)) => return Err(AppError::from(e)),
            Err(_) => {
                fire_cancel(cancel_token, sslmode).await;
                drop(client);
                return Err(AppError::postgres_with_code(
                    "57014",
                    format!("list columns bulk timed out ({}s)", BULK_TIMEOUT.as_secs()),
                ));
            }
        };

        let mut columns_by_relation: BTreeMap<String, Vec<BulkColumnInfo>> = BTreeMap::new();
        for row in rows {
            let relname: String = row.get(0);
            let info = BulkColumnInfo {
                name: row.get(1),
                data_type: row.get(2),
                ordinal_position: row.get(3),
                is_nullable: row.get(4),
                default_value: row.get(5),
                comment: row.get(6),
            };
            columns_by_relation.entry(relname).or_default().push(info);
        }

        Ok(ColumnsBulkResult {
            schema: schema.clone(),
            columns_by_relation,
        })
    }
    .await;

    let total_ms = started.elapsed().as_millis() as u64;
    let builder =
        ActivityLogEntryBuilder::new(ActivityKind::ListColumnsBulk, activity_origin, total_ms)
            .connection(parsed);
    match &inner {
        Ok(r) => {
            let total_cols: usize = r.columns_by_relation.values().map(|v| v.len()).sum();
            emit_activity(
                &app,
                builder.ok(Some(Metric::Items {
                    value: total_cols as u32,
                })),
            );
        }
        Err(e) => emit_activity(&app, builder.err(e)),
    }
    inner
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_includes_expected_joins_and_filters() {
        // Sanity check that the SQL reaches every catalog table we depend on.
        assert!(SQL_LIST_COLUMNS_BULK.contains("pg_catalog.pg_attribute"));
        assert!(SQL_LIST_COLUMNS_BULK.contains("pg_catalog.pg_class"));
        assert!(SQL_LIST_COLUMNS_BULK.contains("pg_catalog.pg_namespace"));
        assert!(SQL_LIST_COLUMNS_BULK.contains("pg_catalog.pg_attrdef"));
        assert!(SQL_LIST_COLUMNS_BULK.contains("pg_catalog.col_description"));
        // Filter clauses
        assert!(SQL_LIST_COLUMNS_BULK.contains("n.nspname = $1"));
        assert!(SQL_LIST_COLUMNS_BULK.contains("c.relkind IN ('r', 'v', 'm', 'p', 'f')"));
        assert!(SQL_LIST_COLUMNS_BULK.contains("a.attnum > 0"));
        assert!(SQL_LIST_COLUMNS_BULK.contains("NOT a.attisdropped"));
        // Ordering for stable output
        assert!(SQL_LIST_COLUMNS_BULK.contains("ORDER BY c.relname, a.attnum"));
    }

    #[test]
    fn bulk_column_info_serializes_with_snake_case() {
        let info = BulkColumnInfo {
            name: "id".into(),
            data_type: "bigint".into(),
            ordinal_position: 1,
            is_nullable: false,
            default_value: Some("nextval('seq')".into()),
            comment: Some("primary key".into()),
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json.get("name").unwrap(), "id");
        assert_eq!(json.get("data_type").unwrap(), "bigint");
        assert_eq!(json.get("ordinal_position").unwrap(), 1);
        assert_eq!(json.get("is_nullable").unwrap(), false);
        assert_eq!(json.get("default_value").unwrap(), "nextval('seq')");
        assert_eq!(json.get("comment").unwrap(), "primary key");
    }

    #[test]
    fn bulk_result_serializes_grouped() {
        let mut by_rel: BTreeMap<String, Vec<BulkColumnInfo>> = BTreeMap::new();
        by_rel.insert(
            "users".into(),
            vec![BulkColumnInfo {
                name: "id".into(),
                data_type: "bigint".into(),
                ordinal_position: 1,
                is_nullable: false,
                default_value: None,
                comment: None,
            }],
        );
        let result = ColumnsBulkResult {
            schema: "public".into(),
            columns_by_relation: by_rel,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json.get("schema").unwrap(), "public");
        let by_rel_json = json.get("columns_by_relation").unwrap();
        let users = by_rel_json.get("users").unwrap();
        assert!(users.is_array());
        assert_eq!(users.as_array().unwrap().len(), 1);
    }
}
