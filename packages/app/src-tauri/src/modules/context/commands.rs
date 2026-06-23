use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::athena::pool::AthenaClientRegistry;
use crate::modules::cloudwatch::client::CloudwatchClientRegistry;
use crate::modules::dynamo::client::DynamoClientRegistry;
use crate::modules::mssql::pool::MssqlPoolRegistry;
use crate::modules::mysql::pool::MysqlPoolRegistry;
use crate::modules::postgres::pool::PgPoolRegistry;
use crate::platform::connections::{self, ConnectionUpdate};
use crate::platform::DbState;

use crate::modules::dynamo::params::TableMatch;

use super::ai::{build_empty_payload, build_payload};
use super::engine::EngineKind;
use super::introspect_adapters::{introspector_for, IntrospectorPools};
use super::normalize::normalize;
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
///
/// `Some` is only used by the legacy migration's tests; production code calls
/// this with `None` to strip a legacy value out of a shared, committable
/// `context.yaml` once it has been relocated into local per-connection storage.
pub(crate) fn write_project_source_path(root: &Path, path: Option<&str>) -> AppResult<()> {
    let mut manifest = parse_manifest(root).map_err(|e| AppError::Storage(format!("{e}")))?;
    match path {
        Some(p) => {
            manifest.extras.insert(
                PROJECT_SOURCE_PATH_KEY.to_string(),
                serde_yaml::Value::String(p.to_string()),
            );
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

/// Resolve a connection's project source path against an open DB connection.
///
/// Returns the connection's locally-stored `project_source_path` if set. If it
/// is absent but the connection has a linked context folder whose `context.yaml`
/// still carries a legacy `project_source_path`, that value is migrated: it is
/// written into the connection record and stripped from `context.yaml` (leaving
/// `schema_version`, `name`, and other extras intact), then returned. Returns
/// `None` when neither source exists. A missing or unparseable legacy
/// `context.yaml` is treated as "no legacy value" rather than an error.
pub(crate) fn resolve_project_source_path_conn(
    conn: &rusqlite::Connection,
    conn_id: Uuid,
) -> AppResult<Option<String>> {
    let record = connections::list(conn)?
        .into_iter()
        .find(|c| c.id == conn_id)
        .ok_or_else(|| AppError::NotFound(format!("connection {conn_id} not found")))?;

    if let Some(p) = record.project_source_path.filter(|s| !s.trim().is_empty()) {
        return Ok(Some(p));
    }

    let Some(root) = record.context_path else {
        return Ok(None);
    };
    let root_path = Path::new(&root);

    // A broken or missing legacy context.yaml is not fatal: there is simply
    // nothing to migrate.
    let Some(legacy) = read_project_source_path(root_path).ok().flatten() else {
        return Ok(None);
    };

    connections::update(
        conn,
        conn_id,
        ConnectionUpdate {
            project_source_path: Some(Some(legacy.clone())),
            ..Default::default()
        },
    )?;
    write_project_source_path(root_path, None)?;
    Ok(Some(legacy))
}

/// Resolve a connection's project source path, locking the shared DB.
///
/// Thin wrapper over [`resolve_project_source_path_conn`] used by Tauri command
/// handlers and the AI model inspector.
pub(crate) fn resolve_project_source_path(
    db: &State<'_, DbState>,
    conn_id: Uuid,
) -> AppResult<Option<String>> {
    let lock = db.0.lock().expect("db poisoned");
    resolve_project_source_path_conn(&lock, conn_id)
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

/// Load the Dynamo table-name normalization rule for a connection from its
/// persisted `params` JSON. Returns `None` for non-Dynamo connections, a
/// missing connection, or an absent rule. Reuses the existing params column
/// (the `connection-registry` treats params as opaque JSON).
pub(crate) fn load_table_match(
    db: &State<'_, DbState>,
    conn_id: Uuid,
) -> AppResult<Option<TableMatch>> {
    let lock = db.0.lock().expect("db poisoned");
    let conns = connections::list(&lock)?;
    let conn = match conns.into_iter().find(|c| c.id == conn_id) {
        Some(c) => c,
        None => return Ok(None),
    };
    if EngineKind::from_connection_kind(&conn.kind) != Some(EngineKind::Dynamo) {
        return Ok(None);
    }
    match conn.params.get("table_match") {
        Some(v) if !v.is_null() => {
            let tm: TableMatch = serde_json::from_value(v.clone())
                .map_err(|e| AppError::Validation(format!("invalid table_match: {e}")))?;
            if tm.is_effectively_empty() {
                Ok(None)
            } else {
                Ok(Some(tm))
            }
        }
        _ => Ok(None),
    }
}

/// Collect `dynamo_model` docs whose derived `physical_table` equals
/// `physical_table` (already normalized). Pure helper for testability.
fn collect_models(objects: &[ObjectDoc], physical_table: &str) -> Vec<ModelListItem> {
    objects
        .iter()
        .filter(|doc| {
            doc.system.kind == "dynamo_model"
                && doc.system.physical_table.as_deref() == Some(physical_table)
        })
        .map(|doc| ModelListItem {
            name: doc.system.name.clone(),
            access_patterns: doc.system.access_patterns.clone().unwrap_or_default(),
            body: doc.body.clone(),
        })
        .collect()
}

// ---- 5.1: context_create_folder ----

/// Create a new context folder at `path` with the given `name`.
///
/// Behaviour:
/// - Directory does not exist → scaffold `context.yaml`, `README.md`, `.gitignore` and return
///   the canonical path.
/// - Directory exists and is empty → scaffold as above.
/// - Directory exists, is non-empty, and contains a parseable `context.yaml` → idempotent:
///   return the canonical path without touching any existing files.
/// - Directory exists, is non-empty, and does NOT contain a parseable `context.yaml` →
///   return `AppError::Validation("directory not empty")`.
#[tauri::command]
pub fn context_create_folder(path: String, name: String) -> AppResult<String> {
    let dir = Path::new(&path);

    if dir.exists() {
        // Check whether the directory has any contents.
        let mut entries =
            std::fs::read_dir(dir).map_err(|e| AppError::Storage(format!("io: {e}")))?;
        if entries.next().is_some() {
            // Non-empty: accept only if it is already a valid context folder.
            match parse_manifest(dir) {
                Ok(_) => {
                    // Valid context folder — idempotent success; return canonical path.
                    let canon = std::fs::canonicalize(dir)
                        .map_err(|e| AppError::Storage(format!("io: {e}")))?;
                    return Ok(canon.to_string_lossy().into_owned());
                }
                Err(_) => {
                    return Err(AppError::Validation("directory not empty".into()));
                }
            }
        }
        // Empty directory — fall through to scaffold.
    } else {
        std::fs::create_dir_all(dir).map_err(|e| AppError::Storage(format!("io: {e}")))?;
    }

    // Scaffold: write context.yaml
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

// ---- context_list_known_folders ----

/// One entry in the `context_list_known_folders` result.
#[derive(Serialize)]
pub struct KnownFolderEntry {
    /// Canonical root path.
    pub path: String,
    /// Display name from `context.yaml`.
    pub name: String,
    /// Ids (as strings) of all connections whose `context_path` resolves to
    /// this canonical root.
    pub connection_ids: Vec<String>,
}

/// Core logic for listing known context folders; extracted for testability.
///
/// Takes a raw DB connection so tests can pass an in-memory database directly
/// without needing a Tauri `State` wrapper.
pub(crate) fn list_known_folders_inner(
    db_conn: &rusqlite::Connection,
) -> AppResult<Vec<KnownFolderEntry>> {
    // Collect (connection_id, context_path) pairs.
    let conn_paths: Vec<(Uuid, String)> = connections::list(db_conn)?
        .into_iter()
        .filter_map(|c| c.context_path.map(|p| (c.id, p)))
        .collect();

    // Canonicalize each path and group connection ids by canonical root.
    // Vec<String> preserves insertion order for deterministic output.
    let mut order: Vec<String> = Vec::new();
    let mut groups: std::collections::HashMap<String, Vec<Uuid>> = std::collections::HashMap::new();

    for (conn_id, raw_path) in conn_paths {
        let canonical = match std::fs::canonicalize(&raw_path) {
            Ok(p) => p.to_string_lossy().into_owned(),
            Err(_) => continue, // path no longer exists — skip
        };
        let entry = groups.entry(canonical.clone()).or_insert_with(|| {
            order.push(canonical.clone());
            Vec::new()
        });
        entry.push(conn_id);
    }

    // Build result: parse manifest for each surviving root; omit on parse failure.
    let mut result = Vec::new();
    for canonical in order {
        let ids = match groups.get(&canonical) {
            Some(v) => v,
            None => continue,
        };
        let manifest = match parse_manifest(std::path::Path::new(&canonical)) {
            Ok(m) => m,
            Err(_) => continue, // missing or unparseable manifest — skip
        };
        result.push(KnownFolderEntry {
            path: canonical,
            name: manifest.name,
            connection_ids: ids.iter().map(|id| id.to_string()).collect(),
        });
    }

    Ok(result)
}

/// Return the distinct context-folder roots already referenced by saved
/// connections, enriched with the manifest name and the set of connection ids
/// sharing each root.
///
/// Roots that no longer exist on disk, or whose `context.yaml` cannot be
/// parsed, are silently omitted. Group membership is not considered.
#[tauri::command]
pub fn context_list_known_folders(db: State<'_, DbState>) -> AppResult<Vec<KnownFolderEntry>> {
    // Drop the DB lock before doing any filesystem IO.
    let lock = db.0.lock().expect("db poisoned");
    list_known_folders_inner(&lock)
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

    // For Dynamo connections, fold the incoming identity through the
    // normalization rule before comparison so a CDK-named live table resolves
    // to its logical doc. Non-Dynamo connections load no rule → unchanged.
    let rule = load_table_match(&db, conn_id)?;
    let needle = normalize(&identity_str, rule.as_ref());

    Ok(parsed
        .objects
        .into_iter()
        .find(|doc| identity(doc) == needle))
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

    // Load the connection's normalization rule (None for non-Dynamo / unset),
    // then match the model's logical `physical_table` against the normalized
    // form of the incoming live table name.
    let rule = load_table_match(&db, conn_id)?;

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

    let normalized = normalize(&table, rule.as_ref());
    let items = collect_models(&parsed.objects, &normalized);

    tracing::info!(
        table = %table,
        normalized = %normalized,
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
    athena: State<'_, AthenaClientRegistry>,
    cloudwatch: State<'_, CloudwatchClientRegistry>,
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
        athena: &athena,
        cloudwatch: &cloudwatch,
    };
    let introspector = introspector_for(engine, pools);
    let shapes = introspector.introspect_for_context(conn_id).await?;

    // Load the Dynamo normalization rule (None for other engines / unset) so
    // sync writes files under logical names and dedups colliding live tables.
    let rule = load_table_match(&db, conn_id)?;

    // Execute sync (engine-agnostic; rule applied only for Dynamo).
    let report = execute_sync(
        std::path::Path::new(&context_path),
        engine,
        shapes,
        rule.as_ref(),
    )
    .await?;

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
/// The incoming `table` is the live (physical) name; it is folded through the
/// connection's normalization rule so models written from a CDK-named live table
/// land under the logical folder (matching the read path and schema-sync).
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
        AppError::Validation(format!("connection {conn_id} has no linked context folder"))
    })?;

    // Fold the live table name to its logical name (identity when no rule).
    let rule = load_table_match(&db, conn_id)?;
    let table = normalize(&table, rule.as_ref());

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
        let bytes = rewrite_file_with_system_yaml(&target, &sys_yaml, draft.body.as_deref())?;
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

/// Return the connection's locally-stored `project_source_path`, or `None` if
/// not configured. Transparently migrates a legacy value out of the linked
/// folder's `context.yaml` on first read (see [`resolve_project_source_path`]).
/// Does not require the connection to have a linked context folder.
#[tauri::command]
pub fn context_get_project_source(
    db: State<'_, DbState>,
    connection_id: String,
) -> AppResult<Option<String>> {
    let conn_id = parse_conn_id(&connection_id)?;
    resolve_project_source_path(&db, conn_id)
}

/// Store `project_source_path` as local per-connection state. This is never
/// written to the shared, committable `context.yaml`. Does not require the
/// connection to have a linked context folder.
#[tauri::command]
pub fn context_set_project_source(
    db: State<'_, DbState>,
    connection_id: String,
    path: String,
) -> AppResult<()> {
    let conn_id = parse_conn_id(&connection_id)?;
    let lock = db.0.lock().expect("db poisoned");
    connections::update(
        &lock,
        conn_id,
        ConnectionUpdate {
            project_source_path: Some(Some(path)),
            ..Default::default()
        },
    )?;
    Ok(())
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
        AppError::Validation(format!("connection {conn_id} has no linked context folder"))
    })?;

    // Fold the live table name to its logical name (identity when no rule).
    let rule = load_table_match(&db, conn_id)?;
    let table = normalize(&table, rule.as_ref());

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
        assert_eq!(
            slug_for_model_name("order_item-v2").unwrap(),
            "order_item-v2"
        );
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

    // ---- resolve_project_source_path_conn (local per-connection storage) ----
    // (imports `ConnectionInput`/`ConnectionUpdate`/`open_in_memory` defined
    // further down in this module are visible here module-wide.)

    fn make_conn(
        db: &rusqlite::Connection,
        context_path: Option<String>,
        project_source_path: Option<String>,
    ) -> Uuid {
        connections::create(
            db,
            ConnectionInput {
                name: "x".into(),
                kind: "dynamo".into(),
                params: serde_json::Value::Null,
                group_id: None,
                secret: None,
                context_path,
                project_source_path,
                color: None,
            },
        )
        .unwrap()
        .id
    }

    #[test]
    fn resolve_returns_db_value_and_ignores_context_yaml() {
        let db = open_in_memory().unwrap();
        let dir = TempDir::new().unwrap();
        // context.yaml carries a DIFFERENT legacy value that must be ignored.
        fs::write(
            dir.path().join("context.yaml"),
            "schema_version: 1\nname: Test\nproject_source_path: /legacy/path\n",
        )
        .unwrap();
        let id = make_conn(
            &db,
            Some(dir.path().to_string_lossy().into_owned()),
            Some("/db/path".into()),
        );

        let resolved = resolve_project_source_path_conn(&db, id).unwrap();
        assert_eq!(resolved.as_deref(), Some("/db/path"));

        // context.yaml left untouched: legacy key still present.
        let manifest = parse_manifest(dir.path()).unwrap();
        assert_eq!(
            manifest
                .extras
                .get(PROJECT_SOURCE_PATH_KEY)
                .and_then(|v| v.as_str()),
            Some("/legacy/path")
        );
    }

    #[test]
    fn resolve_migrates_legacy_context_yaml_into_db() {
        let db = open_in_memory().unwrap();
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("context.yaml"),
            "schema_version: 1\nname: Billing\nproject_source_path: /Users/me/app\nother_key: keep\n",
        )
        .unwrap();
        let id = make_conn(&db, Some(dir.path().to_string_lossy().into_owned()), None);

        let resolved = resolve_project_source_path_conn(&db, id).unwrap();
        assert_eq!(resolved.as_deref(), Some("/Users/me/app"));

        // DB column is now populated.
        let after = connections::list(&db).unwrap();
        assert_eq!(
            after[0].project_source_path.as_deref(),
            Some("/Users/me/app")
        );

        // context.yaml lost the key but kept schema_version/name/other extras.
        let manifest = parse_manifest(dir.path()).unwrap();
        assert!(manifest.extras.get(PROJECT_SOURCE_PATH_KEY).is_none());
        assert_eq!(manifest.schema_version, 1);
        assert_eq!(manifest.name, "Billing");
        assert_eq!(
            manifest.extras.get("other_key").and_then(|v| v.as_str()),
            Some("keep")
        );
    }

    #[test]
    fn set_and_resolve_without_linked_folder() {
        // The "no linked context folder" precondition is dropped: a connection
        // with no context_path can still store and resolve a project source
        // path, and nothing is written to any context.yaml.
        let db = open_in_memory().unwrap();
        let id = make_conn(&db, None, None);

        // Emulate context_set_project_source.
        connections::update(
            &db,
            id,
            ConnectionUpdate {
                project_source_path: Some(Some("/repo".into())),
                ..Default::default()
            },
        )
        .unwrap();

        let resolved = resolve_project_source_path_conn(&db, id).unwrap();
        assert_eq!(resolved.as_deref(), Some("/repo"));
    }

    #[test]
    fn resolve_returns_none_when_unset_and_no_folder() {
        let db = open_in_memory().unwrap();
        let id = make_conn(&db, None, None);
        assert!(resolve_project_source_path_conn(&db, id).unwrap().is_none());
    }

    // ---- read-path matching with normalization (task 3.3) ----

    use crate::modules::context::parser::load_folder;
    use crate::modules::dynamo::params::TableMatch;

    /// Write a `dynamo_model` doc under `dynamo/tables/<table>/models/<name>.md`.
    fn write_model(root: &std::path::Path, table: &str, name: &str) {
        let rel = format!("dynamo/tables/{table}/models/{name}.md");
        let content = format!(
            "---\nsystem:\n  kind: dynamo_model\n  name: {name}\n  access_patterns:\n    - index: table\n      pk: \"PK#${{id}}\"\nhuman: {{}}\n---\n# {name}\n"
        );
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn cdk_prefix_rule(prefix: &str) -> TableMatch {
        TableMatch {
            prefix: Some(prefix.to_string()),
            suffix_pattern: Some("-[A-Z0-9]+$".to_string()),
            regex: None,
        }
    }

    // 3.3 — CDK-named live table matches logical model docs.
    #[test]
    fn cdk_named_table_matches_logical_models() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("context.yaml"),
            "schema_version: 1\nname: T\n",
        )
        .unwrap();
        write_model(dir.path(), "EventsTable", "Event");
        write_model(dir.path(), "EventsTable", "Attendee");

        let ctx = load_folder(dir.path(), EngineKind::Dynamo).unwrap();
        let rule = cdk_prefix_rule("MyApp-prod-");
        let normalized = normalize("MyApp-prod-EventsTable-3M4N5O6P7Q8R", Some(&rule));
        assert_eq!(normalized, "EventsTable");

        let items = collect_models(&ctx.objects, &normalized);
        let mut names: Vec<_> = items.iter().map(|m| m.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["Attendee".to_string(), "Event".to_string()]);
    }

    // 3.3 — same folder reused across two connections with different prefixes.
    #[test]
    fn same_folder_reused_across_environments() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("context.yaml"),
            "schema_version: 1\nname: T\n",
        )
        .unwrap();
        write_model(dir.path(), "EventsTable", "Event");

        let ctx = load_folder(dir.path(), EngineKind::Dynamo).unwrap();

        let dev = cdk_prefix_rule("MyApp-dev-");
        let prod = cdk_prefix_rule("MyApp-prod-");

        let dev_items = collect_models(
            &ctx.objects,
            &normalize("MyApp-dev-EventsTable-AAAA1111", Some(&dev)),
        );
        let prod_items = collect_models(
            &ctx.objects,
            &normalize("MyApp-prod-EventsTable-BBBB2222", Some(&prod)),
        );

        assert_eq!(dev_items.len(), 1);
        assert_eq!(prod_items.len(), 1);
        assert_eq!(dev_items[0].name, "Event");
        assert_eq!(prod_items[0].name, "Event");
    }

    // 3.4 — models written under the logical folder are found by the read path
    // when querying with the live (suffixed) name. Regression for the AI
    // extraction landing models under the physical-named folder.
    #[test]
    fn model_written_under_logical_folder_is_found_via_live_name() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("context.yaml"),
            "schema_version: 1\nname: T\n",
        )
        .unwrap();

        // Rule strips a lowercase-hex CDK suffix.
        let rule = TableMatch {
            prefix: None,
            suffix_pattern: Some("-[0-9a-f]+$".to_string()),
            regex: None,
        };
        let live = "InventoryTable-0a12ed4ec6bf";
        let logical = normalize(live, Some(&rule));
        assert_eq!(logical, "InventoryTable");

        // context_save_model normalizes `table` before building the path, so the
        // model lands under the logical folder.
        write_model(dir.path(), &logical, "Slot");

        let ctx = load_folder(dir.path(), EngineKind::Dynamo).unwrap();
        // Reading with the live name normalizes to the same logical name.
        let items = collect_models(&ctx.objects, &normalize(live, Some(&rule)));
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "Slot");
    }

    // 3.3 — unconfigured connection still matches exactly.
    #[test]
    fn unconfigured_connection_matches_exactly() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("context.yaml"),
            "schema_version: 1\nname: T\n",
        )
        .unwrap();
        write_model(dir.path(), "AppTable", "Order");

        let ctx = load_folder(dir.path(), EngineKind::Dynamo).unwrap();

        // No rule → exact match.
        let exact = collect_models(&ctx.objects, &normalize("AppTable", None));
        assert_eq!(exact.len(), 1);

        // A suffixed live name without a rule does NOT match.
        let suffixed = collect_models(&ctx.objects, &normalize("MyApp-prod-AppTable-XYZ", None));
        assert!(suffixed.is_empty());
    }

    // ---- context_create_folder (task 1.4) ----

    // 1.4a — fresh path scaffolds context.yaml, README.md, .gitignore.
    #[test]
    fn create_folder_fresh_path_scaffolds() {
        let base = TempDir::new().unwrap();
        let target = base.path().join("my-project");
        // Directory must not exist yet.
        assert!(!target.exists());

        let result =
            context_create_folder(target.to_string_lossy().into_owned(), "My Project".into());
        assert!(result.is_ok(), "expected Ok, got {:?}", result);

        assert!(target.join("context.yaml").exists(), "context.yaml missing");
        assert!(target.join("README.md").exists(), "README.md missing");
        assert!(target.join(".gitignore").exists(), ".gitignore missing");

        let manifest = parse_manifest(&target).unwrap();
        assert_eq!(manifest.schema_version, 1);
        assert_eq!(manifest.name, "My Project");
    }

    // 1.4b — existing valid context folder returns canonical path, files unchanged.
    #[test]
    fn create_folder_existing_valid_returns_path_untouched() {
        let base = TempDir::new().unwrap();
        let target = base.path().join("shared-project");
        fs::create_dir_all(&target).unwrap();

        // Scaffold a valid context folder with extra content.
        let original_yaml = "schema_version: 1\nname: Shared Project\nextra_key: keep_me\n";
        fs::write(target.join("context.yaml"), original_yaml).unwrap();
        fs::write(target.join("README.md"), "# original readme\n").unwrap();
        fs::write(target.join(".gitignore"), "**/_generated.*\n").unwrap();
        // Simulate an object doc to ensure nothing is touched.
        fs::create_dir_all(target.join("postgres/public")).unwrap();
        fs::write(
            target.join("postgres/public/users.md"),
            "---\nsystem:\n  kind: table\n  name: users\nhuman: {}\n---\n# users\n",
        )
        .unwrap();

        // Call create_folder a second time (as if a second connection links the same root).
        let result = context_create_folder(
            target.to_string_lossy().into_owned(),
            "Different Name".into(),
        );
        assert!(result.is_ok(), "expected Ok, got {:?}", result);

        // context.yaml must be byte-for-byte identical to what we wrote.
        let yaml_after = fs::read_to_string(target.join("context.yaml")).unwrap();
        assert_eq!(
            yaml_after, original_yaml,
            "context.yaml was modified when it should be untouched"
        );

        // README.md also untouched.
        let readme_after = fs::read_to_string(target.join("README.md")).unwrap();
        assert_eq!(readme_after, "# original readme\n");

        // Object doc untouched.
        let doc_after = fs::read_to_string(target.join("postgres/public/users.md")).unwrap();
        assert!(doc_after.contains("# users"));
    }

    // 1.4c — non-empty foreign directory (no context.yaml) returns Validation error.
    #[test]
    fn create_folder_foreign_nonempty_dir_errors() {
        let base = TempDir::new().unwrap();
        let target = base.path().join("foreign-dir");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("some_file.txt"), "I am not a context folder").unwrap();

        let result = context_create_folder(target.to_string_lossy().into_owned(), "Ignored".into());
        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "expected Validation error, got {:?}",
            result
        );
    }

    // ---- context_list_known_folders (task 2.6) ----

    use crate::platform::connections::{update as conn_update, ConnectionInput, ConnectionUpdate};
    use crate::platform::storage::open_in_memory;

    fn fresh_db() -> rusqlite::Connection {
        open_in_memory().expect("open in-memory db")
    }

    fn make_connection_with_path(
        db: &rusqlite::Connection,
        name: &str,
        kind: &str,
        context_path: Option<String>,
    ) -> uuid::Uuid {
        let conn = crate::platform::connections::create(
            db,
            ConnectionInput {
                name: name.into(),
                kind: kind.into(),
                params: serde_json::Value::Null,
                group_id: None,
                secret: None,
                context_path,
                project_source_path: None,
                color: None,
            },
        )
        .unwrap();
        conn.id
    }

    // Helper: create a valid context folder on disk and return its canonical path.
    fn make_context_folder(base: &std::path::Path, subdir: &str, folder_name: &str) -> String {
        let dir = base.join(subdir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("context.yaml"),
            format!("schema_version: 1\nname: {folder_name}\n"),
        )
        .unwrap();
        std::fs::canonicalize(&dir)
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    // 2.6 — two connections sharing one canonical root collapse to one entry with both ids.
    #[test]
    fn list_known_folders_two_conns_same_root() {
        let base = TempDir::new().unwrap();
        let canonical = make_context_folder(base.path(), "project", "My Project");

        let db = fresh_db();
        let id_a = make_connection_with_path(&db, "pg-conn", "postgres", Some(canonical.clone()));
        let id_b =
            make_connection_with_path(&db, "dynamo-conn", "dynamodb", Some(canonical.clone()));

        let result = list_known_folders_inner(&db).unwrap();
        assert_eq!(result.len(), 1, "expected one entry");
        assert_eq!(result[0].name, "My Project");
        assert_eq!(result[0].path, canonical);

        let mut ids = result[0].connection_ids.clone();
        ids.sort();
        let mut expected = vec![id_a.to_string(), id_b.to_string()];
        expected.sort();
        assert_eq!(ids, expected);
    }

    // 2.6 — stale/non-existent path is omitted.
    #[test]
    fn list_known_folders_stale_path_omitted() {
        let db = fresh_db();
        make_connection_with_path(
            &db,
            "stale-conn",
            "postgres",
            Some("/nonexistent/path/that/does/not/exist".into()),
        );

        let result = list_known_folders_inner(&db).unwrap();
        assert!(
            result.is_empty(),
            "expected empty, got {:?} entries",
            result.len()
        );
    }

    // 2.6 — no linked folders returns empty.
    #[test]
    fn list_known_folders_no_linked_folders_returns_empty() {
        let db = fresh_db();
        make_connection_with_path(&db, "conn-a", "postgres", None);
        make_connection_with_path(&db, "conn-b", "dynamodb", None);

        let result = list_known_folders_inner(&db).unwrap();
        assert!(result.is_empty());
    }

    // 2.6 — cross-group sharing returns a single entry with all connection ids.
    #[test]
    fn list_known_folders_cross_group_single_entry() {
        let base = TempDir::new().unwrap();
        let canonical = make_context_folder(base.path(), "shared", "Cross Group Project");

        // Create connections in different groups (groups not created here to keep
        // it simple; group_id is None for both — the key property is that group
        // membership does not matter for deduplication).
        let db = fresh_db();
        let id_a = make_connection_with_path(&db, "conn-1", "postgres", Some(canonical.clone()));
        let id_b = make_connection_with_path(&db, "conn-2", "mysql", Some(canonical.clone()));

        let result = list_known_folders_inner(&db).unwrap();
        assert_eq!(result.len(), 1);

        let mut ids = result[0].connection_ids.clone();
        ids.sort();
        let mut expected = vec![id_a.to_string(), id_b.to_string()];
        expected.sort();
        assert_eq!(ids, expected);
    }

    // 2.6 — path without a valid context.yaml manifest is omitted.
    #[test]
    fn list_known_folders_no_manifest_omitted() {
        let base = TempDir::new().unwrap();
        let dir = base.path().join("foreign");
        fs::create_dir_all(&dir).unwrap();
        // No context.yaml — just a random file.
        fs::write(dir.join("random.txt"), "hello").unwrap();
        let raw_path = dir.to_string_lossy().into_owned();

        let db = fresh_db();
        make_connection_with_path(&db, "conn", "postgres", Some(raw_path));

        let result = list_known_folders_inner(&db).unwrap();
        assert!(result.is_empty());
    }
}
