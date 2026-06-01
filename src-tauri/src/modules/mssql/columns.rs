//! MS SQL Server bulk columns cache command.
//!
//! `mssql_list_columns_bulk` — fetches all column metadata for every
//! browsable relation (table or view) in a schema in a single round-trip
//! and returns them grouped by table name.

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
use crate::modules::mssql::binding::{bind_kind_for_type, BindKind};
use crate::modules::mssql::errors::map_tiberius_error;
use crate::modules::mssql::pool::MssqlPoolRegistry;
use crate::modules::mssql::structure::build_full_type;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BULK_TIMEOUT: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// §13.1 — DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct BulkColumnInfo {
    pub name: String,
    /// Full type with size/precision, e.g. "nvarchar(255)", "decimal(18,4)".
    pub data_type: String,
    /// Base type name from sys.types, e.g. "nvarchar", "decimal".
    pub base_type: String,
    pub is_nullable: bool,
    pub is_identity: bool,
    pub is_computed: bool,
    /// character_max_length: normalized char length (not bytes) for N-types.
    /// -1 means MAX. `None` for non-string types.
    pub character_max_length: Option<i32>,
    /// Raw default expression from sys.default_constraints.definition.
    pub column_default: Option<String>,
    pub comment: Option<String>,
    pub ordinal: i32,
    pub bind_kind: BindKind,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ColumnsBulkResult {
    pub schema: String,
    pub columns_by_relation: BTreeMap<String, Vec<BulkColumnInfo>>,
}

// ---------------------------------------------------------------------------
// §13.1 — Row grouping helper (pure, testable)
// ---------------------------------------------------------------------------

/// Normalize max_length for character-type columns:
/// - For N-types (nvarchar, nchar): max_length from sys.columns is in bytes;
///   divide by 2 to get char count. -1 means MAX.
/// - For other types: return None (no character_max_length).
fn normalize_char_length(base_type: &str, max_length: i16) -> Option<i32> {
    let lower = base_type.to_ascii_lowercase();
    match lower.as_str() {
        "nvarchar" | "nchar" => {
            if max_length == -1 {
                Some(-1)
            } else {
                Some((max_length / 2) as i32)
            }
        }
        "varchar" | "char" | "binary" | "varbinary" => {
            if max_length == -1 {
                Some(-1)
            } else {
                Some(max_length as i32)
            }
        }
        _ => None,
    }
}

/// Group raw column rows into a `BTreeMap<table_name, Vec<BulkColumnInfo>>`.
pub fn group_bulk_columns(
    rows: Vec<(
        String,  // table_name
        String,  // column_name
        String,  // base_type
        i16,     // max_length (bytes)
        u8,      // precision
        u8,      // scale
        bool,    // is_nullable
        bool,    // is_identity
        bool,    // is_computed
        Option<String>, // default_expression
        Option<String>, // comment
        i32,     // column_id
    )>,
) -> BTreeMap<String, Vec<BulkColumnInfo>> {
    let mut map: BTreeMap<String, Vec<BulkColumnInfo>> = BTreeMap::new();
    for (table_name, col_name, base_type, max_length, precision, scale,
         is_nullable, is_identity, is_computed, default_expr, comment, ordinal) in rows
    {
        let full_type = build_full_type(&base_type, max_length, precision, scale);
        let character_max_length = normalize_char_length(&base_type, max_length);
        let bind_kind = bind_kind_for_type(
            &base_type,
            Some(max_length as i32),
            Some(precision),
            Some(scale),
        );
        let col = BulkColumnInfo {
            name: col_name,
            data_type: full_type,
            base_type,
            is_nullable,
            is_identity,
            is_computed,
            character_max_length,
            column_default: default_expr,
            comment,
            ordinal,
            bind_kind,
        };
        map.entry(table_name).or_default().push(col);
    }
    map
}

