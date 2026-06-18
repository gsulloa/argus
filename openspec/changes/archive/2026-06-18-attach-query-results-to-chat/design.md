## Context

The AI chat panel ships today on `master` (providers + panel + #59 guardrails). The chat is single-direction: the agent emits SQL into the editor, the **user** applies and runs it, and rows land in the data grid. The chat never sees those rows.

Two facts from the codebase shape every decision here:

1. **The agent never executes SQL.** #59 (`ai-agent-guardrails`) hard-pins this — claude is tool-restricted to `Read Glob Grep`, every provider's prompt forbids DB CLIs. So there is no "agent ran a query" event to hook; the only real result is whatever the *user* ran, which already lives in `QueryTab` as `runner.state.result` (`{ kind: "rows", columns, rows, truncated }`).
2. **#59 left explicit seams for this change.** `build_api_system_prompt` assembles sections joined by `\n\n---\n\n` with a reserved trailing slot (`types.rs:224-228`, push before the join at `:230`). `flatten_history_for_cli` has `#62` insertion points to prepend to the latest user turn (`claude_cli.rs:316-322` multi-turn, `:325-328` single-turn). The token budget already measures `system_chars` over the builder's complete output.

```
QueryTab.tsx (parent)
├── runner.state.result = { columns, rows, truncated }   ← the only real result
├── <ResultPanel> ── <AdhocResultGrid columns rows truncated/>
└── <ChatPanel editorRef />   ← sibling; already shares editorRef. Add a result prop.
```

## Goals / Non-Goals

**Goals:**
- One wire shape (`AttachedResult`) carried on `ChatRequest`, consumed identically by all four providers.
- Capture the live executed result into chat session state; let the user attach/remove it as context for the next turn.
- Per-attachment truncation (100 rows / 50 KB) and oldest-first eviction when over the token budget.
- Reuse #59's seams without re-opening its prompt structure.

**Non-Goals:**
- Disk persistence across restarts; CSV/file uploads; agent-initiated re-fetch (tool-use); CloudWatch results.
- Binding an attachment to a specific assistant turn (see Decision 1).
- Changing #59's SQL-only / context-first guardrails.

## Decisions

### Decision 1 — Attach the *live grid result* from the composer, not a per-assistant-turn chip

The issue floats two UIs: a chip on the assistant turn, or a paperclip on the composer. Because the agent never runs SQL, there is **no reliable 1:1 link between an assistant turn and a result** — the user may edit the suggested SQL, run something else, or run it three turns later. Binding to assistant turns would promise a link the architecture can't honor.

**Chosen:** a composer-level "Attach result (N rows)" chip sourced from `runner.state.result`, passed from `QueryTab` into `ChatPanel` as a prop. Removable chips above the composer; multiple allowed; session-memory only.

*Alternative (per-turn capture):* rejected — fragile binding, more session state, misrepresents data flow.

### Decision 2 — `AttachedResult` is a single wire shape; serialisation differs per provider family

```rust
struct AttachedResult {
    id: String,
    columns: Vec<String>,
    rows: Vec<Vec<String>>,   // cells stringified at the frontend boundary
    truncated: bool,
    row_count: usize,         // true count even when rows is truncated
}
// ChatRequest { ..., attached_results: Vec<AttachedResult> }  // additive — trivial merge
```

- **API** (`anthropic`/`openai`): pass `&[AttachedResult]` into `build_api_system_prompt`, which builds a `# Attached results` section and `sections.push(...)` it before the final join — filling #59's reserved trailing slot.
- **CLI** (`claude`/`codex`): render a fenced markdown table with a `# Attached result (N rows)` header and prepend it to `last.content` at the `#62` insertion points. The CLI system prompt is injected separately (claude `--system-prompt`, codex `format!("{system}\n\n{history}")`), so the prefix does not collide with it.

Cells are stringified on the frontend (`CellValue → String`, `null → "NULL"`) so the Rust side carries `Vec<Vec<String>>` and never re-derives types.

### Decision 3 — Two distinct size limits: per-attachment truncation vs. inter-attachment eviction

- **Truncation (capture time):** cap each result to first 100 rows / 50 KB serialised; set `truncated = true`, keep the true `row_count`. Independent of how many attachments exist.
- **Eviction (compose time):** this is the gap #59's seams do **not** cover. `trim_turns_to_fit` only trims *turns* and never touches the system prompt; if bloated attachments live inside the system prompt, the existing guard would evict conversation history while keeping the attachments — the opposite of the issue's "drop the oldest attachment first."

  **Chosen:** `build_api_system_prompt` (or its API caller) runs an explicit oldest-first eviction over `attached_results` **before** composing — dropping whole attachments until the attachments portion fits its sub-budget — then the unchanged `trim_turns_to_fit` handles history. A `ChatDelta::Status` reports the eviction. This honors #59's "count over the full composed string" while adding the selective eviction #59 deliberately left to this change.

*Alternative (rely on turn-trimming):* rejected — wrong eviction target, drops history first.

### Decision 4 — API placement: trailing section of the system prompt (not a separate user message)

#59's reserved slot is in the system prompt, and putting attachments there keeps them out of the trimmable turn history (a separate trailing user message would be the *newest* turn and survive trimming anyway, but would fragment the wire format). Trailing placement also keeps `# Database context` authoritative-first per the guardrails ordering.

## Risks / Trade-offs

- **[Attachment bloat silently shrinks usable history]** → oldest-first eviction runs first; emit a `Status` delta so the user sees what was dropped, never a silent truncation.
- **[Stringified cells lose type fidelity for the model]** → acceptable for v1 (the grid itself renders strings); document `null → "NULL"` so the model isn't misled by empty cells.
- **[Live-result model surprises users expecting "attach what the agent suggested"]** → the chip label shows row count and the chips are explicit/removable; the attached table header names the source.
- **[CLI has no token-budget machinery]** → CLI relies solely on per-attachment truncation; if total CLI prompt is huge the CLI itself errors. Acceptable for v1; note in tasks.
- **[#59 line numbers drift]** → anchor on the `#62` marker comments, not line numbers.

## Migration Plan

Additive only: new `ChatRequest` field defaults to empty, `build_api_system_prompt` gains a parameter (update its two call sites + tests). No data migration, no settings, no DESIGN.md tokens. Rollback = revert the change; empty `attached_results` reproduces today's behavior exactly.

## Open Questions

- Should multiple attachments be merged into one `# Attached results` section with sub-headers, or one section each? (Leaning one section, sub-headed per attachment, for a stable single delimiter.)
- Total-attachment cap independent of token budget (e.g. max 3 attachments) to bound UI clutter? (Leaning yes, soft cap in the UI.)
