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
use super::sync::{atomic_write, build_fresh_doc, execute_sync, rewrite_file_with_system_yaml};
use super::types::{
    AccessPattern, AiPayload, ContextManifest, ObjectDoc, ParsedContext, QueryDoc, QueryParam,
    SyncReport,
};

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

// ---- Constants ----

pub(crate) const PROJECT_SOURCE_PATH_KEY: &str = "project_source_path";

// ---- Helpers ----

fn parse_conn_id(s: &str) -> AppResult<Uuid> {
    Uuid::parse_str(s).map_err(|e| AppError::Validation(format!("invalid connection id: {e}")))
}

/// Read `project_source_path` from `<root>/context.yaml`'s manifest extras.
/// Returns `None` if absent.
pub(crate) fn read_project_source_path(root: &Path) -> AppResult<Option<String>> {
    let manifest = parse_manifest(root).map_err(|e| AppError::Storage(format!("{e}")))?;
    Ok(manifest
        .extras
        .get(PROJECT_SOURCE_PATH_KEY)
        .and_then(|v| v.as_str())
        .map(str::to_string))
}

/// Set (Some) or remove (None) `project_source_path` in `<root>/context.yaml`,
/// preserving `schema_version`, `name`, and all other extras.
/// Writes atomically via `atomic_write`.
pub(crate) fn write_project_source_path(root: &Path, path: Option<&str>) -> AppResult<()> {
    let mut manifest = parse_manifest(root).map_err(|e| AppError::Storage(format!("{e}")))?;
    match path {
        Some(p) => {
            manifest
                .extras
                .insert(PROJECT_SOURCE_PATH_KEY.to_string(), serde_yaml::Value::String(p.to_string()));
        }
        None => {
            manifest.extras.remove(PROJECT_SOURCE_PATH_KEY);
        }
    }
    let yaml = serde_yaml::to_string(&manifest)
        .map_err(|e| AppError::Internal(format!("yaml serialise manifest: {e}")))?;
    atomic_write(&root.join("context.yaml"), yaml.as_bytes())?;
    Ok(())
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

/// Return the parsed context for a connection, subscribing the linked folder on
/// demand if the registry has no entry yet.
///
/// The registry is in-memory and is only populated by `context_link_folder`, so
/// after an app restart (or before the folder was ever linked this session) a
/// linked connection would otherwise read as empty. This lazily (re)subscribes
/// using the connection's persisted `context_path`, so docs and Dynamo model
/// docs are detected without forcing a manual re-link.
fn get_or_subscribe(
    db: &State<'_, DbState>,
    registry: &State<'_, Arc<ContextRegistry>>,
    conn_id: Uuid,
) -> AppResult<Option<ParsedContext>> {
    // Already subscribed and loaded → use it.
    if let Some(parsed) = registry.get(conn_id)? {
        return Ok(Some(parsed));
    }

    // Not subscribed (or unavailable) — try to (re)subscribe from the stored path.
    let (kind, context_path) = get_conn_kind_and_path(db, conn_id)?;
    let path = match context_path {
        Some(p) => p,
        None => return Ok(None),
    };
    let engine = match EngineKind::from_connection_kind(&kind) {
        Some(e) => e,
        None => return Ok(None),
    };
    match registry.subscribe(conn_id, Path::new(&path), engine) {
        Ok(parsed) => Ok(Some(parsed)),
        Err(e) => {
            tracing::warn!(
                conn_id = %conn_id,
                path = %path,
                "context: lazy subscribe failed: {e}"
            );
            Ok(None)
        }
    }
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
    db: State<'_, DbState>,
    registry: State<'_, Arc<ContextRegistry>>,
    connection_id: String,
) -> AppResult<Vec<ObjectListItem>> {
    let conn_id = parse_conn_id(&connection_id)?;

    // Ensure the linked folder is subscribed (lazily re-subscribe after restart).
    let parsed = get_or_subscribe(&db, &registry, conn_id)?;
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
    db: State<'_, DbState>,
    registry: State<'_, Arc<ContextRegistry>>,
    connection_id: String,
    identity_str: String,
) -> AppResult<Option<ObjectDoc>> {
    let conn_id = parse_conn_id(&connection_id)?;

    let parsed = get_or_subscribe(&db, &registry, conn_id)?;
    let parsed = match parsed {
        Some(p) => p,
        None => return Ok(None),
    };

    Ok(parsed
        .objects
        .into_iter()
        .find(|doc| identity(doc) == identity_str))
}

// ---- 5.5b: context_list_models ----

/// Response item for `context_list_models`.
#[derive(Serialize)]
pub struct ModelListItem {
    pub name: String,
    pub access_patterns: Vec<AccessPattern>,
    /// Raw Markdown body of the model doc, so the editor can seed its body
    /// field when editing without re-reading the file.
    pub body: String,
}

/// Return all `dynamo_model` objects whose `physical_table` matches `table`.
///
/// Returns an empty `Vec` (not an error) when the connection has no linked
/// context folder or when no models exist for the given table.
///
/// Mirrors `context_list_objects` in registry access style.
#[tauri::command]
pub fn context_list_models(
    db: State<'_, DbState>,
    registry: State<'_, Arc<ContextRegistry>>,
    connection_id: String,
    table: String,
) -> AppResult<Vec<ModelListItem>> {
    let conn_id = parse_conn_id(&connection_id)?;

    let parsed = get_or_subscribe(&db, &registry, conn_id)?;
    let parsed = match parsed {
        Some(p) => p,
        None => return Ok(vec![]),
    };

    let total_objects = parsed.objects.len();
    let model_docs = parsed
        .objects
        .iter()
        .filter(|d| d.system.kind == "dynamo_model")
        .count();

    let items: Vec<ModelListItem> = parsed
        .objects
        .into_iter()
        .filter(|doc| {
            doc.system.kind == "dynamo_model"
                && doc.system.physical_table.as_deref() == Some(table.as_str())
        })
        .map(|doc| ModelListItem {
            name: doc.system.name.clone(),
            access_patterns: doc.system.access_patterns.clone().unwrap_or_default(),
            body: doc.body.clone(),
        })
        .collect();

    tracing::info!(
        table = %table,
        total_objects,
        model_docs,
        matched = items.len(),
        "context_list_models"
    );

    Ok(items)
}

// ---- 5.6: context_list_queries ----

/// List all queries in the linked context folder for a connection's engine.
#[tauri::command]
pub fn context_list_queries(
    db: State<'_, DbState>,
    registry: State<'_, Arc<ContextRegistry>>,
    connection_id: String,
) -> AppResult<Vec<QueryListItem>> {
    let conn_id = parse_conn_id(&connection_id)?;

    let parsed = get_or_subscribe(&db, &registry, conn_id)?;
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
    db: State<'_, DbState>,
    registry: State<'_, Arc<ContextRegistry>>,
    connection_id: String,
    name: String,
) -> AppResult<Option<QueryDoc>> {
    let conn_id = parse_conn_id(&connection_id)?;

    let parsed = get_or_subscribe(&db, &registry, conn_id)?;
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

// ---- Dynamo model write helpers ----

/// A draft model document supplied by the frontend for create/update.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ModelDraft {
    pub name: String,
    pub access_patterns: Vec<AccessPattern>,
    #[serde(default)]
    pub body: Option<String>,
}

/// Derive an on-disk filename stem from an entity name: keep [A-Za-z0-9_-],
/// replace any run of other chars with a single '-', trim leading/trailing '-'.
/// Returns `AppError::Validation` if the result is empty.
fn slug_for_model_name(name: &str) -> AppResult<String> {
    let mut slug = String::new();
    let mut in_run = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            slug.push(ch);
            in_run = false;
        } else if !in_run {
            slug.push('-');
            in_run = true;
        }
    }
    // Trim leading/trailing '-'.
    let slug = slug.trim_matches('-').to_owned();
    if slug.is_empty() {
        return Err(AppError::Validation(format!(
            "model name {:?} produces an empty filename slug",
            name
        )));
    }
    Ok(slug)
}

