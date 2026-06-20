//! Cross-engine "open connections" registry — Phase 1 of the dual-window shell.
//!
//! This registry is the single source of truth for which connections are
//! currently open across all engines.  It is populated as any engine
//! connects or disconnects and exposes:
//!
//! * `connections_open_list()` Tauri command — returns the current set.
//! * `connections:open-changed` event — broadcast to all windows on every
//!   mutation, carrying the updated list.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::error::AppResult;
use crate::modules::athena::pool::AthenaClientRegistry;
use crate::modules::dynamo::client::DynamoClientRegistry;
use crate::modules::mssql::MssqlPoolRegistry;
use crate::modules::mysql::MysqlPoolRegistry;
use crate::modules::postgres::PgPoolRegistry;
use crate::platform::DbState;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// A single entry in the cross-engine open-connections registry.
///
/// `id` is serialized as the same hyphenated lowercase UUID string form that
/// the frontend already uses (via the `uuid` crate's `serde` feature on
/// `Connection.id` in `platform/connections.rs` and `ActivePoolSummary.id` in
/// every engine's pool module).  We store it as `String` here to make the
/// contract explicit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenConnection {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub connected_at_unix_ms: i64,
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/// Singleton managed-state registry.  One entry per open connection,
/// keyed by `Uuid` internally.
pub struct OpenConnectionsRegistry {
    inner: RwLock<HashMap<Uuid, OpenConnection>>,
}

impl Default for OpenConnectionsRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenConnectionsRegistry {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
        }
    }

    // -----------------------------------------------------------------------
    // Mutation helpers (called from engine connect / disconnect commands)
    // -----------------------------------------------------------------------

    /// Called on a successful engine connect.  Reads `name` and `kind` from
    /// SQLite for `id`, inserts/updates the entry, then emits
    /// `connections:open-changed`.  If the connection row is not found (race
    /// with deletion) the call is silently skipped — no panic.
    pub async fn mark_open(&self, app: &AppHandle, db: &DbState, id: Uuid) {
        let row = {
            let guard = db.0.lock().expect("db poisoned");
            guard
                .query_row(
                    "SELECT name, kind FROM connections WHERE id = ?1",
                    rusqlite::params![id.as_bytes().to_vec()],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                )
                .ok()
        };

        let (name, kind) = match row {
            Some(pair) => pair,
            None => {
                tracing::warn!("open_connections: mark_open for id {id} — row not found, skipping");
                return;
            }
        };

        let connected_at_unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        let list = {
            let mut guard = self.inner.write().await;
            guard.insert(
                id,
                OpenConnection {
                    id: id.to_string(),
                    kind,
                    name,
                    connected_at_unix_ms,
                },
            );
            sorted_snapshot(&guard)
        };

        let _ = app.emit("connections:open-changed", list);
    }

    /// Called on a successful engine disconnect (single connection).  Removes
    /// the entry if present, then emits `connections:open-changed`.
    pub async fn mark_closed(&self, app: &AppHandle, id: Uuid) {
        let list = {
            let mut guard = self.inner.write().await;
            guard.remove(&id);
            sorted_snapshot(&guard)
        };
        let _ = app.emit("connections:open-changed", list);
    }

    /// Called on a `disconnect_all` path for one engine.  Removes ALL entries
    /// whose `kind` matches `engine_kind` (the exact string stored in the
    /// `connections.kind` column: `"postgres"`, `"mysql"`, `"mssql"`,
    /// `"dynamodb"`, `"athena"`), then emits `connections:open-changed`.
    pub async fn mark_kind_closed(&self, app: &AppHandle, engine_kind: &str) {
        let list = {
            let mut guard = self.inner.write().await;
            guard.retain(|_, v| v.kind != engine_kind);
            sorted_snapshot(&guard)
        };
        let _ = app.emit("connections:open-changed", list);
    }

    // -----------------------------------------------------------------------
    // Query
    // -----------------------------------------------------------------------

    /// Returns a snapshot of currently-open connections sorted deterministically
    /// by name then by id string (so the list is stable across calls when the
    /// set hasn't changed).
    pub async fn list(&self) -> Vec<OpenConnection> {
        let guard = self.inner.read().await;
        sorted_snapshot(&guard)
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn sorted_snapshot(map: &HashMap<Uuid, OpenConnection>) -> Vec<OpenConnection> {
    let mut entries: Vec<OpenConnection> = map.values().cloned().collect();
    entries.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
    entries
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

/// Return the current set of open connections across all engines.
///
/// The Workspace calls this on spawn to rebuild its rail from the warm-pool
/// state without relying solely on events.
#[tauri::command]
pub async fn connections_open_list(
    registry: State<'_, OpenConnectionsRegistry>,
) -> AppResult<Vec<OpenConnection>> {
    Ok(registry.list().await)
}

/// Create the `workspace` window if it does not already exist, or focus it if
/// it does.
///
/// Phase 2 (window routing scaffold): this command only ensures the window
/// exists and is focused.  Full open/focus coordination
/// (`workspace_open_connection`, `workspace:focus-connection` events) is
/// implemented in Phase 6.
///
/// `tauri-plugin-window-state` automatically persists and restores geometry for
/// both the `manager` and `workspace` windows by their stable labels — no
/// additional configuration is required.
#[tauri::command]
pub async fn ensure_workspace_window(app: AppHandle) -> AppResult<()> {
    if let Some(win) = app.get_webview_window("workspace") {
        // Window already exists — bring it to the front.
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }

    // Create the workspace window loading the same app bundle.
    WebviewWindowBuilder::new(&app, "workspace", WebviewUrl::App("index.html".into()))
        .title("Argus")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 500.0)
        .resizable(true)
        .build()
        .map_err(|e| crate::error::AppError::Internal(e.to_string()))?;

    Ok(())
}

/// Create the `manager` window if it does not already exist, or focus it if
/// it does.
///
/// Phase 4 (Workspace window + connection rail): the rail "+" affordance calls
/// this so the user can open a new connection from the Workspace without
/// switching away manually.
///
/// `tauri-plugin-window-state` persists geometry for the `manager` label
/// automatically — no additional configuration required.
#[tauri::command]
pub async fn ensure_manager_window(app: AppHandle) -> AppResult<()> {
    if let Some(win) = app.get_webview_window("manager") {
        // Window already exists — bring it to the front.
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }

    // Manager was closed — recreate it loading the same app bundle.
    WebviewWindowBuilder::new(&app, "manager", WebviewUrl::App("index.html".into()))
        .title("Argus")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 500.0)
        .resizable(true)
        .build()
        .map_err(|e| crate::error::AppError::Internal(e.to_string()))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Phase 6: Open-and-focus coordination
// ---------------------------------------------------------------------------

/// Payload emitted with the `workspace:focus-connection` event.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusConnectionPayload {
    pub id: String,
}

