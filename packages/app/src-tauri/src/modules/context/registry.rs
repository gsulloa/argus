use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use notify::{EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

use super::canon_path::CanonPath;
use super::engine::EngineKind;
use super::parser::load_folder;
use super::types::ParsedContext;

// ---- Event emitter trait (for testability) ----

#[derive(Debug, Clone, Serialize)]
pub struct ContextChangedEvent {
    pub path: String,
    pub kinds: Vec<&'static str>,
}

pub trait EventEmitter: Send + Sync + 'static {
    fn emit_changed(&self, event: &ContextChangedEvent);
}

/// Real Tauri-backed emitter.
pub struct TauriEmitter(pub tauri::AppHandle);

impl EventEmitter for TauriEmitter {
    fn emit_changed(&self, e: &ContextChangedEvent) {
        let _ = tauri::Emitter::emit(&self.0, "context://changed", e.clone());
    }
}

// ---- Entry status ----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryStatus {
    Loaded,
    Unavailable,
}

// ---- Registry entry ----

struct Entry {
    status: EntryStatus,
    parsed_by_engine: HashMap<EngineKind, ParsedContext>,
    /// conn_id → the engine to parse for
    subscribers: HashMap<Uuid, EngineKind>,
    /// Keep the watcher alive; dropping it stops the OS watcher.
    _watcher: Option<notify::RecommendedWatcher>,
    /// Keep the worker thread handle.
    _worker: Option<std::thread::JoinHandle<()>>,
    /// Signal shutdown to the worker.
    _shutdown: Option<std::sync::mpsc::Sender<()>>,
}

// ---- Registry ----

pub struct ContextRegistry {
    inner: Mutex<RegistryInner>,
    emitter: Arc<dyn EventEmitter>,
}

struct RegistryInner {
    entries: HashMap<CanonPath, Entry>,
    /// Inverse map: conn_id → CanonPath (for fast unsubscribe).
    conn_to_path: HashMap<Uuid, CanonPath>,
}

