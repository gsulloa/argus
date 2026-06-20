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
use crate::modules::context::normalize::normalize;
use crate::modules::context::types::{
    ObjectColumn, ObjectHuman, ObjectSystem, OrphanedNote, SkippedTable, SyncReport,
};
use crate::modules::dynamo::params::TableMatch;

// ---- Target-path computation ----

/// Fold a CloudWatch log group name so it can be used as a flat filename stem.
///
/// `/` is replaced with `__` so that `/aws/lambda/my-fn` becomes
/// `__aws__lambda__my-fn.md` (flat, no nested dirs).
pub fn fold_log_group_name(name: &str) -> String {
    name.replace('/', "__")
}

/// Reverse the fold applied by [`fold_log_group_name`]:
/// `__` is replaced with `/` to recover the original log group name.
pub fn unfold_log_group_name(folded: &str) -> String {
    folded.replace("__", "/")
}

/// Compute the canonical target path for an `ObjectShape` within a folder root.
///
/// | Engine       | Path |
/// |---|---|
/// | Postgres/MySQL/MSSQL | `<root>/<engine>/<schema>/<name>.md` |
/// | Dynamo       | `<root>/dynamo/tables/<name>/table.md` |
/// | CloudWatch   | `<root>/cloudwatch/groups/<folded-name>.md` |
///
/// CloudWatch log group names may contain `/` (e.g. `/aws/lambda/fn`); they are
/// folded to `__` so the path stays flat: `__aws__lambda__fn.md`.
pub fn target_path_for(root: &Path, engine: EngineKind, shape: &ObjectShape) -> PathBuf {
    match engine {
        EngineKind::Postgres | EngineKind::Mysql | EngineKind::Mssql | EngineKind::Athena => {
            let schema = shape.schema.as_deref().unwrap_or("default");
            root.join(engine.subtree())
                .join(schema)
                .join(format!("{}.md", shape.name))
        }
        EngineKind::Dynamo => root
            .join("dynamo")
            .join("tables")
            .join(&shape.name)
            .join("table.md"),
        EngineKind::Cloudwatch => {
            let folded = fold_log_group_name(&shape.name);
            root.join("cloudwatch")
                .join("groups")
                .join(format!("{folded}.md"))
        }
    }
}

// ---- YAML frontmatter splice ----

