use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppResult;

/// A single column belonging to an `ObjectShape`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectShapeColumn {
    pub name: String,
    pub ty: String,
}

/// Normalised description of a database object (table, view, log group, etc.)
/// used as input to the sync executor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectShape {
    /// "table", "view", "materialized_view", "log_group", "dynamo_table", etc.
    pub kind: String,
    /// Schema name for SQL engines; `None` for flat engines (Dynamo, CloudWatch).
    pub schema: Option<String>,
    pub name: String,
    /// Empty if the engine doesn't have a notion of primary key.
    pub primary_key: Vec<String>,
    pub columns: Vec<ObjectShapeColumn>,
}

/// Per-engine introspection adapter.
///
/// Each adapter converts a live connection's schema into a normalised
/// `Vec<ObjectShape>` that the engine-agnostic sync executor can consume.
#[async_trait]
pub trait IntrospectForContext: Send + Sync {
    async fn introspect_for_context(&self, conn_id: Uuid) -> AppResult<Vec<ObjectShape>>;
}
