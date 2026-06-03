use std::collections::HashMap;
use std::path::{Path, PathBuf};

use thiserror::Error;

use super::engine::EngineKind;
use super::types::{
    ContextManifest, LoadWarning, ObjectDoc, ObjectHuman, ParsedContext, QueryDoc, QueryMeta,
};

// ---- Error type ----

#[derive(Debug, Error)]
pub enum ParserError {
    #[error("missing manifest at {path}")]
    MissingManifest { path: PathBuf },

    #[error("failed to parse manifest at {path}: {msg}")]
    ManifestParse { path: PathBuf, msg: String },

    #[error("unsupported manifest schema_version {found} (supported: {supported:?})")]
    UnsupportedManifestVersion { found: u32, supported: Vec<u32> },

    #[error("missing frontmatter in {path}")]
    MissingFrontmatter { path: PathBuf },

    #[error("missing 'system' block in frontmatter of {path}")]
    MissingSystemBlock { path: PathBuf },

    #[error("failed to parse frontmatter in {path}: {msg}")]
    FrontmatterParse { path: PathBuf, msg: String },

    #[error("io error reading {path}: {msg}")]
    Io { path: PathBuf, msg: String },
}

// ---- Helpers ----

/// Read an optional text file. Returns `None` if the file does not exist;
/// returns `Some(contents)` on success; panics on other I/O errors (callers
/// that need graceful degradation should use `read_optional_text_warn`).
fn read_optional_text(path: &Path) -> Option<String> {
    match std::fs::read_to_string(path) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => None,
    }
}

// ---- 3.1: parse_manifest ----

/// Read and validate `<root>/context.yaml`.
///
/// Returns `ParserError::MissingManifest` if the file is absent,
/// `ParserError::ManifestParse` if it cannot be deserialised, and
/// `ParserError::UnsupportedManifestVersion` if `schema_version` is not 1.
pub fn parse_manifest(root: &Path) -> Result<ContextManifest, ParserError> {
    let path = root.join("context.yaml");

    let content = std::fs::read_to_string(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ParserError::MissingManifest { path: path.clone() }
        } else {
            ParserError::Io {
                path: path.clone(),
                msg: e.to_string(),
            }
        }
    })?;

    let manifest: ContextManifest =
        serde_yaml::from_str(&content).map_err(|e| ParserError::ManifestParse {
            path: path.clone(),
            msg: e.to_string(),
        })?;

    if manifest.schema_version != 1 {
        return Err(ParserError::UnsupportedManifestVersion {
            found: manifest.schema_version,
            supported: vec![1],
        });
    }

    Ok(manifest)
}

// ---- 3.2: parse_object_doc ----

/// Parse a Markdown object-documentation file.
///
/// The file must start with a YAML frontmatter block delimited by `---` lines.
/// The frontmatter must contain a `system:` key; `human:` is optional and
/// defaults to `ObjectHuman::default()` if absent.
///
/// The raw Markdown body (everything after the closing `---`) is preserved
/// byte-for-byte in `ObjectDoc::body`.
pub fn parse_object_doc(path: &Path) -> Result<ObjectDoc, ParserError> {
    let raw = std::fs::read_to_string(path).map_err(|e| ParserError::Io {
        path: path.to_path_buf(),
        msg: e.to_string(),
    })?;

    // Frontmatter must start at byte 0: "---\n"
    if !raw.starts_with("---\n") {
        return Err(ParserError::MissingFrontmatter {
            path: path.to_path_buf(),
        });
    }

    // Find the closing "---\n" (or "---" at end-of-file)
    let after_open = &raw[4..]; // skip the opening "---\n"
    let close_pos = after_open
        .find("\n---\n")
        .map(|p| (p + 1, p + 5)) // (start of "---\n", end)
        .or_else(|| {
            // Handle "---" at very end of file (no trailing newline)
            after_open
                .find("\n---")
                .filter(|&p| p + 4 == after_open.len())
                .map(|p| (p + 1, p + 4))
        });

    let (fm_end_in_after, body_start_in_after) =
        close_pos.ok_or_else(|| ParserError::MissingFrontmatter {
            path: path.to_path_buf(),
        })?;

    let frontmatter = &after_open[..fm_end_in_after];
    let body = after_open[body_start_in_after..].to_string();

    // Parse frontmatter as a YAML map to extract `system` and `human`
    let fm_map: HashMap<String, serde_yaml::Value> =
        serde_yaml::from_str(frontmatter).map_err(|e| ParserError::FrontmatterParse {
            path: path.to_path_buf(),
            msg: e.to_string(),
        })?;

    let system_val = fm_map
        .get("system")
        .ok_or_else(|| ParserError::MissingSystemBlock {
            path: path.to_path_buf(),
        })?;

    let system =
        serde_yaml::from_value(system_val.clone()).map_err(|e| ParserError::FrontmatterParse {
            path: path.to_path_buf(),
            msg: format!("system block: {e}"),
        })?;

    let human = match fm_map.get("human") {
        Some(v) => {
            serde_yaml::from_value(v.clone()).map_err(|e| ParserError::FrontmatterParse {
                path: path.to_path_buf(),
                msg: format!("human block: {e}"),
            })?
        }
        None => ObjectHuman::default(),
    };

    Ok(ObjectDoc {
        system,
        human,
        body,
        source_path: path.to_path_buf(),
    })
}

