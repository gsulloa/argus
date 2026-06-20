//! Minimal stdio MCP server (JSON-RPC 2.0, newline-delimited) that exposes
//! only the `document_object` tool backed by [`run_document_object`].
//!
//! # Usage
//!
//! The server is launched as a hidden subcommand of the Argus binary:
//!
//! ```text
//! argus __mcp-doc-writer --root <path> --engine <subtree> [--table-match <json>]
//! ```
//!
//! The Claude CLI spawns it via `--mcp-config` and communicates over stdin/stdout.
//!
//! # Protocol
//!
//! * Line-delimited JSON-RPC 2.0 over stdin → stdout.
//! * Supported methods: `initialize`, `notifications/initialized`, `tools/list`,
//!   `tools/call`.
//! * Tool errors follow the MCP convention (returned inside `result` with
//!   `isError: true`), NOT as JSON-RPC error responses.

use std::io::{self, BufRead, Write};
use std::path::PathBuf;

use serde_json::{json, Value as JsonValue};

use crate::modules::ai::document_tool::{
    run_document_object, DocWriteContext, DocumentObjectInput,
};
use crate::modules::context::engine::EngineKind;
use crate::modules::dynamo::params::TableMatch;

// ── Public config type ────────────────────────────────────────────────────────

/// Session-scoped configuration baked into argv when the Claude CLI spawns this
/// sidecar.
pub struct SidecarConfig {
    /// Canonical context root directory for the active connection.
    pub context_root: PathBuf,
    /// Engine kind (determines the `<engine>/` subtree inside `context_root`).
    pub engine: EngineKind,
    /// Optional Dynamo table-name normalization rule. `None` for non-Dynamo engines.
    pub dynamo_rule: Option<TableMatch>,
}

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

fn jsonrpc_result(id: &JsonValue, result: JsonValue) -> JsonValue {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })
}

fn jsonrpc_error(id: &JsonValue, code: i64, message: &str) -> JsonValue {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message,
        },
    })
}

// ── document_object JSON schema ───────────────────────────────────────────────

fn document_object_tool_def() -> JsonValue {
    json!({
        "name": "document_object",
        "description": "\
    Persist documentation about a database object (table, view, or DynamoDB table) \
    into its context-folder doc file. Use this whenever the user corrects or teaches \
    you something about a schema object. Three targets are available:\n\
    - target=\"body\": append or replace the freeform prose body of the object's doc.\n\
    - target=\"column_note\": set the note for a specific column (requires column=<name>).\n\
    - target=\"tags\": merge tags into the object's tag set (case-insensitive dedup, never removes).\n\
    IMPORTANT: this tool writes ONLY to the body, column_note, or tags regions. \
    It CANNOT write to or modify the system: frontmatter block, execute SQL, run any \
    database CLI, or write outside the connection's context root.",
        "inputSchema": {
            "type": "object",
            "required": ["name", "target", "content"],
            "properties": {
                "schema": {
                    "type": "string",
                    "description": "Schema name. Omit for schemaless engines (DynamoDB, CloudWatch)."
                },
                "name": {
                    "type": "string",
                    "description": "Object name (table, view, or DynamoDB table name)."
                },
                "target": {
                    "type": "string",
                    "enum": ["body", "column_note", "tags"],
                    "description": "Write target: body prose, a column note, or tags."
                },
                "column": {
                    "type": "string",
                    "description": "Column name. Required when target=column_note."
                },
                "content": {
                    "type": "string",
                    "description": "Content to write. Prose for body, note text for column_note, comma/space-separated tags for tags."
                },
                "mode": {
                    "type": "string",
                    "enum": ["append", "replace"],
                    "description": "Write mode for target=body: append (default, adds a dated section) or replace (rewrites body). Ignored for column_note and tags."
                }
            },
            "additionalProperties": false
        }
    })
}

// ── Core request handler (pure / testable) ────────────────────────────────────