/// The byte range `[start, end)` of a value slice within a string.
pub(crate) struct ByteRange {
    pub(crate) start: usize,
    pub(crate) end: usize,
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
pub(crate) fn find_top_level_value_range(frontmatter: &str, target_key: &str) -> Option<ByteRange> {
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

/// Build a complete fresh doc string from a pre-serialized `sys_yaml` and a body.
///
/// Format:
/// ```text
/// ---
/// system:
///   <indented sys_yaml lines>
/// human: {}
/// ---
/// <body>
/// ```
pub(crate) fn build_fresh_doc(sys_yaml: &str, body: &str) -> String {
    let indented_sys = sys_yaml
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
    format!("---\nsystem:\n{indented_sys}human: {{}}\n---\n{body}")
}

fn build_fresh_file(system: &ObjectSystem) -> AppResult<String> {
    let sys_yaml = serde_yaml::to_string(system)
        .map_err(|e| AppError::Internal(format!("yaml serialise system: {e}")))?;
    let name = &system.name;
    Ok(build_fresh_doc(&sys_yaml, &format!("# {name}\n")))
}

/// Splice a pre-serialized `system:` YAML block into an existing file at `path`,
/// preserving the `human:` block and body bytes. `body_override`, when `Some`,
/// replaces the Markdown body (encoded to match the file's existing line ending);
/// when `None`, the existing body is preserved byte-for-byte.
///
/// If `body_override` equals the existing decoded body (byte-for-byte String
/// comparison), the original body bytes are preserved exactly (round-trip safe).
///
/// Returns the full new file bytes.
pub(crate) fn rewrite_file_with_system_yaml(
    path: &Path,
    sys_yaml: &str,
    body_override: Option<&str>,
) -> AppResult<Vec<u8>> {
    // Read raw bytes to preserve body exactly.
    let raw_bytes = std::fs::read(path)
        .map_err(|e| AppError::Storage(format!("read {}: {e}", path.display())))?;
    let raw_str = String::from_utf8_lossy(&raw_bytes);

    // Detect CRLF.
    let is_crlf = has_crlf(&raw_bytes);

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
    let (fm_end, _body_start_norm) = after_open
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
    let body_start_in_raw = find_body_start_in_raw(&raw_bytes);

    let body_bytes = match body_override {
        Some(override_str) => {
            // If the override equals the existing decoded body, preserve original bytes.
            let existing_body_string = match body_start_in_raw {
                Some(start) => String::from_utf8_lossy(&raw_bytes[start..]).into_owned(),
                None => String::new(),
            };
            if override_str == existing_body_string.as_str() {
                // Round-trip: preserve original bytes.
                match body_start_in_raw {
                    Some(start) => raw_bytes[start..].to_vec(),
                    None => b"\n".to_vec(),
                }
            } else {
                // Use the override, encoded to match the file's line endings.
                if is_crlf {
                    convert_to_crlf(override_str).into_bytes()
                } else {
                    override_str.as_bytes().to_vec()
                }
            }
        }
        None => {
            // Preserve original body bytes.
            match body_start_in_raw {
                Some(start) => raw_bytes[start..].to_vec(),
                None => b"\n".to_vec(),
            }
        }
    };

    // Splice system block into frontmatter.
    let new_frontmatter = match splice_system_block(frontmatter, sys_yaml) {
        Some(f) => f,
        None => {
            // Fall back: full re-serialisation.
            tracing::warn!(
                path = %path.display(),
                "context sync: falling back to full re-serialisation (could not splice system block)"
            );
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

// ---- Atomic write ----

pub(crate) fn atomic_write(path: &Path, content: &[u8]) -> AppResult<()> {
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

pub(crate) fn has_crlf(bytes: &[u8]) -> bool {
    bytes.windows(2).any(|w| w == b"\r\n")
}

pub(crate) fn convert_to_crlf(s: &str) -> String {
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
        EngineKind::Postgres | EngineKind::Mysql | EngineKind::Mssql | EngineKind::Athena => {
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
                if let Ok(entries) = std::fs::read_dir(&tables_dir) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("md") {
                            // Legacy flat table doc: tables/<name>.md
                            // Only include if the folder-based table.md does NOT exist.
                            // Derive the logical name from the file stem.
                            let stem = p
                                .file_stem()
                                .and_then(|s| s.to_str())
                                .unwrap_or("")
                                .to_string();
                            let folder_doc = tables_dir.join(&stem).join("table.md");
                            if !folder_doc.exists() {
                                paths.push(p);
                            }
                            // If folder doc exists, folder wins; the flat file is skipped
                            // from this walk (it will be left untouched per D3).
                        } else if p.is_dir() {
                            // Folder-based table doc: tables/<name>/table.md
                            let folder_doc = p.join("table.md");
                            if folder_doc.exists() {
                                paths.push(folder_doc);
                            }
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
    let sys_yaml =
        serde_yaml::to_string(new_system).map_err(|e| AppError::Internal(format!("yaml: {e}")))?;
    rewrite_file_with_system_yaml(path, &sys_yaml, None)
}

/// Find the byte offset in `raw_bytes` where the body starts (after the
/// closing `---\n` or `---\r\n`).
pub(crate) fn find_body_start_in_raw(raw_bytes: &[u8]) -> Option<usize> {
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
    rule: Option<&TableMatch>,
) -> AppResult<SyncReport> {
    // For Dynamo, fold each live (physical) table name to its logical name via
    // the connection's normalization rule, so files land under the logical name
    // and re-deploys with a new suffix update the same file. When two live
    // tables normalize to the same logical name, the first wins and the rest are
    // skipped (surfaced in the report). No rule → identity → unchanged behavior.
    let mut skipped: Vec<SkippedTable> = Vec::new();
    let shapes: Vec<ObjectShape> = if engine == EngineKind::Dynamo {
        let mut seen: HashMap<String, String> = HashMap::new(); // logical → first live name
        let mut folded: Vec<ObjectShape> = Vec::new();
        for mut shape in shapes {
            let live_name = shape.name.clone();
            let logical = normalize(&live_name, rule);
            if let Some(kept) = seen.get(&logical) {
                skipped.push(SkippedTable {
                    live_name,
                    logical,
                    kept: kept.clone(),
                });
                continue;
            }
            seen.insert(logical.clone(), live_name);
            shape.name = logical;
            folded.push(shape);
        }
        folded
    } else {
        shapes
    };

    // Build the set of live logical names (the shape.name values after folding).
    // Used by the D6 consolidation pass to guard against over-stripping by
    // non-idempotent rules (see comment on D6 below).
    let live_logicals: HashSet<String> = shapes.iter().map(|s| s.name.clone()).collect();

    // Build lookup: target_path → shape.
    let mut shape_map: HashMap<PathBuf, ObjectShape> = HashMap::new();
    for shape in shapes {
        let path = target_path_for(folder_root, engine, &shape);
        shape_map.insert(path, shape);
    }

    // D6 — consolidation pass (Dynamo only, no-op when rule is None/identity).
    //
    // Before walking existing files, scan tables/ for any directories or legacy
    // flat files whose entry name is PHYSICAL (i.e. normalize(X, rule) == L ≠ X).
    // Move their contents into the logical folder so that walk_existing_objects
    // sees everything under the logical name and the UPDATE path reuses it.
    //
    // This handles the case where a user added a normalization rule AFTER docs
    // were already written under the physical (suffixed) name. Without this pass
    // those physical-named folders would be stranded and their models invisible.
    //
    // Guard: only consolidate entry X into L when L is one of the live logical
    // names of the current sync (i.e. `live_logicals.contains(&L)`). Without this
    // guard, non-idempotent rules can over-strip user-renamed folders into a bogus
    // target that has no corresponding live table (e.g. a rule
    // `suffix_pattern: "-[0-9A-Za-z]+$"` would fold the hand-curated folder
    // `CacheStack-CacheTable` → `CacheStack`, which is not a live logical name).
    if engine == EngineKind::Dynamo {
        let tables_dir = folder_root.join("dynamo").join("tables");
        if tables_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&tables_dir) {
                let mut candidates: Vec<(String, String, PathBuf)> = Vec::new();
                for entry in entries.flatten() {
                    let entry_name = match entry.file_name().into_string() {
                        Ok(n) => n,
                        Err(_) => continue,
                    };
                    let path = entry.path();
                    // Derive the name to normalize per entry type:
                    //   - directory         → the directory name as-is
                    //   - file with .md ext → the file stem (strip ".md" first so
                    //                         suffix-anchored rules can match)
                    //   - anything else     → skip
                    let name_to_normalize: String = if path.is_dir() {
                        entry_name.clone()
                    } else if path.is_file()
                        && path.extension().and_then(|e| e.to_str()) == Some("md")
                    {
                        match path.file_stem().and_then(|s| s.to_str()) {
                            Some(stem) => stem.to_string(),
                            None => continue,
                        }
                    } else {
                        continue;
                    };
                    let logical = normalize(&name_to_normalize, rule);
                    // Only act when the rule actually changes the name AND the
                    // resulting logical name is a live table in this sync.
                    // The live_logicals guard prevents non-idempotent rules from
                    // moving user-curated folders into bogus destinations.
                    if logical != name_to_normalize && live_logicals.contains(&logical) {
                        candidates.push((name_to_normalize, entry_name, path));
                    }
                }
                for (name_to_normalize, _entry_name, physical_path) in candidates {
                    // Re-derive logical from the appropriate name (dir name for dirs,
                    // stem for flat files — stripped before normalization so that
                    // suffix-anchored rules can match).
                    let logical = normalize(&name_to_normalize, rule);
                    let logical_dir = tables_dir.join(&logical);

                    if physical_path.is_dir() {
                        // Directory case: tables/<physical>/
                        let physical_table_md = physical_path.join("table.md");
                        let logical_table_md = logical_dir.join("table.md");
                        if physical_table_md.exists() && !logical_table_md.exists() {
                            // Move table.md to logical folder.
                            if let Some(parent) = logical_table_md.parent() {
                                std::fs::create_dir_all(parent).map_err(|e| {
                                    AppError::Storage(format!(
                                        "D6: create dir {}: {e}",
                                        parent.display()
                                    ))
                                })?;
                            }
                            std::fs::rename(&physical_table_md, &logical_table_md).map_err(
                                |e| {
                                    AppError::Storage(format!(
                                        "D6: move table.md {} -> {}: {e}",
                                        physical_table_md.display(),
                                        logical_table_md.display()
                                    ))
                                },
                            )?;
                        }
                        // If both exist, leave physical in place (logical wins; benign leftover).

                        // Move models/*.md to logical/models/ (skip collisions).
                        let physical_models = physical_path.join("models");
                        if physical_models.is_dir() {
                            let logical_models = logical_dir.join("models");
                            if let Ok(model_entries) = std::fs::read_dir(&physical_models) {
                                for mentry in model_entries.flatten() {
                                    let mpath = mentry.path();
                                    if mpath.is_file()
                                        && mpath.extension().and_then(|e| e.to_str()) == Some("md")
                                    {
                                        let fname = mentry.file_name();
                                        let dest = logical_models.join(&fname);
                                        if !dest.exists() {
                                            if let Some(parent) = dest.parent() {
                                                std::fs::create_dir_all(parent).map_err(|e| {
                                                    AppError::Storage(format!(
                                                        "D6: create models dir {}: {e}",
                                                        parent.display()
                                                    ))
                                                })?;
                                            }
                                            std::fs::rename(&mpath, &dest).map_err(|e| {
                                                AppError::Storage(format!(
                                                    "D6: move model {} -> {}: {e}",
                                                    mpath.display(),
                                                    dest.display()
                                                ))
                                            })?;
                                        }
                                        // Skip collision: leave physical model in place.
                                    }
                                }
                            }
                            // Remove models dir if now empty.
                            let _ = std::fs::remove_dir(&physical_models);
                        }
                        // Remove physical table dir if now empty.
                        let _ = std::fs::remove_dir(&physical_path);
                    } else if physical_path.is_file()
                        && physical_path.extension().and_then(|e| e.to_str()) == Some("md")
                    {
                        // Legacy flat file case: tables/<physical>.md
                        let logical_table_md = logical_dir.join("table.md");
                        if !logical_table_md.exists() {
                            if let Some(parent) = logical_table_md.parent() {
                                std::fs::create_dir_all(parent).map_err(|e| {
                                    AppError::Storage(format!(
                                        "D6: create dir for legacy flat {}: {e}",
                                        parent.display()
                                    ))
                                })?;
                            }
                            std::fs::rename(&physical_path, &logical_table_md).map_err(|e| {
                                AppError::Storage(format!(
                                    "D6: move legacy flat {} -> {}: {e}",
                                    physical_path.display(),
                                    logical_table_md.display()
                                ))
                            })?;
                        }
                        // If logical already exists, leave physical flat file (benign leftover).
                    }
                }
            }
        }
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
        //
        // D6 — rule-aware canonical target for Dynamo: fold doc.system.name
        // through normalize so that a doc written pre-rule (carrying the physical
        // name in frontmatter) maps to the same logical canonical path as the
        // live shape. Without this fold, the old physical name does not match
        // any key in shape_map and the file is wrongly marked deleted.
        let canonical_target = if let Some(ref doc) = doc_opt {
            let name_for_path = if engine == EngineKind::Dynamo {
                normalize(&doc.system.name, rule)
            } else {
                doc.system.name.clone()
            };
            target_path_for(
                folder_root,
                engine,
                &ObjectShape {
                    kind: doc.system.kind.clone(),
                    schema: doc.system.schema.clone(),
                    name: name_for_path,
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

            // D3/D6 migration: if the existing file was at a legacy or physical
            // path (different from the canonical target), remove the old file
            // now that the content has been written to the new location.
            // For Dynamo, also remove the physical parent dir if it is now empty
            // (the consolidation pass may have already moved models/ out of it).
            if file_path != &canonical_target {
                let _ = std::fs::remove_file(file_path);
                if engine == EngineKind::Dynamo {
                    if let Some(physical_parent) = file_path.parent() {
                        // Attempt removal; ignore errors (non-empty dir or race).
                        let _ = std::fs::remove_dir(physical_parent);
                    }
                }
            }

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

        // D3 — lazy migration for Dynamo table docs.
        // If a legacy flat tables/<logical>.md exists but the new
        // tables/<logical>/table.md does NOT yet exist, move the legacy file
        // to the new path so the normal splice can run against it (preserving
        // the human: block and body bytes).
        if engine == EngineKind::Dynamo {
            // target_path is <root>/dynamo/tables/<name>/table.md
            // The legacy flat path would be <root>/dynamo/tables/<name>.md
            if let Some(table_dir) = target_path.parent() {
                if let Some(logical_name) = table_dir.file_name().and_then(|n| n.to_str()) {
                    if let Some(tables_dir) = table_dir.parent() {
                        let legacy_flat = tables_dir.join(format!("{}.md", logical_name));
                        if legacy_flat.exists() && !target_path.exists() {
                            // Create parent directory and move file.
                            if let Some(parent) = target_path.parent() {
                                std::fs::create_dir_all(parent).map_err(|e| {
                                    AppError::Storage(format!("create dir for migration: {e}"))
                                })?;
                            }
                            std::fs::rename(&legacy_flat, target_path).map_err(|e| {
                                AppError::Storage(format!(
                                    "migrate legacy dynamo doc {}: {e}",
                                    legacy_flat.display()
                                ))
                            })?;
                        }
                    }
                }
            }
        }

        if target_path.exists() {
            // File was migrated into place (D3); rewrite to update the system block.
            let system = shape_to_system(shape);
            let sys_yaml = serde_yaml::to_string(&system)
                .map_err(|e| AppError::Internal(format!("yaml serialise system: {e}")))?;
            let new_bytes = rewrite_file_with_system_yaml(target_path, &sys_yaml, None)?;
            atomic_write(target_path, &new_bytes)?;
            updated.push(target_path.clone());
        } else {
            let system = shape_to_system(shape);
            let content = build_fresh_file(&system)?;
            atomic_write(target_path, content.as_bytes())?;
            created.push(target_path.clone());
        }
    }

    Ok(SyncReport {
        created,
        updated,
        marked_deleted,
        orphaned_notes,
        skipped,
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
        assert_eq!(p, Path::new("/tmp/ctx/dynamo/tables/Sessions/table.md"));
    }

    // ---- execute_sync tests ----

    #[tokio::test]
    async fn new_table_creates_file() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());
        let shape = simple_shape("public", "invoices");
        let report = execute_sync(dir.path(), EngineKind::Postgres, vec![shape], None)
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
        let report = execute_sync(dir.path(), EngineKind::Postgres, vec![shape], None)
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
        let report = execute_sync(dir.path(), EngineKind::Postgres, vec![shape], None)
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
        let report = execute_sync(dir.path(), EngineKind::Postgres, vec![], None)
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
        let report = execute_sync(dir.path(), EngineKind::Postgres, vec![shape], None)
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
        let _report = execute_sync(dir.path(), EngineKind::Postgres, vec![shape], None)
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
        let report = execute_sync(dir.path(), EngineKind::Postgres, vec![shape], None)
            .await
            .unwrap();
        assert_eq!(report.updated.len(), 1);

        let new_bytes = fs::read(dir.path().join("postgres/public/crlf_tbl.md")).unwrap();
        assert!(
            has_crlf(&new_bytes),
            "CRLF line endings should be preserved"
        );
    }

    // ---- model doc helpers (task 1.5) ----

    fn model_sys_yaml() -> String {
        #[derive(serde::Serialize)]
        struct ModelSystemDoc<'a> {
            kind: &'static str,
            name: &'a str,
            access_patterns: &'a [serde_yaml::Value],
        }
        // Build by hand to avoid pulling in the commands module.
        "kind: dynamo_model\nname: Order\naccess_patterns:\n- index: table\n  pk: \"USER#${userId}\"\n  sk: \"ORDER#${orderId}\"\n".to_string()
    }

    /// A fresh model doc is parseable and round-trips access_patterns.
    /// physical_table must NOT appear in the file bytes.
    #[test]
    fn model_fresh_doc_is_parseable() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());

        let sys_yaml = model_sys_yaml();
        let body = "# Order\n";
        let content = build_fresh_doc(&sys_yaml, body);

        // Must not contain physical_table.
        assert!(
            !content.contains("physical_table"),
            "fresh doc must not contain physical_table"
        );

        // Write to the expected path so load_folder can derive physical_table.
        let path = write_file(
            dir.path(),
            "dynamo/tables/AppTable/models/Order.md",
            &content,
        );

        // Parse directly.
        let doc = crate::modules::context::parser::parse_object_doc(&path).unwrap();
        assert_eq!(doc.system.kind, "dynamo_model");
        assert_eq!(doc.system.name, "Order");
        assert!(
            doc.system.physical_table.is_none(),
            "physical_table is not stored in frontmatter"
        );

        // Verify access_patterns round-trip via load_folder (which derives physical_table).
        let ctx =
            crate::modules::context::parser::load_folder(dir.path(), EngineKind::Dynamo).unwrap();
        let order = ctx
            .objects
            .iter()
            .find(|d| d.system.name == "Order")
            .expect("Order not found");
        assert_eq!(order.system.kind, "dynamo_model");
        assert_eq!(order.system.physical_table.as_deref(), Some("AppTable"));
        let aps = order.system.access_patterns.as_ref().expect("access_patterns missing");
        assert_eq!(aps.len(), 1);
        assert_eq!(aps[0].index, "table");
        assert_eq!(aps[0].pk, "USER#${userId}");
        assert_eq!(aps[0].sk.as_deref(), Some("ORDER#${orderId}"));
    }

    /// Editing a model preserves the human block and body bytes.
    #[test]
    fn model_edit_preserves_human_and_body() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());

        let original = "---\nsystem:\n  kind: dynamo_model\n  name: Order\n  access_patterns:\n    - index: table\n      pk: \"USER#${userId}\"\nhuman:\n  tags:\n    - important\n---\n# Order\n\nSome body text.\n";
        let path = write_file(
            dir.path(),
            "dynamo/tables/AppTable/models/Order.md",
            original,
        );

        // New access pattern.
        let new_sys_yaml =
            "kind: dynamo_model\nname: Order\naccess_patterns:\n- index: table\n  pk: \"USER#${userId}\"\n- index: GSI1\n  pk: \"STATUS#${status}\"\n";

        let bytes = rewrite_file_with_system_yaml(&path, new_sys_yaml, None).unwrap();
        atomic_write(&path, &bytes).unwrap();

        let new_content = String::from_utf8(fs::read(&path).unwrap()).unwrap();

        // New access pattern present.
        assert!(
            new_content.contains("GSI1"),
            "new access pattern should be present"
        );
        // Human block preserved.
        assert!(
            new_content.contains("important"),
            "human tags should be preserved"
        );
        // Body preserved byte-for-byte.
        let new_bytes = fs::read(&path).unwrap();
        let body_start = find_body_start_in_raw(&new_bytes).expect("body start");
        let body = &new_bytes[body_start..];
        assert_eq!(body, b"# Order\n\nSome body text.\n");
    }

    /// When body_override equals the existing body string, original body bytes are preserved.
    #[test]
    fn model_edit_unchanged_body_preserved() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());

        let original = "---\nsystem:\n  kind: dynamo_model\n  name: Order\n  access_patterns:\n    - index: table\n      pk: \"USER#${userId}\"\nhuman: {}\n---\n# Order\n\nOriginal body.\n";
        let path = write_file(
            dir.path(),
            "dynamo/tables/AppTable/models/Order.md",
            original,
        );

        let original_bytes = fs::read(&path).unwrap();
        let body_start_orig = find_body_start_in_raw(&original_bytes).unwrap();
        let original_body_bytes = original_bytes[body_start_orig..].to_vec();

        let new_sys_yaml = "kind: dynamo_model\nname: Order\naccess_patterns:\n- index: table\n  pk: \"USER#${userId}\"\n- index: GSI1\n  pk: \"X#${x}\"\n";
        // Pass the existing body string as the override → should round-trip.
        let existing_body_str = "# Order\n\nOriginal body.\n";
        let bytes =
            rewrite_file_with_system_yaml(&path, new_sys_yaml, Some(existing_body_str)).unwrap();
        atomic_write(&path, &bytes).unwrap();

        let new_bytes = fs::read(&path).unwrap();
        let body_start_new = find_body_start_in_raw(&new_bytes).unwrap();
        let new_body_bytes = new_bytes[body_start_new..].to_vec();

        assert_eq!(
            new_body_bytes, original_body_bytes,
            "body bytes should be identical when override matches existing"
        );
    }

    /// When body_override differs from the existing body, the new body is written.
    #[test]
    fn model_edit_body_changed() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());

