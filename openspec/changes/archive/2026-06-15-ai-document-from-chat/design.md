## Context

The AI chat (`src-tauri/src/modules/ai/`) is strictly one-directional: providers stream text/observed tool calls out, but nothing the model emits calls back into Argus. Claude CLI is the most write-ready provider — it already emits structured tool events that Argus parses into `ChatDelta::ToolCallStarted` / `ToolCallFinished` (`claude_cli.rs:461-520`), and the chat panel already renders them. It is also the most locked down: spawned with `--strict-mcp-config` and **no** `--mcp-config`, restricted to `--tools "Read Glob Grep"` (`claude_cli.rs:191`, `242`), precisely so it cannot reach any callback or DB MCP server.

The disk-write machinery already exists and is battle-tested in `context/sync.rs`:
- `target_path_for(root, engine, shape)` resolves `<root>/<engine>/<schema>/<name>.md` (and folds Dynamo names through `normalize`) — `sync.rs:49-67`.
- `rewrite_file_with_system_yaml` splices only a targeted region, preserves untouched bytes (incl. CRLF), and writes atomically (temp + rename) — `sync.rs:253-378`.
- The `parser.rs` frontmatter splitter and the `splice_system_block` / `find_top_level_value_range` helpers already locate `system:` / `human:` / body regions by byte range.
- The `context::registry` watcher debounces and re-emits `context://changed` on any `*.md` write — refresh is free.

So the new work is concentrated in two places: (1) a callback transport from Claude CLI back into Argus, and (2) a structured-write helper for the `human` block + body (the existing splice targets `system:`).

## Goals / Non-Goals

**Goals:**
- Let Claude, mid-conversation, persist user corrections into the connection's object doc: body prose, `human.column_notes[col]`, and `human.tags`.
- Reuse `sync.rs` path-resolution + atomic-write + region-splice primitives so untouched regions (especially `system:`) stay byte-for-byte intact.
- Confine every write inside the connection's canonical context root.
- Surface each write as a streamed tool call ("documented X") with zero new frontend plumbing.
- Keep the guardrail posture: the new MCP server is the *only* server loaded, is write-only, and cannot execute SQL or reach a database.

**Non-Goals:**
- Other providers (codex-cli, anthropic-api, openai-api) — fast-follow.
- A confirmation/approval step (the user chose autonomous writes with a UI indicator).
- Writing `human.owners`, prefab queries, the `system:` block, or CloudWatch docs.
- A Markdown renderer for the body (still a `<pre>`); out of scope.

## Decisions

### D1 — Callback transport: a stdio MCP sidecar that is a subcommand of the Argus binary (Option B, chosen)

Claude Code reaches non-built-in tools through MCP. We expose a minimal **stdio** MCP server implemented as a hidden subcommand of the *same* Argus binary (`argus __mcp-doc-writer …`). Claude spawns it via our `--mcp-config` (keeping `--strict-mcp-config` so *only* our server loads). Because it is the same binary, the sidecar links the `context::write` + `ai::document_tool` modules directly — no protocol/HTTP layer, no callback into the running Argus process. The resolved per-session parameters (context-root path, engine, Dynamo normalization rule) are baked into the sidecar's argv/env at spawn time, so the sidecar writes straight to disk and the main process's existing filesystem watcher refreshes the UI.

- `--mcp-config` entry is `{"type":"stdio","command":"<current_exe>","args":["__mcp-doc-writer","--root",…,"--engine",…,(dynamo rule)…]}`; the tool is allowed with `--allowedTools "mcp__argus__document_object"`.
- The sidecar implements just enough MCP/JSON-RPC over stdio: `initialize`, `notifications/initialized`, `tools/list`, `tools/call` → `run_document_object`.
- **Why B over A (in-process HTTP server):** Argus ships no HTTP-server stack (only `reqwest` as a client) and no MCP crate, so A would add a web-server dependency *plus* a hand-rolled MCP-over-HTTP implementation. B adds zero dependencies, reuses the already-tested write module, and removes the network-listener attack surface entirely (no port, no token-over-network — params are spawn-baked).

**Alternatives considered:**
- *Option A — in-process HTTP/SSE MCP server on `127.0.0.1:0` with a bearer token.* Confirmed viable (claude 2.1.152 supports `"type":"http"`), but rejected on dependency cost (new web-server framework) and added attack surface vs. B.
- *Option C — adopt the `rmcp` Rust MCP SDK.* Rejected for v1: a non-trivial new dependency to vet when the stdio protocol surface we need is tiny.
- *Loosen `--tools` to allow built-in `Write`/`Edit` scoped to the context folder.* Rejected: cannot do structured YAML edits to `human.column_notes`/`tags`, would let the agent rewrite `system:`, loses body-only/region safety and Dynamo normalization, and renders as a generic `Write` call instead of "documented X".
- *Post-process the transcript at end-of-session (distill to docs).* Rejected: the user explicitly chose autonomous, in-conversation writes with a live indicator.