// ---- 3.3: parse_queries_dir ----

/// Walk the top-level files in `dir` (non-recursive) and pair body files with
/// their optional `.meta.yaml` sidecars.
///
/// Returns a tuple of `(docs, warnings)`. If `dir` does not exist the result
/// is `(vec![], vec![])`.
pub fn parse_queries_dir(dir: &Path, engine: EngineKind) -> (Vec<QueryDoc>, Vec<LoadWarning>) {
    if !dir.exists() {
        return (vec![], vec![]);
    }

    let read_dir = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return (vec![], vec![]),
    };

    // Collect all files by their "basename" (the logical name without extension).
    // Key: basename string
    // Value: (body_path, meta_path)
    let mut body_files: HashMap<String, PathBuf> = HashMap::new();
    let mut meta_files: HashMap<String, PathBuf> = HashMap::new();

    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        if file_name.ends_with(".meta.yaml") {
            // Basename is everything before ".meta.yaml"
            let basename = file_name[..file_name.len() - ".meta.yaml".len()].to_string();
            meta_files.insert(basename, path);
        } else {
            // Check if the extension is a recognised body extension
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if engine.query_extensions().contains(&ext) {
                let stem = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                // If there's already a body for this stem, prefer the earlier
                // extension in the list and warn about the duplicate.
                if !body_files.contains_key(&stem) {
                    body_files.insert(stem, path);
                }
                // Duplicate body files for the same stem are silently ignored
                // (first-wins by iteration order, which is good enough).
            }
        }
    }

    let mut docs: Vec<QueryDoc> = Vec::new();
    let mut warnings: Vec<LoadWarning> = Vec::new();

    // Process basenames that appear in meta_files (orphan detection)
    for (basename, meta_path) in &meta_files {
        if !body_files.contains_key(basename) {
            warnings.push(LoadWarning {
                path: meta_path.clone(),
                message: "orphaned meta file (no body sibling)".into(),
            });
        }
    }

    // Process basenames that appear in body_files
    for (basename, body_path) in &body_files {
        let body = match std::fs::read_to_string(body_path) {
            Ok(s) => s,
            Err(e) => {
                warnings.push(LoadWarning {
                    path: body_path.clone(),
                    message: format!("failed to read body: {e}"),
                });
                continue;
            }
        };

        let meta = if let Some(meta_path) = meta_files.get(basename) {
            match std::fs::read_to_string(meta_path) {
                Ok(content) => match serde_yaml::from_str::<QueryMeta>(&content) {
                    Ok(m) => Some(m),
                    Err(e) => {
                        warnings.push(LoadWarning {
                            path: meta_path.clone(),
                            message: format!("failed to parse meta: {e}"),
                        });
                        None
                    }
                },
                Err(e) => {
                    warnings.push(LoadWarning {
                        path: meta_path.clone(),
                        message: format!("failed to read meta: {e}"),
                    });
                    None
                }
            }
        } else {
            None
        };

        let doc = match meta {
            Some(m) => QueryDoc {
                name: m.name.unwrap_or_else(|| basename.clone()),
                description: m.description,
                params: m.params,
                tags: m.tags,
                body,
                source_path: body_path.clone(),
            },
            None => QueryDoc {
                name: basename.clone(),
                description: None,
                params: vec![],
                tags: vec![],
                body,
                source_path: body_path.clone(),
            },
        };
        docs.push(doc);
    }

    (docs, warnings)
}