/// Open a connection into the Workspace and focus it.
///
/// This command:
/// 1. Ensures the `workspace` window exists (creates it if absent, else shows +
///    focuses it).
/// 2. Focuses the workspace window.
/// 3. Emits `workspace:focus-connection { id }` to **all** windows so the
///    Workspace rail can add the connection and make it the focused item.
///
/// # Important: connecting is the caller's responsibility
///
/// This command does NOT open the connection itself.  The Manager row must
/// call the per-engine connect command (e.g. `postgres_connect`) *before*
/// calling `workspace_open_connection`, because connection parameters and
/// secrets live in the Manager window's context.  This design keeps the
/// connect/disconnect logic per-engine and lets `workspace_open_connection`
/// remain engine-agnostic.  For an already-open connection the caller should
/// skip the connect step and call this command directly for idempotent focus.
#[tauri::command]
pub async fn workspace_open_connection(app: AppHandle, id: String) -> AppResult<()> {
    // Ensure the workspace window exists and is focused.
    if let Some(win) = app.get_webview_window("workspace") {
        let _ = win.show();
        let _ = win.set_focus();
    } else {
        WebviewWindowBuilder::new(&app, "workspace", WebviewUrl::App("index.html".into()))
            .title("Argus")
            .inner_size(1280.0, 800.0)
            .min_inner_size(800.0, 500.0)
            .resizable(true)
            .build()
            .map_err(|e| crate::error::AppError::Internal(e.to_string()))?;
    }

    // Emit to all windows so the Workspace rail adds and focuses this connection.
    let _ = app.emit("workspace:focus-connection", FocusConnectionPayload { id });

    Ok(())
}

