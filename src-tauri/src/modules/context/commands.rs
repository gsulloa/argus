use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::dynamo::client::DynamoClientRegistry;
use crate::modules::mssql::pool::MssqlPoolRegistry;
use crate::modules::mysql::pool::MysqlPoolRegistry;
use crate::modules::postgres::pool::PgPoolRegistry;
use crate::platform::connections::{self, ConnectionUpdate};
use crate::platform::DbState;

use super::ai::{build_empty_payload, build_payload};
use super::engine::EngineKind;
use super::introspect_adapters::{introspector_for, IntrospectorPools};
use super::parser::parse_manifest;
use super::registry::ContextRegistry;
use super::sync::execute_sync;
use super::types::{AiPayload, ContextManifest, ObjectDoc, QueryDoc, QueryParam, SyncReport};

// ---- Response types ----

#[derive(Serialize)]
pub struct ObjectListItem {
    pub identity: String,
    pub kind: String,
    pub name: String,
    pub schema: Option<String>,
    pub has_human: bool,
    pub deleted_in_db: bool,
}

#[derive(Serialize)]
pub struct QueryListItem {
    pub name: String,
    pub description: Option<String>,
    pub params: Vec<QueryParam>,
    pub tags: Vec<String>,
}

// ---- Helpers ----

fn parse_conn_id(s: &str) -> AppResult<Uuid> {
    Uuid::parse_str(s).map_err(|e| AppError::Validation(format!("invalid connection id: {e}")))
}

/// Look up a connection and return its `kind` string.
/// Drops the DB lock before returning.
fn get_conn_kind(db: &State<'_, DbState>, conn_id: Uuid) -> AppResult<String> {
    let lock = db.0.lock().expect("db poisoned");
    let conns = connections::list(&lock)?;
    conns
        .into_iter()
        .find(|c| c.id == conn_id)
        .map(|c| c.kind)
        .ok_or_else(|| AppError::NotFound(format!("connection {conn_id} not found")))
}

/// Look up a connection and return `(kind, context_path)`.
/// Drops the DB lock before returning.
pub(crate) fn get_conn_kind_and_path(
    db: &State<'_, DbState>,
    conn_id: Uuid,
) -> AppResult<(String, Option<String>)> {
    let lock = db.0.lock().expect("db poisoned");
    let conns = connections::list(&lock)?;
    conns
        .into_iter()
        .find(|c| c.id == conn_id)
        .map(|c| (c.kind, c.context_path))
        .ok_or_else(|| AppError::NotFound(format!("connection {conn_id} not found")))
}

fn identity(doc: &ObjectDoc) -> String {
    match &doc.system.schema {
        Some(s) => format!("{}.{}", s, doc.system.name),
        None => doc.system.name.clone(),
    }
}

// ---- 5.1: context_create_folder ----

/// Create a new context folder at `path` with the given `name`.
/// Errors if the directory exists and is non-empty.
/// Returns the canonical path string.
#[tauri::command]
pub fn context_create_folder(path: String, name: String) -> AppResult<String> {
    let dir = Path::new(&path);

    if dir.exists() {
        // Error if non-empty.
        let mut entries =
            std::fs::read_dir(dir).map_err(|e| AppError::Storage(format!("io: {e}")))?;
        if entries.next().is_some() {
            return Err(AppError::Validation("directory not empty".into()));
        }
    } else {
        std::fs::create_dir_all(dir).map_err(|e| AppError::Storage(format!("io: {e}")))?;
    }

    // Write context.yaml
    #[derive(serde::Serialize)]
    struct ManifestInit {
        schema_version: u32,
        name: String,
    }
    let manifest_content = serde_yaml::to_string(&ManifestInit {
        schema_version: 1,
        name: name.clone(),
    })
    .map_err(|e| AppError::Internal(format!("yaml: {e}")))?;
    std::fs::write(dir.join("context.yaml"), manifest_content)
        .map_err(|e| AppError::Storage(format!("io: {e}")))?;

    // Write README.md
    let readme = format!("# {name}\n\nContext folder for Argus.\n");
    std::fs::write(dir.join("README.md"), readme)
        .map_err(|e| AppError::Storage(format!("io: {e}")))?;

    // Write .gitignore
    let gitignore = "**/_generated.*\n**/.argus-cache/\n";
    std::fs::write(dir.join(".gitignore"), gitignore)
        .map_err(|e| AppError::Storage(format!("io: {e}")))?;

    let canon = std::fs::canonicalize(dir).map_err(|e| AppError::Storage(format!("io: {e}")))?;
    Ok(canon.to_string_lossy().into_owned())
}

