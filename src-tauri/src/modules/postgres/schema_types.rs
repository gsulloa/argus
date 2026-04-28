use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaSummary {
    pub name: String,
    pub owner: Option<String>,
    pub is_system: bool,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaObjects {
    pub schema: String,
    pub tables: Vec<TableInfo>,
    pub views: Vec<ViewInfo>,
    pub materialized_views: Vec<ViewInfo>,
    pub functions: Vec<FunctionInfo>,
    pub types: Vec<TypeInfo>,
    pub extensions: Vec<ExtensionInfo>,
    pub indexes: Vec<IndexInfo>,
    pub triggers: Vec<TriggerInfo>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TableKind {
    Regular,
    Partitioned,
    Foreign,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    pub owner: Option<String>,
    pub estimated_rows: Option<i64>,
    pub comment: Option<String>,
    pub kind: TableKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewInfo {
    pub name: String,
    pub owner: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionInfo {
    pub name: String,
    pub args_signature: String,
    pub return_type: Option<String>,
    pub language: String,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TypeKind {
    Composite,
    Enum,
    Domain,
    Range,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypeInfo {
    pub name: String,
    pub kind: TypeKind,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionInfo {
    pub name: String,
    pub version: String,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexInfo {
    pub name: String,
    pub table: String,
    pub is_unique: bool,
    pub is_primary: bool,
    pub method: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TriggerTiming {
    Before,
    After,
    #[serde(rename = "instead_of")]
    InsteadOf,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TriggerEvent {
    Insert,
    Update,
    Delete,
    Truncate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerInfo {
    pub name: String,
    pub table: String,
    pub timing: TriggerTiming,
    pub events: Vec<TriggerEvent>,
    pub function: String,
}
