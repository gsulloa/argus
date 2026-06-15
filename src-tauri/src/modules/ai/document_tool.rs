//! Transport-independent handler for the `document_object` tool call.
//!
//! This module is intentionally decoupled from any transport (MCP, HTTP, stdio).
//! It takes an already-resolved [`DocWriteContext`] — the caller is responsible
//! for mapping a `connection_id` to a context root, engine kind, and optional
//! Dynamo normalization rule before calling [`run_document_object`].
//!
//! # Validation rules
//!
//! - `target` must be one of `"body"`, `"column_note"`, or `"tags"`.
//! - `target=column_note` requires a non-empty `column`; absent or blank → `AppError::Validation`.
//! - `mode` parses to [`BodyMode`] (`"append"` or `"replace"`); only meaningful
//!   for `target=body`; silently ignored for `column_note` and `tags`.
//!   An unrecognised `mode` value → `AppError::Validation`.
//! - Unknown `target` value → `AppError::Validation`.

use std::path::Path;

use crate::error::{AppError, AppResult};
use crate::modules::context::engine::EngineKind;
use crate::modules::context::write::{apply_doc_write, resolve_doc_path, BodyMode, WriteTarget};
use crate::modules::dynamo::params::TableMatch;

// ---- Input types ----

/// The JSON-deserializable input that arrives from a `document_object` tool call.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct DocumentObjectInput {
    /// Schema name. `None` for schemaless engines (DynamoDB, CloudWatch).
    pub schema: Option<String>,
    /// Object name (table / view name; for Dynamo the physical or logical table name).
    pub name: String,
    /// Write target: `"body"` | `"column_note"` | `"tags"`.
    pub target: String,
    /// Required when `target == "column_note"`.
    pub column: Option<String>,
    /// The content to write. Meaning depends on `target`:
    /// - `body`: prose to append / replace.
    /// - `column_note`: the note text.
    /// - `tags`: comma- or whitespace-separated tag list.
    pub content: String,
    /// Write mode for `target=body`: `"append"` (default) or `"replace"`.
    /// Silently ignored when `target` is `column_note` or `tags`.
    pub mode: Option<String>,
}

/// Resolved context for the connection the chat session is bound to.
///
/// The caller (wiring task) resolves the connection → context path mapping
/// before invoking [`run_document_object`].
pub struct DocWriteContext<'a> {
    /// The canonical context root directory for this connection.
    pub context_root: &'a Path,
    /// The engine kind for this connection (determines the subtree layout).
    pub engine: EngineKind,
    /// Optional Dynamo table-name normalization rule. Only used when
    /// `engine == EngineKind::Dynamo`.
    pub dynamo_rule: Option<&'a TableMatch>,
}

// ---- Core handler ----