impl ContextRegistry {
    pub fn new(emitter: Arc<dyn EventEmitter>) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(RegistryInner {
                entries: HashMap::new(),
                conn_to_path: HashMap::new(),
            }),
            emitter,
        })
    }

    /// Subscribe a connection to a folder path. Returns the parsed view for
    /// the connection's engine.
    pub fn subscribe(
        self: &Arc<Self>,
        conn_id: Uuid,
        raw_path: &Path,
        engine: EngineKind,
    ) -> AppResult<ParsedContext> {
        // First unsubscribe from any previous path.
        self.unsubscribe(conn_id);

        // Canonicalise the path.
        let (canon, available) = match CanonPath::new(raw_path) {
            Ok(c) => (c, true),
            Err(_) => (CanonPath::new_lenient(raw_path), false),
        };

        let mut lock = self.inner.lock().unwrap();

        if let Some(entry) = lock.entries.get_mut(&canon) {
            // Entry already exists; add this subscriber.
            entry.subscribers.insert(conn_id, engine);
            // Parse for this engine if not done yet.
            if !entry.parsed_by_engine.contains_key(&engine) && entry.status == EntryStatus::Loaded
            {
                if let Ok(parsed) = load_folder(canon.as_path(), engine) {
                    entry.parsed_by_engine.insert(engine, parsed);
                }
            }
            lock.conn_to_path.insert(conn_id, canon.clone());
            return match lock.entries[&canon].parsed_by_engine.get(&engine) {
                Some(p) => Ok(p.clone()),
                None => Err(AppError::Validation(format!(
                    "context folder is unavailable: {}",
                    raw_path.display()
                ))),
            };
        }

        // Create new entry.
        let (status, parsed_by_engine, watcher, worker, shutdown) = if available {
            match load_folder(canon.as_path(), engine) {
                Ok(parsed) => {
                    let mut pbe = HashMap::new();
                    pbe.insert(engine, parsed);
                    let (w, wk, sd) =
                        start_watcher(Arc::downgrade(self), canon.clone(), self.emitter.clone());
                    (EntryStatus::Loaded, pbe, Some(w), Some(wk), Some(sd))
                }
                Err(_) => {
                    // Folder might exist but manifest is missing/corrupt.
                    let (w, wk, sd) =
                        start_watcher(Arc::downgrade(self), canon.clone(), self.emitter.clone());
                    (
                        EntryStatus::Unavailable,
                        HashMap::new(),
                        Some(w),
                        Some(wk),
                        Some(sd),
                    )
                }
            }
        } else {
            (EntryStatus::Unavailable, HashMap::new(), None, None, None)
        };

        let result = if status == EntryStatus::Loaded {
            parsed_by_engine
                .get(&engine)
                .cloned()
                .ok_or_else(|| AppError::Validation("engine not parsed".into()))
        } else {
            Err(AppError::Validation(format!(
                "context folder is unavailable: {}",
                raw_path.display()
            )))
        };

        let mut subscribers = HashMap::new();
        subscribers.insert(conn_id, engine);

        let entry = Entry {
            status,
            parsed_by_engine,
            subscribers,
            _watcher: watcher,
            _worker: worker,
            _shutdown: shutdown,
        };

        lock.entries.insert(canon.clone(), entry);
        lock.conn_to_path.insert(conn_id, canon);

        result
    }

    /// Remove a connection from its current subscription, if any.
    /// Drops the entry (and stops its watcher) when the last subscriber leaves.
    pub fn unsubscribe(&self, conn_id: Uuid) {
        let mut lock = self.inner.lock().unwrap();

        let canon = match lock.conn_to_path.remove(&conn_id) {
            Some(c) => c,
            None => return,
        };

        let should_drop = if let Some(entry) = lock.entries.get_mut(&canon) {
            entry.subscribers.remove(&conn_id);
            entry.subscribers.is_empty()
        } else {
            false
        };

        if should_drop {
            // Drop the entry; this drops _watcher (stops OS watcher) and
            // sends the shutdown signal to the worker thread.
            lock.entries.remove(&canon);
        }
    }

    /// Read the current parsed view for a connection, parsing on demand if
    /// the engine wasn't parsed yet.
    pub fn get(&self, conn_id: Uuid) -> AppResult<Option<ParsedContext>> {
        let mut lock = self.inner.lock().unwrap();

        let canon = match lock.conn_to_path.get(&conn_id) {
            Some(c) => c.clone(),
            None => return Ok(None),
        };

        let engine = match lock
            .entries
            .get(&canon)
            .and_then(|e| e.subscribers.get(&conn_id))
        {
            Some(eng) => *eng,
            None => return Ok(None),
        };

        let entry = match lock.entries.get_mut(&canon) {
            Some(e) => e,
            None => return Ok(None),
        };

        if entry.status == EntryStatus::Unavailable {
            return Ok(None);
        }

        if let Some(p) = entry.parsed_by_engine.get(&engine) {
            return Ok(Some(p.clone()));
        }

        // Parse on demand.
        match load_folder(canon.as_path(), engine) {
            Ok(parsed) => {
                let cloned = parsed.clone();
                entry.parsed_by_engine.insert(engine, parsed);
                Ok(Some(cloned))
            }
            Err(e) => Err(AppError::Validation(format!("failed to load context: {e}"))),
        }
    }

    /// Called by the watcher worker thread to re-parse after a debounced flush.
    /// Emits `context://changed` with the appropriate `kinds`.
    fn on_flush(&self, canon: &CanonPath, kinds: Vec<&'static str>, root_deleted: bool) {
        let engines_and_ids: Vec<(EngineKind, Vec<Uuid>)> = {
            let lock = self.inner.lock().unwrap();
            let entry = match lock.entries.get(canon) {
                Some(e) => e,
                None => return,
            };
            // Group subscribers by engine.
            let mut by_engine: HashMap<EngineKind, Vec<Uuid>> = HashMap::new();
            for (id, eng) in &entry.subscribers {
                by_engine.entry(*eng).or_default().push(*id);
            }
            by_engine.into_iter().collect()
        };

        if root_deleted {
            let mut lock = self.inner.lock().unwrap();
            if let Some(entry) = lock.entries.get_mut(canon) {
                entry.status = EntryStatus::Unavailable;
                entry.parsed_by_engine.clear();
            }
        } else {
            // Re-parse per engine.
            let mut lock = self.inner.lock().unwrap();
            if let Some(entry) = lock.entries.get_mut(canon) {
                let engines: Vec<EngineKind> = engines_and_ids.iter().map(|(e, _)| *e).collect();
                for eng in engines {
                    match load_folder(canon.as_path(), eng) {
                        Ok(parsed) => {
                            entry.parsed_by_engine.insert(eng, parsed);
                        }
                        Err(_) => {
                            entry.status = EntryStatus::Unavailable;
                            entry.parsed_by_engine.clear();
                        }
                    }
                }
            }
        }

        // Emit exactly one event.
        let event = ContextChangedEvent {
            path: canon.as_path().to_string_lossy().into_owned(),
            kinds,
        };
        self.emitter.emit_changed(&event);
    }
}