// ---------------------------------------------------------------------------
// Phase 6: disconnect_all_connections — Task 6.8
// ---------------------------------------------------------------------------

/// Disconnect every currently-open connection across all engines, clear the
/// open-connections registry, and emit `connections:open-changed` so both
/// windows reflect the now-empty state.
///
/// Implementation strategy (matches Decision 7 / task 6.8):
///
/// * Postgres / MySQL / Athena — each has a `disconnect_all()` method on its
///   pool registry that drains all pools in one lock cycle.
/// * MSSQL — same, but `disconnect_all()` returns `AppResult<usize>`.
/// * DynamoDB — the `DynamoClientRegistry` has no `disconnect_all`; instead we
///   snapshot the open registry for `kind == "dynamodb"` entries and call
///   `remove()` on each id.
///
/// For all engines we directly drain the open registry map (retaining by kind)
/// *without* emitting intermediate events, then emit a single
/// `connections:open-changed` at the end so listeners see one atomic transition
/// to the empty state.
///
/// A failing disconnect for one engine is logged but does NOT abort the rest.
#[tauri::command]
pub async fn disconnect_all_connections(
    app: AppHandle,
    open_registry: State<'_, OpenConnectionsRegistry>,
    pg_pools: State<'_, PgPoolRegistry>,
    mysql_pools: State<'_, MysqlPoolRegistry>,
    mssql_pools: State<'_, MssqlPoolRegistry>,
    dynamo_clients: State<'_, DynamoClientRegistry>,
    athena_clients: State<'_, AthenaClientRegistry>,
) -> AppResult<()> {
    // --- Postgres ---
    let pg_dropped = pg_pools.disconnect_all().await;
    if pg_dropped > 0 {
        let mut guard = open_registry.inner.write().await;
        guard.retain(|_, v| v.kind != "postgres");
        tracing::info!("disconnect_all_connections: dropped {pg_dropped} postgres pool(s)");
    }

    // --- MySQL ---
    let mysql_dropped = mysql_pools.disconnect_all().await;
    if mysql_dropped > 0 {
        let mut guard = open_registry.inner.write().await;
        guard.retain(|_, v| v.kind != "mysql");
        tracing::info!("disconnect_all_connections: dropped {mysql_dropped} mysql pool(s)");
    }

    // --- MSSQL ---
    match mssql_pools.disconnect_all().await {
        Ok(mssql_dropped) => {
            if mssql_dropped > 0 {
                let mut guard = open_registry.inner.write().await;
                guard.retain(|_, v| v.kind != "mssql");
                tracing::info!("disconnect_all_connections: dropped {mssql_dropped} mssql pool(s)");
            }
        }
        Err(e) => {
            tracing::warn!("disconnect_all_connections: mssql disconnect_all error: {e}");
            // Still clear the registry entries so the open list is clean.
            let mut guard = open_registry.inner.write().await;
            guard.retain(|_, v| v.kind != "mssql");
        }
    }

    // --- Athena ---
    let athena_dropped = athena_clients.disconnect_all().await;
    if athena_dropped > 0 {
        let mut guard = open_registry.inner.write().await;
        guard.retain(|_, v| v.kind != "athena");
        tracing::info!("disconnect_all_connections: dropped {athena_dropped} athena client(s)");
    }

    // --- DynamoDB (no disconnect_all on the registry; iterate by id) ---
    // Snapshot the dynamo ids from the open registry first, then remove each.
    let dynamo_ids: Vec<Uuid> = {
        let guard = open_registry.inner.read().await;
        guard
            .iter()
            .filter(|(_, v)| v.kind == "dynamodb")
            .map(|(id, _)| *id)
            .collect()
    };
    if !dynamo_ids.is_empty() {
        let mut dynamo_dropped = 0usize;
        for id in &dynamo_ids {
            if dynamo_clients.remove(id).await {
                dynamo_dropped += 1;
            }
        }
        {
            let mut guard = open_registry.inner.write().await;
            guard.retain(|_, v| v.kind != "dynamodb");
        }
        tracing::info!(
            "disconnect_all_connections: dropped {dynamo_dropped}/{} dynamodb client(s)",
            dynamo_ids.len()
        );
    }

    // --- Emit a single connections:open-changed with the now-empty list ---
    let final_list = open_registry.list().await;
    let _ = app.emit("connections:open-changed", &final_list);

    Ok(())
}
