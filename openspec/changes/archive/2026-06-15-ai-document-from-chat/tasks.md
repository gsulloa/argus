## 1. Backend: structured write helper (context module)

- [x] 1.1 Add a `human`/body region-splice writer alongside `rewrite_file_with_system_yaml` in `context/sync.rs` (or a new `context/write.rs`): given a parsed doc, replace/append the body and/or splice an updated `human` block, leaving `system:` and untouched regions byte-for-byte intact (reuse `find_top_level_value_range`, CRLF detection, atomic temp+rename).
- [x] 1.2 Implement body `append` (insert/extend a `## Notes from chat YYYY-MM-DD` section) and body `replace` semantics.
- [x] 1.3 Implement `column_notes[col]` set (replace per column) and `tags` set-union merge (case-insensitive dedupe) by re-serializing `ObjectHuman` and splicing the `human:` range.
- [x] 1.4 Handle the not-yet-existing-doc case: mkdir the engine/schema subtree and write a fresh doc with the targeted region populated.
- [x] 1.5 Unit tests: frontmatter preserved on body write; body preserved on column/tag write; `system:` never mutated; CRLF round-trip; new-file creation; tag dedupe.

## 2. Backend: path resolution + safety

- [x] 2.1 Resolve the target path via `target_path_for(context_root, engine, shape)`, folding Dynamo identity through `normalize` with the connection's `table_match`.
- [x] 2.2 Canonicalize the resolved path and assert it is a descendant of the canonical context root; reject `..` and symlink escapes (reuse `CanonPath`-style logic).
- [x] 2.3 Unit tests: Postgres/Dynamo path resolution; traversal rejection (`..`, symlink); Dynamo normalization fold.

## 3. Backend: document_object handler

- [x] 3.1 Define the `document_object` input type: object identity (schema+name / Dynamo table), `target` (`body`|`column_note`|`tags`), optional `column`, `content`, optional `mode` (`append`|`replace`, default append).
- [x] 3.2 Implement the handler: validate input (e.g. `column` required for `column_note`), resolve connection → context root + engine + normalization rule, call the path resolver (§2) and the write helper (§1).
- [x] 3.3 Return a structured result string suitable for the tool-call `output` (what was written, to which path/region).
- [x] 3.4 Unit tests for input validation and end-to-end write per target.

## 4. Backend: MCP server + Claude CLI wiring

- [x] 4.1 Stand up the stdio MCP sidecar (Option B) as a hidden `__mcp-doc-writer` subcommand of the Argus binary, exposing only `document_object`; receives context-root + engine + Dynamo rule via argv/env and writes directly to disk.
- [x] 4.2 Verify Claude Code's HTTP MCP support against the pinned CLI version; if unsupported, fall back to an stdio shim (resolve in design Open Questions before coding). **RESOLVED: claude 2.1.152 supports both `"type":"http"` and `"type":"stdio"` in `--mcp-config`; chose Option B (stdio sidecar subcommand, zero new deps), allowed via `--allowedTools "mcp__argus__document_object"`.**
- [x] 4.3 Generate the `--mcp-config` JSON per chat invocation pointing at `current_exe` + the `__mcp-doc-writer` args; sidecar is spawned/torn down by the claude CLI itself (no Argus-side endpoint lifecycle).
- [x] 4.4 Extend `build_claude_argv` / `spawn_claude_stream_json` to pass `--mcp-config` (keeping `--strict-mcp-config`) and add the `document_object` MCP tool to the allowed-tools list — only when the connection has a linked context folder.
- [x] 4.5 Ensure the tool is wired on both the `--resume` path and the full-history-replay fallback path.
- [x] 4.6 ~~Gate handler calls on the session token so a stale endpoint cannot be driven by another process.~~ **N/A for Option B: no shared network endpoint exists; the sidecar is spawned by the claude CLI with params baked into argv, so there is nothing to hijack.**

## 5. System prompt

- [x] 5.1 Update `build_cli_system_prompt` to instruct the agent: when the user corrects/teaches about a table or column, persist it via `document_object` — body for prose, `column_note` for column meaning, `tags` for tags; never the `system:` block.
- [x] 5.2 Keep the existing SQL-only / no-execution clauses intact.

## 6. Frontend: tool-call indicator

- [x] 6.1 Render the `document_object` tool call through the existing `ToolCallStarted` / `ToolCallFinished` delta path so it shows a "documented `<object>.<region>`" indicator (label/affordance, not a raw tool name).
- [x] 6.2 Confirm the docs panel / structure view refresh on `context://changed` after a write (no new code expected; verify).

## 7. Validation

- [x] 7.1 Manual: in chat on a Postgres connection, correct a column meaning → verify `human.column_notes[col]` on disk and inline in the structure view.
- [x] 7.2 Manual: append a body note → verify dated section on disk and in the docs panel; verify `system:` unchanged.
- [x] 7.3 Manual: attempt a traversal-style write → verify rejection.
- [x] 7.4 Manual: connection without a context folder → verify `document_object` is unavailable and the agent stays read-only.
- [x] 7.5 Run `openspec validate ai-document-from-chat` and the Rust test suite.
