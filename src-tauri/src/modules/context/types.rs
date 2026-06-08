use std::collections::HashMap;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// ---- Manifest ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextManifest {
    pub schema_version: u32,
    pub name: String,
    /// Free-form extra fields preserved opaquely for forward compatibility.
    #[serde(flatten)]
    pub extras: HashMap<String, serde_yaml::Value>,
}

// ---- Object docs ----

/// An access pattern for a Single-Table Design entity.
/// Each pattern maps to a specific index and provides key templates.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessPattern {
    /// Optional human-readable label for the pattern.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The index to use: `"table"` for the primary key, or a GSI/LSI name.
    pub index: String,
    /// Partition-key template, e.g. `"USER#${userId}"`.
    pub pk: String,
    /// Optional sort-key template, e.g. `"ORDER#${orderId}"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sk: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    #[serde(flatten)]
    pub extras: HashMap<String, serde_yaml::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectSystem {
    /// "table", "view", "log_group", "dynamo_table"
    pub kind: String,
    pub schema: Option<String>,
    pub name: String,
    pub primary_key: Option<Vec<String>>,
    pub columns: Option<Vec<ObjectColumn>>,
    pub last_synced: Option<DateTime<Utc>>,
    pub deleted_in_db: Option<bool>,
    /// Dynamo model docs only: the access patterns for this entity.
    /// `None` for all non-`dynamo_model` docs; always `None` after serialising
    /// a Postgres/MySQL/MSSQL doc (skip_serializing_if).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_patterns: Option<Vec<AccessPattern>>,
    /// Dynamo model docs only: the physical DynamoDB table this entity belongs
    /// to, derived from the directory path (never authored in frontmatter).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub physical_table: Option<String>,
    #[serde(flatten)]
    pub extras: HashMap<String, serde_yaml::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ObjectHuman {
    pub tags: Option<Vec<String>>,
    pub owners: Option<Vec<String>>,
    pub column_notes: Option<HashMap<String, String>>,
    #[serde(flatten)]
    pub extras: HashMap<String, serde_yaml::Value>,
}

/// A parsed object documentation file (e.g. `postgres/public/users.md`).
/// `body` and `source_path` are excluded from IPC serialisation; they are
/// used only during in-process logic.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectDoc {
    pub system: ObjectSystem,
    #[serde(default)]
    pub human: ObjectHuman,
    /// Raw Markdown body preserved byte-for-byte from the source file.
    /// Serialised out to IPC (frontend reads it) but not required on
    /// deserialise (the frontend never sends full bodies back).
    #[serde(default, skip_deserializing)]
    pub body: String,
    /// Absolute path to the source file on disk. Not exposed over IPC.
    #[serde(skip)]
    pub source_path: PathBuf,
}

// ---- Query docs ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryParam {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: Option<String>,
    /// Default value; may be a string, integer, etc.
    pub default: Option<serde_yaml::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct QueryMeta {
    pub name: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub params: Vec<QueryParam>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// A parsed prefab query (body file + optional `.meta.yaml`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryDoc {
    /// Display name (from meta, or basename if absent).
    pub name: String,
    pub description: Option<String>,
    pub params: Vec<QueryParam>,
    pub tags: Vec<String>,
    /// Raw query body, byte-for-byte from the body file.
    /// Serialised out to IPC (frontend reads it) but not required on
    /// deserialise.
    #[serde(default, skip_deserializing)]
    pub body: String,
    /// Absolute path to the body file on disk. Not exposed over IPC.
    #[serde(skip)]
    pub source_path: PathBuf,
}

// ---- Parsed context (result of load_folder) ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadWarning {
    pub path: PathBuf,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedContext {
    pub manifest: ContextManifest,
    /// Raw text of `ai/overview.md`, if present.
    pub overview: Option<String>,
    /// Raw text of `ai/glossary.md`, if present.
    pub glossary: Option<String>,
    /// Raw text of `README.md`, if present.
    pub readme: Option<String>,
    /// Object docs filtered by the engine that loaded this context.
    pub objects: Vec<ObjectDoc>,
    /// Query docs filtered by the engine that loaded this context.
    pub queries: Vec<QueryDoc>,
    pub warnings: Vec<LoadWarning>,
}

// ---- Sync report ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrphanedNote {
    pub file: PathBuf,
    pub key: String,
}

/// A live table skipped during sync because it normalized to the same logical
/// name as a table already written in this run (first wins, rest skipped).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkippedTable {
    /// The live (physical) table name that was skipped.
    pub live_name: String,
    /// The logical name both tables folded to.
    pub logical: String,
    /// The live table name that was kept (written) for this logical name.
    pub kept: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncReport {
    pub created: Vec<PathBuf>,
    pub updated: Vec<PathBuf>,
    pub marked_deleted: Vec<PathBuf>,
    pub orphaned_notes: Vec<OrphanedNote>,
    /// Live tables skipped due to a logical-name collision (Dynamo only).
    #[serde(default)]
    pub skipped: Vec<SkippedTable>,
}

// ---- AI payload ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiObjectEntry {
    pub name: String,
    pub system: ObjectSystem,
    pub human: ObjectHuman,
    pub body_summary: Option<String>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiQueryEntry {
    pub name: String,
    pub description: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiPayload {
    pub manifest: Option<ContextManifest>,
    pub overview: Option<String>,
    pub glossary: Option<String>,
    pub objects: Vec<AiObjectEntry>,
    pub queries: Vec<AiQueryEntry>,
}
