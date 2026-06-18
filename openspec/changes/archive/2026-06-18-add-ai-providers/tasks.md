## 1. Migration & settings storage

- [x] 1.1 Create `src-tauri/migrations/0006_ai_settings.sql` defining `ai_settings` (singleton) and `ai_connection_overrides` tables per the design.
- [x] 1.2 Register the migration in `src-tauri/src/platform/storage.rs` (next slot after `0005_connection_context.sql`).
- [x] 1.3 Add `AiSettings` and `ResolvedProviderConfig` types in `src-tauri/src/modules/ai/settings.rs` with `get/set/resolve` async methods using the existing sqlite pool.
- [x] 1.4 Add unit tests for `AiSettings::resolve` covering: no default + no override → Validation error; default only; override wins; cascade delete on connection removal.

## 2. Module scaffold (Rust)

- [x] 2.1 Create `src-tauri/src/modules/ai/` with `mod.rs`, `types.rs`, `trait.rs`, `factory.rs`, `validation_cache.rs`, `settings.rs`, `commands.rs`.
- [x] 2.2 Register the module in `src-tauri/src/modules/mod.rs`.
- [x] 2.3 In `types.rs` define `ProviderId` (with `serde` snake-kebab serialisation), `Capabilities`, `ValidationResult`, `GenerateRequest`, `GenerateDelta`, `GenerateStream` type alias, `AiSettingsView`, `AiSettingsInput`.
- [x] 2.4 In `trait.rs` define the `AiProvider` trait (object-safe, `Send + Sync`).
- [x] 2.5 Verify deps in `Cargo.toml`: confirm `reqwest` (with `json` + `rustls-tls` features) and `tokio-stream` are available; add if missing. Confirm `futures` is available for `Stream` utilities; add if missing.

## 3. Provider implementations

- [x] 3.1 `src-tauri/src/modules/ai/claude_cli.rs` — spawn `claude -p <prompt>` via `tokio::process::Command`, set `current_dir`, stream stdout lines, propagate stderr on non-zero exit, kill on stream drop.
- [x] 3.2 `src-tauri/src/modules/ai/codex_cli.rs` — same pattern as `claude_cli`. Implementation MUST start with a spike: invoke `codex --help` locally to confirm non-interactive flag (likely `codex exec` or `-p`) and adjust the argument vector accordingly. Document the discovered invocation inline.
- [x] 3.3 `src-tauri/src/modules/ai/anthropic_api.rs` — `reqwest` POST to `https://api.anthropic.com/v1/messages`, headers `x-api-key` + `anthropic-version`, system prompt embeds `serde_json::to_string_pretty(&payload)`, response → first fenced SQL block → `Text` + `Done`.
- [x] 3.4 `src-tauri/src/modules/ai/openai_api.rs` — `reqwest` POST to `https://api.openai.com/v1/chat/completions`, header `Authorization: Bearer …`, system+user message structure, fenced-block extraction shared with Anthropic via a helper in `types.rs`.
- [x] 3.5 Capability constants per provider: `*_DEFAULT_MODEL`, `*_MODELS` static slices matching the design's Decision 8 list. Provide a single `Capabilities` value per impl.
- [x] 3.6 Validation: each provider's `validate()` runs within a 3-second `tokio::time::timeout`; CLI validation spawns `<cli> --version`, API validation issues a `max_tokens=1` probe.
- [x] 3.7 Unit tests with `tempfile` and fake HTTP servers (`mockito` or `wiremock`) covering: CLI presence/absence, CLI timeout, API 401, API 200 with fenced block, API 200 without fenced block, model validation rejects unknown.

## 4. Factory & validation cache

- [x] 4.1 `factory::build(id, &settings, &secrets)` returns `Box<dyn AiProvider>` reading the relevant API key from `secrets` and the configured model from `settings`.
- [x] 4.2 `ValidationCache` with `HashMap<ProviderId, (ValidationResult, Instant)>` and 60-second TTL; methods `peek`, `insert`, `invalidate`, `invalidate_all`.
- [x] 4.3 Wire cache into Tauri commands: `ai_list_providers` reads cache, falls back to fresh probe; `ai_validate_provider` always invalidates+re-probes; `ai_set_settings`/`ai_set_api_key`/`ai_delete_api_key` invalidate.

