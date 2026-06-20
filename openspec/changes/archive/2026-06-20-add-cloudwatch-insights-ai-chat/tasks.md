## 1. Backend — engine-aware generation prompt (`ai-agent-guardrails`)

- [x] 1.1 Change `build_api_system_prompt` (`src-tauri/src/modules/ai/types.rs`) to accept the connection's `context_engine` (or a derived language label) and, for `EngineKind::Cloudwatch`, emit a CloudWatch Logs Insights mandate (single fenced ` ```cwlogs ` block, pipe syntax, `@`-fields, no `aws logs` execution); return the existing SQL text unchanged for SQL engines and `None`.
- [x] 1.2 Apply the same engine branch to `build_cli_system_prompt`, keeping the context-folder / parent-directory information sections intact.
- [x] 1.3 Thread `context_engine` into both builders at the four provider call sites: `anthropic_api.rs` (×2), `openai_api.rs` (×2), `claude_cli.rs` (`chat`), `codex_cli.rs`. Confirm `ai_chat_send` already supplies `context_engine` on `ChatRequest`.
- [x] 1.4 Confirm `extract_fenced_block` requires no change (language-agnostic) and that the folder-free CLI temp-dir fallback is unaffected.
- [x] 1.5 Update/extend `ai-agent-guardrails` tests in `types.rs`: keep the SQL-only assertions for SQL/`None` engines and add CloudWatch assertions (prompt contains a `cwlogs` mandate, no SQL mandate) across providers.

## 2. Frontend — Logs Insights editor write capability

- [x] 2.1 Extend `QueryEditorHandle` in `modules/cloudwatch/insights/QueryEditor.tsx` with `getSql()` (alias of `getQuery()`), `getCursor()`, `setCursor(offset)`, and `replaceBody(text)`, implemented via CodeMirror `viewRef` reads and dispatch transactions; keep `getQuery()`/`focus()`.
- [x] 2.2 Verify the handle structurally satisfies `ChatEditorHandle` from `ChatPanel.tsx` (no type errors when passed as `editorRef`).

## 3. Frontend — context-optional readiness (`ai-setup-readiness`)

- [x] 3.1 In `modules/ai/useAiReadiness.ts`, support a context-optional readiness profile so a CloudWatch connection resolves to `ready` on a configured provider alone and never `needs-context` (e.g. an engine-aware derivation or an explicit `contextOptional` option), leaving context-required engines unchanged.
- [x] 3.2 In `ChatPanel.tsx` `SetupChecklist`, suppress the context-folder item as a *required* prerequisite when readiness is context-optional; show only the provider prerequisite. Verify SQL engines still show both items.

## 4. Frontend — apply non-SQL blocks (`ai-chat-panel`)

- [x] 4.1 Widen the apply-language check in `ChatPanel.tsx` (currently `isSqlLike`: `null | "sql" | "SQL"`) to also accept `"cwlogs"` so generated Logs Insights blocks expose **Apply**/**Insert**; consider renaming to an engine-neutral name. Keep `"json"`-only-Copy behaviour.
- [x] 4.2 Confirm auto-apply's "exactly one applicable block" rule treats a single `cwlogs` block the same as a single `sql` block.

## 5. Frontend — Logs Insights AI chat panel wiring (`cloudwatch-insights-ai-chat`)

- [x] 5.1 In `modules/cloudwatch/insights/QueryTab.tsx`, add `useAiReadiness(connectionId)`, resolve the connection + `context_path` via `useConnections`, and wire `onLinkContext` to `useCloudwatchForm().openEdit`.
- [x] 5.2 Add `panelOpen`/`panelWidth` state with the shared `argus.ai.*` `localStorage` persistence, the splitter drag handler, and the `argus:ai:openPanel` event listener (copy the Athena patterns; drop the read-only banner and named-query flow).
- [x] 5.3 Mount `ChatPanel` at the editor-row level with `connectionId`, `contextPath`, `readiness`, `onLinkContext`, `editorRef`, and the attachable result.
- [x] 5.4 Derive the attachable result from `runner.state.result` (`kind === "rows"` and non-empty → `{ columns: columns.map(c => c.name), rows, truncated }`; otherwise `null`).
- [x] 5.5 In `modules/cloudwatch/insights/Toolbar.tsx`, add the ✨ toggle button with the readiness status dot (ready = green, setup = gray) and title hints, toggling `panelOpen`.

## 6. Verification

- [x] 6.1 Manually verify all four providers chat folder-free against a CloudWatch connection and that responses are Logs Insights syntax (not SQL).
- [x] 6.2 Verify Apply/Insert place a generated `cwlogs` query into the editor and that executed results attach as context.
- [x] 6.3 Verify the ✨ dot reflects readiness (gray with no provider → setup checklist showing only the provider item; green with a provider → chat usable with no folder).
- [x] 6.4 Regression check: a Postgres/Athena tab still requires a context folder, shows both checklist items, and emits SQL.
- [x] 6.5 Run frontend (`ChatPanel` tests) and backend (`ai/types.rs`) test suites; ensure DESIGN.md conformance for the toolbar button/dot.