### D2 — Tool surface: one `document_object` tool with a discriminated `target`

A single tool keeps the agent's decision simple and the allowed-tools list to one entry. Shape:

```
document_object(
  object: { connection-scoped identity — schema + name, or table name for Dynamo },
  target: "body" | "column_note" | "tags",
  column?: string,        // required when target = "column_note"
  content: string,        // prose | note text | (for tags) comma/JSON list
  mode?: "append" | "replace"   // applies to body; default append
)
```

- `body` + `mode=append` (default) adds a `## Notes from chat YYYY-MM-DD` section so conversations stack; `mode=replace` rewrites the body.
- `column_note` sets `human.column_notes[column]` (replace semantics — one note per column).
- `tags` merges into `human.tags` (set union; never removes).

**Alternative considered:** three separate tools (`append_doc_note`, `set_column_note`, `set_tags`). Cleaner per-tool schemas but a larger allowed-tools surface and more MCP boilerplate; deferred — can split later without changing the backend write helper.

### D3 — Structured write helper generalizes the `sync.rs` splice

The existing splice replaces only the `system:` byte-range. We add a sibling that, given a parsed doc, can: (a) replace/append the body region, and (b) re-serialize an updated `human` block and splice it into the `human:` byte-range — leaving `system:` and body bytes untouched. Reuse `find_top_level_value_range(fm, "human")`, the atomic temp+rename writer, and CRLF detection. When the file or `human:` block is absent, fall back to a full safe re-serialization via the existing `parser` round-trip.

This keeps the issue's core invariant ("`system:` is owned by introspection") enforced *structurally*, not just by prompt.

### D4 — Path resolution + safety reuse `target_path_for` + `CanonPath`

Resolve via `target_path_for(context_root, engine, shape)` (Dynamo folded through `normalize` with the connection's `table_match`). Then canonicalize the resolved path and assert it is a descendant of the canonical context root; reject `..` and symlink escapes (`CanonPath`-style canonicalization). A write to a doc that doesn't exist yet creates it under the canonical path (mkdir -p of the engine/schema subtree), matching how sync seeds files.

### D5 — Refresh is free via the existing watcher

The atomic rename lands a `*.md` change inside the watched root; `registry::run_worker` classifies it as `"object"`, reparses, and emits `context://changed`. The docs panel and structure views (which already consume `column_notes` inline) refresh with no new code.

### D6 — Guardrail delta is scoped and structural

`ai-agent-guardrails` is updated, not loosened wholesale: the argv still passes `--strict-mcp-config`; the *only* MCP server is Argus's write-only documentation server; the `document_object` tool cannot execute SQL, run a DB CLI, or read/write outside the context root; Bash and external MCP stay unavailable. The SQL-only emission contract is unchanged.

## Risks / Trade-offs

- **Agent reliability — model may forget to call the tool, or call it with noise.** → Autonomous writes were the user's explicit choice; mitigate with a clear system-prompt instruction tied to the "user corrects/teaches" trigger, and default body writes to *append under a dated heading* so noise is additive and reversible, never clobbering. `mode=replace` exists but is opt-in.
- **First write path = new attack surface.** → Single-server `--mcp-config` + `--strict-mcp-config`, write-only tool, region-scoped (`system:` structurally unwritable), and context-root path confinement (canonicalize + descendant assertion, reject symlink/`..`).
- **Localhost MCP endpoint lifetime/port.** → Bind to `127.0.0.1` on an ephemeral port, scoped to the chat session, torn down on `ai_chat_close`; gate calls on the per-session token so a stale endpoint can't be driven by another process.
- **Concurrent write vs. a schema resync touching the same file.** → Both use atomic temp+rename; last-writer-wins on the file, and region splices are independent (`human`/body vs `system`), so a resync preserves the agent's body/`human` bytes exactly as it does today.
- **`column_note`/`tags` write into `human:`, which the original issue declared off-limits.** → Reconciled by design: the *user* authored the knowledge (the agent only transcribes a correction), the write is region-scoped and never touches `system:`, and `human:` survives resync byte-for-byte. The UI indicator keeps it visible.

## Open Questions

- ~~Token/endpoint mechanics: HTTP-on-localhost vs. an stdio MCP shim — confirm Claude Code's HTTP MCP support against the pinned CLI version before implementing D1.~~ **RESOLVED (claude CLI 2.1.152):** `--mcp-config` accepts both `"type":"http"` and `"type":"stdio"` servers. Chose **Option B (stdio sidecar subcommand)** over A on dependency/attack-surface grounds (see D1). The tool is allowed with `--allowedTools "mcp__argus__document_object"` while built-ins stay `--tools "Read Glob Grep"` and `--strict-mcp-config` is kept so only our server loads.
- Should `tags` writes be capped (max N) or deduped case-insensitively? (Lean: dedupe case-insensitively, no hard cap.)
- Dated body heading format/locale — fixed `## Notes from chat YYYY-MM-DD` vs. include time/session id for multiple same-day sessions.
