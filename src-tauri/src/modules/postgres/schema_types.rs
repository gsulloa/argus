use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaSummary {
    pub name: String,
    pub owner: Option<String>,
    pub is_system: bool,
    pub comment: Option<String>,
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
    pub oid: i64,
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

/// Per-kind failure entry inside a partial-degradation envelope. `code` is the
/// SQLSTATE when the underlying error was Postgres-typed (e.g. `"57014"` for
/// query_canceled / timeout). `kind` is the logical group name (`"functions"`,
/// `"types"`, `"extensions"`, `"indexes"`, `"triggers"`).
#[derive(Debug, Clone, Serialize)]
pub struct KindFailure {
    pub kind: String,
    pub code: Option<String>,
    pub message: String,
}

/// Result of `postgres_list_relations`. Always-success or hard error — no
/// partial-result envelope is needed because there is exactly one underlying
/// query.
#[derive(Debug, Clone, Serialize)]
pub struct RelationsResult {
    pub schema: String,
    pub tables: Vec<TableInfo>,
    pub views: Vec<ViewInfo>,
    pub materialized_views: Vec<ViewInfo>,
}

/// Result of `postgres_list_structure`. Each kind field is `None` when its
/// sub-query failed (a `KindFailure` is appended to `failures` in that case).
/// Permission-denied (SQLSTATE 42501) collapses to `Some(Vec::new())` silently
/// — it never enters `failures`.
#[derive(Debug, Clone, Serialize)]
pub struct StructureResult {
    pub schema: String,
    pub functions: Option<Vec<FunctionInfo>>,
    pub types: Option<Vec<TypeInfo>>,
    pub extensions: Option<Vec<ExtensionInfo>>,
    pub failures: Vec<KindFailure>,
}

/// Result of `postgres_list_table_extras`. Same partial-degradation semantics
/// as `StructureResult`, scoped to one relation.
#[derive(Debug, Clone, Serialize)]
pub struct TableExtrasResult {
    pub schema: String,
    pub relation: String,
    pub indexes: Option<Vec<IndexInfo>>,
    pub triggers: Option<Vec<TriggerInfo>>,
    pub failures: Vec<KindFailure>,
}

/// Result of `postgres_get_function_signature`. Both fields come straight from
/// `pg_get_function_arguments` / `pg_get_function_result` for the OID.
#[derive(Debug, Clone, Serialize)]
pub struct FunctionSignature {
    pub args_signature: String,
    pub return_type: Option<String>,
}