## 5. Tauri commands

- [x] 5.1 `ai_list_providers` — concurrent validation via `futures::future::join_all` with per-call 3s timeout, returns stable-ordered list of all four providers + capabilities + validation result.
- [x] 5.2 `ai_validate_provider(id)` — single-provider revalidation, bypasses cache, updates cache with the new result.
- [x] 5.3 `ai_get_settings` — returns current `AiSettingsView` including per-provider `key_present: bool` and the list of overrides.
- [x] 5.4 `ai_set_settings(input)` — validates `default_provider` is a known `ProviderId`, writes singleton + override rows in a transaction, emits `ai-settings-changed` event, invalidates cache.
- [x] 5.5 `ai_set_api_key(provider, key)` — rejects providers with `requires_api_key = false`, writes keyring entry, invalidates cache.
- [x] 5.6 `ai_delete_api_key(provider)` — idempotent keyring delete, invalidates cache.
- [x] 5.7 `ai_generate_sql(prompt, context_path, payload, connection_id, model)` — resolves provider via `AiSettings`, builds via factory, calls `generate_sql`, collects stream into a single string via helper `collect_stream`, returns it.
- [x] 5.8 Register all seven commands in `src-tauri/src/lib.rs` `invoke_handler!` block. Add `app.manage(ValidationCache::new())` and any other required state.

## 6. Frontend module scaffold

- [x] 6.1 Create `src/modules/ai/` with `api.ts`, `types.ts`, `store.tsx`, `components/`.
- [x] 6.2 `types.ts` — TypeScript mirrors of every Rust type touching the IPC boundary (`ProviderId` union, `Capabilities`, `ValidationResult` discriminated union, `AiSettingsView`, `AiSettingsInput`, `ProviderListEntry`).
- [x] 6.3 `api.ts` — one wrapper per Tauri command using the existing `invoke` helper pattern (see `src/modules/context/api.ts` for the canonical shape).
- [x] 6.4 `store.tsx` — `AiSettingsProvider` with cached `ai_list_providers` + settings; subscribes to `ai-settings-changed` Tauri event; revalidates on `document.visibilitychange` → visible.
- [x] 6.5 Mount `AiSettingsProvider` in `src/app/App.tsx` inside `ConnectionsProvider`, outside per-engine form providers (mirroring `ContextEventBusProvider` placement).

## 7. Generate SQL modal

- [x] 7.1 Create `src/modules/ai/components/GenerateModal.tsx` + CSS module. Props: `connectionId`, `contextPath`, `onInsert(sql)`, `onReplace(sql)`, `onClose()`.
- [x] 7.2 Implement modal states: `idle` (textarea + dropdowns + Generate), `generating` (spinner + Cancel), `success` (read-only SQL block + Insert/Replace/Cancel), `error` (message + Retry).
- [x] 7.3 Provider dropdown sources from store; lists only providers with `validation.kind === "Ready"`. Disabled-state hint when none are ready.
- [x] 7.4 Model dropdown sources from selected provider's `capabilities.available_models`; preselects configured model.
- [x] 7.5 On "Generate": call `contextApi.aiPayload(connectionId, false)`, then call `api.generateSql({ prompt, contextPath, payload, connectionId, model: changed ? selectedModel : undefined })`. Track an `AbortController`-like flag so Cancel discards a stale response.
- [x] 7.6 On "Insert": call `onInsert(sql)`; on "Replace": call `onReplace(sql)`; close on either.
- [x] 7.7 Unit tests (`@testing-library/react`) for: open focuses textarea; Generate disabled when empty; Cancel during generating returns to idle; Insert/Replace invoke callbacks with the SQL.

## 8. Wire modal into Postgres QueryEditor