// ---- 3.4: load_folder ----

/// Load a full context folder for a given engine.
///
/// Hard error: `context.yaml` is missing or invalid.
/// Soft errors (file read failures, bad frontmatter): collected as `warnings`.
pub fn load_folder(root: &Path, engine: EngineKind) -> Result<ParsedContext, ParserError> {
    let manifest = parse_manifest(root)?;

    let engine_root = root.join(engine.subtree());

    let mut objects: Vec<ObjectDoc> = Vec::new();
    let mut warnings: Vec<LoadWarning> = Vec::new();

    // Walk object files depending on the engine.
    match engine {
        EngineKind::Postgres | EngineKind::Mysql | EngineKind::Mssql => {
            // <engine_root>/<schema>/<table>.md
            // Walk every subdirectory of engine_root except "queries/".
            if engine_root.exists() {
                match std::fs::read_dir(&engine_root) {
                    Ok(schema_dirs) => {
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
                            match std::fs::read_dir(&schema_path) {
                                Ok(table_files) => {
                                    for table_entry in table_files.flatten() {
                                        let table_path = table_entry.path();
                                        if table_path.is_file()
                                            && table_path.extension().and_then(|e| e.to_str())
                                                == Some("md")
                                        {
                                            match parse_object_doc(&table_path) {
                                                Ok(doc) => objects.push(doc),
                                                Err(e) => warnings.push(LoadWarning {
                                                    path: table_path,
                                                    message: e.to_string(),
                                                }),
                                            }
                                        }
                                    }
                                }
                                Err(e) => warnings.push(LoadWarning {
                                    path: schema_path,
                                    message: format!("failed to read schema dir: {e}"),
                                }),
                            }
                        }
                    }
                    Err(e) => warnings.push(LoadWarning {
                        path: engine_root.clone(),
                        message: format!("failed to read engine root: {e}"),
                    }),
                }
            }
        }
        EngineKind::Dynamo => {
            // <engine_root>/tables/<name>.md
            let tables_dir = engine_root.join("tables");
            if tables_dir.exists() {
                match std::fs::read_dir(&tables_dir) {
                    Ok(files) => {
                        for entry in files.flatten() {
                            let p = entry.path();
                            if p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("md") {
                                match parse_object_doc(&p) {
                                    Ok(doc) => objects.push(doc),
                                    Err(e) => warnings.push(LoadWarning {
                                        path: p,
                                        message: e.to_string(),
                                    }),
                                }
                            }
                        }
                    }
                    Err(e) => warnings.push(LoadWarning {
                        path: tables_dir,
                        message: format!("failed to read dynamo/tables: {e}"),
                    }),
                }
            }
        }
        EngineKind::Cloudwatch => {
            // <engine_root>/groups/<name>.md
            let groups_dir = engine_root.join("groups");
            if groups_dir.exists() {
                match std::fs::read_dir(&groups_dir) {
                    Ok(files) => {
                        for entry in files.flatten() {
                            let p = entry.path();
                            if p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("md") {
                                match parse_object_doc(&p) {
                                    Ok(doc) => objects.push(doc),
                                    Err(e) => warnings.push(LoadWarning {
                                        path: p,
                                        message: e.to_string(),
                                    }),
                                }
                            }
                        }
                    }
                    Err(e) => warnings.push(LoadWarning {
                        path: groups_dir,
                        message: format!("failed to read cloudwatch/groups: {e}"),
                    }),
                }
            }
        }
    }

    // Queries
    let queries_dir = engine_root.join("queries");
    let (queries, query_warnings) = parse_queries_dir(&queries_dir, engine);
    warnings.extend(query_warnings);

    // Optional prose files
    let overview = read_optional_text(&root.join("ai").join("overview.md"));
    let glossary = read_optional_text(&root.join("ai").join("glossary.md"));
    let readme = read_optional_text(&root.join("README.md"));

    Ok(ParsedContext {
        manifest,
        overview,
        glossary,
        readme,
        objects,
        queries,
        warnings,
    })
}

