## 1. Types & data model (Rust)

- [x] 1.1 In `modules/ai/types.rs`, add `ModelSource` enum (`Provider`/`Cache`/`Fallback`, `#[serde(rename_all = "kebab-case")]`) and `ModelListing { models: Vec<String>, source: ModelSource, refreshed_at: Option<i64>, error: Option<String> }` with serde derives + unit tests for JSON round-trip.
- [x] 1.2 Add a `models: ModelListing` field to `ProviderListEntry`; keep `capabilities.available_models` unchanged (curated fallback).

## 2. Provider trait & discovery (Rust)

- [x] 2.1 In `modules/ai/provider.rs`, add `async fn list_models(&self) -> ModelListing` to the `AiProvider` trait.
- [x] 2.2 Implement `list_models` for `ClaudeCli` and `CodexCli` returning the curated array with `source: Fallback`, `error: None`.
- [x] 2.3 Implement `AnthropicApi::list_models` — `GET https://api.anthropic.com/v1/models` (`x-api-key`, `anthropic-version: 2023-06-01`) with 3s timeout; parse `data[].id`, union-in curated defaults; on any failure (no key/timeout/non-2xx/parse/network) return curated fallback with `source: Fallback` + descriptive `error`.
- [x] 2.4 Implement `OpenAiApi::list_models` — `GET https://api.openai.com/v1/models` (`Authorization: Bearer`) with 3s timeout; parse `data[].id`, filter to chat-capable families, union-in curated defaults; same fallback rules as 2.3.
- [x] 2.5 Add curated-fallback accessors in `caps.rs` (reuse `available_models_for`) so providers build fallback listings from the existing arrays.

## 3. Model cache (Rust)

- [x] 3.1 Add `modules/ai/model_cache.rs` — `ModelCache` (Mutex<HashMap<ProviderId,(ModelListing,Instant)>>) with `peek`/`insert`/`invalidate`/`invalidate_all`, TTL 5 min, mirroring `validation_cache.rs`.
- [x] 3.2 Register `ModelCache` as Tauri managed state in `lib.rs` (alongside `ValidationCache`).

## 4. Commands (Rust)

- [x] 4.1 Extend `ai_list_providers` (`commands.rs`) to resolve each provider's `ModelListing`: serve from `ModelCache` (rewriting `source` to `Cache`) when unexpired, else call `list_models()` with the same concurrent/timeout pattern as validation, then cache; attach to `ProviderListEntry.models`.
- [x] 4.2 Add `ai_refresh_models(provider: ProviderId) -> ModelListing` command: invalidate the cache entry, fetch fresh, store, return; register in `lib.rs` invoke handler.
- [x] 4.3 Invalidate the affected `ModelCache` entry on `ai_set_settings`, `ai_set_api_key`, and `ai_delete_api_key`.

## 5. Effective-list validation (Rust)

- [x] 5.1 Add an effective-list-aware model check (e.g. `sanitize_model_against(list, model)` / validation helper) and use it in `ai_set_settings` to validate against the dynamic list when available, else the curated array.
- [x] 5.2 Update the `generate_sql`/chat per-request model guard to validate `model` against the effective list, returning `AppError::Validation("unsupported model: …")` before any HTTP/spawn.
- [x] 5.3 Confirm `factory::configured_model` and `AiSettings::resolve` keep the synchronous curated-array `sanitize_model` (no network on hot path) so retired stored models resolve to `None` with the provider default; surface a clear reason.
- [x] 5.4 Keep `context_window` conservative (100k) for unknown IDs; optionally prefer remote metadata when discovery exposes a window.

## 6. Frontend

- [x] 6.1 In `src/modules/ai/types.ts`, add `ModelSource`, `ModelListing`, and the `models` field on `ProviderListEntry`.
- [x] 6.2 In `src/modules/ai/api.ts`, add `refreshModels(id)` calling `ai_refresh_models`.
- [x] 6.3 In `SettingsPanel.tsx`, source the model dropdown from `entry.models.models` (fallback to `capabilities.available_models` if absent); preselect configured model when present else `default_model`; never render an option absent from the effective list.
- [x] 6.4 Add a discreet source indicator (provider + relative "last refreshed" from `refreshed_at` / cache / local fallback) and surface `models.error` discreetly (tooltip/subtext).
- [x] 6.5 Add a per-provider refresh affordance that calls `refreshModels` and updates the dropdown + indicator; ensure `store.tsx` surfaces provenance and refreshes appropriately.

## 7. Tests

- [x] 7.1 Rust: `AnthropicApi`/`OpenAiApi` `list_models` with `wiremock` — successful discovery (`source: Provider`, timestamp), non-2xx/401 (fallback + error), missing key (no request, fallback), timeout (fallback + error).
- [x] 7.2 Rust: `ModelCache` — cached served without refetch (`source: Cache`, preserved `refreshed_at`), expiry triggers refetch, invalidate paths.
- [x] 7.3 Rust: effective-list validation — model present in dynamic list accepted; stored model absent from dynamic + fallback resolves to default with reason; validation uses fallback when discovery unavailable.
- [x] 7.4 Rust: `ai_refresh_models` invalidates then fetches; `ai_list_providers` entry carries `models` + `source`.
- [x] 7.5 Frontend: dropdown sourced from effective list, source indicator states (provider/cache/fallback + error), refresh button triggers `ai_refresh_models` and updates UI.

## 8. Verification

- [x] 8.1 Run `cargo test` (ai module) and frontend tests; run `cargo clippy`/lints.
- [ ] 8.2 Manual QA against real Anthropic + OpenAI keys: dropdown shows live models with "from provider" indicator; remove key → fallback with error; refresh button works. Flag any `DESIGN.md` deviations in the indicator UI.
