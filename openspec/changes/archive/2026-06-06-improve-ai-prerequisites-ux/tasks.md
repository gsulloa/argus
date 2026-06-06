## 1. Readiness hook

- [x] 1.1 Create `useAiReadiness(connectionId)` in `src/modules/ai/` returning `{ providerConfigured: boolean, contextState: "none" | "available" | "missing" | "unknown", level: "not-configured" | "needs-context" | "ready" }`
- [x] 1.2 Derive `providerConfigured` from `useAiSettings` (global default OR per-connection override) — reuse the logic currently inlined as `aiConfigured` in `QueryTab.tsx:326-335`
- [x] 1.3 Derive `contextState` via `contextApi.listObjects` + `isMissingFolderError` (`availability.ts`), defaulting to `none` when the connection has no `context_path`
- [x] 1.4 Subscribe to context changes with `useContextChangeListener` so the hook recomputes reactively
- [x] 1.5 Map to `level`: no provider → `not-configured`; provider + (`none`|`missing`) → `needs-context`; provider + `available` → `ready`; treat `unknown` as not-`ready`
- [x] 1.6 Add unit tests for the mapping across all provider/context combinations including `missing` and `unknown`

## 2. Always-visible button + status indicator (QueryTab)

- [x] 2.1 Remove the `aiConfigured` render gate on the ✨ button in `QueryTab.tsx:631` so it always renders
- [x] 2.2 Consume `useAiReadiness` in `QueryTab` and render a status dot on the ✨ button distinguishing `ready` from unmet states (follow `DESIGN.md` for color/size/position)
- [x] 2.3 Ensure clicking ✨ always toggles the panel open regardless of readiness (drop the `aiConfigured` force-close effect at `QueryTab.tsx:356-358`)
- [x] 2.4 Wire the panel render condition to no longer require `aiConfigured` (`QueryTab.tsx:681`) — open in setup or chat mode based on readiness

## 3. Setup checklist + chat gating (ChatPanel)

- [x] 3.1 Pass readiness (and a `connection` reference for the context CTA) into `ChatPanel`
- [x] 3.2 Render a setup-mode checklist when `level !== "ready"`: two items (AI provider, context folder) each marked satisfied/unsatisfied
- [x] 3.3 Provider CTA → `CommandRegistry.get("ai.configureProviders")?.run()`
- [x] 3.4 Context CTA → `usePostgresForm().openEdit(connection)` to open the connection form for linking/locating the folder
- [x] 3.5 Gate `ChatSession` creation on `open && ready` (move the effect at `ChatPanel.tsx:482-491`); close any existing session if readiness drops below `ready`
- [x] 3.6 Hide/disable the chat input and Send while `level !== "ready"`
- [x] 3.7 Ensure the panel transitions setup → chat (and back) reactively when readiness changes, without manual refresh

## 4. Remove degraded no-context mode

- [x] 4.1 Remove the degraded-mode tooltip/badge copy at `ChatPanel.tsx:626-631` (empty-payload / temp-dir messaging)
- [x] 4.2 Keep the linked-folder context badge for the `ready` state; verify no remaining code path opens chat with an empty/degraded payload

## 5. Tests & docs

- [x] 5.1 Component tests for `ChatPanel` setup mode: checklist items reflect each readiness level; CTAs invoke the right action; input hidden until ready
- [x] 5.2 Test that no `ChatSession` is created while not ready and that becoming ready transitions to chat
- [x] 5.3 Update `README.md` AI providers section to state a context folder is now required to chat (removal of degraded mode)
- [x] 5.4 Manual QA across the three states (not-configured, needs-context incl. missing-on-disk, ready) and the reactive transitions after configuring provider / linking context