// ---- 5.10: context_save_model ----

/// Result returned by `context_save_model`.
#[derive(serde::Serialize)]
pub struct SaveModelResult {
    pub path: String,
    pub created: bool,
}

/// Create or update a Dynamo model doc at
/// `<context_root>/dynamo/tables/<table>/models/<slug>.md`.
///
/// On create: writes a fresh doc with the given access patterns and optional body.
/// On update: splices the new system YAML in, optionally replacing the body.
/// Collision guard: if the file exists but its `name` differs from `draft.name`,
/// returns `AppError::Validation` and writes nothing.
#[tauri::command]
pub fn context_save_model(
    db: State<'_, DbState>,
    connection_id: String,
    table: String,
    draft: ModelDraft,
) -> AppResult<SaveModelResult> {
    let conn_id = parse_conn_id(&connection_id)?;
    let (_kind, context_path) = get_conn_kind_and_path(&db, conn_id)?;
    let root = context_path.ok_or_else(|| {
        AppError::Validation(format!(
            "connection {conn_id} has no linked context folder"
        ))
    })?;

    // Validate at least one access pattern.
    if draft.access_patterns.is_empty() {
        return Err(AppError::Validation(
            "a model requires at least one access pattern".into(),
        ));
    }

    let slug = slug_for_model_name(&draft.name)?;
    let models_dir = Path::new(&root)
        .join("dynamo")
        .join("tables")
        .join(&table)
        .join("models");
    let target = models_dir.join(format!("{slug}.md"));

    // Collision check: if the file exists, confirm it belongs to the same entity.
    let file_exists = target.exists();
    if file_exists {
        if let Ok(doc) = crate::modules::context::parser::parse_object_doc(&target) {
            if doc.system.name != draft.name {
                return Err(AppError::Validation(format!(
                    "filename {slug}.md already belongs to a different entity \"{}\"",
                    doc.system.name
                )));
            }
        }
    }

    // Build clean system YAML (no null fields, no physical_table).
    #[derive(serde::Serialize)]
    struct ModelSystemDoc<'a> {
        kind: &'static str,
        name: &'a str,
        access_patterns: &'a [AccessPattern],
    }
    let sys_yaml = serde_yaml::to_string(&ModelSystemDoc {
        kind: "dynamo_model",
        name: &draft.name,
        access_patterns: &draft.access_patterns,
    })
    .map_err(|e| AppError::Internal(format!("yaml serialise model system: {e}")))?;

    let created;
    if file_exists {
        // Edit: splice new system YAML, optionally replace body.
        let bytes =
            rewrite_file_with_system_yaml(&target, &sys_yaml, draft.body.as_deref())?;
        atomic_write(&target, &bytes)?;
        created = false;
    } else {
        // Create: build fresh doc.
        let body = match draft.body.as_deref() {
            Some(b) if !b.is_empty() => b.to_owned(),
            _ => format!("# {}\n", draft.name),
        };
        let content = build_fresh_doc(&sys_yaml, &body);
        atomic_write(&target, content.as_bytes())?;
        created = true;
    }

    Ok(SaveModelResult {
        path: target.to_string_lossy().into_owned(),
        created,
    })
}

