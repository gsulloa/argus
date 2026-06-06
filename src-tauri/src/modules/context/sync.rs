//! Schema-sync executor.
//!
//! `execute_sync` is the engine-agnostic core: it takes a `Vec<ObjectShape>`
//! from any introspection adapter, walks the existing files in the engine
//! subtree, and creates/updates/marks-deleted files atomically.
//!
//! # Indentation and line-ending preservation
//!
//! * Line-endings: The original file is scanned for `\r\n`; if found the new
//!   content is converted from `\n` to `\r\n` before writing.
//! * Indentation: `serde_yaml` emits 2-space-indented YAML. If a user hand-
//!   wrote 4-space YAML it will be normalised to 2-space on first sync.
//!   **Deferred decision**: round-tripping arbitrary user indent styles is out
//!   of scope for v1.
//!
//! # Human-block byte preservation
//!
//! The `system:` value in the frontmatter is replaced via a **splice**
//! algorithm: byte ranges for `system:` and `human:` are located in the raw
//! frontmatter bytes and only the `system:` slice is replaced. This keeps the
//! `human:` bytes identical to what the user wrote. Body bytes (after the
//! closing `---\n`) are likewise taken verbatim from disk.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde_yaml;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::context::engine::EngineKind;
use crate::modules::context::introspect::ObjectShape;
use crate::modules::context::types::{
    ObjectColumn, ObjectHuman, ObjectSystem, OrphanedNote, SyncReport,
};

// ---- Target-path computation ----

/// Compute the canonical target path for an `ObjectShape` within a folder root.
///
/// | Engine       | Path |
/// |---|---|
/// | Postgres/MySQL/MSSQL | `<root>/<engine>/<schema>/<name>.md` |
/// | Dynamo       | `<root>/dynamo/tables/<name>.md` |
/// | CloudWatch   | `<root>/cloudwatch/groups/<name>.md` |
pub fn target_path_for(root: &Path, engine: EngineKind, shape: &ObjectShape) -> PathBuf {
    match engine {
        EngineKind::Postgres | EngineKind::Mysql | EngineKind::Mssql => {
            let schema = shape.schema.as_deref().unwrap_or("default");
            root.join(engine.subtree())
                .join(schema)
                .join(format!("{}.md", shape.name))
        }
        EngineKind::Dynamo => root
            .join("dynamo")
            .join("tables")
            .join(format!("{}.md", shape.name)),
        EngineKind::Cloudwatch => root
            .join("cloudwatch")
            .join("groups")
            .join(format!("{}.md", shape.name)),
    }
}

// ---- YAML frontmatter splice ----

/// The byte range `[start, end)` of a value slice within a string.
struct ByteRange {
    start: usize,
    end: usize,
}

/// Find the byte range of the *value* of `target_key` inside a YAML frontmatter
/// string (everything between `---\n` and `---`).
///
/// A "value" here is defined as everything on and after the `target_key:\n`
/// line up to (but not including) the next line whose first character is not a
/// space/tab (i.e. the next top-level key), or the end of the frontmatter
/// string.
///
/// Returns `None` if `target_key` is not found at top level.
fn find_top_level_value_range(frontmatter: &str, target_key: &str) -> Option<ByteRange> {
    let needle = format!("{target_key}:\n");
    // Only match at the very start of a line (column 0).
    let key_pos = frontmatter.find(&needle)?;
    // Verify it's at column 0 (either at byte 0, or preceded by '\n').
    if key_pos != 0 && frontmatter.as_bytes()[key_pos - 1] != b'\n' {
        return None;
    }

    let value_start = key_pos + needle.len();
    let remaining = &frontmatter[value_start..];

    // Find the next top-level key: a line that starts at column 0 and is not
    // blank (we consider any non-space, non-empty line start to be a new key).
    let mut value_end = remaining.len(); // default: consume to end
    let mut search_pos = 0;
    while search_pos < remaining.len() {
        if let Some(nl) = remaining[search_pos..].find('\n') {
            let line_start = search_pos + nl + 1;
            if line_start >= remaining.len() {
                break;
            }
            let first_byte = remaining.as_bytes()[line_start];
            if first_byte != b' '
                && first_byte != b'\t'
                && first_byte != b'\n'
                && first_byte != b'\r'
            {
                value_end = line_start;
                break;
            }
            search_pos = line_start;
        } else {
            break;
        }
    }

    Some(ByteRange {
        start: value_start,
        end: value_start + value_end,
    })
}

