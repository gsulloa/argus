//! DTO types for the MS SQL Server schema browser.
//!
//! All types use `snake_case` JSON serialization to match the frontend
//! conventions. Mirror shapes from `mysql/schema_types.rs` where applicable.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// §7.1 — Core schema browser DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SchemaInfo {
    pub name: String,
    pub is_system: bool,
}

/// A table, view, indexed-view, or partitioned table in a schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct RelationInfo {
    pub name: String,
    pub schema: String,
    /// "table" | "view" | "indexed-view" | "partitioned"
    pub kind: String,
    pub estimated_rows: Option<i64>,
    /// True if the view has at least one index (making it an indexed view).
    pub is_indexed: bool,
}

/// Split result for `mssql_list_relations`.
/// Tables (kind ∈ {"table","partitioned"}) and views (kind ∈ {"view","indexed-view"}) are
/// pre-split so the frontend consumer can directly iterate `tables` and `views`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RelationsResult {
    pub schema: String,
    pub tables: Vec<RelationInfo>,
    pub views: Vec<RelationInfo>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub failures: Vec<KindFailure>,
}

/// A stored procedure, scalar function, TVF, or CLR routine.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct RoutineInfo {
    pub name: String,
    pub schema: String,
    /// "procedure" | "scalar_function" | "inline_tvf" | "tvf" | "clr_scalar" | "clr_tvf"
    pub kind: String,
    /// Normalised function kind exposed to the frontend ("scalar_function" etc.)
    /// Absent for procedures.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub function_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TriggerInfo {
    pub name: String,
    pub table: String,
    pub schema: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SequenceInfo {
    pub name: String,
    pub schema: String,
    pub start_value: Option<i64>,
    pub increment: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DatabaseInfo {
    pub name: String,
    pub is_current: bool,
}

// ---------------------------------------------------------------------------
// §7.8 / §7.1 — Partial-result envelope
// ---------------------------------------------------------------------------

/// A per-kind failure inside a partial-result envelope. Code is an optional
/// numeric SQL Server error code (i32).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct KindFailure {
    pub kind: String,
    pub code: Option<i32>,
    pub message: String,
}

/// Envelope wrapping partial-result data with per-kind failures.
/// Used for `mssql_list_structure` and `mssql_list_table_extras` where
/// sub-queries may degrade independently.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct MssqlPartialResult<T> {
    pub items: Vec<T>,
    pub failures: Vec<KindFailure>,
}

// ---------------------------------------------------------------------------
// §7.1 — Structure browser buckets
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct StructureBuckets {
    pub schema: String,
    pub procedures: Vec<RoutineInfo>,
    pub functions: Vec<RoutineInfo>,
    pub triggers: Vec<TriggerInfo>,
    pub sequences: Vec<SequenceInfo>,
    pub failures: Vec<KindFailure>,
}

// ---------------------------------------------------------------------------
// §7.1 — Table extras
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct IndexColumn {
    pub name: String,
    pub key_ordinal: i32,
    /// Serialised as `descending` to match the frontend `IndexColumn.descending` field.
    #[serde(rename = "descending")]
    pub is_descending: bool,
    pub is_included: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct IndexSummary {
    pub name: String,
    pub is_unique: bool,
    /// Serialised as `is_primary` to match the frontend `IndexInfo.is_primary` field.
    #[serde(rename = "is_primary")]
    pub is_primary_key: bool,
    pub is_clustered: bool,
    pub index_type: String,
    pub columns: Vec<IndexColumn>,
    pub included_columns: Vec<String>,
    /// Serialised as `filter_predicate` to match the frontend `IndexInfo.filter_predicate`.
    #[serde(rename = "filter_predicate")]
    pub filter_definition: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ForeignKeySummary {
    pub name: String,
    pub columns: Vec<String>,
    /// Serialised as `ref_schema` to match the frontend `ForeignKeyInfo.ref_schema`.
    #[serde(rename = "ref_schema")]
    pub referenced_schema: String,
    /// Serialised as `ref_table` to match the frontend `ForeignKeyInfo.ref_table`.
    #[serde(rename = "ref_table")]
    pub referenced_table: String,
    /// Serialised as `ref_columns` to match the frontend `ForeignKeyInfo.ref_columns`.
    #[serde(rename = "ref_columns")]
    pub referenced_columns: Vec<String>,
    /// Serialised as `on_update` to match the frontend `ForeignKeyInfo.on_update`.
    #[serde(rename = "on_update")]
    pub update_rule: String,
    /// Serialised as `on_delete` to match the frontend `ForeignKeyInfo.on_delete`.
    #[serde(rename = "on_delete")]
    pub delete_rule: String,
    pub is_disabled: bool,
    pub is_not_trusted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CheckConstraintSummary {
    pub name: String,
    /// Serialised as `column` to match the frontend `CheckConstraintInfo.column`.
    #[serde(rename = "column")]
    pub column_name: Option<String>,
    pub definition: String,
    pub is_disabled: bool,
    pub is_not_trusted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DefaultConstraintSummary {
    pub name: String,
    /// Serialised as `column` to match the frontend `DefaultConstraintInfo.column`.
    #[serde(rename = "column")]
    pub column_name: String,
    pub definition: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TableExtras {
    pub schema: String,
    pub relation: String,
    pub indexes: Vec<IndexSummary>,
    pub triggers: Vec<TriggerInfo>,
    pub foreign_keys: Vec<ForeignKeySummary>,
    pub check_constraints: Vec<CheckConstraintSummary>,
    pub default_constraints: Vec<DefaultConstraintSummary>,
    pub failures: Vec<KindFailure>,
}

// ---------------------------------------------------------------------------
// §7.1 — Routine signature
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct RoutineParameter {
    pub name: String,
    pub data_type: String,
    /// "in" | "out" | "inout" | "return"
    pub mode: String,
    pub ordinal: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct RoutineSignature {
    pub schema: String,
    pub name: String,
    pub kind: String,
    pub parameters: Vec<RoutineParameter>,
    pub returns: Option<String>,
}