// ---- 5.2: context_link_folder ----

/// Link a context folder to a connection.
/// Validates the folder (must have a valid context.yaml), persists context_path,
/// subscribes in the registry, and returns the manifest.
#[tauri::command]
pub fn context_link_folder(
    db: State<'_, DbState>,
    registry: State<'_, Arc<ContextRegistry>>,
    connection_id: String,
    path: String,
) -> AppResult<ContextManifest> {
    let conn_id = parse_conn_id(&connection_id)?;

    // Validate the folder by parsing the manifest.
    let manifest = parse_manifest(Path::new(&path))
        .map_err(|e| AppError::Validation(format!("invalid context folder: {e}")))?;

    // Look up the connection kind (drop DB lock before registry call).
    let kind = get_conn_kind(&db, conn_id)?;
    let engine = EngineKind::from_connection_kind(&kind)
        .ok_or_else(|| AppError::Validation(format!("unsupported engine kind: {kind}")))?;

    // Persist context_path on the connection.
    {
        let lock = db.0.lock().expect("db poisoned");
        connections::update(
            &lock,
            conn_id,
            ConnectionUpdate {
                context_path: Some(Some(path.clone())),
                ..Default::default()
            },
        )?;
    }

    // Subscribe in the registry (ignore the returned ParsedContext; we return manifest).
    let _ = registry.subscribe(conn_id, Path::new(&path), engine);

    Ok(manifest)
}

// ---- 5.3: context_unlink ----

/// Unlink the context folder from a connection. Clears context_path; does not touch disk.
#[tauri::command]
pub fn context_unlink(
    db: State<'_, DbState>,
    registry: State<'_, Arc<ContextRegistry>>,
    connection_id: String,
) -> AppResult<()> {
    let conn_id = parse_conn_id(&connection_id)?;

    {
        let lock = db.0.lock().expect("db poisoned");
        connections::update(
            &lock,
            conn_id,
            ConnectionUpdate {
                context_path: Some(None),
                ..Default::default()
            },
        )?;
    }

    registry.unsubscribe(conn_id);
    Ok(())
}

// ---- 5.4: context_list_objects ----

/// List all objects in the linked context folder for a connection's engine.
#[tauri::command]
pub fn context_list_objects(
    registry: State<'_, Arc<ContextRegistry>>,
    connection_id: String,
) -> AppResult<Vec<ObjectListItem>> {
    let conn_id = parse_conn_id(&connection_id)?;

    // Need to ensure subscribed; load registry view.
    let parsed = registry.get(conn_id)?;
    let parsed = match parsed {
        Some(p) => p,
        None => return Ok(vec![]),
    };

    Ok(parsed
        .objects
        .iter()
        .map(|doc| {
            let has_human = doc.human.tags.is_some()
                || doc.human.owners.is_some()
                || doc.human.column_notes.is_some();
            let deleted_in_db = doc.system.deleted_in_db.unwrap_or(false);
            ObjectListItem {
                identity: identity(doc),
                kind: doc.system.kind.clone(),
                name: doc.system.name.clone(),
                schema: doc.system.schema.clone(),
                has_human,
                deleted_in_db,
            }
        })
        .collect())
}

// ---- 5.5: context_get_object ----

/// Return the full ObjectDoc for the given identity (e.g. "public.users").
#[tauri::command]
pub fn context_get_object(
    registry: State<'_, Arc<ContextRegistry>>,
    connection_id: String,
    identity_str: String,
) -> AppResult<Option<ObjectDoc>> {
    let conn_id = parse_conn_id(&connection_id)?;

    let parsed = registry.get(conn_id)?;
    let parsed = match parsed {
        Some(p) => p,
        None => return Ok(None),
    };

    Ok(parsed
        .objects
        .into_iter()
        .find(|doc| identity(doc) == identity_str))
}

// ---- 5.6: context_list_queries ----