- [x] 8.1 In `src/modules/postgres/sql/QueryTab.tsx`, add a "✨ Generate" button after the Save button. Render only when `useAiSettings().defaultProvider !== null OR per-connection override exists`.
- [x] 8.2 Manage modal open state locally; pass `connectionId`, `contextPath`, and editor `onInsert`/`onReplace` handlers (append-with-newline / set-buffer).
- [x] 8.3 Verify that existing `postgres.runSql` flow and activity-log emission are unchanged (regression test: clicking Run with AI configured still produces the identical event shape).
- [x] 8.4 Update existing tests around the toolbar if they rely on a fixed button count.

## 9. Settings panel

- [x] 9.1 Create `src/modules/ai/components/SettingsPanel.tsx` + CSS module.
- [x] 9.2 Layout: top section with default-provider radio group (one row per provider showing validation status + remediation hint), bottom section with per-provider sub-cards.
- [x] 9.3 Each per-provider sub-card: name + status, model dropdown (sourced from capabilities), API key input (password-masked, only for providers with `requires_api_key`) with Save/Clear buttons + `key present` indicator, install hint for CLI providers.
- [x] 9.4 Save key flow: input → `setApiKey(provider, value)` → input clears → store re-fetches `ai_list_providers` → status updates inline.
- [x] 9.5 Save settings flow: bottom Save button collects form state into `AiSettingsInput`, calls `setSettings`, closes modal. Save is disabled when form state == loaded state.
- [x] 9.6 Unit tests: panel opens with loaded settings preselected; saving a key clears the input; saving settings closes the modal; Cancel does not persist.

## 10. Command palette entry

- [x] 10.1 Add a new entry to the command-palette registry (location: existing `src/platform/command-palette/` — find the registry file via the existing `connection.add` entry for the pattern). Entry: `id: "ai.configureProviders"`, label `"AI: Configure providers"`, group `"AI"` (new group if needed).
- [x] 10.2 Wire the entry's action to open `SettingsPanel` as a modal at the app shell level. Use the same modal-host pattern as the existing `SyncReportModal` (see `src/app/App.tsx`).
- [x] 10.3 Verify the entry is keyboard-navigable and the modal is focus-trapped.

## 11. Integration verification

- [ ] 11.1 Manual smoke against a local Postgres with a linked context folder: configure `claude-cli`, click ✨, generate, insert, run — verify happy path end-to-end.
- [ ] 11.2 Manual smoke for `anthropic-api`: paste a real key, validate succeeds, generate succeeds.
- [ ] 11.3 Manual smoke for unconfigured state: fresh install, ✨ button hidden, palette entry present, configuring shows the button.
- [ ] 11.4 Manual smoke for missing CLI: rename `claude` binary, observe `Missing` status and remediation hint in the panel.
- [ ] 11.5 Manual smoke for revoked key: change Anthropic key to `"invalid"`, observe `Misconfigured` status.

## 12. Documentation

- [x] 12.1 Add an "AI providers" section to `README.md` covering: supported providers, how to install the CLIs (links), where to put API keys, the command palette entry, the ✨ button.
- [x] 12.2 Update `CLAUDE.md` with a short "AI providers (cross-engine)" paragraph mirroring the "Context folders (cross-engine)" paragraph, referencing the new section in README.
- [x] 12.3 If applicable, note in `DESIGN.md` any new modal styling decisions (the GenerateModal and SettingsPanel should reuse existing tokens; flag any deviation). No changes — both CSS modules reuse existing tokens only (`var(--surface)`, `var(--accent)`, `var(--border-strong)`, `var(--radius-*)`, etc.).

## 13. Defer / out-of-scope (explicit)

- [x] 13.1 Chat / multi-turn UI — not in v1.
- [x] 13.2 Streaming UI surface — backend produces a stream; v1 collects to string. Surface streaming when chat ships.
- [x] 13.3 "Explain with AI" on schema nodes — separate change.
- [x] 13.4 ✨ button in MySQL / MSSQL / Dynamo / CloudWatch editors — mechanical replication once the Postgres flow is proven. Document the replication pattern in a follow-up tasks section in this change's archive notes.
- [x] 13.5 Tool-use protocol for API providers (where the model can call back to Argus to query the DB) — separate change.
- [x] 13.6 Token / cost accounting — separate change.
- [x] 13.7 Local model support (Ollama et al.) — would be a new provider impl; not blocked by this change's architecture.
