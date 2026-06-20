## Context

The Postgres, MySQL, MSSQL, and Athena editors all host a docked AI chat panel (`ChatPanel.tsx`) wired through the same seams: `useAiReadiness(connectionId)`, a context folder lookup, `localStorage`-persisted panel open/width + splitter drag, a ✨ toolbar toggle with a readiness dot, and an attachable executed result. Athena is the closest template — it shares CloudWatch's async query lifecycle and the same `{columns, rows, truncated}` result envelope, and carries no engine-specific handling in the panel.

The CloudWatch Logs Insights editor (`modules/cloudwatch/insights/`) is the only query editor with no AI panel. Investigation showed the runtime plumbing is mostly already in place, but with three load-bearing gaps the GitHub issue did not anticipate:

1. **The editor is read-only.** `QueryEditor`'s handle exposes only `getQuery()` and `focus()`; it never dispatches a write transaction. `ChatPanel` drives the editor through `ChatEditorHandle { getSql, getCursor, setCursor, replaceBody }`, so "Apply/Insert a generated query" is impossible until the editor gains a write surface.
2. **The generation prompt is hard-coded to SQL.** `build_api_system_prompt` / `build_cli_system_prompt` (`ai/types.rs`) say *"Your only job is to generate SQL … single fenced ```sql block"* and ignore `context_engine`. A CloudWatch chat would be told to emit SQL, not Logs Insights. The issue's "No Rust changes expected" is incorrect.
3. **Readiness requires a context folder.** `ai-setup-readiness` derives `ready` only when a context folder is available, and explicitly prohibits "degraded no-context chat". The product decision for CloudWatch is the opposite: AI must work with **no** context folder, for all four providers.

Confirmed already-working: `EngineKind::Cloudwatch` exists with `query_languages() → ["cwlogs"]`; `ai_chat_send` resolves `context_engine` from the connection row and tolerates a null `context_path` (empty payload); CLI providers fall back to `std::env::temp_dir()` as cwd and skip the doc-writer MCP when there is no folder ("guardrails scenario D6"); `extract_fenced_block` is language-agnostic. So folder-free chat runs for all four providers today — only its *output language* is wrong without the prompt change.

## Goals / Non-Goals

**Goals:**
- A docked, resizable, persisted AI chat panel + ✨ toggle (with readiness dot) in the CloudWatch Logs Insights editor, behaviourally matching Athena.
- AI generation produces CloudWatch Logs Insights pipe syntax (in a `cwlogs` block) for CloudWatch connections; SQL engines are byte-for-byte unchanged.
- AI is usable with **no** context folder for all four providers; a CloudWatch connection is `ready` on a configured provider alone.
- Generated Logs Insights queries can be Applied (replace) or Inserted (at cursor) into the `.cwlogs` editor.
- Executed Insights results can be attached as read-only context for the next message.

**Non-Goals:**
- No autocomplete/grounding from a context folder for Insights (folder remains optional enrichment; not required and not built here).
- No change to how SQL engines build their prompt, gate readiness, or apply blocks.
- No Logs Insights schema sync work (already shipped: `cloudwatch/groups/<name>.md`).
- No DynamoDB/`partiql` prompt or apply changes (left on the existing SQL/`null` path).
- No inline-editing grid — logs are immutable; the result is read-only context only.

## Decisions

### D1 — Extend the editor handle rather than wrap it
Add `getSql()` (alias of `getQuery()`), `getCursor()`, `setCursor(offset)`, and `replaceBody(text)` to `QueryEditor`'s `useImperativeHandle`, implemented as CodeMirror reads/transactions on the existing `viewRef`. The CloudWatch handle then *structurally satisfies* `ChatEditorHandle`, exactly as every other engine's editor does.

*Alternative considered:* build an adapter object in `QueryTab` wrapping `getQuery()`. Rejected — only the editor holds the CodeMirror `viewRef`, so write operations (`replaceBody`, `setCursor`) cannot be implemented outside it. `getQuery()`/`focus()` are retained for existing callers.

