//! MS SQL Server table structure & DDL commands.
//!
//! - `mssql_table_structure` — concurrent sys.* queries for all structural
//!   facets of a table (columns, PK, unique constraints, FKs, indexes,
//!   check constraints, default constraints, triggers, table options).
//! - `mssql_table_ddl` — synthesized CREATE TABLE for tables;
//!   OBJECT_DEFINITION for views / procedures / functions / triggers.

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, State};
use tokio::time::timeout;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::mssql::binding::{bind_kind_for_type, mssql_quote_ident, BindKind};
use crate::modules::mssql::errors::map_tiberius_error;
use crate::modules::mssql::pool::{map_bb8_error, MssqlPoolRegistry};
use crate::modules::mssql::schema_types::KindFailure;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STRUCTURE_TOTAL_TIMEOUT: Duration = Duration::from_secs(10);
const PER_QUERY_TIMEOUT: Duration = Duration::from_secs(8);
const DDL_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// §12.3 — DTO types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ColumnInfo {
    pub name: String,
    pub ordinal: i32,
    pub data_type: String,
    pub full_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub comment: Option<String>,
    pub collation: Option<String>,
    pub is_identity: bool,
    pub identity_seed: Option<i64>,
    pub identity_increment: Option<i64>,
    pub is_computed: bool,
    pub computed_expression: Option<String>,
    pub is_persisted: bool,
    pub is_sparse: bool,
    pub category: String,
    pub bind_kind: BindKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct PrimaryKeyInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub identity_column: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct UniqueConstraintInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub is_clustered: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ForeignKeyInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub referenced_schema: String,
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
    pub is_disabled: bool,
    pub is_not_trusted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct IndexColumnInfo {
    pub name: String,
    pub direction: String, // "ASC" | "DESC"
    pub is_included: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<IndexColumnInfo>,
    pub unique: bool,
    pub r#type: String, // "CLUSTERED" | "NONCLUSTERED" | "XML" | "SPATIAL" | "COLUMNSTORE" | "HEAP"
    pub is_column_store: bool,
    pub filter_definition: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CheckConstraintInfo {
    pub name: String,
    pub definition: String,
    pub is_disabled: bool,
    pub is_not_trusted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DefaultConstraintInfo {
    pub name: String,
    pub column: String,
    pub definition: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TriggerStructInfo {
    pub name: String,
    pub event: String,  // e.g. "INSERT,UPDATE"
    pub timing: String, // "AFTER" | "INSTEAD OF"
    pub is_disabled: bool,
    pub definition: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TableOptionsInfo {
    pub is_memory_optimized: bool,
    pub temporal_type: String,
    pub lock_escalation_desc: Option<String>,
    pub is_partitioned: bool,
    pub filegroup: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TableStructureResult {
    pub schema: String,
    pub relation: String,
    pub columns: Option<Vec<ColumnInfo>>,
    pub primary_key: Option<PrimaryKeyInfo>,
    pub unique_constraints: Option<Vec<UniqueConstraintInfo>>,
    pub foreign_keys: Option<Vec<ForeignKeyInfo>>,
    pub indexes: Option<Vec<IndexInfo>>,
    pub check_constraints: Option<Vec<CheckConstraintInfo>>,
    pub default_constraints: Option<Vec<DefaultConstraintInfo>>,
    pub triggers: Option<Vec<TriggerStructInfo>>,
    pub table_options: Option<TableOptionsInfo>,
    pub failures: Vec<KindFailure>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DdlResult {
    pub ddl: Option<String>,
    pub kind: String, // "table" | "view" | "procedure" | "function" | "trigger"
    pub is_encrypted: bool,
    pub synthesized: bool,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Build the `full_type` string from base type + size/precision/scale.
/// For nvarchar/nchar: max_length in sys.columns is bytes; divide by 2 for chars.
/// -1 means MAX.
pub fn build_full_type(base_type: &str, max_length: i16, precision: u8, scale: u8) -> String {
    let lower = base_type.to_ascii_lowercase();
    match lower.as_str() {
        // Variable-length string types — max_length is bytes, divide by 2 for N-types.
        "nvarchar" | "nchar" => {
            if max_length == -1 {
                format!("{base_type}(max)")
            } else {
                format!("{base_type}({})", max_length / 2)
            }
        }
        "varchar" | "char" | "binary" | "varbinary" => {
            if max_length == -1 {
                format!("{base_type}(max)")
            } else {
                format!("{base_type}({max_length})")
            }
        }
        // Precision/scale types.
        "decimal" | "numeric" => {
            if precision > 0 {
                format!("{base_type}({precision},{scale})")
            } else {
                base_type.to_string()
            }
        }
        "datetime2" | "datetimeoffset" | "time" => {
            if scale > 0 || lower == "datetime2" || lower == "datetimeoffset" {
                format!("{base_type}({scale})")
            } else {
                base_type.to_string()
            }
        }
        "float" => {
            // float(53) is the default double; float(24) is real-precision.
            if precision > 0 && precision != 53 {
                format!("{base_type}({precision})")
            } else {
                base_type.to_string()
            }
        }
        _ => base_type.to_string(),
    }
}

/// Derive the column category from the base type name.
pub fn category_for_type(base_type: &str) -> &'static str {
    let lower = base_type.to_ascii_lowercase();
    match lower.as_str() {
        "bit" | "tinyint" | "smallint" | "int" | "bigint" | "decimal" | "numeric" | "money"
        | "smallmoney" | "float" | "real" => "numeric",
        "char" | "varchar" | "nchar" | "nvarchar" | "text" | "ntext" => "string",
        "date" | "time" | "datetime" | "datetime2" | "datetimeoffset" | "smalldatetime" => {
            "temporal"
        }
        "binary" | "varbinary" | "image" => "binary",
        "geography" | "geometry" => "spatial",
        "xml" => "xml",
        "uniqueidentifier" => "uniqueidentifier",
        "hierarchyid" => "hierarchyid",
        "sql_variant" => "sql_variant",
        _ => "other",
    }
}

/// Map an `AppError` into a `KindFailure`.
fn map_failure(kind: &str, err: AppError) -> KindFailure {
    let (code, message) = match err {
        AppError::Mssql(body) => (body.code, body.message),
        other => (None, other.to_string()),
    };
    KindFailure {
        kind: kind.to_string(),
        code,
        message,
    }
}

fn map_tib<T>(
    res: Result<Result<T, AppError>, tokio::time::error::Elapsed>,
    kind: &str,
    failures: &mut Vec<KindFailure>,
) -> Option<T> {
    match res {
        Ok(Ok(v)) => Some(v),
        Ok(Err(e)) => {
            failures.push(map_failure(kind, e));
            None
        }
        Err(_) => {
            failures.push(KindFailure {
                kind: kind.to_string(),
                code: None,
                message: format!("{kind} query timed out ({}s)", PER_QUERY_TIMEOUT.as_secs()),
            });
            None
        }
    }
}

// ---------------------------------------------------------------------------
// §12.1 — Sub-query implementations
// ---------------------------------------------------------------------------

async fn fetch_columns(
    client: &mut bb8::PooledConnection<'static, bb8_tiberius::ConnectionManager>,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<ColumnInfo>> {
    // Join sys.columns + sys.types + sys.identity_columns + sys.computed_columns
    // + sys.default_constraints + sys.extended_properties (MS_Description).
    let sql = "
SELECT
    c.name AS col_name,
    c.column_id AS ordinal,
    ty.name AS base_type,
    c.max_length,
    c.precision,
    c.scale,
    c.is_nullable,
    c.is_identity,
    c.is_computed,
    c.is_sparse,
    ic.seed_value AS identity_seed,
    ic.increment_value AS identity_increment,
    cc.definition AS computed_expr,
    cc.is_persisted AS is_persisted,
    dc.definition AS default_expr,
    CAST(ep.value AS NVARCHAR(MAX)) AS comment,
    c.collation_name
FROM sys.columns c
JOIN sys.objects o ON o.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
LEFT JOIN sys.extended_properties ep
    ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
    AND ep.class = 1
WHERE s.name = @P1 AND o.name = @P2
ORDER BY c.column_id
";
    let rows = client
        .query(sql, &[&schema, &relation])
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let mut cols: Vec<ColumnInfo> = Vec::with_capacity(rows.len());
    for row in &rows {
        let col_name: &str = row.get(0).unwrap_or_default();
        let ordinal: i32 = row.get::<i32, _>(1).unwrap_or(0);
        let base_type: &str = row.get(2).unwrap_or_default();
        let max_length: i16 = row.get::<i16, _>(3).unwrap_or(0);
        let precision: u8 = row.get::<u8, _>(4).unwrap_or(0);
        let scale: u8 = row.get::<u8, _>(5).unwrap_or(0);
        let is_nullable: bool = row.get::<bool, _>(6).unwrap_or(false);
        let is_identity: bool = row.get::<bool, _>(7).unwrap_or(false);
        let is_computed: bool = row.get::<bool, _>(8).unwrap_or(false);
        let is_sparse: bool = row.get::<bool, _>(9).unwrap_or(false);
        let identity_seed: Option<&str> = row.get(10);
        let identity_increment: Option<&str> = row.get(11);
        let computed_expr: Option<&str> = row.get(12);
        let is_persisted: Option<bool> = row.get(13);
        let default_expr: Option<&str> = row.get(14);
        let comment: Option<&str> = row.get(15);
        let collation: Option<&str> = row.get(16);

        let full_type = build_full_type(base_type, max_length, precision, scale);
        let category = category_for_type(base_type).to_string();
        let bind_kind = bind_kind_for_type(
            base_type,
            Some(max_length as i32),
            Some(precision),
            Some(scale),
        );

        // identity_seed / increment come from sys.identity_columns as sql_variant
        // which tiberius may decode as a string. Parse as i64.
        let seed_val = identity_seed.and_then(|s| s.parse::<i64>().ok());
        let inc_val = identity_increment.and_then(|s| s.parse::<i64>().ok());

        cols.push(ColumnInfo {
            name: col_name.to_string(),
            ordinal,
            data_type: base_type.to_string(),
            full_type,
            nullable: is_nullable,
            default: default_expr.map(|s| s.to_string()),
            comment: comment.map(|s| s.to_string()),
            collation: collation.map(|s| s.to_string()),
            is_identity,
            identity_seed: seed_val,
            identity_increment: inc_val,
            is_computed,
            computed_expression: computed_expr.map(|s| s.to_string()),
            is_persisted: is_persisted.unwrap_or(false),
            is_sparse,
            category,
            bind_kind,
        });
    }

    Ok(cols)
}

async fn fetch_primary_key(
    client: &mut bb8::PooledConnection<'static, bb8_tiberius::ConnectionManager>,
    schema: &str,
    relation: &str,
) -> AppResult<Option<PrimaryKeyInfo>> {
    let sql = "
SELECT
    i.name AS index_name,
    c.name AS col_name,
    c.is_identity
FROM sys.indexes i
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
JOIN sys.objects o ON o.object_id = i.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE s.name = @P1 AND o.name = @P2 AND i.is_primary_key = 1 AND ic.is_included_column = 0
ORDER BY ic.key_ordinal
";
    let rows = client
        .query(sql, &[&schema, &relation])
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    if rows.is_empty() {
        return Ok(None);
    }

    let index_name: String = rows[0].get::<&str, _>(0).unwrap_or_default().to_string();
    let mut columns: Vec<String> = Vec::new();
    let mut identity_column: Option<String> = None;

    for row in &rows {
        let col_name: &str = row.get(1).unwrap_or_default();
        let is_identity: bool = row.get::<bool, _>(2).unwrap_or(false);
        if is_identity {
            identity_column = Some(col_name.to_string());
        }
        columns.push(col_name.to_string());
    }

    Ok(Some(PrimaryKeyInfo {
        name: index_name,
        columns,
        identity_column,
    }))
}

async fn fetch_unique_constraints(
    client: &mut bb8::PooledConnection<'static, bb8_tiberius::ConnectionManager>,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<UniqueConstraintInfo>> {
    let sql = "
SELECT
    i.name AS constraint_name,
    c.name AS col_name,
    i.type_desc
FROM sys.indexes i
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
JOIN sys.objects o ON o.object_id = i.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE s.name = @P1 AND o.name = @P2
  AND i.is_unique_constraint = 1 AND ic.is_included_column = 0
ORDER BY i.name, ic.key_ordinal
";
    let rows = client
        .query(sql, &[&schema, &relation])
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let mut map: Vec<UniqueConstraintInfo> = Vec::new();
    for row in &rows {
        let constraint_name: &str = row.get(0).unwrap_or_default();
        let col_name: &str = row.get(1).unwrap_or_default();
        let type_desc: &str = row.get(2).unwrap_or_default();
        let is_clustered = type_desc.eq_ignore_ascii_case("CLUSTERED");

        if let Some(last) = map.last_mut() {
            if last.name == constraint_name {
                last.columns.push(col_name.to_string());
                continue;
            }
        }
        map.push(UniqueConstraintInfo {
            name: constraint_name.to_string(),
            columns: vec![col_name.to_string()],
            is_clustered,
        });
    }
    Ok(map)
}

async fn fetch_foreign_keys(
    client: &mut bb8::PooledConnection<'static, bb8_tiberius::ConnectionManager>,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<ForeignKeyInfo>> {
    let sql = "
SELECT
    fk.name AS fk_name,
    c.name AS col_name,
    rs.name AS ref_schema,
    ro.name AS ref_table,
    rc.name AS ref_col,
    fk.update_referential_action_desc,
    fk.delete_referential_action_desc,
    fk.is_disabled,
    fk.is_not_trusted
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
JOIN sys.objects ro ON ro.object_id = fk.referenced_object_id
JOIN sys.schemas rs ON rs.schema_id = ro.schema_id
JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
JOIN sys.objects o ON o.object_id = fk.parent_object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE s.name = @P1 AND o.name = @P2
ORDER BY fk.name, fkc.constraint_column_id
";
    let rows = client
        .query(sql, &[&schema, &relation])
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let mut fks: Vec<ForeignKeyInfo> = Vec::new();
    for row in &rows {
        let fk_name: &str = row.get(0).unwrap_or_default();
        let col_name: &str = row.get(1).unwrap_or_default();
        let ref_schema: &str = row.get(2).unwrap_or_default();
        let ref_table: &str = row.get(3).unwrap_or_default();
        let ref_col: &str = row.get(4).unwrap_or_default();
        let on_update: &str = row.get(5).unwrap_or("NO_ACTION");
        let on_delete: &str = row.get(6).unwrap_or("NO_ACTION");
        let is_disabled: bool = row.get::<bool, _>(7).unwrap_or(false);
        let is_not_trusted: bool = row.get::<bool, _>(8).unwrap_or(false);

        if let Some(last) = fks.last_mut() {
            if last.name == fk_name {
                last.columns.push(col_name.to_string());
                last.referenced_columns.push(ref_col.to_string());
                continue;
            }
        }
        fks.push(ForeignKeyInfo {
            name: fk_name.to_string(),
            columns: vec![col_name.to_string()],
            referenced_schema: ref_schema.to_string(),
            referenced_table: ref_table.to_string(),
            referenced_columns: vec![ref_col.to_string()],
            on_update: on_update.to_string(),
            on_delete: on_delete.to_string(),
            is_disabled,
            is_not_trusted,
        });
    }
    Ok(fks)
}

async fn fetch_indexes(
    client: &mut bb8::PooledConnection<'static, bb8_tiberius::ConnectionManager>,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<IndexInfo>> {
    let sql = "
SELECT
    i.name AS index_name,
    c.name AS col_name,
    i.is_unique,
    i.type_desc,
    ic.is_descending_key,
    ic.is_included_column,
    i.filter_definition
FROM sys.indexes i
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
JOIN sys.objects o ON o.object_id = i.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE s.name = @P1 AND o.name = @P2
  AND i.is_primary_key = 0 AND i.is_unique_constraint = 0
  AND i.type != 0  -- exclude HEAP pseudo-index
ORDER BY i.name, ic.key_ordinal, ic.index_column_id
";
    let rows = client
        .query(sql, &[&schema, &relation])
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let mut indexes: Vec<IndexInfo> = Vec::new();
    for row in &rows {
        let index_name: &str = row.get(0).unwrap_or_default();
        let col_name: &str = row.get(1).unwrap_or_default();
        let is_unique: bool = row.get::<bool, _>(2).unwrap_or(false);
        let type_desc: &str = row.get(3).unwrap_or_default();
        let is_descending: bool = row.get::<bool, _>(4).unwrap_or(false);
        let is_included: bool = row.get::<bool, _>(5).unwrap_or(false);
        let filter_def: Option<&str> = row.get(6);

        let direction = if is_descending { "DESC" } else { "ASC" }.to_string();
        let col_entry = IndexColumnInfo {
            name: col_name.to_string(),
            direction,
            is_included,
        };

        let type_upper = type_desc.to_ascii_uppercase();
        let index_type_str = if type_upper.contains("COLUMNSTORE") {
            "COLUMNSTORE".to_string()
        } else if type_upper.contains("XML") {
            "XML".to_string()
        } else if type_upper.contains("SPATIAL") {
            "SPATIAL".to_string()
        } else {
            type_upper.clone()
        };
        let is_column_store = type_upper.contains("COLUMNSTORE");

        if let Some(last) = indexes.last_mut() {
            if last.name == index_name {
                last.columns.push(col_entry);
                continue;
            }
        }
        indexes.push(IndexInfo {
            name: index_name.to_string(),
            columns: vec![col_entry],
            unique: is_unique,
            r#type: index_type_str,
            is_column_store,
            filter_definition: filter_def.map(|s| s.to_string()),
        });
    }
    Ok(indexes)
}

async fn fetch_check_constraints(
    client: &mut bb8::PooledConnection<'static, bb8_tiberius::ConnectionManager>,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<CheckConstraintInfo>> {
    let sql = "
SELECT
    cc.name,
    cc.definition,
    cc.is_disabled,
    cc.is_not_trusted
FROM sys.check_constraints cc
JOIN sys.objects o ON o.object_id = cc.parent_object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE s.name = @P1 AND o.name = @P2
ORDER BY cc.name
";
    let rows = client
        .query(sql, &[&schema, &relation])
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let mut result: Vec<CheckConstraintInfo> = Vec::new();
    for row in &rows {
        let name: &str = row.get(0).unwrap_or_default();
        let definition: &str = row.get(1).unwrap_or_default();
        let is_disabled: bool = row.get::<bool, _>(2).unwrap_or(false);
        let is_not_trusted: bool = row.get::<bool, _>(3).unwrap_or(false);
        result.push(CheckConstraintInfo {
            name: name.to_string(),
            definition: definition.to_string(),
            is_disabled,
            is_not_trusted,
        });
    }
    Ok(result)
}

async fn fetch_default_constraints(
    client: &mut bb8::PooledConnection<'static, bb8_tiberius::ConnectionManager>,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<DefaultConstraintInfo>> {
    let sql = "
SELECT
    dc.name AS constraint_name,
    c.name AS column_name,
    dc.definition
FROM sys.default_constraints dc
JOIN sys.objects o ON o.object_id = dc.parent_object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
WHERE s.name = @P1 AND o.name = @P2
ORDER BY dc.name
";
    let rows = client
        .query(sql, &[&schema, &relation])
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let mut result: Vec<DefaultConstraintInfo> = Vec::new();
    for row in &rows {
        let constraint_name: &str = row.get(0).unwrap_or_default();
        let column_name: &str = row.get(1).unwrap_or_default();
        let definition: &str = row.get(2).unwrap_or_default();
        result.push(DefaultConstraintInfo {
            name: constraint_name.to_string(),
            column: column_name.to_string(),
            definition: definition.to_string(),
        });
    }
    Ok(result)
}

async fn fetch_triggers(
    client: &mut bb8::PooledConnection<'static, bb8_tiberius::ConnectionManager>,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<TriggerStructInfo>> {
    // Fetch triggers and their events from sys.triggers + sys.trigger_events.
    let sql = "
SELECT
    t.name AS trigger_name,
    STRING_AGG(CAST(te.type_desc AS NVARCHAR(MAX)), ',')
        WITHIN GROUP (ORDER BY te.type_desc) AS events,
    t.is_instead_of_trigger,
    t.is_disabled,
    OBJECT_DEFINITION(t.object_id) AS definition
FROM sys.triggers t
JOIN sys.trigger_events te ON te.object_id = t.object_id
JOIN sys.objects o ON o.object_id = t.parent_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE s.name = @P1 AND o.name = @P2
GROUP BY t.name, t.is_instead_of_trigger, t.is_disabled, t.object_id
ORDER BY t.name
";
    let rows = client
        .query(sql, &[&schema, &relation])
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let mut result: Vec<TriggerStructInfo> = Vec::new();
    for row in &rows {
        let trigger_name: &str = row.get(0).unwrap_or_default();
        let events: &str = row.get(1).unwrap_or_default();
        let is_instead_of: bool = row.get::<bool, _>(2).unwrap_or(false);
        let is_disabled: bool = row.get::<bool, _>(3).unwrap_or(false);
        let definition: Option<&str> = row.get(4);

        let timing = if is_instead_of { "INSTEAD OF" } else { "AFTER" };
        result.push(TriggerStructInfo {
            name: trigger_name.to_string(),
            event: events.to_uppercase(),
            timing: timing.to_string(),
            is_disabled,
            definition: definition.map(|s| s.to_string()),
        });
    }
    Ok(result)
}

async fn fetch_table_options(
    client: &mut bb8::PooledConnection<'static, bb8_tiberius::ConnectionManager>,
    schema: &str,
    relation: &str,
) -> AppResult<Option<TableOptionsInfo>> {
    let sql = "
SELECT
    t.is_memory_optimized,
    t.temporal_type_desc,
    t.lock_escalation_desc,
    CASE WHEN t.partition_scheme_id IS NOT NULL AND t.partition_scheme_id != 0 THEN 1 ELSE 0 END AS is_partitioned,
    ds.name AS filegroup_name
FROM sys.tables t
JOIN sys.objects o ON o.object_id = t.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
LEFT JOIN sys.data_spaces ds ON ds.data_space_id = t.lob_data_space_id
WHERE s.name = @P1 AND o.name = @P2
";
    let rows = client
        .query(sql, &[&schema, &relation])
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    if let Some(row) = rows.first() {
        let is_memory_optimized: bool = row.get::<bool, _>(0).unwrap_or(false);
        let temporal_type: &str = row.get(1).unwrap_or("NON_TEMPORAL_TABLE");
        let lock_escalation: Option<&str> = row.get(2);
        let is_partitioned: bool = row.get::<i32, _>(3).unwrap_or(0) != 0;
        let filegroup: Option<&str> = row.get(4);

        Ok(Some(TableOptionsInfo {
            is_memory_optimized,
            temporal_type: temporal_type.to_string(),
            lock_escalation_desc: lock_escalation.map(|s| s.to_string()),
            is_partitioned,
            filegroup: filegroup.map(|s| s.to_string()),
        }))
    } else {
        Ok(None)
    }
}

// ---------------------------------------------------------------------------
// §12.1 — mssql_table_structure command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mssql_table_structure(
    app: AppHandle,
    registry: State<'_, MssqlPoolRegistry>,
    id: Uuid,
    schema: String,
    relation: String,
    origin: Option<Origin>,
) -> AppResult<TableStructureResult> {
    let started = Instant::now();
    let activity_origin = origin.unwrap_or(Origin::Auto);

    // We need 9 independent connections to run queries concurrently.
    // We acquire separate connections per sub-query to avoid ordering issues
    // with the tiberius client which processes one query at a time.
    // For simplicity in v1, we run concurrently using separate acquired clients.
    let pool = registry.get_pool(id)?;

    let inner_result =
        timeout(STRUCTURE_TOTAL_TIMEOUT, async {
            // Acquire 9 clients for concurrent sub-queries.
            async fn get_client(
                pool: &bb8::Pool<bb8_tiberius::ConnectionManager>,
            ) -> AppResult<bb8::PooledConnection<'static, bb8_tiberius::ConnectionManager>>
            {
                let leaked: &'static bb8::Pool<bb8_tiberius::ConnectionManager> =
                    Box::leak(Box::new(pool.clone()));
                leaked.get().await.map_err(map_bb8_error)
            }

            let (c0r, c1r, c2r, c3r, c4r, c5r, c6r, c7r, c8r) = tokio::join!(
                get_client(&pool),
                get_client(&pool),
                get_client(&pool),
                get_client(&pool),
                get_client(&pool),
                get_client(&pool),
                get_client(&pool),
                get_client(&pool),
                get_client(&pool),
            );

            let mut c0 = c0r?;
            let mut c1 = c1r?;
            let mut c2 = c2r?;
            let mut c3 = c3r?;
            let mut c4 = c4r?;
            let mut c5 = c5r?;
            let mut c6 = c6r?;
            let mut c7 = c7r?;
            let mut c8 = c8r?;

            let s = schema.as_str();
            let r = relation.as_str();

            let (
                cols_res,
                pk_res,
                unique_res,
                fk_res,
                idx_res,
                check_res,
                def_res,
                trig_res,
                opts_res,
            ) = tokio::join!(
                timeout(PER_QUERY_TIMEOUT, fetch_columns(&mut c0, s, r)),
                timeout(PER_QUERY_TIMEOUT, fetch_primary_key(&mut c1, s, r)),
                timeout(PER_QUERY_TIMEOUT, fetch_unique_constraints(&mut c2, s, r)),
                timeout(PER_QUERY_TIMEOUT, fetch_foreign_keys(&mut c3, s, r)),
                timeout(PER_QUERY_TIMEOUT, fetch_indexes(&mut c4, s, r)),
                timeout(PER_QUERY_TIMEOUT, fetch_check_constraints(&mut c5, s, r)),
                timeout(PER_QUERY_TIMEOUT, fetch_default_constraints(&mut c6, s, r)),
                timeout(PER_QUERY_TIMEOUT, fetch_triggers(&mut c7, s, r)),
                timeout(PER_QUERY_TIMEOUT, fetch_table_options(&mut c8, s, r)),
            );

            let mut failures: Vec<KindFailure> = Vec::new();

            // Columns are required.
            let columns: Vec<ColumnInfo> = match cols_res {
                Ok(Ok(v)) => v,
                Ok(Err(e)) => return Err(e),
                Err(_) => {
                    return Err(AppError::mssql(format!(
                        "columns query timed out ({}s)",
                        PER_QUERY_TIMEOUT.as_secs()
                    )));
                }
            };

            // Primary key — optional.
            let primary_key = match pk_res {
                Ok(Ok(v)) => v,
                Ok(Err(e)) => {
                    failures.push(map_failure("primary_key", e));
                    None
                }
                Err(_) => {
                    failures.push(KindFailure {
                        kind: "primary_key".into(),
                        code: None,
                        message: format!(
                            "primary_key query timed out ({}s)",
                            PER_QUERY_TIMEOUT.as_secs()
                        ),
                    });
                    None
                }
            };

            let unique_constraints = map_tib(unique_res, "unique_constraints", &mut failures);
            let foreign_keys = map_tib(fk_res, "foreign_keys", &mut failures);
            let indexes = map_tib(idx_res, "indexes", &mut failures);
            let check_constraints = map_tib(check_res, "check_constraints", &mut failures);
            let default_constraints = map_tib(def_res, "default_constraints", &mut failures);
            let triggers = map_tib(trig_res, "triggers", &mut failures);
            let table_options: Option<TableOptionsInfo> = match opts_res {
                Ok(Ok(v)) => v,
                Ok(Err(e)) => {
                    failures.push(map_failure("table_options", e));
                    None
                }
                Err(_) => {
                    failures.push(KindFailure {
                        kind: "table_options".into(),
                        code: None,
                        message: format!(
                            "table_options query timed out ({}s)",
                            PER_QUERY_TIMEOUT.as_secs()
                        ),
                    });
                    None
                }
            };

            Ok(TableStructureResult {
                schema: schema.clone(),
                relation: relation.clone(),
                columns: Some(columns),
                primary_key,
                unique_constraints,
                foreign_keys,
                indexes,
                check_constraints,
                default_constraints,
                triggers,
                table_options,
                failures,
            })
        })
        .await;

    let duration_ms = started.elapsed().as_millis() as u64;

    let result: AppResult<TableStructureResult> = match inner_result {
        Ok(Ok(r)) => Ok(r),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(AppError::mssql(format!(
            "table_structure command timed out ({}s)",
            STRUCTURE_TOTAL_TIMEOUT.as_secs()
        ))),
    };

    let builder =
        ActivityLogEntryBuilder::new(ActivityKind::TableStructure, activity_origin, duration_ms)
            .connection(id);

    match &result {
        Ok(r) => {
            let mut count: u32 = 0;
            if let Some(cols) = &r.columns {
                count += cols.len() as u32;
            }
            if let Some(idx) = &r.indexes {
                count += idx.len() as u32;
            }
            if let Some(trigs) = &r.triggers {
                count += trigs.len() as u32;
            }
            if let Some(fks) = &r.foreign_keys {
                count += fks.len() as u32;
            }
            if let Some(uq) = &r.unique_constraints {
                count += uq.len() as u32;
            }
            if let Some(cc) = &r.check_constraints {
                count += cc.len() as u32;
            }
            if let Some(dc) = &r.default_constraints {
                count += dc.len() as u32;
            }
            if r.primary_key.is_some() {
                count += 1;
            }
            let entry = builder.ok(Some(Metric::Items { value: count }));
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
// §12.2 — DDL synthesis helpers
// ---------------------------------------------------------------------------

/// Synthesize a CREATE TABLE statement from the structure result.
/// v1: covers columns, PK, UNIQUE, FK, indexes (as separate CREATE INDEX),
/// check constraints, and default constraints. Does NOT cover partitioning,
/// file groups, full-text indexes, extended properties, or table-level options.
fn synthesize_create_table(
    schema: &str,
    relation: &str,
    columns: &[ColumnInfo],
    primary_key: &Option<PrimaryKeyInfo>,
    unique_constraints: &Option<Vec<UniqueConstraintInfo>>,
    foreign_keys: &Option<Vec<ForeignKeyInfo>>,
    indexes: &Option<Vec<IndexInfo>>,
    check_constraints: &Option<Vec<CheckConstraintInfo>>,
    default_constraints: &Option<Vec<DefaultConstraintInfo>>,
) -> String {
    let mut ddl = String::new();
    let table_ref = format!(
        "{}.{}",
        mssql_quote_ident(schema),
        mssql_quote_ident(relation)
    );

    ddl.push_str(&format!("CREATE TABLE {table_ref} (\n"));

    let mut defs: Vec<String> = Vec::new();

    // Column definitions.
    for col in columns {
        let quoted_name = mssql_quote_ident(&col.name);
        let mut col_def = format!("    {quoted_name} [{}]", col.data_type);

        // Append type parameters from full_type if they differ from base_type.
        if col.full_type != col.data_type {
            // Extract the parameter portion from full_type.
            if let Some(paren_start) = col.full_type.find('(') {
                col_def.push_str(&col.full_type[paren_start..]);
            }
        }

        if col.is_computed {
            let expr = col.computed_expression.as_deref().unwrap_or("(NULL)");
            let qn = mssql_quote_ident(&col.name);
            col_def = format!("    {qn} AS {expr}");
            if col.is_persisted {
                col_def.push_str(" PERSISTED");
            }
        } else {
            if col.is_identity {
                let seed = col.identity_seed.unwrap_or(1);
                let inc = col.identity_increment.unwrap_or(1);
                col_def.push_str(&format!(" IDENTITY({seed},{inc})"));
            }
            if col.is_sparse {
                col_def.push_str(" SPARSE");
            }
            if col.nullable {
                col_def.push_str(" NULL");
            } else {
                col_def.push_str(" NOT NULL");
            }
            if let Some(default) = &col.default {
                // Check if there is a named default constraint for this column.
                let named = default_constraints
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .find(|dc| dc.column == col.name);
                if let Some(dc) = named {
                    col_def.push_str(&format!(
                        " CONSTRAINT [{}] DEFAULT {}",
                        mssql_quote_ident(&dc.name),
                        default
                    ));
                } else {
                    col_def.push_str(&format!(" DEFAULT {default}"));
                }
            }
        }
        defs.push(col_def);
    }

    // Primary key constraint.
    if let Some(pk) = primary_key {
        let cols = pk
            .columns
            .iter()
            .map(|c| mssql_quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        defs.push(format!(
            "    CONSTRAINT {} PRIMARY KEY ({})",
            mssql_quote_ident(&pk.name),
            cols
        ));
    }

    // Unique constraints.
    if let Some(uqs) = unique_constraints {
        for uq in uqs {
            let cols = uq
                .columns
                .iter()
                .map(|c| mssql_quote_ident(c))
                .collect::<Vec<_>>()
                .join(", ");
            let clustered = if uq.is_clustered {
                " CLUSTERED"
            } else {
                " NONCLUSTERED"
            };
            defs.push(format!(
                "    CONSTRAINT {} UNIQUE{clustered} ({})",
                mssql_quote_ident(&uq.name),
                cols
            ));
        }
    }

    // Check constraints.
    if let Some(ccs) = check_constraints {
        for cc in ccs {
            let nocheck = if cc.is_disabled || cc.is_not_trusted {
                " WITH NOCHECK"
            } else {
                ""
            };
            defs.push(format!(
                "    CONSTRAINT {} CHECK{nocheck} {}",
                mssql_quote_ident(&cc.name),
                cc.definition
            ));
        }
    }

    // Foreign key constraints.
    if let Some(fks) = foreign_keys {
        for fk in fks {
            let local_cols = fk
                .columns
                .iter()
                .map(|c| mssql_quote_ident(c))
                .collect::<Vec<_>>()
                .join(", ");
            let ref_cols = fk
                .referenced_columns
                .iter()
                .map(|c| mssql_quote_ident(c))
                .collect::<Vec<_>>()
                .join(", ");
            let nocheck = if fk.is_disabled || fk.is_not_trusted {
                " WITH NOCHECK"
            } else {
                ""
            };
            defs.push(format!(
                "    CONSTRAINT {fk_name} FOREIGN KEY{nocheck} ({lc}) REFERENCES {rs}.{rt} ({rc}) ON UPDATE {on_upd} ON DELETE {on_del}",
                fk_name = mssql_quote_ident(&fk.name),
                lc = local_cols,
                rs = mssql_quote_ident(&fk.referenced_schema),
                rt = mssql_quote_ident(&fk.referenced_table),
                rc = ref_cols,
                on_upd = fk.on_update,
                on_del = fk.on_delete,
            ));
        }
    }

    ddl.push_str(&defs.join(",\n"));
    ddl.push_str("\n);\nGO\n");

    // Non-PK/non-unique indexes as separate CREATE INDEX statements.
    if let Some(idxs) = indexes {
        for idx in idxs {
            let key_cols = idx
                .columns
                .iter()
                .filter(|c| !c.is_included)
                .map(|c| format!("{} {}", mssql_quote_ident(&c.name), c.direction))
                .collect::<Vec<_>>()
                .join(", ");
            let inc_cols_str = {
                let inc: Vec<_> = idx
                    .columns
                    .iter()
                    .filter(|c| c.is_included)
                    .map(|c| mssql_quote_ident(&c.name))
                    .collect();
                if inc.is_empty() {
                    String::new()
                } else {
                    format!("\nINCLUDE ({})", inc.join(", "))
                }
            };
            let unique_kw = if idx.unique { " UNIQUE" } else { "" };
            let clustered_kw = match idx.r#type.as_str() {
                "CLUSTERED" => " CLUSTERED",
                "COLUMNSTORE" if idx.name.to_ascii_uppercase().contains("CLUSTER") => {
                    " CLUSTERED COLUMNSTORE"
                }
                "COLUMNSTORE" => " NONCLUSTERED COLUMNSTORE",
                _ => " NONCLUSTERED",
            };
            let filter_str = idx
                .filter_definition
                .as_deref()
                .map(|f| format!("\nWHERE {f}"))
                .unwrap_or_default();
            ddl.push_str(&format!(
                "\nCREATE{unique_kw}{clustered_kw} INDEX {} ON {table_ref} ({key_cols}){inc_cols_str}{filter_str};\nGO\n",
                mssql_quote_ident(&idx.name)
            ));
        }
    }

    ddl
}

// ---------------------------------------------------------------------------
// §12.2 — mssql_table_ddl command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mssql_table_ddl(
    app: AppHandle,
    registry: State<'_, MssqlPoolRegistry>,
    id: Uuid,
    schema: String,
    relation: String,
    origin: Option<Origin>,
) -> AppResult<DdlResult> {
    let started = Instant::now();
    let activity_origin = origin.unwrap_or(Origin::Auto);

    let mut client = registry.acquire(id).await?;

    let result = timeout(DDL_TIMEOUT, async {
        // Detect object type from sys.objects.
        let type_sql =
            "SELECT TOP 1 o.type FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = @P1 AND o.name = @P2";
        let type_rows = client
            .query(type_sql, &[&schema.as_str(), &relation.as_str()])
            .await
            .map_err(map_tiberius_error)?
            .into_first_result()
            .await
            .map_err(map_tiberius_error)?;

        let obj_type: String = type_rows
            .first()
            .and_then(|r| r.get::<&str, _>(0))
            .map(|s| s.trim().to_uppercase())
            .ok_or_else(|| AppError::mssql(format!("object '{schema}.{relation}' not found")))?;

        let kind = match obj_type.as_str() {
            "U" => "table",
            "V" => "view",
            "P" => "procedure",
            "FN" | "IF" | "TF" | "FS" | "FT" => "function",
            "TR" => "trigger",
            _ => "table",
        };

        if kind == "table" {
            // Synthesize CREATE TABLE — fetch structure data.
            async fn get_one(
                pool: bb8::Pool<bb8_tiberius::ConnectionManager>,
            ) -> AppResult<bb8::PooledConnection<'static, bb8_tiberius::ConnectionManager>> {
                let leaked: &'static bb8::Pool<bb8_tiberius::ConnectionManager> =
                    Box::leak(Box::new(pool));
                leaked.get().await.map_err(map_bb8_error)
            }

            let ddl_pool = registry.get_pool(id)?;
            let (c0r, c1r, c2r, c3r, c4r, c5r, c6r) = tokio::join!(
                get_one(ddl_pool.clone()), get_one(ddl_pool.clone()), get_one(ddl_pool.clone()),
                get_one(ddl_pool.clone()), get_one(ddl_pool.clone()), get_one(ddl_pool.clone()),
                get_one(ddl_pool.clone()),
            );
            let mut c0 = c0r?;
            let mut c1 = c1r?;
            let mut c2 = c2r?;
            let mut c3 = c3r?;
            let mut c4 = c4r?;
            let mut c5 = c5r?;
            let mut c6 = c6r?;
            let s = schema.as_str();
            let r = relation.as_str();

            let (cols, pk, uq, fks, idxs, ccs, dcs) = tokio::join!(
                fetch_columns(&mut c0, s, r),
                fetch_primary_key(&mut c1, s, r),
                fetch_unique_constraints(&mut c2, s, r),
                fetch_foreign_keys(&mut c3, s, r),
                fetch_indexes(&mut c4, s, r),
                fetch_check_constraints(&mut c5, s, r),
                fetch_default_constraints(&mut c6, s, r),
            );

            let columns = cols.map_err(|e| e)?;
            let primary_key = pk.unwrap_or(None);
            let unique_constraints = uq.ok();
            let foreign_keys = fks.ok();
            let indexes = idxs.ok();
            let check_constraints = ccs.ok();
            let default_constraints = dcs.ok();

            let ddl = synthesize_create_table(
                &schema,
                &relation,
                &columns,
                &primary_key,
                &unique_constraints,
                &foreign_keys,
                &indexes,
                &check_constraints,
                &default_constraints,
            );

            Ok(DdlResult {
                ddl: Some(ddl),
                kind: "table".to_string(),
                is_encrypted: false,
                synthesized: true,
            })
        } else {
            // For views/procedures/functions/triggers: use OBJECT_DEFINITION.
            let qualified = format!("[{schema}].[{relation}]");
            let def_sql = "SELECT OBJECT_DEFINITION(OBJECT_ID(@P1)) AS def";
            let def_rows = client
                .query(def_sql, &[&qualified.as_str()])
                .await
                .map_err(map_tiberius_error)?
                .into_first_result()
                .await
                .map_err(map_tiberius_error)?;

            let def: Option<&str> = def_rows.first().and_then(|r| r.get(0));

            match def {
                Some(text) => Ok(DdlResult {
                    ddl: Some(text.to_string()),
                    kind: kind.to_string(),
                    is_encrypted: false,
                    synthesized: false,
                }),
                None => {
                    // NULL from OBJECT_DEFINITION means encrypted or not found.
                    Err(AppError::mssql(format!(
                        "definition unavailable for [{schema}].[{relation}]: object may be encrypted (WITH ENCRYPTION)"
                    )))
                }
            }
        }
    })
    .await;

    let duration_ms = started.elapsed().as_millis() as u64;

    let result: AppResult<DdlResult> = match result {
        Ok(Ok(r)) => Ok(r),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(AppError::mssql(format!(
            "table_ddl command timed out ({}s)",
            DDL_TIMEOUT.as_secs()
        ))),
    };

    let builder =
        ActivityLogEntryBuilder::new(ActivityKind::TableDdl, activity_origin, duration_ms)
            .connection(id);

    match &result {
        Ok(_) => {
            let entry = builder.ok(Some(Metric::Items { value: 1 }));
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
// §12.3/12.4 — Unit tests for pure helpers
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_full_type_nvarchar_sized() {
        // nvarchar max_length is bytes; /2 for chars.
        assert_eq!(build_full_type("nvarchar", 510, 0, 0), "nvarchar(255)");
    }

    #[test]
    fn build_full_type_nvarchar_max() {
        assert_eq!(build_full_type("nvarchar", -1, 0, 0), "nvarchar(max)");
    }

    #[test]
    fn build_full_type_varchar_sized() {
        assert_eq!(build_full_type("varchar", 255, 0, 0), "varchar(255)");
    }

    #[test]
    fn build_full_type_varchar_max() {
        assert_eq!(build_full_type("varchar", -1, 0, 0), "varchar(max)");
    }

    #[test]
    fn build_full_type_decimal_precision_scale() {
        assert_eq!(build_full_type("decimal", 0, 18, 4), "decimal(18,4)");
    }

    #[test]
    fn build_full_type_int_no_params() {
        assert_eq!(build_full_type("int", 4, 10, 0), "int");
    }

    #[test]
    fn build_full_type_datetime2() {
        assert_eq!(build_full_type("datetime2", 0, 0, 7), "datetime2(7)");
    }

    #[test]
    fn category_numeric_types() {
        for t in &[
            "bit",
            "tinyint",
            "smallint",
            "int",
            "bigint",
            "decimal",
            "numeric",
            "money",
            "smallmoney",
            "float",
            "real",
        ] {
            assert_eq!(category_for_type(t), "numeric", "failed for {t}");
        }
    }

    #[test]
    fn category_string_types() {
        for t in &["char", "varchar", "nchar", "nvarchar", "text", "ntext"] {
            assert_eq!(category_for_type(t), "string", "failed for {t}");
        }
    }

    #[test]
    fn category_temporal_types() {
        for t in &[
            "date",
            "time",
            "datetime",
            "datetime2",
            "datetimeoffset",
            "smalldatetime",
        ] {
            assert_eq!(category_for_type(t), "temporal", "failed for {t}");
        }
    }

    #[test]
    fn category_binary_types() {
        for t in &["binary", "varbinary", "image"] {
            assert_eq!(category_for_type(t), "binary", "failed for {t}");
        }
    }

    #[test]
    fn category_special_types() {
        assert_eq!(category_for_type("geography"), "spatial");
        assert_eq!(category_for_type("geometry"), "spatial");
        assert_eq!(category_for_type("xml"), "xml");
        assert_eq!(category_for_type("uniqueidentifier"), "uniqueidentifier");
        assert_eq!(category_for_type("hierarchyid"), "hierarchyid");
        assert_eq!(category_for_type("sql_variant"), "sql_variant");
    }

    #[test]
    fn category_other_for_unknown() {
        assert_eq!(category_for_type("sysname"), "other");
    }

    #[test]
    fn synthesize_ddl_simple_table() {
        let cols = vec![
            ColumnInfo {
                name: "Id".to_string(),
                ordinal: 1,
                data_type: "int".to_string(),
                full_type: "int".to_string(),
                nullable: false,
                default: None,
                comment: None,
                collation: None,
                is_identity: true,
                identity_seed: Some(1),
                identity_increment: Some(1),
                is_computed: false,
                computed_expression: None,
                is_persisted: false,
                is_sparse: false,
                category: "numeric".to_string(),
                bind_kind: BindKind::Identity,
            },
            ColumnInfo {
                name: "Name".to_string(),
                ordinal: 2,
                data_type: "nvarchar".to_string(),
                full_type: "nvarchar(100)".to_string(),
                nullable: true,
                default: None,
                comment: None,
                collation: None,
                is_identity: false,
                identity_seed: None,
                identity_increment: None,
                is_computed: false,
                computed_expression: None,
                is_persisted: false,
                is_sparse: false,
                category: "string".to_string(),
                bind_kind: BindKind::NVarchar,
            },
        ];
        let pk = Some(PrimaryKeyInfo {
            name: "PK_Test".to_string(),
            columns: vec!["Id".to_string()],
            identity_column: Some("Id".to_string()),
        });
        let ddl =
            synthesize_create_table("dbo", "Test", &cols, &pk, &None, &None, &None, &None, &None);
        assert!(ddl.contains("CREATE TABLE [dbo].[Test]"), "got: {ddl}");
        assert!(ddl.contains("[Id]"), "got: {ddl}");
        assert!(ddl.contains("IDENTITY(1,1)"), "got: {ddl}");
        assert!(ddl.contains("[Name]"), "got: {ddl}");
        assert!(ddl.contains("[PK_Test]"), "got: {ddl}");
    }

    #[test]
    fn synthesize_ddl_includes_fk() {
        let cols = vec![ColumnInfo {
            name: "CustomerId".to_string(),
            ordinal: 1,
            data_type: "int".to_string(),
            full_type: "int".to_string(),
            nullable: false,
            default: None,
            comment: None,
            collation: None,
            is_identity: false,
            identity_seed: None,
            identity_increment: None,
            is_computed: false,
            computed_expression: None,
            is_persisted: false,
            is_sparse: false,
            category: "numeric".to_string(),
            bind_kind: BindKind::Int,
        }];
        let fks = Some(vec![ForeignKeyInfo {
            name: "FK_Customer".to_string(),
            columns: vec!["CustomerId".to_string()],
            referenced_schema: "dbo".to_string(),
            referenced_table: "Customers".to_string(),
            referenced_columns: vec!["Id".to_string()],
            on_update: "NO_ACTION".to_string(),
            on_delete: "CASCADE".to_string(),
            is_disabled: false,
            is_not_trusted: false,
        }]);
        let ddl = synthesize_create_table(
            "dbo", "Orders", &cols, &None, &None, &fks, &None, &None, &None,
        );
        assert!(ddl.contains("[FK_Customer]"), "got: {ddl}");
        assert!(ddl.contains("REFERENCES [dbo].[Customers]"), "got: {ddl}");
    }
}
