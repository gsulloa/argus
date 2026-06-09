use std::collections::HashMap;

use aws_sdk_athena::Client as AthenaClient;
use aws_sdk_glue::Client as GlueClient;
use serde::Serialize;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

// ---------------------------------------------------------------------------
// Active client envelope
// ---------------------------------------------------------------------------

pub struct ActiveAthenaClient {
    pub athena: AthenaClient,
    pub glue: GlueClient,
    pub account_id: String,
    pub identity_arn: String,
    pub region: String,
    pub workgroup: String,
    pub output_location: Option<String>,
    pub read_only: bool,
    pub connected_at_unix_ms: i64,
}

/// What commands get when they `acquire` a connection.
#[derive(Clone)]
pub struct AcquiredClient {
    pub athena: AthenaClient,
    pub glue: GlueClient,
    pub region: String,
    pub workgroup: String,
    pub output_location: Option<String>,
    pub read_only: bool,
    pub account_id: String,
}

/// Public-safe summary for the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct ActivePoolSummary {
    pub id: Uuid,
    pub region: String,
    pub account_id: String,
    pub read_only: bool,
    pub connected_at_unix_ms: i64,
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/// Singleton registry of active Athena clients, stored as Tauri state.
pub struct AthenaClientRegistry {
    clients: RwLock<HashMap<Uuid, ActiveAthenaClient>>,
}

impl AthenaClientRegistry {
    pub fn new() -> Self {
        Self {
            clients: RwLock::new(HashMap::new()),
        }
    }

    /// Snapshot the active clients.
    pub async fn list_active(&self) -> Vec<ActivePoolSummary> {
        let guard = self.clients.read().await;
        guard
            .iter()
            .map(|(id, a)| ActivePoolSummary {
                id: *id,
                region: a.region.clone(),
                account_id: a.account_id.clone(),
                read_only: a.read_only,
                connected_at_unix_ms: a.connected_at_unix_ms,
            })
            .collect()
    }

    /// True if a client is registered for this id.
    pub async fn is_active(&self, id: &Uuid) -> bool {
        self.clients.read().await.contains_key(id)
    }

    /// Register (or replace) a client.
    pub async fn insert(&self, id: Uuid, client: ActiveAthenaClient) {
        self.clients.write().await.insert(id, client);
    }

    /// Remove a client. Returns true if one was present.
    pub async fn remove(&self, id: &Uuid) -> bool {
        self.clients.write().await.remove(id).is_some()
    }

    /// Acquire a clone of the clients and config for a connection.
    pub async fn acquire(&self, id: &Uuid) -> AppResult<AcquiredClient> {
        let guard = self.clients.read().await;
        guard
            .get(id)
            .map(|a| AcquiredClient {
                athena: a.athena.clone(),
                glue: a.glue.clone(),
                region: a.region.clone(),
                workgroup: a.workgroup.clone(),
                output_location: a.output_location.clone(),
                read_only: a.read_only,
                account_id: a.account_id.clone(),
            })
            .ok_or_else(|| AppError::NotFound(format!("athena client {id} not active")))
    }

    /// Return whether the connection is read-only, if known.
    pub async fn read_only_for(&self, id: &Uuid) -> Option<bool> {
        let guard = self.clients.read().await;
        guard.get(id).map(|a| a.read_only)
    }

    /// Snapshot of a single connection's summary (for idempotent connect).
    pub async fn snapshot(&self, id: &Uuid) -> Option<ActivePoolSummary> {
        let guard = self.clients.read().await;
        guard.get(id).map(|a| ActivePoolSummary {
            id: *id,
            region: a.region.clone(),
            account_id: a.account_id.clone(),
            read_only: a.read_only,
            connected_at_unix_ms: a.connected_at_unix_ms,
        })
    }

    /// Disconnect all active clients.
    pub async fn disconnect_all(&self) -> usize {
        let mut guard = self.clients.write().await;
        let count = guard.len();
        guard.clear();
        count
    }
}

impl Default for AthenaClientRegistry {
    fn default() -> Self {
        Self::new()
    }
}