### D2 — Engine-aware prompt, branch only CloudWatch
`build_api_system_prompt` and `build_cli_system_prompt` take the `context_engine` (or a derived language label). When the engine is `Cloudwatch`, the role/restriction section instructs the agent to emit a CloudWatch Logs Insights query (pipe syntax: `fields`/`filter`/`stats`/`sort`/`limit`/`parse`, `@`-fields) in a single fenced `cwlogs` block and forbids self-execution (including `aws logs`). For every other engine — and for `None` — the prompt is the **existing SQL text, unchanged**. The four provider call sites (`anthropic_api` ×2, `openai_api` ×2, `claude_cli`, `codex_cli`) pass the engine through. The model's built-in knowledge of Logs Insights syntax is the grounding source folder-free, per the product decision.

*Alternative considered:* a generic templated language label derived from `EngineKind::query_languages()` for all engines. Rejected for v1 — perturbs the shipped SQL/PartiQL prompts and their byte-stability tests for no benefit; an explicit CloudWatch branch is lower-risk.

*Note:* `extract_fenced_block` already skips the language tag, so a `cwlogs` fence is parsed without change.

### D3 — Context-folder-optional readiness, expressed per engine
Introduce a notion of *context-optional* readiness so a CloudWatch connection is `ready` when a provider is configured, regardless of folder, and never resolves to `needs-context`. The panel's render gate is `readiness.level === "ready"`, so this alone makes the chat surface (not the checklist) render. The CloudWatch tab binds readiness directly to its fixed `connectionId` (no connection selector).

*Alternative considered:* flip the global readiness model so context is never required. Rejected — Postgres/MySQL/MSSQL/Athena/Dynamo all depend on the context requirement and the "no degraded chat" prohibition; a global flip is a behaviour change to shipped engines. The carve-out is scoped to engines that opt in.

### D4 — Apply for `cwlogs`, generalised from `isSqlLike`
`ChatPanel`'s apply-language check (`isSqlLike`, currently `null | "sql" | "SQL"`) is widened to also accept `cwlogs`, so generated Logs Insights blocks expose Apply/Insert. This is additive and harmless for SQL engines (no engine emits `cwlogs` for a SQL connection). Auto-apply's "exactly one block" rule applies equally.

### D5 — Setup checklist reflects optional context
When readiness is context-optional, the `SetupChecklist` (shown only when no provider is configured) MUST NOT present the context folder as a *required* prerequisite. It drops/softens the context item so a CloudWatch user who only needs a provider is not told a folder is mandatory. The existing two-item checklist is unchanged for context-requiring engines.

## Risks / Trade-offs

- **[Folder-free output quality]** With no context folder there is zero schema grounding; Insights query quality rests entirely on the model's prior knowledge + the engine-aware prompt. → Mitigation: explicit, syntax-naming prompt (D2); folder remains available as optional enrichment for users who link one.
- **[Perturbing shipped SQL prompts]** Threading `context_engine` through the builders risks changing SQL-engine output and breaking byte-stability tests. → Mitigation: D2 branches only CloudWatch; SQL/`None` paths return the exact existing string; keep the existing `api_prompt_contains_sql_only_clause` tests green and add CloudWatch-specific tests.
- **[`isSqlLike` is now a misnomer]** Widening it to `cwlogs` makes the name inaccurate. → Mitigation: rename to an engine-neutral name (e.g. `isApplicableLang`) or document; behaviour stays additive.
- **[Readiness regression]** A per-engine readiness branch could accidentally relax the context requirement for SQL engines. → Mitigation: default remains context-required; CloudWatch opts in explicitly; cover both paths with tests.
- **[Two write surfaces]** Adding `getSql`/`replaceBody` alongside `getQuery` is mild redundancy. → Mitigation: `getSql` is a thin alias; both kept to avoid churn at existing call sites.