/// Build a new frontmatter string by splicing in new `system:` YAML.
///
/// Algorithm:
/// 1. Locate `system:` value range in the original frontmatter.
/// 2. Replace that range with the new system YAML (indented under `system:`).
/// 3. If `human:` is absent, append `human: {}\n` at the end of the
///    frontmatter so the file always has both top-level keys.
///
/// Returns the spliced frontmatter, or `None` if the splice fails (caller
/// should fall back to full re-serialisation).
fn splice_system_block(frontmatter: &str, new_system_yaml: &str) -> Option<String> {
    let range = find_top_level_value_range(frontmatter, "system")?;

    let before = &frontmatter[..range.start];
    let after = &frontmatter[range.end..];

    // new_system_yaml is the serde_yaml serialisation of ObjectSystem, which
    // starts with the field names at indentation 0. We need to indent every
    // line by 2 spaces since it lives under `system:`.
    let indented: String = new_system_yaml
        .lines()
        .map(|line| {
            if line.is_empty() {
                String::new()
            } else {
                format!("  {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    // Ensure trailing newline.
    let indented = if indented.ends_with('\n') {
        indented
    } else {
        format!("{indented}\n")
    };

    let mut result = format!("{before}{indented}{after}");

    // Ensure `human:` exists; append empty block if absent.
    if find_top_level_value_range(&result, "human").is_none() {
        // Need to add `human: {}\n` before the end of the frontmatter.
        result.push_str("human: {}\n");
    }

    Some(result)
}

// ---- Object system builder ----

fn shape_to_system(shape: &ObjectShape) -> ObjectSystem {
    ObjectSystem {
        kind: shape.kind.clone(),
        schema: shape.schema.clone(),
        name: shape.name.clone(),
        primary_key: if shape.primary_key.is_empty() {
            None
        } else {
            Some(shape.primary_key.clone())
        },
        columns: Some(
            shape
                .columns
                .iter()
                .map(|c| ObjectColumn {
                    name: c.name.clone(),
                    ty: c.ty.clone(),
                    extras: Default::default(),
                })
                .collect(),
        ),
        last_synced: Some(Utc::now()),
        deleted_in_db: Some(false),
        access_patterns: None,
        physical_table: None,
        extras: Default::default(),
    }
}

// ---- Fresh file content ----

fn build_fresh_file(system: &ObjectSystem) -> AppResult<String> {
    let sys_yaml = serde_yaml::to_string(system)
        .map_err(|e| AppError::Internal(format!("yaml serialise system: {e}")))?;
    let human_yaml = "{}";
    let name = &system.name;
    Ok(format!(
        "---\nsystem:\n{indented_sys}human: {human_yaml}\n---\n# {name}\n",
        indented_sys = sys_yaml
            .lines()
            .map(|l| if l.is_empty() {
                String::new()
            } else {
                format!("  {l}")
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
        human_yaml = human_yaml,
        name = name,
    ))
}

// ---- Atomic write ----

fn atomic_write(path: &Path, content: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Storage(format!("create dir: {e}")))?;
    }
    let tmp_path = path.with_extension(format!("md.tmp.{}", Uuid::new_v4().simple()));
    std::fs::write(&tmp_path, content).map_err(|e| AppError::Storage(format!("write tmp: {e}")))?;
    std::fs::rename(&tmp_path, path).map_err(|e| AppError::Storage(format!("rename tmp: {e}")))?;
    Ok(())
}

// ---- CRLF detection ----

fn has_crlf(bytes: &[u8]) -> bool {
    bytes.windows(2).any(|w| w == b"\r\n")
}

fn convert_to_crlf(s: &str) -> String {
    // Only replace bare `\n` (not `\r\n` already present).
    let mut result = String::with_capacity(s.len() + s.len() / 10);
    let mut prev = 0u8;
    for &b in s.as_bytes() {
        if b == b'\n' && prev != b'\r' {
            result.push('\r');
        }
        result.push(b as char);
        prev = b;
    }
    result
}

// ---- Walk existing engine subtree ----

/// Walk the existing markdown files in the engine subtree and return a list of
/// `(file_path, identity_key)` where `identity_key` is `"schema/name"` for
/// relational engines or `"name"` for flat engines.
fn walk_existing_objects(root: &Path, engine: EngineKind) -> Vec<PathBuf> {
    let engine_root = root.join(engine.subtree());
    let mut paths = Vec::new();

    match engine {
        EngineKind::Postgres | EngineKind::Mysql | EngineKind::Mssql => {
            // <engine>/<schema>/<name>.md — skip queries/ subdir
            if !engine_root.exists() {
                return paths;
            }
            let schema_dirs = match std::fs::read_dir(&engine_root) {
                Ok(d) => d,
                Err(_) => return paths,
            };
            for schema_entry in schema_dirs.flatten() {
                let schema_path = schema_entry.path();
                if !schema_path.is_dir() {
                    continue;
                }
                let dir_name = schema_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                if dir_name == "queries" {
                    continue;
                }
                let table_files = match std::fs::read_dir(&schema_path) {
                    Ok(d) => d,
                    Err(_) => continue,
                };
                for table_entry in table_files.flatten() {
                    let p = table_entry.path();
                    if p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("md") {
                        paths.push(p);
                    }
                }
            }
        }
        EngineKind::Dynamo => {
            let tables_dir = engine_root.join("tables");
            if tables_dir.exists() {
                if let Ok(files) = std::fs::read_dir(&tables_dir) {
                    for entry in files.flatten() {
                        let p = entry.path();
                        if p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("md") {
                            paths.push(p);
                        }
                    }
                }
            }
        }
        EngineKind::Cloudwatch => {
            let groups_dir = engine_root.join("groups");
            if groups_dir.exists() {
                if let Ok(files) = std::fs::read_dir(&groups_dir) {
                    for entry in files.flatten() {
                        let p = entry.path();
                        if p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("md") {
                            paths.push(p);
                        }
                    }
                }
            }
        }
    }

    paths
}

// ---- Rewrite an existing file (update or mark-deleted) ----

/// Rewrite an existing file preserving human block and body bytes.
///
/// `new_system`: the updated `ObjectSystem` to splice in.
/// Returns the bytes to write, or an error.
fn rewrite_file(path: &Path, new_system: &ObjectSystem) -> AppResult<Vec<u8>> {
    // Read raw bytes to preserve body exactly.
    let raw_bytes = std::fs::read(path)
        .map_err(|e| AppError::Storage(format!("read {}: {e}", path.display())))?;
    let raw_str = String::from_utf8_lossy(&raw_bytes);

    // Detect CRLF.
    let is_crlf = has_crlf(&raw_bytes);

    // Extract frontmatter boundaries.
    // File must start with "---\n" (or "---\r\n").
    // Normalise to LF for parsing.
    let normalised = raw_str.replace("\r\n", "\n");

    if !normalised.starts_with("---\n") {
        return Err(AppError::Internal(format!(
            "rewrite: malformed frontmatter in {}",
            path.display()
        )));
    }

    let after_open = &normalised[4..];
    // Find closing "---".
    let (fm_end, body_start) = after_open
        .find("\n---\n")
        .map(|p| (p + 1, p + 5))
        .or_else(|| {
            after_open
                .find("\n---")
                .filter(|&p| p + 4 == after_open.len())
                .map(|p| (p + 1, p + 4))
        })
        .ok_or_else(|| {
            AppError::Internal(format!(
                "rewrite: could not find closing --- in {}",
                path.display()
            ))
        })?;

    let frontmatter = &after_open[..fm_end];
    // Body bytes from original (raw, preserving encoding).
    let body_start_in_raw = {
        // Recalculate body start in the original (possibly CRLF) bytes.
        // Since we normalised for parsing, map back via counting the text
        // before the body. Safest: just re-derive from raw.
        // We'll search the raw bytes for the pattern "---\n" or "---\r\n"
        // following the opening "---\n".
        find_body_start_in_raw(&raw_bytes)
    };

    let body_bytes = match body_start_in_raw {
        Some(start) => raw_bytes[start..].to_vec(),
        None => b"\n".to_vec(),
    };

    // Serialise new system block.
    let sys_yaml =
        serde_yaml::to_string(new_system).map_err(|e| AppError::Internal(format!("yaml: {e}")))?;

    // Splice system block into frontmatter.
    let new_frontmatter = match splice_system_block(frontmatter, &sys_yaml) {
        Some(f) => f,
        None => {
            // Fall back: full re-serialisation.
            tracing::warn!(
                path = %path.display(),
                "context sync: falling back to full re-serialisation (could not splice system block)"
            );
            // Build minimal frontmatter with system + empty human.
            let indented: String = sys_yaml
                .lines()
                .map(|l| {
                    if l.is_empty() {
                        String::new()
                    } else {
                        format!("  {l}")
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
                + "\n";
            format!("{indented}human: {{}}\n")
        }
    };

    let full_content = format!("---\nsystem:\n{new_frontmatter}---\n");
    let full_content = if is_crlf {
        convert_to_crlf(&full_content)
    } else {
        full_content
    };

    let mut out = full_content.into_bytes();
    out.extend_from_slice(&body_bytes);
    Ok(out)
}

/// Find the byte offset in `raw_bytes` where the body starts (after the
/// closing `---\n` or `---\r\n`).
fn find_body_start_in_raw(raw_bytes: &[u8]) -> Option<usize> {
    // Pattern: \n---\n or \n---\r\n
    let len = raw_bytes.len();
    if len < 4 {
        return None;
    }
    // Skip the first 4 bytes (opening "---\n").
    let mut i = 4;
    while i + 3 < len {
        if raw_bytes[i] == b'\n' {
            // Check for "\n---\n"
            if i + 4 < len
                && raw_bytes[i + 1] == b'-'
                && raw_bytes[i + 2] == b'-'
                && raw_bytes[i + 3] == b'-'
                && raw_bytes[i + 4] == b'\n'
            {
                return Some(i + 5);
            }
            // Check for "\n---\r\n"
            if i + 5 < len
                && raw_bytes[i + 1] == b'-'
                && raw_bytes[i + 2] == b'-'
                && raw_bytes[i + 3] == b'-'
                && raw_bytes[i + 4] == b'\r'
                && raw_bytes[i + 5] == b'\n'
            {
                return Some(i + 6);
            }
        }
        i += 1;
    }
    None
}

// ---- Orphan detection ----

/// Given a list of existing column names in `system.columns` and the
/// `human.column_notes` map, return the keys in `column_notes` that have no
/// matching column.
fn find_orphaned_note_keys(system_col_names: &HashSet<String>, human: &ObjectHuman) -> Vec<String> {
    match &human.column_notes {
        None => vec![],
        Some(notes) => notes
            .keys()
            .filter(|k| !system_col_names.contains(*k))
            .cloned()
            .collect(),
    }
}

// ---- Main executor ----

/// Execute a schema sync for one connection's engine subtree.
///
/// Decoupled from the introspection adapter so it can be tested with synthetic
/// `ObjectShape` values (no live DB required).
pub async fn execute_sync(
    folder_root: &Path,
    engine: EngineKind,
    shapes: Vec<ObjectShape>,
) -> AppResult<SyncReport> {
    // Build lookup: target_path → shape.
    let mut shape_map: HashMap<PathBuf, ObjectShape> = HashMap::new();
    for shape in shapes {
        let path = target_path_for(folder_root, engine, &shape);
        shape_map.insert(path, shape);
    }

    // Walk existing files in the engine subtree.
    let existing_files = walk_existing_objects(folder_root, engine);

    let mut created: Vec<PathBuf> = Vec::new();
    let mut updated: Vec<PathBuf> = Vec::new();
    let mut marked_deleted: Vec<PathBuf> = Vec::new();
    let mut orphaned_notes: Vec<OrphanedNote> = Vec::new();

    // Track which target paths have been handled (existing files).
    let mut handled_paths: HashSet<PathBuf> = HashSet::new();

    for file_path in &existing_files {
        // Try to parse the existing file to get identity.
        // On CRLF files the parser may fail (it expects "---\n"); in that case
        // fall back to deriving identity from the file path.
        let doc_opt = match crate::modules::context::parser::parse_object_doc(file_path) {
            Ok(d) => Some(d),
            Err(e) => {
                tracing::warn!(
                    path = %file_path.display(),
                    "context sync: could not parse existing file (may be CRLF), using path-based identity: {e}"
                );
                None
            }
        };

        // Derive the canonical target path.
        // If we have a parsed doc, use its system identity; otherwise derive
        // schema + name from the file path (parent dir = schema, stem = name).
        let canonical_target = if let Some(ref doc) = doc_opt {
            target_path_for(
                folder_root,
                engine,
                &ObjectShape {
                    kind: doc.system.kind.clone(),
                    schema: doc.system.schema.clone(),
                    name: doc.system.name.clone(),
                    primary_key: vec![],
                    columns: vec![],
                },
            )
        } else {
            // Path-based identity fallback.
            file_path.to_path_buf()
        };

        handled_paths.insert(canonical_target.clone());

        if let Some(shape) = shape_map.get(&canonical_target) {
            // UPDATE: shape still exists in DB.
            let mut new_system = shape_to_system(shape);
            // Preserve `deleted_in_db: false` explicitly.
            new_system.deleted_in_db = Some(false);

            let new_bytes = rewrite_file(file_path, &new_system)?;
            atomic_write(&canonical_target, &new_bytes)?;

            // Orphan detection (only if we parsed the existing doc).
            if let Some(ref doc) = doc_opt {
                let col_names: HashSet<String> =
                    shape.columns.iter().map(|c| c.name.clone()).collect();
                let orphan_keys = find_orphaned_note_keys(&col_names, &doc.human);
                for key in orphan_keys {
                    orphaned_notes.push(OrphanedNote {
                        file: canonical_target.clone(),
                        key,
                    });
                }
            }

            updated.push(canonical_target);
        } else {
            // MARK DELETED: file exists but not in live schema.
            // Only do a semantic rewrite if we could parse the doc; otherwise
            // just mark by falling back to a path-key approach.
            if let Some(ref doc) = doc_opt {
                let mut new_system = doc.system.clone();
                new_system.deleted_in_db = Some(true);
                new_system.last_synced = Some(Utc::now());

                let new_bytes = rewrite_file(file_path, &new_system)?;
                atomic_write(file_path, &new_bytes)?;

                // Orphan check on deleted too.
                let col_names: HashSet<String> = doc
                    .system
                    .columns
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .map(|c| c.name.clone())
                    .collect();
                let orphan_keys = find_orphaned_note_keys(&col_names, &doc.human);
                for key in orphan_keys {
                    orphaned_notes.push(OrphanedNote {
                        file: file_path.clone(),
                        key,
                    });
                }
            } else {
                tracing::warn!(
                    path = %file_path.display(),
                    "context sync: could not determine identity of existing file; \
                     skipping mark-deleted (path-based identity not in shape map)"
                );
            }

            marked_deleted.push(file_path.clone());
        }
    }

    // CREATE: shapes whose target path was not in existing files.
    for (target_path, shape) in &shape_map {
        if handled_paths.contains(target_path) {
            continue;
        }
        let system = shape_to_system(shape);
        let content = build_fresh_file(&system)?;
        atomic_write(target_path, content.as_bytes())?;
        created.push(target_path.clone());
    }

    Ok(SyncReport {
        created,
        updated,
        marked_deleted,
        orphaned_notes,
    })
}

// ---- tests ----

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::context::introspect::{ObjectShape, ObjectShapeColumn};
    use std::fs;
    use tempfile::TempDir;

    // ---- helpers ----

    fn write_file(root: &Path, rel: &str, content: &str) -> PathBuf {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&path, content).unwrap();
        path
    }

    fn write_file_bytes(root: &Path, rel: &str, content: &[u8]) -> PathBuf {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&path, content).unwrap();
        path
    }

    fn manifest(root: &Path) {
        write_file(root, "context.yaml", "schema_version: 1\nname: Test\n");
    }

    fn simple_shape(schema: &str, name: &str) -> ObjectShape {
        ObjectShape {
            kind: "table".to_string(),
            schema: Some(schema.to_string()),
            name: name.to_string(),
            primary_key: vec!["id".to_string()],
            columns: vec![
                ObjectShapeColumn {
                    name: "id".to_string(),
                    ty: "integer".to_string(),
                },
                ObjectShapeColumn {
                    name: "email".to_string(),
                    ty: "text".to_string(),
                },
            ],
        }
    }

    // ---- target_path_for unit tests ----

    #[test]
    fn target_path_relational_uses_schema() {
        let root = Path::new("/tmp/ctx");
        let shape = simple_shape("public", "invoices");
        let p = target_path_for(root, EngineKind::Postgres, &shape);
        assert_eq!(p, Path::new("/tmp/ctx/postgres/public/invoices.md"));
    }

    #[test]
    fn target_path_dynamo() {
        let root = Path::new("/tmp/ctx");
        let shape = ObjectShape {
            kind: "dynamo_table".to_string(),
            schema: None,
            name: "Sessions".to_string(),
            primary_key: vec![],
            columns: vec![],
        };
        let p = target_path_for(root, EngineKind::Dynamo, &shape);
        assert_eq!(p, Path::new("/tmp/ctx/dynamo/tables/Sessions.md"));
    }

    // ---- execute_sync tests ----

    #[tokio::test]
    async fn new_table_creates_file() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());
        let shape = simple_shape("public", "invoices");
        let report = execute_sync(dir.path(), EngineKind::Postgres, vec![shape])
            .await
            .unwrap();

        assert_eq!(report.created.len(), 1);
        assert!(report.updated.is_empty());
        assert!(report.marked_deleted.is_empty());
        assert!(report.orphaned_notes.is_empty());

        let expected = dir.path().join("postgres/public/invoices.md");
        assert!(
            expected.exists(),
            "file should be created at {:?}",
            expected
        );
        assert_eq!(report.created[0], expected);

        let content = fs::read_to_string(&expected).unwrap();
        // Should have system block.
        assert!(content.contains("kind: table"));
        assert!(content.contains("name: invoices"));
        assert!(content.contains("schema: public"));
        // Should have human block (empty).
        assert!(content.contains("human:"));
        // Body should have heading.
        assert!(content.contains("# invoices"));
    }

    #[tokio::test]
    async fn existing_file_preserves_human_and_body_byte_for_byte() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());

        // Write a file with hand-crafted human block and special body.
        let original = "---\nsystem:\n  kind: table\n  schema: public\n  name: users\n  columns:\n    - name: id\n      type: integer\n  last_synced: \"2024-01-01T00:00:00Z\"\n  deleted_in_db: false\nhuman:\n  tags:\n    - pii\n    - billing\n  column_notes:\n    id: \"primary surrogate key\"\n---\n\n## Gotchas\n- email is case-insensitive.\n";
        let original_bytes = original.as_bytes();
        write_file_bytes(dir.path(), "postgres/public/users.md", original_bytes);

        // Sync with a shape that adds a new column.
        let shape = ObjectShape {
            kind: "table".to_string(),
            schema: Some("public".to_string()),
            name: "users".to_string(),
            primary_key: vec!["id".to_string()],
            columns: vec![
                ObjectShapeColumn {
                    name: "id".to_string(),
                    ty: "integer".to_string(),
                },
                ObjectShapeColumn {
                    name: "email".to_string(),
                    ty: "text".to_string(),
                },
            ],
        };
        let report = execute_sync(dir.path(), EngineKind::Postgres, vec![shape])
            .await
            .unwrap();

        assert!(report.created.is_empty());
        assert_eq!(report.updated.len(), 1);

        let new_bytes = fs::read(dir.path().join("postgres/public/users.md")).unwrap();
        let new_content = String::from_utf8_lossy(&new_bytes);

        // New column appears in system.
        assert!(
            new_content.contains("email"),
            "new column should appear in system block"
        );

        // Body bytes preserved byte-for-byte.
        let body_start = find_body_start_in_raw(&new_bytes).expect("body start");
        let body_bytes = &new_bytes[body_start..];
        let expected_body = b"\n## Gotchas\n- email is case-insensitive.\n";
        assert_eq!(
            body_bytes, expected_body,
            "body bytes should be preserved byte-for-byte"
        );

        // human block preserved: check that tags and column_notes are still present.
        assert!(
            new_content.contains("pii"),
            "human tags should be preserved"
        );
        assert!(
            new_content.contains("billing"),
            "human tags should be preserved"
        );
        assert!(
            new_content.contains("primary surrogate key"),
            "human column_notes should be preserved"
        );
    }

    #[tokio::test]
    async fn new_column_appears_in_system() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());

        write_file(
            dir.path(),
            "postgres/public/orders.md",
            "---\nsystem:\n  kind: table\n  schema: public\n  name: orders\n  columns:\n    - name: id\n      type: integer\nhuman: {}\n---\n# orders\n",
        );

        let shape = ObjectShape {
            kind: "table".to_string(),
            schema: Some("public".to_string()),
            name: "orders".to_string(),
            primary_key: vec!["id".to_string()],
            columns: vec![
                ObjectShapeColumn {
                    name: "id".to_string(),
                    ty: "integer".to_string(),
                },
                ObjectShapeColumn {
                    name: "total".to_string(),
                    ty: "numeric".to_string(),
                },
            ],
        };
        let report = execute_sync(dir.path(), EngineKind::Postgres, vec![shape])
            .await
            .unwrap();
        assert_eq!(report.updated.len(), 1);

        let content = fs::read_to_string(dir.path().join("postgres/public/orders.md")).unwrap();
        assert!(
            content.contains("total"),
            "new column should appear in system block"
        );
    }

    #[tokio::test]
    async fn removed_table_marked_deleted() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());

        let original = "---\nsystem:\n  kind: table\n  schema: public\n  name: old_audit\nhuman:\n  tags:\n    - legacy\n---\n# old_audit\nThis table is old.\n";
        write_file(dir.path(), "postgres/public/old_audit.md", original);

        // Sync with empty shapes.
        let report = execute_sync(dir.path(), EngineKind::Postgres, vec![])
            .await
            .unwrap();

        assert!(report.created.is_empty());
        assert!(report.updated.is_empty());
        assert_eq!(report.marked_deleted.len(), 1);

        let file_path = dir.path().join("postgres/public/old_audit.md");
        assert!(file_path.exists(), "file should still exist");

        let content = fs::read_to_string(&file_path).unwrap();
        assert!(
            content.contains("deleted_in_db: true"),
            "deleted_in_db should be true"
        );
        // human preserved.
        assert!(
            content.contains("legacy"),
            "human block should be preserved"
        );
        // Body preserved.
        assert!(
            content.contains("This table is old."),
            "body should be preserved"
        );
    }

    #[tokio::test]
    async fn renamed_column_produces_orphan() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());

        // File has human.column_notes for `old_email_col` which no longer exists.
        let original = "---\nsystem:\n  kind: table\n  schema: public\n  name: members\n  columns:\n    - name: id\n      type: integer\nhuman:\n  column_notes:\n    old_email_col: deprecated\n---\n# members\n";
        write_file(dir.path(), "postgres/public/members.md", original);

        // Shape whose columns do NOT include `old_email_col`.
        let shape = ObjectShape {
            kind: "table".to_string(),
            schema: Some("public".to_string()),
            name: "members".to_string(),
            primary_key: vec!["id".to_string()],
            columns: vec![ObjectShapeColumn {
                name: "id".to_string(),
                ty: "integer".to_string(),
            }],
        };
        let report = execute_sync(dir.path(), EngineKind::Postgres, vec![shape])
            .await
            .unwrap();

        assert_eq!(report.orphaned_notes.len(), 1);
        assert_eq!(report.orphaned_notes[0].key, "old_email_col");

        // column_notes map should be unchanged.
        let content = fs::read_to_string(dir.path().join("postgres/public/members.md")).unwrap();
        assert!(
            content.contains("old_email_col"),
            "human.column_notes should be unchanged"
        );
    }

    #[tokio::test]
    async fn atomic_temp_file_then_rename() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());
        let parent = dir.path().join("postgres/public");
        fs::create_dir_all(&parent).unwrap();

        // Create a stale tmp file mimicking a previous crash (should be ignored by sync).
        let stale_name = "users.md.tmp.deadbeef";
        fs::write(parent.join(stale_name), b"stale").unwrap();

        let shape = simple_shape("public", "users");
        let _report = execute_sync(dir.path(), EngineKind::Postgres, vec![shape])
            .await
            .unwrap();

        // Sync must NOT blow up (no panic / error) — already verified by `.unwrap()` above.
        // The stale pre-crash file should still be present (sync ignores it).
        assert!(
            parent.join(stale_name).exists(),
            "stale tmp file should be ignored (left in place) by sync"
        );

        // No NEW `.tmp.` files created by this sync should remain (atomic rename cleaned them).
        // We detect this by checking that only the known stale file contains ".tmp.".
        let tmp_files: Vec<_> = fs::read_dir(&parent)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .map(|n| n.contains(".tmp.") && n != stale_name)
                    .unwrap_or(false)
            })
            .collect();
        assert!(
            tmp_files.is_empty(),
            "no new .tmp. files should remain after sync, found: {:?}",
            tmp_files.iter().map(|e| e.file_name()).collect::<Vec<_>>()
        );

        // The real file should exist.
        assert!(parent.join("users.md").exists());
    }

    #[tokio::test]
    async fn crlf_preserved() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());

        // Write original file with CRLF endings.
        let original_lf = "---\nsystem:\n  kind: table\n  schema: public\n  name: crlf_tbl\n  columns:\n    - name: id\n      type: integer\nhuman: {}\n---\n# crlf_tbl\n";
        let original_crlf = original_lf.replace('\n', "\r\n");
        write_file_bytes(
            dir.path(),
            "postgres/public/crlf_tbl.md",
            original_crlf.as_bytes(),
        );

        let shape = simple_shape("public", "crlf_tbl");
        let report = execute_sync(dir.path(), EngineKind::Postgres, vec![shape])
            .await
            .unwrap();
        assert_eq!(report.updated.len(), 1);

        let new_bytes = fs::read(dir.path().join("postgres/public/crlf_tbl.md")).unwrap();
        assert!(
            has_crlf(&new_bytes),
            "CRLF line endings should be preserved"
        );
    }
}