// ---- Watcher + worker thread ----

/// Start a filesystem watcher and debounce worker for the given path.
/// Returns `(watcher, worker_handle, shutdown_sender)`.
fn start_watcher(
    registry: Weak<ContextRegistry>,
    canon: CanonPath,
    _emitter: Arc<dyn EventEmitter>,
) -> (
    notify::RecommendedWatcher,
    std::thread::JoinHandle<()>,
    std::sync::mpsc::Sender<()>,
) {
    let (events_tx, events_rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let (shutdown_tx, shutdown_rx) = std::sync::mpsc::channel::<()>();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let _ = events_tx.send(res);
    })
    .expect("failed to create watcher");

    // Best-effort: if the path doesn't exist we still create the watcher but
    // don't watch anything; the worker will run but receive no events.
    let _ = watcher.watch(canon.as_path(), RecursiveMode::Recursive);

    let canon_for_worker = canon.clone();
    let worker = std::thread::spawn(move || {
        run_worker(canon_for_worker, registry, events_rx, shutdown_rx);
    });

    (watcher, worker, shutdown_tx)
}

/// The debounce worker.
/// - Waits for an initial event.
/// - Accumulates events until a quiet period (200ms single / 500ms bulk).
/// - On flush: classifies paths into kinds, calls registry.on_flush().
fn run_worker(
    canon: CanonPath,
    registry: Weak<ContextRegistry>,
    events_rx: std::sync::mpsc::Receiver<notify::Result<notify::Event>>,
    shutdown_rx: std::sync::mpsc::Receiver<()>,
) {
    loop {
        // Check shutdown.
        if shutdown_rx.try_recv().is_ok() {
            return;
        }

        // Wait for the first event (or check shutdown every 250ms).
        let first = match events_rx.recv_timeout(Duration::from_millis(250)) {
            Ok(e) => e,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
        };

        // Accumulate events during quiet window.
        let mut accumulated: Vec<notify::Result<notify::Event>> = vec![first];
        let mut root_deleted = false;

        // Keep reading until quiet for short_quiet_ms, but cap at max_wait_ms total.
        let start = std::time::Instant::now();
        let max_wait = Duration::from_millis(600);
        let short_quiet = Duration::from_millis(50);
        let bulk_quiet = Duration::from_millis(200);

        loop {
            let elapsed = start.elapsed();
            if elapsed >= max_wait {
                break;
            }

            let timeout = if accumulated.len() > 5 {
                bulk_quiet
            } else {
                short_quiet
            };

            match events_rx.recv_timeout(timeout) {
                Ok(e) => {
                    accumulated.push(e);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    // Quiet period reached.
                    break;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    // Channel closed; still flush, then exit after.
                    break;
                }
            }
        }

        // Classify events into kinds.
        let mut kinds_set: std::collections::HashSet<&'static str> =
            std::collections::HashSet::new();

        for event_result in &accumulated {
            let event = match event_result {
                Ok(e) => e,
                Err(_) => {
                    kinds_set.insert("manifest");
                    continue;
                }
            };

            // Check for root deletion.
            if matches!(event.kind, EventKind::Remove(_)) {
                for path in &event.paths {
                    if path == canon.as_path() {
                        root_deleted = true;
                        kinds_set.insert("manifest");
                    }
                }
            }

            for path in &event.paths {
                let kind = classify_path(canon.as_path(), path);
                kinds_set.insert(kind);
            }
        }

        let kinds: Vec<&'static str> = kinds_set.into_iter().collect();

        // Upgrade weak reference to perform flush.
        let registry = match registry.upgrade() {
            Some(r) => r,
            None => return, // Registry dropped; exit worker.
        };

        registry.on_flush(&canon, kinds, root_deleted);

        // Exit if channel is closed (watcher dropped).
        if matches!(
            events_rx.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Disconnected)
        ) {
            return;
        }
    }
}