/// Execute a `document_object` tool call.
///
/// Returns a human-readable result string describing what was written, intended
/// for use as the tool-call `output` sent back to the model.
///
/// `today` is injected as a `YYYY-MM-DD` string so unit tests can pass a fixed
/// value without relying on the system clock.
///
/// # Errors
///
/// Returns `AppError::Validation` for:
/// - Unknown `target` value.
/// - `target=column_note` with absent or empty `column`.
/// - Unrecognised `mode` value.
/// - Path traversal attempts (propagated from `resolve_doc_path`).
///
/// Returns `AppError::Storage` or `AppError::Internal` for filesystem errors.
pub fn run_document_object(
    ctx: &DocWriteContext,
    input: DocumentObjectInput,
    today: &str,
) -> AppResult<String> {
    // ── 1. Parse target and mode ─────────────────────────────────────────────

    let body_mode: Option<BodyMode> = match input.mode.as_deref() {
        None | Some("append") => Some(BodyMode::Append),
        Some("replace") => Some(BodyMode::Replace),
        Some(other) => {
            return Err(AppError::Validation(format!(
                "document_object: unknown mode {:?}; expected \"append\" or \"replace\"",
                other
            )));
        }
    };

    let write_target: WriteTarget = match input.target.as_str() {
        "body" => WriteTarget::Body {
            mode: body_mode.unwrap_or(BodyMode::Append),
        },
        "column_note" => {
            let column = input
                .column
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| {
                    AppError::Validation(
                        "document_object: column is required for target=column_note".to_string(),
                    )
                })?
                .to_string();
            WriteTarget::ColumnNote { column }
        }
        "tags" => WriteTarget::Tags,
        other => {
            return Err(AppError::Validation(format!(
                "document_object: unknown target {:?}; expected \"body\", \"column_note\", or \"tags\"",
                other
            )));
        }
    };

    // ── 2. Resolve path ──────────────────────────────────────────────────────

    let path = resolve_doc_path(
        ctx.context_root,
        ctx.engine,
        input.schema.as_deref(),
        &input.name,
        ctx.dynamo_rule,
    )?;

    // ── 3. Apply write ───────────────────────────────────────────────────────

    apply_doc_write(&path, &write_target, &input.content, today)?;

    // ── 4. Build result string ───────────────────────────────────────────────

    // Relative path for concise display (best-effort; falls back to absolute).
    let rel_path = path
        .strip_prefix(ctx.context_root)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| path.display().to_string());

    let object_label = match input.schema.as_deref() {
        Some(s) => format!("{}.{}", s, input.name),
        None => input.name.clone(),
    };

    let result = match &write_target {
        WriteTarget::Body { mode } => {
            let mode_label = match mode {
                BodyMode::Append => "appended note",
                BodyMode::Replace => "replaced body",
            };
            format!("Documented body of {} ({}) → {}", object_label, mode_label, rel_path)
        }
        WriteTarget::ColumnNote { column } => {
            format!(
                "Set column note on {}.{} → {}",
                object_label, column, rel_path
            )
        }
        WriteTarget::Tags => {
            let tags: Vec<&str> = input
                .content
                .split(|c: char| c.is_whitespace() || c == ',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect();
            let tag_list = tags.join(", ");
            format!("Added tags to {}: {} → {}", object_label, tag_list, rel_path)
        }
    };

    Ok(result)
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_ctx<'a>(root: &'a Path) -> DocWriteContext<'a> {
        DocWriteContext {
            context_root: root,
            engine: EngineKind::Postgres,
            dynamo_rule: None,
        }
    }

    fn input(target: &str, name: &str, content: &str) -> DocumentObjectInput {
        DocumentObjectInput {
            schema: Some("public".to_string()),
            name: name.to_string(),
            target: target.to_string(),
            column: None,
            content: content.to_string(),
            mode: None,
        }
    }

    // ── Validation error: column_note without column ──────────────────────────

    #[test]
    fn column_note_without_column_returns_validation_error() {
        let dir = TempDir::new().unwrap();
        // context root must exist for resolve_doc_path to canonicalize; create a file so
        // the dir is real on disk.
        fs::write(dir.path().join("context.yaml"), "schema_version: 1\n").unwrap();

        let ctx = make_ctx(dir.path());
        let inp = DocumentObjectInput {
            schema: Some("public".to_string()),
            name: "users".to_string(),
            target: "column_note".to_string(),
            column: None, // missing
            content: "some note".to_string(),
            mode: None,
        };

        let result = run_document_object(&ctx, inp, "2026-06-15");
        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "expected Validation error, got: {result:?}"
        );
        // No file should have been written.
        let doc_path = dir.path().join("postgres/public/users.md");
        assert!(!doc_path.exists(), "no file should be written on validation error");
    }

    #[test]
    fn column_note_with_blank_column_returns_validation_error() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("context.yaml"), "schema_version: 1\n").unwrap();

        let ctx = make_ctx(dir.path());
        let inp = DocumentObjectInput {
            schema: Some("public".to_string()),
            name: "users".to_string(),
            target: "column_note".to_string(),
            column: Some("   ".to_string()), // blank
            content: "some note".to_string(),
            mode: None,
        };

        let result = run_document_object(&ctx, inp, "2026-06-15");
        assert!(matches!(result, Err(AppError::Validation(_))));
    }

    // ── Validation error: unknown target ─────────────────────────────────────

    #[test]
    fn unknown_target_returns_validation_error() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("context.yaml"), "schema_version: 1\n").unwrap();

        let ctx = make_ctx(dir.path());
        let inp = input("nonsense_target", "users", "content");

        let result = run_document_object(&ctx, inp, "2026-06-15");
        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "expected Validation error for unknown target, got: {result:?}"
        );
    }

    // ── Validation error: unknown mode ───────────────────────────────────────

    #[test]
    fn unknown_mode_returns_validation_error() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("context.yaml"), "schema_version: 1\n").unwrap();

        let ctx = make_ctx(dir.path());
        let inp = DocumentObjectInput {
            schema: Some("public".to_string()),
            name: "users".to_string(),
            target: "body".to_string(),
            column: None,
            content: "content".to_string(),
            mode: Some("clobber".to_string()), // unknown
        };

        let result = run_document_object(&ctx, inp, "2026-06-15");
        assert!(matches!(result, Err(AppError::Validation(_))));
    }

    // ── Valid: body append ────────────────────────────────────────────────────

    #[test]
    fn body_append_creates_file_and_returns_result_string() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("context.yaml"), "schema_version: 1\n").unwrap();

        let ctx = make_ctx(dir.path());
        let inp = input("body", "orders", "This table tracks all orders.");

        let result = run_document_object(&ctx, inp, "2026-06-15").unwrap();

        let doc_path = dir.path().join("postgres/public/orders.md");
        assert!(doc_path.exists(), "doc file should be created");

        let content = fs::read_to_string(&doc_path).unwrap();
        assert!(content.contains("This table tracks all orders."));
        assert!(content.contains("## Notes from chat 2026-06-15"));

        assert!(result.contains("public.orders"), "result should mention object");
        assert!(result.contains("appended note"), "result should mention mode");
    }

    // ── Valid: body replace ───────────────────────────────────────────────────

    #[test]
    fn body_replace_creates_file_and_returns_result_string() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("context.yaml"), "schema_version: 1\n").unwrap();

        let ctx = make_ctx(dir.path());
        let inp = DocumentObjectInput {
            schema: Some("public".to_string()),
            name: "products".to_string(),
            target: "body".to_string(),
            column: None,
            content: "Replacement body content.".to_string(),
            mode: Some("replace".to_string()),
        };

        let result = run_document_object(&ctx, inp, "2026-06-15").unwrap();

        let doc_path = dir.path().join("postgres/public/products.md");
        assert!(doc_path.exists());
        let content = fs::read_to_string(&doc_path).unwrap();
        assert!(content.contains("Replacement body content."));

        assert!(result.contains("replaced body"), "result should mention replace mode");
    }

    // ── Valid: column_note ────────────────────────────────────────────────────

    #[test]
    fn column_note_writes_and_returns_result_string() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("context.yaml"), "schema_version: 1\n").unwrap();

        let ctx = make_ctx(dir.path());
        let inp = DocumentObjectInput {
            schema: Some("public".to_string()),
            name: "users".to_string(),
            target: "column_note".to_string(),
            column: Some("status".to_string()),
            content: "active | inactive | banned".to_string(),
            mode: None,
        };

        let result = run_document_object(&ctx, inp, "2026-06-15").unwrap();

        let doc_path = dir.path().join("postgres/public/users.md");
        assert!(doc_path.exists());
        let content = fs::read_to_string(&doc_path).unwrap();
        assert!(content.contains("active | inactive | banned"));

        assert!(result.contains("public.users"), "result mentions object");
        assert!(result.contains("status"), "result mentions column");
        assert!(result.contains("Set column note"), "result describes action");
    }

    // ── Valid: tags ───────────────────────────────────────────────────────────

    #[test]
    fn tags_writes_and_returns_result_string() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("context.yaml"), "schema_version: 1\n").unwrap();

        let ctx = make_ctx(dir.path());
        let inp = DocumentObjectInput {
            schema: Some("public".to_string()),
            name: "payments".to_string(),
            target: "tags".to_string(),
            column: None,
            content: "pii, billing".to_string(),
            mode: None,
        };

        let result = run_document_object(&ctx, inp, "2026-06-15").unwrap();

        let doc_path = dir.path().join("postgres/public/payments.md");
        assert!(doc_path.exists());
        let content = fs::read_to_string(&doc_path).unwrap();
        assert!(content.contains("pii") && content.contains("billing"));

        assert!(result.contains("Added tags"), "result describes action");
        assert!(result.contains("public.payments"), "result mentions object");
    }

    // ── Valid: mode is ignored for column_note and tags ───────────────────────

    #[test]
    fn mode_is_ignored_for_column_note() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("context.yaml"), "schema_version: 1\n").unwrap();

        let ctx = make_ctx(dir.path());
        // Passing mode=replace with column_note should NOT error; mode is ignored.
        let inp = DocumentObjectInput {
            schema: Some("public".to_string()),
            name: "users".to_string(),
            target: "column_note".to_string(),
            column: Some("id".to_string()),
            content: "primary key".to_string(),
            mode: Some("replace".to_string()), // ignored
        };

        let result = run_document_object(&ctx, inp, "2026-06-15");
        assert!(result.is_ok(), "mode should be ignored for column_note, got: {result:?}");
    }

    #[test]
    fn mode_is_ignored_for_tags() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("context.yaml"), "schema_version: 1\n").unwrap();

        let ctx = make_ctx(dir.path());
        let inp = DocumentObjectInput {
            schema: Some("public".to_string()),
            name: "events".to_string(),
            target: "tags".to_string(),
            column: None,
            content: "audit".to_string(),
            mode: Some("append".to_string()), // ignored
        };

        let result = run_document_object(&ctx, inp, "2026-06-15");
        assert!(result.is_ok(), "mode should be ignored for tags");
    }

    // ── Path traversal rejected ───────────────────────────────────────────────

    #[test]
    fn path_traversal_name_rejected() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("context.yaml"), "schema_version: 1\n").unwrap();

        let ctx = make_ctx(dir.path());
        // A name like "../../etc/passwd" should be rejected by resolve_doc_path.
        // On most systems PathBuf::join with a component containing "/" splits
        // into a new absolute path; the safety check in resolve_doc_path will
        // catch the escape.
        let inp = DocumentObjectInput {
            schema: Some("public".to_string()),
            name: "../../etc/passwd".to_string(),
            target: "body".to_string(),
            column: None,
            content: "pwned".to_string(),
            mode: None,
        };

        let result = run_document_object(&ctx, inp, "2026-06-15");
        // resolve_doc_path must reject this as a traversal or path-escape.
        assert!(
            result.is_err(),
            "path traversal name should be rejected, got Ok"
        );
        // Make sure /etc/passwd was not touched (basic sanity).
        let passwd = std::path::Path::new("/etc/passwd");
        if passwd.exists() {
            // The content written would start with ---\n (seed minimal file);
            // if the file is readable its content must not be the Argus seed.
            let c = fs::read_to_string(passwd).unwrap_or_default();
            assert!(!c.contains("---\nsystem:"), "/etc/passwd must not have been overwritten");
        }
    }

    // ── DynamoDB: schemaless (no schema) result string ────────────────────────

    #[test]
    fn dynamo_result_string_has_no_dot_prefix() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("context.yaml"), "schema_version: 1\n").unwrap();

        let ctx = DocWriteContext {
            context_root: dir.path(),
            engine: EngineKind::Dynamo,
            dynamo_rule: None,
        };

        let inp = DocumentObjectInput {
            schema: None, // schemaless
            name: "EventsTable".to_string(),
            target: "tags".to_string(),
            column: None,
            content: "events".to_string(),
            mode: None,
        };

        let result = run_document_object(&ctx, inp, "2026-06-15").unwrap();
        assert!(
            !result.starts_with('.'),
            "result string must not start with dot for schemaless engine"
        );
        assert!(result.contains("EventsTable"), "result must mention table name");
    }
}