// ---- context_get_project_source / context_set_project_source ----

/// Return the `project_source_path` from the linked context folder's `context.yaml`,
/// or `None` if not configured. Returns an error if the connection has no linked folder.
#[tauri::command]
pub fn context_get_project_source(
    db: State<'_, DbState>,
    connection_id: String,
) -> AppResult<Option<String>> {
    let conn_id = parse_conn_id(&connection_id)?;
    let (_kind, context_path) = get_conn_kind_and_path(&db, conn_id)?;
    let root = context_path.ok_or_else(|| {
        AppError::Validation(format!("connection {conn_id} has no linked context folder"))
    })?;
    read_project_source_path(Path::new(&root))
}

/// Set the `project_source_path` in the linked context folder's `context.yaml`.
/// Returns an error if the connection has no linked folder.
#[tauri::command]
pub fn context_set_project_source(
    db: State<'_, DbState>,
    connection_id: String,
    path: String,
) -> AppResult<()> {
    let conn_id = parse_conn_id(&connection_id)?;
    let (_kind, context_path) = get_conn_kind_and_path(&db, conn_id)?;
    let root = context_path.ok_or_else(|| {
        AppError::Validation(format!("connection {conn_id} has no linked context folder"))
    })?;
    write_project_source_path(Path::new(&root), Some(&path))
}

// ---- 5.11: context_delete_model ----

/// Result returned by `context_delete_model`.
#[derive(serde::Serialize)]
pub struct DeleteModelResult {
    pub deleted: bool,
}