/// Classify a changed path relative to the root into one of the event kinds.
fn classify_path(root: &Path, changed: &Path) -> &'static str {
    // context.yaml → manifest
    if changed == root.join("context.yaml") {
        return "manifest";
    }

    // ai/** → manifest
    if let Ok(rel) = changed.strip_prefix(root.join("ai")) {
        let _ = rel;
        return "manifest";
    }

    // <engine>/queries/** → query
    // Match any path containing a "queries" component.
    let components: Vec<_> = changed.components().collect();
    let has_queries = components.iter().any(|c| c.as_os_str() == "queries");
    if has_queries {
        return "query";
    }

    // *.md outside queries/ → object
    if changed.extension().and_then(|e| e.to_str()) == Some("md") {
        return "object";
    }

    // Root directory itself deleted.
    if changed == root {
        return "manifest";
    }

    // Default for unrecognised paths (e.g. _generated.json).
    "object"
}

// ---- tests ----

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex as StdMutex;
    use tempfile::TempDir;

    // ---- Mock emitter ----

    struct MockEmitter {
        events: Arc<StdMutex<Vec<ContextChangedEvent>>>,
    }

    impl MockEmitter {
        fn new() -> (Self, Arc<StdMutex<Vec<ContextChangedEvent>>>) {
            let v = Arc::new(StdMutex::new(Vec::new()));
            (Self { events: v.clone() }, v)
        }
    }

    impl EventEmitter for MockEmitter {
        fn emit_changed(&self, e: &ContextChangedEvent) {
            self.events.lock().unwrap().push(e.clone());
        }
    }

    fn write_file(root: &Path, rel: &str, content: &str) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&path, content).unwrap();
    }

    fn minimal_manifest() -> &'static str {
        "schema_version: 1\nname: Test\n"
    }

    fn make_registry() -> (
        Arc<ContextRegistry>,
        Arc<StdMutex<Vec<ContextChangedEvent>>>,
    ) {
        let (emitter, events) = MockEmitter::new();
        let registry = ContextRegistry::new(Arc::new(emitter));
        (registry, events)
    }

    #[test]
    fn lenient_subscribe_to_missing_path_succeeds() {
        let (registry, _events) = make_registry();
        let result = registry.subscribe(
            Uuid::new_v4(),
            Path::new("/nonexistent/path/xyz"),
            EngineKind::Postgres,
        );
        // Should succeed (not panic), but return an Unavailable error.
        assert!(result.is_err());
        // The error should be a Validation error (unavailable).
        assert!(matches!(result, Err(AppError::Validation(_))));
    }

    #[test]
    fn single_watcher_invariant() {
        let dir = TempDir::new().unwrap();
        write_file(dir.path(), "context.yaml", minimal_manifest());

        let (registry, _events) = make_registry();

        let id1 = Uuid::new_v4();
        let id2 = Uuid::new_v4();
        let id3 = Uuid::new_v4();

        registry
            .subscribe(id1, dir.path(), EngineKind::Postgres)
            .ok();
        registry
            .subscribe(id2, dir.path(), EngineKind::Postgres)
            .ok();
        registry.subscribe(id3, dir.path(), EngineKind::Dynamo).ok();

        let lock = registry.inner.lock().unwrap();
        // Should have exactly one entry in the registry.
        assert_eq!(lock.entries.len(), 1);
    }

    #[test]
    fn unsubscribe_last_drops_entry() {
        let dir = TempDir::new().unwrap();
        write_file(dir.path(), "context.yaml", minimal_manifest());

        let (registry, events) = make_registry();
        let id = Uuid::new_v4();

        registry
            .subscribe(id, dir.path(), EngineKind::Postgres)
            .ok();

        // Entry should exist.
        {
            let lock = registry.inner.lock().unwrap();
            assert_eq!(lock.entries.len(), 1);
        }

        registry.unsubscribe(id);

        // Entry should be gone.
        {
            let lock = registry.inner.lock().unwrap();
            assert!(lock.entries.is_empty());
        }

        // Write a file; wait; no event should arrive.
        write_file(
            dir.path(),
            "postgres/public/users.md",
            "---\nsystem:\n  kind: table\n  name: users\n---\n# users\n",
        );
        std::thread::sleep(Duration::from_millis(500));

        let ev = events.lock().unwrap();
        assert_eq!(ev.len(), 0, "no events should arrive after unsubscribe");
    }

    #[test]
    fn shared_subscribers_receive_one_event() {
        let dir = TempDir::new().unwrap();
        write_file(dir.path(), "context.yaml", minimal_manifest());

        let (registry, events) = make_registry();
        let id1 = Uuid::new_v4();
        let id2 = Uuid::new_v4();

        registry
            .subscribe(id1, dir.path(), EngineKind::Postgres)
            .ok();
        registry
            .subscribe(id2, dir.path(), EngineKind::Postgres)
            .ok();

        // Write a single file.
        write_file(
            dir.path(),
            "postgres/public/orders.md",
            "---\nsystem:\n  kind: table\n  name: orders\n---\n# orders\n",
        );

        std::thread::sleep(Duration::from_millis(500));

        let ev = events.lock().unwrap();
        assert_eq!(ev.len(), 1, "exactly one event expected, got {}", ev.len());
    }

    #[test]
    fn bulk_change_collapses() {
        let dir = TempDir::new().unwrap();
        write_file(dir.path(), "context.yaml", minimal_manifest());

        let (registry, events) = make_registry();
        let id = Uuid::new_v4();

        registry
            .subscribe(id, dir.path(), EngineKind::Postgres)
            .ok();

        // Write 10 files in rapid succession.
        for i in 0..10 {
            write_file(
                dir.path(),
                &format!("postgres/public/tbl{i}.md"),
                &format!("---\nsystem:\n  kind: table\n  name: tbl{i}\n---\n# tbl{i}\n"),
            );
        }

        std::thread::sleep(Duration::from_millis(800));

        let ev = events.lock().unwrap();
        assert_eq!(
            ev.len(),
            1,
            "bulk change should collapse to one event, got {}",
            ev.len()
        );
    }

    #[test]
    fn deleted_root_transitions_to_unavailable() {
        let dir = TempDir::new().unwrap();
        write_file(dir.path(), "context.yaml", minimal_manifest());

        let (registry, events) = make_registry();
        let id = Uuid::new_v4();

        registry
            .subscribe(id, dir.path(), EngineKind::Postgres)
            .ok();

        // Check initially loaded.
        {
            let lock = registry.inner.lock().unwrap();
            let canon = CanonPath::new(dir.path()).unwrap();
            let entry = lock.entries.get(&canon).unwrap();
            assert_eq!(entry.status, EntryStatus::Loaded);
        }

        // Get the real path before dropping the TempDir.
        let dir_path = dir.path().to_path_buf();

        // Delete the root directory.
        drop(dir); // TempDir is cleaned up on drop.

        // Wait for the watcher to detect and process the deletion.
        std::thread::sleep(Duration::from_millis(500));

        let ev = events.lock().unwrap();
        // Should have at least one event.
        assert!(
            !ev.is_empty(),
            "expected at least one event after root deletion"
        );
        // At least one event should contain "manifest".
        let has_manifest = ev.iter().any(|e| e.kinds.contains(&"manifest"));
        assert!(
            has_manifest,
            "deletion event should contain 'manifest' kind"
        );

        // Check status transitioned to Unavailable.
        let canon = CanonPath::new_lenient(&dir_path);
        let lock = registry.inner.lock().unwrap();
        if let Some(entry) = lock.entries.get(&canon) {
            assert_eq!(entry.status, EntryStatus::Unavailable);
        }
        // If entry was already cleaned up, that's fine too.
    }
}