// ---- tests ----

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Write a file, creating parent directories as needed.
    fn write_file(dir: &Path, rel: &str, content: &str) {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&path, content).unwrap();
    }

    /// A minimal valid `context.yaml`.
    fn minimal_manifest() -> &'static str {
        "schema_version: 1\nname: Test\n"
    }

    /// A minimal valid object doc with both system and human blocks.
    fn minimal_object_doc() -> &'static str {
        "---\nsystem:\n  kind: table\n  name: users\nhuman:\n  tags:\n    - pii\n---\n# users\n\nThe user table.\n"
    }

    // ---- manifest tests ----

    #[test]
    fn manifest_missing_returns_error() {
        let dir = TempDir::new().unwrap();
        let err = parse_manifest(dir.path()).unwrap_err();
        assert!(matches!(err, ParserError::MissingManifest { .. }));
    }

    #[test]
    fn manifest_unsupported_version_returns_error() {
        let dir = TempDir::new().unwrap();
        write_file(dir.path(), "context.yaml", "schema_version: 99\nname: x\n");
        let err = parse_manifest(dir.path()).unwrap_err();
        assert!(matches!(
            err,
            ParserError::UnsupportedManifestVersion { found: 99, .. }
        ));
    }

    #[test]
    fn manifest_valid_loads() {
        let dir = TempDir::new().unwrap();
        write_file(
            dir.path(),
            "context.yaml",
            "schema_version: 1\nname: Billing service\n",
        );
        let manifest = parse_manifest(dir.path()).unwrap();
        assert_eq!(manifest.schema_version, 1);
        assert_eq!(manifest.name, "Billing service");
    }

    // ---- object doc tests ----

    #[test]
    fn object_doc_with_system_and_human_parses() {
        let dir = TempDir::new().unwrap();
        write_file(dir.path(), "users.md", minimal_object_doc());
        let doc = parse_object_doc(&dir.path().join("users.md")).unwrap();
        assert_eq!(doc.system.kind, "table");
        assert_eq!(doc.system.name, "users");
        let tags = doc.human.tags.unwrap();
        assert_eq!(tags, vec!["pii"]);
    }

    #[test]
    fn object_doc_missing_system_block_errors() {
        let dir = TempDir::new().unwrap();
        write_file(
            dir.path(),
            "users.md",
            "---\nhuman:\n  tags: [pii]\n---\n# users\n",
        );
        let err = parse_object_doc(&dir.path().join("users.md")).unwrap_err();
        assert!(matches!(err, ParserError::MissingSystemBlock { .. }));
    }

    #[test]
    fn object_doc_missing_human_block_defaults() {
        let dir = TempDir::new().unwrap();
        write_file(
            dir.path(),
            "users.md",
            "---\nsystem:\n  kind: table\n  name: users\n---\n# users\n",
        );
        let doc = parse_object_doc(&dir.path().join("users.md")).unwrap();
        assert!(doc.human.tags.is_none());
        assert!(doc.human.owners.is_none());
    }

    #[test]
    fn object_doc_body_preserved_byte_for_byte() {
        let dir = TempDir::new().unwrap();
        // Body with leading newline, special chars, trailing newline
        let body_bytes =
            b"\n# users\n\nThe user table.\n\n## Gotchas\n- `email` is unique.\xc3\xa9\n";
        let frontmatter = "---\nsystem:\n  kind: table\n  name: users\n---\n";
        let mut file_bytes = frontmatter.as_bytes().to_vec();
        file_bytes.extend_from_slice(body_bytes);

        let path = dir.path().join("users.md");
        fs::write(&path, &file_bytes).unwrap();

        let doc = parse_object_doc(&path).unwrap();
        assert_eq!(doc.body.as_bytes(), body_bytes);
    }

    // ---- query tests ----

    #[test]
    fn query_pair_loads_meta_and_body() {
        let dir = TempDir::new().unwrap();
        write_file(dir.path(), "top-customers.sql", "SELECT 1;");
        write_file(
            dir.path(),
            "top-customers.meta.yaml",
            "name: Top customers\ndescription: Ranking\nparams:\n  - name: since\n    type: timestamp\ntags: [analytics]\n",
        );
        let (docs, warnings) = parse_queries_dir(dir.path(), EngineKind::Postgres);
        assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].name, "Top customers");
        assert_eq!(docs[0].description.as_deref(), Some("Ranking"));
        assert_eq!(docs[0].params.len(), 1);
        assert_eq!(docs[0].tags, vec!["analytics"]);
        assert_eq!(docs[0].body, "SELECT 1;");
    }

    #[test]
    fn query_body_without_meta_uses_defaults() {
        let dir = TempDir::new().unwrap();
        write_file(dir.path(), "raw.sql", "SELECT 2;");
        let (docs, warnings) = parse_queries_dir(dir.path(), EngineKind::Postgres);
        assert!(warnings.is_empty());
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].name, "raw");
        assert!(docs[0].description.is_none());
        assert!(docs[0].params.is_empty());
        assert!(docs[0].tags.is_empty());
    }

    #[test]
    fn query_orphan_meta_emits_warning() {
        let dir = TempDir::new().unwrap();
        write_file(dir.path(), "ghost.meta.yaml", "name: Ghost\n");
        let (docs, warnings) = parse_queries_dir(dir.path(), EngineKind::Postgres);
        assert!(docs.is_empty());
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].message.contains("orphaned meta file"));
    }

    // ---- load_folder tests ----

    #[test]
    fn load_folder_postgres_isolates_subtree() {
        let dir = TempDir::new().unwrap();
        write_file(dir.path(), "context.yaml", minimal_manifest());
        write_file(
            dir.path(),
            "postgres/public/users.md",
            "---\nsystem:\n  kind: table\n  schema: public\n  name: users\n---\n# users\n",
        );
        write_file(
            dir.path(),
            "dynamo/tables/sessions.md",
            "---\nsystem:\n  kind: dynamo_table\n  name: sessions\n---\n# sessions\n",
        );
        let ctx = load_folder(dir.path(), EngineKind::Postgres).unwrap();
        assert_eq!(ctx.objects.len(), 1);
        assert_eq!(ctx.objects[0].system.name, "users");
    }

    #[test]
    fn load_folder_ignores_unrecognised_top_level_files() {
        let dir = TempDir::new().unwrap();
        write_file(dir.path(), "context.yaml", minimal_manifest());
        write_file(dir.path(), "notes.txt", "some notes");
        // Should load without error and without warnings about notes.txt
        let ctx = load_folder(dir.path(), EngineKind::Postgres).unwrap();
        assert!(ctx.objects.is_empty());
        // notes.txt should not appear in warnings
        for w in &ctx.warnings {
            let name = w.path.file_name().unwrap().to_str().unwrap();
            assert_ne!(name, "notes.txt");
        }
    }

    #[test]
    fn load_folder_missing_engine_subtree_returns_empty() {
        let dir = TempDir::new().unwrap();
        write_file(dir.path(), "context.yaml", minimal_manifest());
        // Only context.yaml exists; no dynamo/ subtree.
        let ctx = load_folder(dir.path(), EngineKind::Dynamo).unwrap();
        assert!(ctx.objects.is_empty());
        assert!(ctx.queries.is_empty());
    }
}
