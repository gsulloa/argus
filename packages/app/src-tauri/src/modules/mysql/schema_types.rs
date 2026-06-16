use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SchemaInfo {
    pub name: String,
    pub charset: String,
    pub collation: String,
    pub is_system: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct RelationInfo {
    pub name: String,
    /// "regular" | "partitioned"
    pub kind: String,
    pub comment: Option<String>,
    pub estimated_rows: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ViewInfo {
    pub name: String,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RelationsResult {
    pub schema: String,
    pub tables: Vec<RelationInfo>,
    pub views: Vec<ViewInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct RoutineInfo {
    pub name: String,
    /// "procedure" | "function"
    pub kind: String,
    pub language: String,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TriggerInfo {
    pub name: String,
    pub table: Option<String>,
    pub event: String,
    pub timing: String,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct EventInfo {
    pub name: String,
    pub status: String,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct StructureResult {
    pub schema: String,
    pub routines: Option<Vec<RoutineInfo>>,
    pub triggers: Option<Vec<TriggerInfo>>,
    pub events: Option<Vec<EventInfo>>,
    pub failures: Vec<KindFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct IndexColumn {
    pub name: String,
    pub sub_part: Option<i64>,
    pub direction: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<IndexColumn>,
    pub unique: bool,
    /// BTREE | HASH | FULLTEXT | SPATIAL
    pub index_type: String,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ForeignKeyInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub referenced_schema: String,
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TableExtrasResult {
    pub schema: String,
    pub relation: String,
    pub indexes: Option<Vec<IndexInfo>>,
    pub triggers: Option<Vec<TriggerInfo>>,
    pub foreign_keys: Option<Vec<ForeignKeyInfo>>,
    pub failures: Vec<KindFailure>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RoutineSignature {
    pub args_signature: String,
    pub return_type: Option<String>,
}

/// Per-kind failure inside a partial-degradation envelope. `code` is the
/// SQLSTATE when available (e.g. `"70100"` for timeout, `"42000"` for
/// permission-denied). `kind` is the logical group name.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct KindFailure {
    pub kind: String,
    pub code: Option<String>,
    pub message: String,
}
