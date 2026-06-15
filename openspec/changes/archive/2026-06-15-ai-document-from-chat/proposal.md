## Why

Today the AI chat is read-only: the agent ingests the context folder but can never write back. The most valuable knowledge in a session — the corrections the user gives mid-conversation ("use `orders` not `order_log`", "`status`: 0=pending, 1=paid", "this column is denormalized because Z") — is lost the moment the chat closes. The agent should sediment that knowledge into the object docs so the *next* session starts better-informed.

This is the agent's **first write capability**, so it also moves a load-bearing guardrail: Claude is currently spawned with `--strict-mcp-config` and *no* MCP server specifically so it has no callback into Argus. We open exactly one Argus-owned, write-only callback and nothing else.

## What Changes

- **New AI documentation tool, exposed only to Claude CLI in v1.** Argus runs a single in-process MCP server exposing a write-only `document_object` tool. Claude is spawned with our own `--mcp-config` (keeping `--strict-mcp-config`, so no other MCP server loads) and the tool is added to its allowed-tools list.
- **The agent writes autonomously, mid-conversation.** No confirmation step. Each write streams through the existing `ToolCallStarted` / `ToolCallFinished` deltas, so the chat panel shows a "documented `users.status`" indicator as it happens.
- **Write targets expand beyond the body.** The tool can write three regions of an object doc:
  - the Markdown **body** (free prose: "use table X", source-of-truth notes),
  - `human.column_notes[col]` (per-column meaning — surfaced inline in every structure view and the Dynamo inspector),
  - `human.tags` (object-level tags).
  - It MUST NOT touch the `system:` block (owned by schema sync).
- **Backend write handler** resolves the canonical doc path for the connection (reusing `target_path_for` + Dynamo `normalize`), splices only the targeted region (reusing `sync.rs` structured-write + atomic temp-file/rename primitives), leaves untouched regions byte-for-byte, and lets the existing filesystem watcher refresh the docs panel / structure view for free.
- **Path safety**: the resolved path is canonicalized and asserted to stay inside the connection's context root — `..` escapes and symlink traversal are rejected.
- **System-prompt update**: the CLI prompt tells the agent that, when the user corrects or teaches it about a table/column, it should persist that via `document_object` (body for prose, `column_notes` for column meaning, `tags` for tags) — never the `system:` block.

Out of scope for v1: codex-cli, anthropic-api, openai-api (fast-follow); writing prefab queries; writing `human.owners`; CloudWatch (no introspector).

## Capabilities

### New Capabilities
- `ai-context-documentation`: the agent's ability to persist conversation knowledge into a connection's object docs — what regions are writable (body, `column_notes`, `tags`), append-vs-replace semantics, canonical-path resolution and traversal rejection, byte-preservation of untouched regions, watcher-driven refresh, and tool-call streaming to the chat UI.

### Modified Capabilities
- `ai-agent-guardrails`: the "claude is tool-restricted" requirement changes. The argv no longer guarantees *no* `--mcp-config`; instead it guarantees that the *only* MCP server loaded is Argus's own write-only documentation server, that this server cannot execute SQL or reach a database, and that the documentation tool is added to the allowed-tools list while Bash / external MCP remain unavailable.

## Impact

- **Backend (Rust)**: new MCP server + `document_object` handler under `src-tauri/src/modules/ai/`; new structured-write helpers (or generalized `sync.rs` splice) for the `human` block and body; `claude_cli.rs` spawn path (`build_claude_argv`, `spawn_claude_stream_json`) to pass `--mcp-config` and extend the tools list; `build_cli_system_prompt` copy; reuse of `context::sync` path-resolution and atomic-write primitives and the `context::registry` watcher.
- **Frontend**: minimal — the `document_object` tool call renders through the existing `ToolCallStarted` / `ToolCallFinished` chat-delta path; a small label/affordance so the call reads as "documented X" rather than a raw tool name.
- **Specs**: new `ai-context-documentation`; delta on `ai-agent-guardrails`.
- **Security**: introduces the agent's first write path; mitigated by single-server `--mcp-config`, write-only tool surface, body/`human`-only region scoping, and context-root path confinement.