        let original = "---\nsystem:\n  kind: dynamo_model\n  name: Order\n  access_patterns:\n    - index: table\n      pk: \"USER#${userId}\"\nhuman: {}\n---\n# Order\n\nOld body.\n";
        let path = write_file(
            dir.path(),
            "dynamo/tables/AppTable/models/Order.md",
            original,
        );

        let new_sys_yaml = "kind: dynamo_model\nname: Order\naccess_patterns:\n- index: table\n  pk: \"USER#${userId}\"\n";
        let bytes =
            rewrite_file_with_system_yaml(&path, new_sys_yaml, Some("# New body\n")).unwrap();
        atomic_write(&path, &bytes).unwrap();

        let new_bytes = fs::read(&path).unwrap();
        let body_start = find_body_start_in_raw(&new_bytes).unwrap();
        let new_body = &new_bytes[body_start..];
        assert_eq!(new_body, b"# New body\n");
    }

    // ---- Dynamo normalization in sync (task 4.3) ----

    fn dynamo_shape(name: &str) -> ObjectShape {
        ObjectShape {
            kind: "dynamo_table".to_string(),
            schema: None,
            name: name.to_string(),
            primary_key: vec!["pk".to_string()],
            columns: vec![ObjectShapeColumn {
                name: "pk".to_string(),
                ty: "S".to_string(),
            }],
        }
    }

    fn cdk_rule() -> TableMatch {
        TableMatch {
            prefix: Some("MyApp-prod-".to_string()),
            suffix_pattern: Some("-[A-Z0-9]+$".to_string()),
            regex: None,
        }
    }

    /// A rule folds the live suffixed name to the logical filename.
    #[tokio::test]
    async fn dynamo_sync_writes_logical_filename_under_rule() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());
        let rule = cdk_rule();

        let report = execute_sync(
            dir.path(),
            EngineKind::Dynamo,
            vec![dynamo_shape("MyApp-prod-EventsTable-3M4N5O6P7Q8R")],
            Some(&rule),
        )
        .await
        .unwrap();

        let expected = dir.path().join("dynamo/tables/EventsTable/table.md");
        assert_eq!(report.created, vec![expected.clone()]);
        assert!(expected.exists());
        // system.name is the logical name, not the suffixed live name.
        let content = fs::read_to_string(&expected).unwrap();
        assert!(content.contains("name: EventsTable"));
        assert!(!content.contains("3M4N5O6P7Q8R"));
    }

    /// Re-deploy with a new random suffix updates the same logical file and
    /// preserves the human block and body.
    #[tokio::test]
    async fn dynamo_resync_new_suffix_updates_same_file() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());
        let rule = cdk_rule();

        // Existing logical file in the new folder layout with a hand-edited human block + body.
        let original = "---\nsystem:\n  kind: dynamo_table\n  name: EventsTable\nhuman:\n  tags:\n    - audited\n---\n# EventsTable\n\nNotes about events.\n";
        write_file(dir.path(), "dynamo/tables/EventsTable/table.md", original);

        let report = execute_sync(
            dir.path(),
            EngineKind::Dynamo,
            vec![dynamo_shape("MyApp-prod-EventsTable-9Z8Y7X6W5V4U")],
            Some(&rule),
        )
        .await
        .unwrap();

        assert!(report.created.is_empty(), "should update, not create");
        assert_eq!(report.updated.len(), 1);
        // No new suffixed file.
        let suffixed = dir
            .path()
            .join("dynamo/tables/MyApp-prod-EventsTable-9Z8Y7X6W5V4U/table.md");
        assert!(!suffixed.exists());

        let content =
            fs::read_to_string(dir.path().join("dynamo/tables/EventsTable/table.md")).unwrap();
        assert!(content.contains("audited"), "human block preserved");
        assert!(content.contains("Notes about events."), "body preserved");
    }

    /// Two live tables that normalize to the same logical name: first wins, the
    /// rest are skipped and surfaced in the report.
    #[tokio::test]
    async fn dynamo_sync_colliding_tables_skipped() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());
        // Over-broad rule: strip prefix + any trailing -XXXX.
        let rule = TableMatch {
            prefix: Some("MyApp-prod-".to_string()),
            suffix_pattern: Some("-[A-Z0-9]+$".to_string()),
            regex: None,
        };

        let report = execute_sync(
            dir.path(),
            EngineKind::Dynamo,
            vec![
                dynamo_shape("MyApp-prod-Events-AAAA"),
                dynamo_shape("MyApp-prod-Events-BBBB"),
            ],
            Some(&rule),
        )
        .await
        .unwrap();

        assert_eq!(report.created.len(), 1);
        assert_eq!(report.created[0], dir.path().join("dynamo/tables/Events/table.md"));
        assert_eq!(report.skipped.len(), 1, "one collision skipped");
        let s = &report.skipped[0];
        assert_eq!(s.logical, "Events");
        assert_eq!(s.live_name, "MyApp-prod-Events-BBBB");
        assert_eq!(s.kept, "MyApp-prod-Events-AAAA");
    }

    /// No rule → live names are used unchanged (retrocompat).
    #[tokio::test]
    async fn dynamo_sync_no_rule_uses_live_name() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());

        let report = execute_sync(
            dir.path(),
            EngineKind::Dynamo,
            vec![dynamo_shape("MyApp-prod-EventsTable-3M4N5O6P7Q8R")],
            None,
        )
        .await
        .unwrap();

        let expected = dir
            .path()
            .join("dynamo/tables/MyApp-prod-EventsTable-3M4N5O6P7Q8R/table.md");
        assert_eq!(report.created, vec![expected.clone()]);
        assert!(expected.exists());
        assert!(report.skipped.is_empty());
    }

    /// D3 migration: a legacy flat tables/<logical>.md with a hand-written human block/body
    /// and an existing models/ directory; after sync the flat file is gone,
    /// tables/<logical>/table.md has the preserved human/body with a fresh system block,
    /// and the models file is untouched.
    #[tokio::test]
    async fn dynamo_migration_moves_flat_doc_to_folder() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());

        // Write the legacy flat table doc with custom human block and body.
        let legacy_content = "---\nsystem:\n  kind: dynamo_table\n  name: Orders\nhuman:\n  tags:\n    - important\n---\n# Orders\n\nLegacy notes.\n";
        write_file(dir.path(), "dynamo/tables/Orders.md", legacy_content);

        // Write a pre-existing model doc inside the table's models directory.
        let model_content = "---\nsystem:\n  kind: dynamo_model\n  name: Order\n  access_patterns:\n    - index: table\n      pk: \"ORDER#${id}\"\n---\n# Order\n";
        write_file(dir.path(), "dynamo/tables/Orders/models/Order.md", model_content);

        let report = execute_sync(
            dir.path(),
            EngineKind::Dynamo,
            vec![dynamo_shape("Orders")],
            None,
        )
        .await
        .unwrap();

        // The legacy flat file must be gone.
        let legacy_path = dir.path().join("dynamo/tables/Orders.md");
        assert!(!legacy_path.exists(), "legacy flat file should be removed after migration");

        // The new folder-based table.md must exist.
        let new_path = dir.path().join("dynamo/tables/Orders/table.md");
        assert!(new_path.exists(), "folder-based table.md must exist after migration");

        // The content must preserve the human block and body.
        let new_content = fs::read_to_string(&new_path).unwrap();
        assert!(new_content.contains("important"), "human block should be preserved");
        assert!(new_content.contains("Legacy notes."), "body should be preserved");
        // System block should be fresh.
        assert!(new_content.contains("kind: dynamo_table"), "system block should be present");
        assert!(new_content.contains("name: Orders"), "system name should match");

        // The models file must be untouched.
        let model_path = dir.path().join("dynamo/tables/Orders/models/Order.md");
        assert!(model_path.exists(), "models file must be untouched");
        let model_read = fs::read_to_string(&model_path).unwrap();
        assert_eq!(model_read, model_content, "model file content should be unchanged");

        // The report should show the table as updated (migrated then rewritten).
        assert!(report.created.is_empty() || report.updated.contains(&new_path),
            "migrated table should appear in updated or created; report={:?}", report);
    }

    /// Re-sync after migration produces no spurious deletes (deleted_in_db not set for live tables).
    #[tokio::test]
    async fn dynamo_resync_after_migration_no_spurious_deletes() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());

        // Set up the new folder layout directly (post-migration state).
        let table_content = "---\nsystem:\n  kind: dynamo_table\n  name: Products\nhuman:\n  tags:\n    - live\n---\n# Products\n\nProduct catalogue.\n";
        write_file(dir.path(), "dynamo/tables/Products/table.md", table_content);

        // First sync.
        let report1 = execute_sync(
            dir.path(),
            EngineKind::Dynamo,
            vec![dynamo_shape("Products")],
            None,
        )
        .await
        .unwrap();

        // Should update (not create), and definitely not mark deleted.
        assert!(report1.marked_deleted.is_empty(),
            "live table should not be marked deleted on first resync: {:?}", report1.marked_deleted);

        // Second sync (idempotent).
        let report2 = execute_sync(
            dir.path(),
            EngineKind::Dynamo,
            vec![dynamo_shape("Products")],
            None,
        )
        .await
        .unwrap();

        assert!(report2.marked_deleted.is_empty(),
            "live table should not be marked deleted on second resync: {:?}", report2.marked_deleted);

        // Content should still have the human block.
        let content = fs::read_to_string(dir.path().join("dynamo/tables/Products/table.md")).unwrap();
        assert!(content.contains("live"), "human block preserved across resyncs");
    }

    // ---- D6 bug-fix tests: consolidation + rule-aware canonical target ----

    /// After configuring a normalization rule, a pre-rule layout with
    /// tables/<physical>/table.md and tables/<physical>/models/Order.md must be
    /// consolidated into tables/<logical>/. The physical folder must be gone, the
    /// table must appear under `updated` (not `marked_deleted`, not `created`),
    /// and human block + body must be preserved with system.name rewritten to
    /// the logical name.
    #[tokio::test]
    async fn dynamo_rule_added_after_sync_consolidates_physical_folder() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());
        let rule = cdk_rule();

        // Physical name that the rule folds to "CredentialsTable".
        let physical = "MyApp-prod-CredentialsTable-LKL2QPAEYYKZ";
        let logical = "CredentialsTable";

        // Pre-rule layout: table.md has physical name in frontmatter, plus human/body.
        let table_content = format!(
            "---\nsystem:\n  kind: dynamo_table\n  name: {physical}\nhuman:\n  tags:\n    - secure\n---\n# {physical}\n\nPre-rule notes.\n"
        );
        write_file(
            dir.path(),
            &format!("dynamo/tables/{physical}/table.md"),
            &table_content,
        );
        // Model doc under the physical folder.
        let model_content = "---\nsystem:\n  kind: dynamo_model\n  name: Order\nhuman: {}\n---\n# Order\n";
        write_file(
            dir.path(),
            &format!("dynamo/tables/{physical}/models/Order.md"),
            model_content,
        );

        // Sync with the rule; live shape uses the physical name (what DynamoDB returns).
        let report = execute_sync(
            dir.path(),
            EngineKind::Dynamo,
            vec![dynamo_shape(physical)],
            Some(&rule),
        )
        .await
        .unwrap();

        // Physical folder must be gone.
        let physical_dir = dir.path().join(format!("dynamo/tables/{physical}"));
        assert!(!physical_dir.exists(), "physical dir should be removed: {}", physical_dir.display());

        // Logical table.md must exist with logical system.name.
        let logical_table = dir.path().join(format!("dynamo/tables/{logical}/table.md"));
        assert!(logical_table.exists(), "logical table.md must exist");
        let content = fs::read_to_string(&logical_table).unwrap();
        assert!(content.contains(&format!("name: {logical}")), "system.name should be logical");
        assert!(!content.contains("deleted_in_db: true"), "must not be marked deleted");
        // Human block and body preserved.
        assert!(content.contains("secure"), "human tags should be preserved");
        assert!(content.contains("Pre-rule notes."), "body should be preserved");

        // Model moved to logical folder.
        let logical_model = dir.path().join(format!("dynamo/tables/{logical}/models/Order.md"));
        assert!(logical_model.exists(), "model must be in logical folder");
        let model_read = fs::read_to_string(&logical_model).unwrap();
        assert_eq!(model_read, model_content, "model content must be unchanged");

        // Report: table appears in updated, not marked_deleted, not created.
        assert!(
            report.updated.contains(&logical_table),
            "table should be in updated; report={:?}", report
        );
        assert!(
            !report.marked_deleted.iter().any(|p| p.to_str().unwrap_or("").contains(logical)),
            "table should not be in marked_deleted; report={:?}", report
        );
        assert!(
            !report.created.iter().any(|p| p.to_str().unwrap_or("").contains(logical)),
            "table should not be in created; report={:?}", report
        );
    }

    /// When only a models folder exists under the physical name (no table.md),
    /// and the logical table.md already exists from a prior rule-aware sync,
    /// the models must be moved to the logical folder and the physical dir cleaned up.
    #[tokio::test]
    async fn dynamo_stranded_models_folder_merges_into_logical() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());
        let rule = cdk_rule();

        let physical = "MyApp-prod-OrdersTable-STRANDED1";
        let logical = "OrdersTable";

        // Physical folder has only a models dir (no table.md).
        let model_content = "---\nsystem:\n  kind: dynamo_model\n  name: Order\nhuman: {}\n---\n# Order\n";
        write_file(
            dir.path(),
            &format!("dynamo/tables/{physical}/models/Order.md"),
            model_content,
        );

        // Logical table.md already exists (from a prior rule-aware sync).
        let logical_table_content = format!(
            "---\nsystem:\n  kind: dynamo_table\n  name: {logical}\nhuman:\n  tags:\n    - live\n---\n# {logical}\n\nLogical notes.\n"
        );
        write_file(
            dir.path(),
            &format!("dynamo/tables/{logical}/table.md"),
            &logical_table_content,
        );

        let report = execute_sync(
            dir.path(),
            EngineKind::Dynamo,
            vec![dynamo_shape(physical)],
            Some(&rule),
        )
        .await
        .unwrap();

        // Physical dir must be gone (models moved + dir emptied).
        let physical_dir = dir.path().join(format!("dynamo/tables/{physical}"));
        assert!(!physical_dir.exists(), "physical dir should be removed");

        // Model must exist in the logical folder.
        let logical_model = dir.path().join(format!("dynamo/tables/{logical}/models/Order.md"));
        assert!(logical_model.exists(), "model must be in logical folder");
        let model_read = fs::read_to_string(&logical_model).unwrap();
        assert_eq!(model_read, model_content, "model content must be unchanged");

        // Logical table.md should be updated (not created or deleted).
        let logical_table = dir.path().join(format!("dynamo/tables/{logical}/table.md"));
        assert!(report.updated.contains(&logical_table),
            "logical table should be in updated; report={:?}", report);
        assert!(report.marked_deleted.is_empty(),
            "nothing should be marked deleted; report={:?}", report);
    }

    /// A legacy flat tables/<physical>.md (human block + body) is consolidated
    /// into tables/<logical>/table.md before the walk runs. After sync:
    /// - tables/<logical>/table.md exists with preserved human/body and logical
    ///   system.name;
    /// - the physical flat file is gone.
    #[tokio::test]
    async fn dynamo_pre_rule_legacy_flat_migrates_to_logical_folder() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());
        let rule = cdk_rule();

        let physical = "MyApp-prod-LegacyFlatTable-ABCDEFGH";
        let logical = "LegacyFlatTable";

        // Legacy flat file with physical name in frontmatter + human/body.
        let flat_content = format!(
            "---\nsystem:\n  kind: dynamo_table\n  name: {physical}\nhuman:\n  tags:\n    - legacy\n---\n# {physical}\n\nFlat file body.\n"
        );
        write_file(
            dir.path(),
            &format!("dynamo/tables/{physical}.md"),
            &flat_content,
        );

        let report = execute_sync(
            dir.path(),
            EngineKind::Dynamo,
            vec![dynamo_shape(physical)],
            Some(&rule),
        )
        .await
        .unwrap();

        // Physical flat file must be gone.
        let physical_flat = dir.path().join(format!("dynamo/tables/{physical}.md"));
        assert!(!physical_flat.exists(), "physical flat file should be gone");

        // Logical table.md must exist.
        let logical_table = dir.path().join(format!("dynamo/tables/{logical}/table.md"));
        assert!(logical_table.exists(), "logical table.md must exist");
        let content = fs::read_to_string(&logical_table).unwrap();
        // system.name rewritten to logical.
        assert!(content.contains(&format!("name: {logical}")), "system.name should be logical");
        // Human block and body preserved.
        assert!(content.contains("legacy"), "human tags should be preserved");
        assert!(content.contains("Flat file body."), "body should be preserved");

        // Must appear in updated (migrated then rewritten) or created, not marked_deleted.
        assert!(
            report.updated.contains(&logical_table) || report.created.contains(&logical_table),
            "logical table should be in updated or created; report={:?}", report
        );
        assert!(report.marked_deleted.is_empty(),
            "nothing should be marked deleted; report={:?}", report);
    }

    /// Regression: D6 consolidation must strip the `.md` extension from legacy flat
    /// file names before normalizing, so that suffix-anchored rules can match.
    ///
    /// Without the fix, `normalize("MyApp-prod-Sessions-AAAA1111.md", rule)` produces
    /// `"Sessions-AAAA1111.md"` (prefix stripped but suffix not matched because the
    /// string ends in `.md`), causing the file to land in a junk directory literally
    /// named `tables/Sessions-AAAA1111.md/table.md`.
    #[tokio::test]
    async fn dynamo_consolidation_flat_file_uses_stem_for_normalization() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());
        let rule = cdk_rule(); // prefix: "MyApp-prod-", suffix_pattern: "-[A-Z0-9]+$"

        let physical = "MyApp-prod-Sessions-AAAA1111";
        let logical = "Sessions";

        // Legacy flat file: tables/MyApp-prod-Sessions-AAAA1111.md
        let flat_content = format!(
            "---\nsystem:\n  kind: dynamo_table\n  name: {physical}\nhuman:\n  tags:\n    - auth\n---\n# {physical}\n\nSession docs.\n"
        );
        write_file(
            dir.path(),
            &format!("dynamo/tables/{physical}.md"),
            &flat_content,
        );

        let report = execute_sync(
            dir.path(),
            EngineKind::Dynamo,
            vec![dynamo_shape(physical)],
            Some(&rule),
        )
        .await
        .unwrap();

        let tables_dir = dir.path().join("dynamo/tables");

        // tables/Sessions/table.md must exist.
        let logical_table = tables_dir.join(format!("{logical}/table.md"));
        assert!(logical_table.exists(), "tables/{logical}/table.md must exist");

        // The flat file must be gone.
        let flat_file = tables_dir.join(format!("{physical}.md"));
        assert!(!flat_file.exists(), "flat file {physical}.md must be removed");

        // No entry whose name ends with ".md" may exist as a DIRECTORY under tables/.
        let entries: Vec<_> = fs::read_dir(&tables_dir)
            .unwrap()
            .flatten()
            .collect();
        for entry in &entries {
            let name = entry.file_name();
            let name_str = name.to_str().unwrap_or("");
            assert!(
                !(name_str.ends_with(".md") && entry.path().is_dir()),
                "junk *.md directory found: {:?}",
                entry.path()
            );
        }

        // tables/ must contain exactly one entry: the Sessions/ directory.
        assert_eq!(
            entries.len(),
            1,
            "tables/ should contain exactly one entry (Sessions/), found: {:?}",
            entries.iter().map(|e| e.file_name()).collect::<Vec<_>>()
        );
        assert_eq!(
            entries[0].file_name().to_str().unwrap_or(""),
            logical,
            "the single entry should be the logical dir '{logical}'"
        );

        // Report: table should be in updated or created, not marked_deleted.
        assert!(
            report.updated.contains(&logical_table) || report.created.contains(&logical_table),
            "logical table should be in updated or created; report={:?}", report
        );
        assert!(
            report.marked_deleted.is_empty(),
            "nothing should be marked deleted; report={:?}", report
        );
    }

    /// When rule is None, a folder `tables/Orders/table.md` and its models
    /// should be updated in-place with no moves, no extra folders, and no
    /// deleted entries.
    #[tokio::test]
    async fn dynamo_no_rule_behavior_unchanged() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());

        let table_content = "---\nsystem:\n  kind: dynamo_table\n  name: Orders\nhuman:\n  tags:\n    - live\n---\n# Orders\n\nOrders table.\n";
        write_file(dir.path(), "dynamo/tables/Orders/table.md", table_content);
        let model_content = "---\nsystem:\n  kind: dynamo_model\n  name: OrderItem\nhuman: {}\n---\n# OrderItem\n";
        write_file(dir.path(), "dynamo/tables/Orders/models/OrderItem.md", model_content);

        let report = execute_sync(
            dir.path(),
            EngineKind::Dynamo,
            vec![dynamo_shape("Orders")],
            None,
        )
        .await
        .unwrap();

        // Updated in place, nothing moved or deleted.
        let table_path = dir.path().join("dynamo/tables/Orders/table.md");
        assert!(table_path.exists(), "table.md should still exist");
        assert!(report.updated.contains(&table_path),
            "table should be in updated; report={:?}", report);
        assert!(report.marked_deleted.is_empty(),
            "nothing should be deleted; report={:?}", report);
        assert!(report.created.is_empty(),
            "nothing should be created; report={:?}", report);

        // No extra folder created.
        let tables_dir = dir.path().join("dynamo/tables");
        let entries: Vec<_> = fs::read_dir(&tables_dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_str().unwrap_or("").to_string())
            .collect();
        assert_eq!(entries.len(), 1, "only Orders/ should exist, found: {:?}", entries);

        // Models file still in the same location, content unchanged.
        let model_path = dir.path().join("dynamo/tables/Orders/models/OrderItem.md");
        assert!(model_path.exists(), "model file should be untouched");
        let model_read = fs::read_to_string(&model_path).unwrap();
        assert_eq!(model_read, model_content, "model content should be unchanged");
    }

    // ---- D6 live-logicals guard tests ----

    /// Bug regression: with a non-idempotent rule (suffix_pattern: "-[0-9A-Za-z]+$"),
    /// the D6 consolidation pass must NOT move the hand-renamed folder
    /// `CacheStack-CacheTable` into the bogus target `CacheStack/`.
    ///
    /// Only entries that normalize to a LIVE logical name should be consolidated.
    /// `CacheStack-CacheTableC1E6DF7E-ML2P8F7HDM0M` normalizes to
    /// `CacheStack-CacheTableC1E6DF7E` (the live logical), so the stranded models
    /// from that physical folder land in the right place. The hand-curated
    /// `CacheStack-CacheTable/` folder, which would over-strip to `CacheStack`
    /// (NOT a live logical), must be left alone by the consolidation pass and then
    /// processed by the rule-aware UPDATE path — landing its table.md under the
    /// live logical `CacheStack-CacheTableC1E6DF7E/`.
    #[tokio::test]
    async fn dynamo_consolidation_skips_folders_not_matching_live_logicals() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());

        let rule = TableMatch {
            prefix: None,
            suffix_pattern: Some("-[0-9A-Za-z]+$".to_string()),
            regex: None,
        };

        // The live (physical) table name that DynamoDB returns.
        let physical = "CacheStack-CacheTableC1E6DF7E-ML2P8F7HDM0M";
        // The live logical name: normalize(physical, rule) strips the last
        // "-ML2P8F7HDM0M" suffix → "CacheStack-CacheTableC1E6DF7E".
        let live_logical = "CacheStack-CacheTableC1E6DF7E";

        // Hand-renamed folder — the user had previously renamed the table doc to
        // a friendly name. Its frontmatter still carries the full physical name.
        // Under the given rule normalize("CacheStack-CacheTable") = "CacheStack"
        // which is NOT a live logical — this folder must NOT be moved to CacheStack/.
        let hand_table_content = format!(
            "---\nsystem:\n  kind: dynamo_table\n  name: {physical}\nhuman:\n  tags:\n    - hand-edited\n---\n# CacheStack-CacheTable\n\nHand-curated notes.\n"
        );
        write_file(
            dir.path(),
            "dynamo/tables/CacheStack-CacheTable/table.md",
            &hand_table_content,
        );

        // Stranded models under the physical-named folder (no table.md here).
        let model_content = "---\nsystem:\n  kind: dynamo_model\n  name: UserCredential\nhuman: {}\n---\n# UserCredential\n";
        write_file(
            dir.path(),
            &format!("dynamo/tables/{physical}/models/UserCredential.md"),
            model_content,
        );

        let report = execute_sync(
            dir.path(),
            EngineKind::Dynamo,
            vec![dynamo_shape(physical)],
            Some(&rule),
        )
        .await
        .unwrap();

        // The bogus over-strip target must NOT exist.
        let bogus_dir = dir.path().join("dynamo/tables/CacheStack");
        assert!(
            !bogus_dir.exists(),
            "tables/CacheStack/ must not be created by over-stripping the hand-curated folder"
        );

        // The stranded models were merged into the live logical folder.
        let live_model = dir
            .path()
            .join(format!("dynamo/tables/{live_logical}/models/UserCredential.md"));
        assert!(live_model.exists(), "stranded model must be merged into live logical folder");
        let model_read = fs::read_to_string(&live_model).unwrap();
        assert_eq!(model_read, model_content, "model content must be unchanged");

        // The hand-curated folder's table.md was relocated to the live logical
        // folder by the rule-aware UPDATE path (system.name in frontmatter folds
        // to live_logical, so it matches the live shape).
        let live_table = dir
            .path()
            .join(format!("dynamo/tables/{live_logical}/table.md"));
        assert!(live_table.exists(), "live logical table.md must exist");
        let live_table_content = fs::read_to_string(&live_table).unwrap();
        assert!(
            live_table_content.contains("hand-edited"),
            "human tag from hand-curated folder must be preserved"
        );

        // The report must not have a `created` entry for this table (it's an update).
        assert!(
            !report.created.iter().any(|p| p.to_str().unwrap_or("").contains(live_logical)),
            "live logical table should not be in created (it's an update); report={:?}", report
        );
        assert!(
            report.updated.contains(&live_table),
            "live logical table should be in updated; report={:?}", report
        );
    }

    /// A rule that cleanly strips both the hash segment AND the random suffix in
    /// one pass (`suffix_pattern: "[0-9A-F]{{8}}-[0-9A-Za-z]+$"`) is effectively
    /// idempotent for the physical name. When the pre-sync state already has a
    /// `tables/CacheStack-CacheTable/` folder (the correct logical target) plus
    /// a stranded `tables/CacheStack-CacheTableC1E6DF7E-ML2P8F7HDM0M/models/`
    /// folder, everything should converge into a single
    /// `tables/CacheStack-CacheTable/` folder after sync.
    #[tokio::test]
    async fn dynamo_consolidation_converges_with_hash_stripping_rule() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());

        // This rule strips "C1E6DF7E-ML2P8F7HDM0M" in one shot, folding
        // "CacheStack-CacheTableC1E6DF7E-ML2P8F7HDM0M" → "CacheStack-CacheTable".
        let rule = TableMatch {
            prefix: None,
            suffix_pattern: Some("[0-9A-F]{8}-[0-9A-Za-z]+$".to_string()),
            regex: None,
        };

        let physical = "CacheStack-CacheTableC1E6DF7E-ML2P8F7HDM0M";
        let logical = "CacheStack-CacheTable";

        // `tables/CacheStack-CacheTable/table.md` already exists (the user had
        // set it up, or a prior sync with this rule created it). Its frontmatter
        // still carries the full physical name (written before normalization was
        // known) and a human tag.
        let table_content = format!(
            "---\nsystem:\n  kind: dynamo_table\n  name: {physical}\nhuman:\n  tags:\n    - important\n---\n# CacheStack-CacheTable\n\nCache table notes.\n"
        );
        write_file(
            dir.path(),
            &format!("dynamo/tables/{logical}/table.md"),
            &table_content,
        );

        // Stranded models under the physical-named folder.
        let model_content = "---\nsystem:\n  kind: dynamo_model\n  name: UserCredential\nhuman: {}\n---\n# UserCredential\n";
        write_file(
            dir.path(),
            &format!("dynamo/tables/{physical}/models/UserCredential.md"),
            model_content,
        );

        let report = execute_sync(
            dir.path(),
            EngineKind::Dynamo,
            vec![dynamo_shape(physical)],
            Some(&rule),
        )
        .await
        .unwrap();

        // Everything must converge into a single CacheStack-CacheTable/ folder.
        let tables_dir = dir.path().join("dynamo/tables");
        let entries: Vec<_> = fs::read_dir(&tables_dir)
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(
            entries.len(),
            1,
            "tables/ should contain exactly one entry after convergence, found: {:?}",
            entries.iter().map(|e| e.file_name()).collect::<Vec<_>>()
        );
        assert_eq!(
            entries[0].file_name().to_str().unwrap_or(""),
            logical,
            "the single entry should be the logical dir '{logical}'"
        );

        // table.md updated in place with human tag preserved and system.name = logical.
        let logical_table = tables_dir.join(format!("{logical}/table.md"));
        assert!(logical_table.exists(), "logical table.md must exist");
        let content = fs::read_to_string(&logical_table).unwrap();
        assert!(
            content.contains(&format!("name: {logical}")),
            "system.name should be updated to logical name"
        );
        assert!(
            content.contains("important"),
            "human tag should be preserved"
        );

        // models/UserCredential.md present in logical folder.
        let logical_model = tables_dir.join(format!("{logical}/models/UserCredential.md"));
        assert!(logical_model.exists(), "models/UserCredential.md must be present in logical folder");

        // Physical-named folder must be gone.
        let physical_dir = tables_dir.join(physical);
        assert!(!physical_dir.exists(), "physical folder must be removed after consolidation");

        // Report: updated, not created or marked_deleted.
        assert!(
            report.updated.contains(&logical_table),
            "logical table should be in updated; report={:?}", report
        );
        assert!(
            report.marked_deleted.is_empty(),
            "nothing should be marked deleted; report={:?}", report
        );
        assert!(
            !report.created.iter().any(|p| p.to_str().unwrap_or("").contains(logical)),
            "logical table should not be in created; report={:?}", report
        );
    }

    // ---- CloudWatch filename folding round-trip (task 5.2) ----

    #[test]
    fn fold_log_group_name_replaces_slashes() {
        assert_eq!(fold_log_group_name("/aws/lambda/my-fn"), "__aws__lambda__my-fn");
        assert_eq!(fold_log_group_name("no-slashes"), "no-slashes");
        assert_eq!(fold_log_group_name("/single"), "__single");
    }

    #[test]
    fn unfold_log_group_name_reverses_fold() {
        assert_eq!(unfold_log_group_name("__aws__lambda__my-fn"), "/aws/lambda/my-fn");
        assert_eq!(unfold_log_group_name("no-slashes"), "no-slashes");
        assert_eq!(unfold_log_group_name("__single"), "/single");
    }

    #[test]
    fn fold_unfold_round_trip() {
        let names = &[
            "/aws/lambda/my-function",
            "/aws/ecs/my-cluster",
            "my-log-group",
            "/",
            "a/b/c/d",
        ];
        for name in names {
            let folded = fold_log_group_name(name);
            let unfolded = unfold_log_group_name(&folded);
            assert_eq!(
                &unfolded, name,
                "round-trip failed for {name:?}: fold={folded:?}"
            );
        }
    }

    // ---- CloudWatch sync report shape (task 5.4) ----

    fn cw_shape(name: &str) -> ObjectShape {
        ObjectShape {
            kind: "log_group".to_string(),
            schema: None,
            name: name.to_string(),
            primary_key: vec![],
            columns: vec![],
        }
    }

    #[tokio::test]
    async fn cloudwatch_sync_creates_folded_filename() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());

        let group_name = "/aws/lambda/my-fn";
        let report = execute_sync(
            dir.path(),
            EngineKind::Cloudwatch,
            vec![cw_shape(group_name)],
            None,
        )
        .await
        .unwrap();

        // Expect the folded path to be created.
        let expected_path = dir.path()
            .join("cloudwatch")
            .join("groups")
            .join("__aws__lambda__my-fn.md");

        assert!(
            expected_path.exists(),
            "cloudwatch groups file should exist at folded path; report={:?}", report
        );
        assert!(
            report.created.contains(&expected_path),
            "path should be in report.created; report={:?}", report
        );
    }

    #[tokio::test]
    async fn cloudwatch_sync_no_slash_name_creates_plain_filename() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());

        let group_name = "my-app-logs";
        let report = execute_sync(
            dir.path(),
            EngineKind::Cloudwatch,
            vec![cw_shape(group_name)],
            None,
        )
        .await
        .unwrap();

        let expected_path = dir.path()
            .join("cloudwatch")
            .join("groups")
            .join("my-app-logs.md");

        assert!(
            expected_path.exists(),
            "plain-named cloudwatch group should exist; report={:?}", report
        );
    }

    #[tokio::test]
    async fn cloudwatch_sync_marks_deleted_when_group_removed() {
        let dir = TempDir::new().unwrap();
        manifest(dir.path());

        let group_name = "/aws/lambda/gone";
        // First sync: create the file.
        execute_sync(
            dir.path(),
            EngineKind::Cloudwatch,
            vec![cw_shape(group_name)],
            None,
        )
        .await
        .unwrap();

        // Second sync: group no longer exists.
        let report = execute_sync(
            dir.path(),
            EngineKind::Cloudwatch,
            vec![],
            None,
        )
        .await
        .unwrap();

        assert!(
            !report.marked_deleted.is_empty(),
            "removed group should be marked deleted; report={:?}", report
        );
    }
}