/// Delete the model doc at
/// `<context_root>/dynamo/tables/<table>/models/<slug>.md`.
///
/// Returns `{ deleted: true }` when the file was found and removed.
/// Returns `{ deleted: false }` when the file does not exist (no-op-safe).
/// Does NOT touch the table doc or any other model file.
#[tauri::command]
pub fn context_delete_model(
    db: State<'_, DbState>,
    connection_id: String,
    table: String,
    model_name: String,
) -> AppResult<DeleteModelResult> {
    let conn_id = parse_conn_id(&connection_id)?;
    let (_kind, context_path) = get_conn_kind_and_path(&db, conn_id)?;
    let root = context_path.ok_or_else(|| {
        AppError::Validation(format!(
            "connection {conn_id} has no linked context folder"
        ))
    })?;

    let slug = slug_for_model_name(&model_name)?;
    let target = Path::new(&root)
        .join("dynamo")
        .join("tables")
        .join(&table)
        .join("models")
        .join(format!("{slug}.md"));

    if target.exists() {
        std::fs::remove_file(&target)
            .map_err(|e| AppError::Storage(format!("delete model {}: {e}", target.display())))?;
        Ok(DeleteModelResult { deleted: true })
    } else {
        Ok(DeleteModelResult { deleted: false })
    }
}

// ---- unit tests ----

#[cfg(test)]
mod tests {
    use super::*;

    // ---- slug_for_model_name ----

    #[test]
    fn slug_simple_name() {
        assert_eq!(slug_for_model_name("Order").unwrap(), "Order");
    }

    #[test]
    fn slug_name_with_spaces() {
        assert_eq!(slug_for_model_name("Order Item").unwrap(), "Order-Item");
    }

    #[test]
    fn slug_name_with_special_chars() {
        assert_eq!(slug_for_model_name("Order Item!").unwrap(), "Order-Item");
    }

    #[test]
    fn slug_run_of_non_alnum() {
        // Multiple consecutive non-alnum chars collapse to a single '-'.
        assert_eq!(slug_for_model_name("A  B!!C").unwrap(), "A-B-C");
    }

    #[test]
    fn slug_trims_leading_trailing_dashes() {
        assert_eq!(slug_for_model_name("!Order!").unwrap(), "Order");
    }

    #[test]
    fn slug_empty_input_is_error() {
        assert!(slug_for_model_name("").is_err());
    }

    #[test]
    fn slug_whitespace_only_is_error() {
        assert!(slug_for_model_name("  ").is_err());
    }

    #[test]
    fn slug_underscore_and_dash_preserved() {
        assert_eq!(slug_for_model_name("order_item-v2").unwrap(), "order_item-v2");
    }

    // ---- project_source_path helpers ----

    use std::fs;
    use tempfile::TempDir;

    fn write_minimal_context_yaml(dir: &std::path::Path) {
        fs::write(
            dir.join("context.yaml"),
            "schema_version: 1\nname: Test\nsome_extra: keepme\n",
        )
        .unwrap();
    }

    #[test]
    fn project_source_path_set_then_read() {
        let dir = TempDir::new().unwrap();
        write_minimal_context_yaml(dir.path());

        write_project_source_path(dir.path(), Some("/Users/me/app")).unwrap();
        let result = read_project_source_path(dir.path()).unwrap();
        assert_eq!(result, Some("/Users/me/app".to_string()));
    }

    #[test]
    fn project_source_path_set_preserves_other_fields() {
        let dir = TempDir::new().unwrap();
        write_minimal_context_yaml(dir.path());

        write_project_source_path(dir.path(), Some("/Users/me/app")).unwrap();

        // Re-parse and verify other fields are intact.
        let manifest = parse_manifest(dir.path()).unwrap();
        assert_eq!(manifest.schema_version, 1);
        assert_eq!(manifest.name, "Test");
        assert!(
            manifest.extras.contains_key("some_extra"),
            "some_extra should still be present after write"
        );
        assert_eq!(
            manifest.extras.get("some_extra").and_then(|v| v.as_str()),
            Some("keepme")
        );
    }

    #[test]
    fn project_source_path_absent_returns_none() {
        let dir = TempDir::new().unwrap();
        // context.yaml without project_source_path
        fs::write(
            dir.path().join("context.yaml"),
            "schema_version: 1\nname: Test\n",
        )
        .unwrap();

        let result = read_project_source_path(dir.path()).unwrap();
        assert_eq!(result, None);
    }
}
