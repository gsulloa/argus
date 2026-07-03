## Why

The list of AI models is hardcoded as compile-time arrays in `caps.rs` (`CLAUDE_CLI_MODELS`, `CODEX_CLI_MODELS`, `ANTHROPIC_API_MODELS`, `OPENAI_API_MODELS`), and the backend validates saved settings against them. Every time Anthropic or OpenAI publishes, renames, or retires a model, Argus must ship a new release — and until then the settings UI lags behind the provider, and a valid saved model can be wrongly treated as "retired" just because it is missing from our local array. This change makes model lists dynamic when a provider can be queried, while keeping the curated local arrays as a safe fallback.

## What Changes

- Query API providers for their live model list: **Anthropic** via `GET /v1/models` and **OpenAI** via `GET /v1/models`, using the API key already stored in the OS keychain.
- Add a TTL-backed in-memory model cache (mirroring the existing `ValidationCache` pattern) so provider APIs/CLIs are not hit on every render.
- Extend `ai_list_providers` so each provider entry reports the **effective** model list plus provenance: `model_source` (`provider` | `cache` | `fallback`), `model_last_refreshed_at`, and `model_refresh_error`.
- Add an `ai_refresh_models(provider)` command that force-refreshes one provider's model list, bypassing the cache, and invalidates the cached entry.
- Change settings validation on save to validate the chosen model against the **effective dynamic list** when one is available, and against the curated local fallback otherwise. A saved model that is absent from the effective list must not hard-fail the app — it falls back to the provider default with a clear reason, as today.
- CLI providers (Claude CLI, Codex CLI) continue to use the curated local list as fallback, since no stable non-interactive "list models" command exists today; discovery for them is left as a future spike behind the same provenance contract.
- Settings UI discreetly indicates whether the shown model list came from the provider, cache, or local fallback, and surfaces any refresh error.
- `context_window(model)` stays conservative for unknown model IDs but prefers remote metadata when the provider exposes it.

## Capabilities

### New Capabilities
- `ai-model-discovery`: Dynamic resolution of a provider's available models from the provider API/CLI, with TTL caching, provenance tracking (`provider`/`cache`/`fallback`), force-refresh, and graceful fallback to the curated local list on error, timeout, or missing credentials.

### Modified Capabilities
- `ai-providers`: `ai_list_providers` now returns the effective (possibly dynamic) model list and provenance metadata per provider; model validation in `generate_sql`/settings resolution validates against the effective list rather than only the static array.
- `ai-settings-panel`: the per-provider model dropdown is sourced from the effective dynamic list, shows a discreet source indicator (provider/cache/fallback) and refresh error, and offers a way to trigger a refresh.

## Impact

- **Rust backend** (`packages/app/src-tauri/src/modules/ai/`): `caps.rs` (curated arrays become fallback + provenance helpers), new `model_cache.rs` (TTL cache), `anthropic_api.rs` / `openai_api.rs` (add `list_models()` HTTP calls to `/v1/models`), `provider.rs` (trait gains model-listing method), `commands.rs` (new `ai_refresh_models`, extended `ai_list_providers`), `settings.rs` / `factory.rs` (`sanitize_model` consults effective list), `types.rs` (extend `Capabilities`/`ProviderListEntry` with provenance), `lib.rs` (register new command + cache state).
- **Frontend** (`packages/app/src/modules/ai/`): `types.ts` (mirror new provenance fields), `api.ts` (`refreshModels`), `components/SettingsPanel.tsx` (source indicator + refresh affordance), `store.tsx` (surface provenance).
- **Dependencies**: none new — reuses `reqwest` and the `keyring`-backed `keys.rs`.
- **Tests**: new/extended coverage for successful discovery, timeout/error, no credentials, stored-model-absent-from-dynamic-list, and settings validation against the effective list (Rust `wiremock` for HTTP).