// ---------------------------------------------------------------------------
// §13.1 — mssql_list_columns_bulk command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mssql_list_columns_bulk(
    app: AppHandle,
    registry: State<'_, MssqlPoolRegistry>,
    id: Uuid,
    schema: String,
    origin: Option<Origin>,
) -> AppResult<ColumnsBulkResult> {
    let started = Instant::now();
    let activity_origin = origin.unwrap_or(Origin::Auto);

    let mut client = registry.acquire(id).await?;

    let result = timeout(BULK_TIMEOUT, async {
        // Query sys.columns joined with sys.tables + sys.views (UNION to cover both)
        // + sys.schemas + sys.types, filtered by schema name.
        // Includes is_nullable, is_identity, is_computed, default expression,
        // and MS_Description extended property comment.
        let sql = "
SELECT
    t.name AS table_name,
    c.name AS column_name,
    ty.name AS base_type,
    c.max_length,
    c.precision,
    c.scale,
    c.is_nullable,
    c.is_identity,
    c.is_computed,
    dc.definition AS default_expression,
    CAST(ep.value AS NVARCHAR(MAX)) AS comment,
    c.column_id
FROM sys.columns c
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
LEFT JOIN sys.extended_properties ep
    ON ep.major_id = c.object_id AND ep.minor_id = c.column_id
    AND ep.name = 'MS_Description' AND ep.class = 1
WHERE s.name = @P1

UNION ALL

SELECT
    v.name AS table_name,
    c.name AS column_name,
    ty.name AS base_type,
    c.max_length,
    c.precision,
    c.scale,
    c.is_nullable,
    c.is_identity,
    c.is_computed,
    NULL AS default_expression,
    CAST(ep.value AS NVARCHAR(MAX)) AS comment,
    c.column_id
FROM sys.columns c
JOIN sys.views v ON v.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = v.schema_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.extended_properties ep
    ON ep.major_id = c.object_id AND ep.minor_id = c.column_id
    AND ep.name = 'MS_Description' AND ep.class = 1
WHERE s.name = @P1

ORDER BY table_name, column_id
";

        let rows = client
            .query(sql, &[&schema.as_str()])
            .await
            .map_err(map_tiberius_error)?
            .into_first_result()
            .await
            .map_err(map_tiberius_error)?;

        let mut raw_rows: Vec<(
            String, String, String, i16, u8, u8,
            bool, bool, bool, Option<String>, Option<String>, i32,
        )> = Vec::with_capacity(rows.len());

        for row in &rows {
            let table_name: &str = row.get(0).unwrap_or_default();
            let column_name: &str = row.get(1).unwrap_or_default();
            let base_type: &str = row.get(2).unwrap_or_default();
            let max_length: i16 = row.get::<i16, _>(3).unwrap_or(0);
            let precision: u8 = row.get::<u8, _>(4).unwrap_or(0);
            let scale: u8 = row.get::<u8, _>(5).unwrap_or(0);
            let is_nullable: bool = row.get::<bool, _>(6).unwrap_or(false);
            let is_identity: bool = row.get::<bool, _>(7).unwrap_or(false);
            let is_computed: bool = row.get::<bool, _>(8).unwrap_or(false);
            let default_expr: Option<&str> = row.get(9);
            let comment: Option<&str> = row.get(10);
            let column_id: i32 = row.get::<i32, _>(11).unwrap_or(0);

            raw_rows.push((
                table_name.to_string(),
                column_name.to_string(),
                base_type.to_string(),
                max_length,
                precision,
                scale,
                is_nullable,
                is_identity,
                is_computed,
                default_expr.map(|s| s.to_string()),
                comment.map(|s| s.to_string()),
                column_id,
            ));
        }

        let columns_by_relation = group_bulk_columns(raw_rows);
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
        Err(_elapsed) => Err(AppError::mssql(format!(
            "list_columns_bulk timed out ({}s)",
            BULK_TIMEOUT.as_secs()
        ))),
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
// §13.2 — Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_row(
        table: &str,
        col: &str,
        base_type: &str,
        max_length: i16,
        precision: u8,
        scale: u8,
        nullable: bool,
        is_identity: bool,
        is_computed: bool,
        default_expr: Option<&str>,
        comment: Option<&str>,
        ordinal: i32,
    ) -> (
        String,
        String,
        String,
        i16,
        u8,
        u8,
        bool,
        bool,
        bool,
        Option<String>,
        Option<String>,
        i32,
    ) {
        (
            table.to_string(),
            col.to_string(),
            base_type.to_string(),
            max_length,
            precision,
            scale,
            nullable,
            is_identity,
            is_computed,
            default_expr.map(|s| s.to_string()),
            comment.map(|s| s.to_string()),
            ordinal,
        )
    }

    #[test]
    fn group_single_table_two_columns() {
        let rows = vec![
            make_row("users", "id", "int", 4, 10, 0, false, true, false, None, None, 1),
            make_row("users", "email", "nvarchar", 510, 0, 0, true, false, false, None, Some("email address"), 2),
        ];
        let result = group_bulk_columns(rows);
        assert_eq!(result.len(), 1);
        let cols = result.get("users").unwrap();
        assert_eq!(cols.len(), 2);
        assert_eq!(cols[0].name, "id");
        assert_eq!(cols[0].is_identity, true);
        assert_eq!(cols[0].is_nullable, false);
        assert_eq!(cols[0].base_type, "int");
        assert_eq!(cols[1].name, "email");
        // nvarchar(510 bytes) = 255 chars
        assert_eq!(cols[1].character_max_length, Some(255));
        assert_eq!(cols[1].data_type, "nvarchar(255)");
        assert_eq!(cols[1].comment.as_deref(), Some("email address"));
    }

    #[test]
    fn group_multiple_tables() {
        let rows = vec![
            make_row("orders", "id", "int", 4, 10, 0, false, false, false, None, None, 1),
            make_row("users", "id", "bigint", 8, 19, 0, false, true, false, None, None, 1),
            make_row("users", "name", "nvarchar", 202, 0, 0, true, false, false, None, None, 2),
        ];
        let result = group_bulk_columns(rows);
        assert_eq!(result.len(), 2);
        assert!(result.contains_key("orders"));
        assert!(result.contains_key("users"));
        assert_eq!(result["users"].len(), 2);
        // nvarchar(202 bytes) = 101 chars
        assert_eq!(result["users"][1].character_max_length, Some(101));
    }

    #[test]
    fn nvarchar_max_normalizes_correctly() {
        let rows = vec![
            make_row("t", "body", "nvarchar", -1, 0, 0, true, false, false, None, None, 1),
        ];
        let result = group_bulk_columns(rows);
        let col = &result["t"][0];
        assert_eq!(col.data_type, "nvarchar(max)");
        assert_eq!(col.character_max_length, Some(-1));
    }

    #[test]
    fn varchar_max_normalizes_correctly() {
        let rows = vec![
            make_row("t", "txt", "varchar", -1, 0, 0, true, false, false, None, None, 1),
        ];
        let result = group_bulk_columns(rows);
        let col = &result["t"][0];
        assert_eq!(col.data_type, "varchar(max)");
        assert_eq!(col.character_max_length, Some(-1));
    }

    #[test]
    fn decimal_precision_scale_in_full_type() {
        let rows = vec![
            make_row("t", "price", "decimal", 9, 18, 4, false, false, false, None, None, 1),
        ];
        let result = group_bulk_columns(rows);
        let col = &result["t"][0];
        assert_eq!(col.data_type, "decimal(18,4)");
        assert_eq!(col.character_max_length, None);
    }

    #[test]
    fn default_expression_preserved() {
        let rows = vec![
            make_row(
                "t",
                "created_at",
                "datetime2",
                8,
                0,
                7,
                false,
                false,
                false,
                Some("(SYSUTCDATETIME())"),
                Some("row insertion timestamp"),
                1,
            ),
        ];
        let result = group_bulk_columns(rows);
        let col = &result["t"][0];
        assert_eq!(col.column_default.as_deref(), Some("(SYSUTCDATETIME())"));
        assert_eq!(col.comment.as_deref(), Some("row insertion timestamp"));
        assert_eq!(col.data_type, "datetime2(7)");
    }

    #[test]
    fn no_default_or_comment_is_none() {
        let rows = vec![
            make_row("t", "col", "int", 4, 10, 0, false, false, false, None, None, 1),
        ];
        let result = group_bulk_columns(rows);
        let col = &result["t"][0];
        assert!(col.column_default.is_none());
        assert!(col.comment.is_none());
    }

    #[test]
    fn empty_schema_returns_empty_map() {
        let rows: Vec<(String, String, String, i16, u8, u8, bool, bool, bool, Option<String>, Option<String>, i32)> = vec![];
        let result = group_bulk_columns(rows);
        assert!(result.is_empty());
    }

    #[test]
    fn normalize_char_length_nchar() {
        // nchar(10) = 20 bytes in sys.columns
        assert_eq!(normalize_char_length("nchar", 20), Some(10));
    }

    #[test]
    fn normalize_char_length_varchar() {
        assert_eq!(normalize_char_length("varchar", 100), Some(100));
    }

    #[test]
    fn normalize_char_length_int_is_none() {
        assert_eq!(normalize_char_length("int", 4), None);
    }

    #[test]
    fn computed_column_flag() {
        let rows = vec![
            make_row("t", "full_name", "nvarchar", 202, 0, 0, false, false, true, None, None, 1),
        ];
        let result = group_bulk_columns(rows);
        assert!(result["t"][0].is_computed);
    }
}