/// Handle one parsed JSON-RPC 2.0 request.
///
/// Returns `Some(response)` for requests (which carry an `id`) and `None` for
/// notifications (no `id` — e.g. `notifications/initialized`).
///
/// `today` is injected so unit tests can pass a fixed date without relying on
/// the system clock.
///
/// This function is entirely pure with respect to stdio — no stdin/stdout calls.
pub fn handle_request(cfg: &SidecarConfig, req: &JsonValue, today: &str) -> Option<JsonValue> {
    let method = req.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let id = req.get("id");

    // Notifications have no `id`; we MUST NOT send a response.
    if id.is_none() {
        // Still need to handle notifications/initialized gracefully.
        return None;
    }

    let id = id.unwrap();

    match method {
        // ── initialize ────────────────────────────────────────────────────────
        "initialize" => {
            // Echo client's protocolVersion if provided, else our default.
            let protocol_version = req
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .and_then(|v| v.as_str())
                .unwrap_or("2024-11-05")
                .to_string();

            Some(jsonrpc_result(
                id,
                json!({
                    "protocolVersion": protocol_version,
                    "capabilities": {
                        "tools": {}
                    },
                    "serverInfo": {
                        "name": "argus",
                        "version": env!("CARGO_PKG_VERSION"),
                    }
                }),
            ))
        }

        // ── tools/list ────────────────────────────────────────────────────────
        "tools/list" => Some(jsonrpc_result(
            id,
            json!({
                "tools": [document_object_tool_def()]
            }),
        )),

        // ── tools/call ────────────────────────────────────────────────────────
        "tools/call" => {
            let params = match req.get("params") {
                Some(p) => p,
                None => {
                    return Some(jsonrpc_error(id, -32602, "tools/call: params missing"));
                }
            };

            let tool_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");

            if tool_name != "document_object" {
                return Some(jsonrpc_error(
                    id,
                    -32602,
                    &format!("tools/call: unknown tool {tool_name:?}"),
                ));
            }

            let arguments = params.get("arguments").cloned().unwrap_or(JsonValue::Null);

            // Deserialize input.
            let input: DocumentObjectInput = match serde_json::from_value(arguments) {
                Ok(v) => v,
                Err(e) => {
                    let text = format!("document_object: invalid arguments: {e}");
                    return Some(jsonrpc_result(
                        id,
                        json!({
                            "content": [{ "type": "text", "text": text }],
                            "isError": true,
                        }),
                    ));
                }
            };

            // Build write context from sidecar config.
            let ctx = DocWriteContext {
                context_root: &cfg.context_root,
                engine: cfg.engine,
                dynamo_rule: cfg.dynamo_rule.as_ref(),
            };

            // Execute.
            match run_document_object(&ctx, input, today) {
                Ok(msg) => Some(jsonrpc_result(
                    id,
                    json!({
                        "content": [{ "type": "text", "text": msg }],
                        "isError": false,
                    }),
                )),
                Err(e) => {
                    let text = format!("{e}");
                    Some(jsonrpc_result(
                        id,
                        json!({
                            "content": [{ "type": "text", "text": text }],
                            "isError": true,
                        }),
                    ))
                }
            }
        }

        // ── unknown method ────────────────────────────────────────────────────
        other => Some(jsonrpc_error(
            id,
            -32601,
            &format!("method not found: {other:?}"),
        )),
    }
}

// ── stdio loop ────────────────────────────────────────────────────────────────