/// List all queries in the linked context folder for a connection's engine.
#[tauri::command]
pub fn context_list_queries(
    registry: State<'_, Arc<ContextRegistry>>,
    connection_id: String,
) -> AppResult<Vec<QueryListItem>> {
    let conn_id = parse_conn_id(&connection_id)?;

    let parsed = registry.get(conn_id)?;
    let parsed = match parsed {
        Some(p) => p,
        None => return Ok(vec![]),
    };

    Ok(parsed
        .queries
        .into_iter()
        .map(|q| QueryListItem {
            name: q.name,
            description: q.description,
            params: q.params,
            tags: q.tags,
        })
        .collect())
}

// ---- 5.7: context_get_query ----

/// Return the full QueryDoc (including body) for the given query name.
#[tauri::command]
pub fn context_get_query(
    registry: State<'_, Arc<ContextRegistry>>,
    connection_id: String,
    name: String,
) -> AppResult<Option<QueryDoc>> {
    let conn_id = parse_conn_id(&connection_id)?;

    let parsed = registry.get(conn_id)?;
    let parsed = match parsed {
        Some(p) => p,
        None => return Ok(None),
    };

    Ok(parsed.queries.into_iter().find(|q| q.name == name))
}

// ---- 5.8: context_sync_schema ----

/// Sync the schema for the linked context folder.
///
/// Introspects the live connection and runs the sync executor, returning a `SyncReport`.
#[tauri::command]
pub async fn context_sync_schema(
    connection_id: String,
    db: State<'_, DbState>,
    pool: State<'_, PgPoolRegistry>,
    mysql: State<'_, MysqlPoolRegistry>,
    mssql: State<'_, MssqlPoolRegistry>,
    dynamo: State<'_, DynamoClientRegistry>,
    registry: State<'_, Arc<ContextRegistry>>,
) -> AppResult<SyncReport> {
    let conn_id = parse_conn_id(&connection_id)?;

    // Look up kind + context_path.
    let (kind, context_path) = get_conn_kind_and_path(&db, conn_id)?;
    let context_path = context_path.ok_or_else(|| {
        AppError::Validation(format!("connection {conn_id} has no linked context folder"))
    })?;

    let engine = EngineKind::from_connection_kind(&kind)
        .ok_or_else(|| AppError::Validation(format!("unsupported engine kind: {kind}")))?;

    // Introspect schema.
    let pools = IntrospectorPools {
        pg: &pool,
        mysql: &mysql,
        mssql: &mssql,
        dynamo: &dynamo,
    };
    let introspector = introspector_for(engine, pools);
    let shapes = introspector.introspect_for_context(conn_id).await?;

    // Execute sync (engine-agnostic).
    let report = execute_sync(std::path::Path::new(&context_path), engine, shapes).await?;

    // The filesystem watcher will pick up the written files and emit
    // `context://changed` within the debounce window. No explicit reload needed.
    let _ = registry.get(conn_id); // keep the borrow checker happy

    Ok(report)
}

// ---- context_reveal_path ----

/// Reveal the given path in the OS file manager (Finder on macOS, Explorer on Windows,
/// xdg-open on Linux). Non-blocking: spawns the helper and returns immediately.
#[tauri::command]
pub fn context_reveal_path(path: String) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| AppError::Internal(format!("reveal failed: {e}")))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()
            .map_err(|e| AppError::Internal(format!("reveal failed: {e}")))?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux / other: open the parent directory.
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| AppError::Internal(format!("reveal failed: {e}")))?;
    }
    Ok(())
}

// ---- 5.9: context_ai_payload ----

/// Return a serialised AI context payload for the linked folder.
///
/// `include_full_bodies` defaults to `false` (use body summaries).
/// Returns an empty payload when no folder is linked or the registry has no
/// entry for this connection.
#[tauri::command]
pub fn context_ai_payload(
    connection_id: String,
    include_full_bodies: Option<bool>,
    db: State<'_, DbState>,
    registry: State<'_, Arc<ContextRegistry>>,
) -> AppResult<AiPayload> {
    let conn_id = parse_conn_id(&connection_id)?;
    let include_full = include_full_bodies.unwrap_or(false);

    // Check context_path; empty payload if not linked.
    let (_kind, context_path) = get_conn_kind_and_path(&db, conn_id)?;
    if context_path.is_none() {
        return Ok(build_empty_payload());
    }

    // Get parsed context from registry.
    let parsed = registry.get(conn_id)?;
    match parsed {
        None => Ok(build_empty_payload()),
        Some(p) => Ok(build_payload(&p, include_full)),
    }
}