/// Run the stdio MCP loop: read newline-delimited JSON-RPC from stdin, dispatch
/// via [`handle_request`], write responses to stdout (flushed after each line).
///
/// Exits (via `std::process::exit(0)`) on EOF. Parsing errors are responded to
/// with a JSON-RPC parse-error (`-32700`), with `id: null`.
pub fn run_stdio_loop(cfg: SidecarConfig) -> ! {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let stdin = io::stdin();
    let stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break, // EOF or read error → exit
        };

        if line.trim().is_empty() {
            continue;
        }

        let req: JsonValue = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                // Parse error — id is unknown, use null.
                let response =
                    jsonrpc_error(&JsonValue::Null, -32700, &format!("parse error: {e}"));
                let mut out = stdout.lock();
                let _ = writeln!(out, "{}", response);
                let _ = out.flush();
                continue;
            }
        };

        if let Some(response) = handle_request(&cfg, &req, &today) {
            let mut out = stdout.lock();
            let _ = writeln!(out, "{}", response);
            let _ = out.flush();
        }
    }

    std::process::exit(0);
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_cfg(root: &std::path::Path) -> SidecarConfig {
        SidecarConfig {
            context_root: root.to_path_buf(),
            engine: EngineKind::Postgres,
            dynamo_rule: None,
        }
    }

    fn seed_root(dir: &TempDir) {
        // context.yaml is required by resolve_doc_path for canonicalization.
        fs::write(dir.path().join("context.yaml"), "schema_version: 1\n").unwrap();
    }

    // ── initialize ───────────────────────────────────────────────────────────

    #[test]
    fn initialize_returns_protocol_version() {
        let dir = TempDir::new().unwrap();
        let cfg = make_cfg(dir.path());
        let req = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "protocolVersion": "2024-11-05" }
        });
        let resp = handle_request(&cfg, &req, "2026-06-15").unwrap();
        let result = &resp["result"];
        assert_eq!(result["protocolVersion"], "2024-11-05");
        let caps = &result["capabilities"];
        assert!(
            caps.get("tools").is_some(),
            "capabilities must contain tools"
        );
        let server_info = &result["serverInfo"];
        assert_eq!(server_info["name"], "argus");
    }

    #[test]
    fn initialize_echoes_client_protocol_version() {
        let dir = TempDir::new().unwrap();
        let cfg = make_cfg(dir.path());
        let req = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "protocolVersion": "2025-03-26" }
        });
        let resp = handle_request(&cfg, &req, "2026-06-15").unwrap();
        assert_eq!(resp["result"]["protocolVersion"], "2025-03-26");
    }

    #[test]
    fn initialize_defaults_protocol_version_when_absent() {
        let dir = TempDir::new().unwrap();
        let cfg = make_cfg(dir.path());
        let req = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize"
        });
        let resp = handle_request(&cfg, &req, "2026-06-15").unwrap();
        assert_eq!(resp["result"]["protocolVersion"], "2024-11-05");
    }

    // ── notifications/initialized ─────────────────────────────────────────────

    #[test]
    fn notifications_initialized_returns_none() {
        let dir = TempDir::new().unwrap();
        let cfg = make_cfg(dir.path());
        // notifications have no id
        let req = json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });
        let resp = handle_request(&cfg, &req, "2026-06-15");
        assert!(resp.is_none(), "notification must not produce a response");
    }

    // ── tools/list ────────────────────────────────────────────────────────────

    #[test]
    fn tools_list_contains_document_object() {
        let dir = TempDir::new().unwrap();
        let cfg = make_cfg(dir.path());
        let req = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list"
        });
        let resp = handle_request(&cfg, &req, "2026-06-15").unwrap();
        let tools = resp["result"]["tools"]
            .as_array()
            .expect("tools must be an array");
        assert_eq!(tools.len(), 1);

        let tool = &tools[0];
        assert_eq!(tool["name"], "document_object");

        // Input schema must carry the required fields.
        let schema = &tool["inputSchema"];
        let props = &schema["properties"];
        assert!(
            props.get("name").is_some(),
            "schema must have name property"
        );
        assert!(
            props.get("target").is_some(),
            "schema must have target property"
        );
        assert!(
            props.get("content").is_some(),
            "schema must have content property"
        );
        assert!(
            props.get("column").is_some(),
            "schema must have column property"
        );
        assert!(
            props.get("mode").is_some(),
            "schema must have mode property"
        );
        assert!(
            props.get("schema").is_some(),
            "schema must have schema property"
        );

        // Required array must include name, target, content.
        let required = schema["required"]
            .as_array()
            .expect("required must be an array");
        let req_strs: Vec<&str> = required.iter().filter_map(|v| v.as_str()).collect();
        assert!(req_strs.contains(&"name"), "name must be required");
        assert!(req_strs.contains(&"target"), "target must be required");
        assert!(req_strs.contains(&"content"), "content must be required");
    }

    // ── tools/call success ────────────────────────────────────────────────────

    #[test]
    fn tools_call_success_writes_file_and_returns_is_error_false() {
        let dir = TempDir::new().unwrap();
        seed_root(&dir);
        let cfg = make_cfg(dir.path());

        let req = json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "document_object",
                "arguments": {
                    "schema": "public",
                    "name": "orders",
                    "target": "body",
                    "content": "Tracks all customer orders."
                }
            }
        });

        let resp = handle_request(&cfg, &req, "2026-06-15").unwrap();

        // isError must be false.
        assert_eq!(resp["result"]["isError"], false);

        // Content must be a non-empty text block.
        let content = resp["result"]["content"]
            .as_array()
            .expect("content must be array");
        assert!(!content.is_empty());
        let text = content[0]["text"].as_str().unwrap_or("");
        assert!(!text.is_empty(), "result text must be non-empty");

        // File must have been written.
        let doc_path = dir.path().join("postgres/public/orders.md");
        assert!(doc_path.exists(), "doc file must be created on disk");
        let contents = fs::read_to_string(&doc_path).unwrap();
        assert!(contents.contains("Tracks all customer orders."));
    }

    // ── tools/call validation failure (column_note without column) ────────────

    #[test]
    fn tools_call_column_note_without_column_returns_is_error_true() {
        let dir = TempDir::new().unwrap();
        seed_root(&dir);
        let cfg = make_cfg(dir.path());

        let req = json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "document_object",
                "arguments": {
                    "schema": "public",
                    "name": "users",
                    "target": "column_note",
                    // column is intentionally absent
                    "content": "some note"
                }
            }
        });

        let resp = handle_request(&cfg, &req, "2026-06-15").unwrap();

        // Must be isError: true in the result (not a JSON-RPC error).
        assert_eq!(
            resp["result"]["isError"], true,
            "column_note without column must return isError: true"
        );
        assert!(
            resp.get("error").is_none(),
            "must NOT use JSON-RPC error for tool errors"
        );

        // No file should have been created.
        let doc_path = dir.path().join("postgres/public/users.md");
        assert!(
            !doc_path.exists(),
            "no file should be written on validation error"
        );
    }

    // ── unknown method → -32601 ───────────────────────────────────────────────

    #[test]
    fn unknown_method_returns_minus_32601() {
        let dir = TempDir::new().unwrap();
        let cfg = make_cfg(dir.path());

        let req = json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "foo/bar"
        });

        let resp = handle_request(&cfg, &req, "2026-06-15").unwrap();
        assert_eq!(resp["error"]["code"], -32601);
        assert!(
            resp.get("result").is_none(),
            "error response must not have result"
        );
    }

    // ── unknown tool → -32602 ─────────────────────────────────────────────────

    #[test]
    fn unknown_tool_name_returns_minus_32602() {
        let dir = TempDir::new().unwrap();
        let cfg = make_cfg(dir.path());

        let req = json!({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "tools/call",
            "params": {
                "name": "execute_sql",
                "arguments": {}
            }
        });

        let resp = handle_request(&cfg, &req, "2026-06-15").unwrap();
        assert_eq!(resp["error"]["code"], -32602);
    }

    // ── id preservation ───────────────────────────────────────────────────────

    #[test]
    fn response_preserves_request_id_string() {
        let dir = TempDir::new().unwrap();
        let cfg = make_cfg(dir.path());

        let req = json!({
            "jsonrpc": "2.0",
            "id": "req-abc-123",
            "method": "tools/list"
        });

        let resp = handle_request(&cfg, &req, "2026-06-15").unwrap();
        assert_eq!(resp["id"], "req-abc-123");
    }

    #[test]
    fn response_preserves_request_id_integer() {
        let dir = TempDir::new().unwrap();
        let cfg = make_cfg(dir.path());

        let req = json!({
            "jsonrpc": "2.0",
            "id": 42,
            "method": "tools/list"
        });

        let resp = handle_request(&cfg, &req, "2026-06-15").unwrap();
        assert_eq!(resp["id"], 42);
    }
}
