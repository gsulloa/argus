## Context

Argus's AI module keeps four curated model arrays as compile-time constants in `src-tauri/src/modules/ai/caps.rs` and validates saved settings against them at three checkpoints: `factory::configured_model` (via `sanitize_model`), `AiSettings::resolve` (via `sanitize_model`), and `ai_set_settings` (explicit array membership check). The frontend `SettingsPanel` populates its model dropdown from `capabilities.available_models`, which points at those same arrays. `ai_list_providers` already runs the four providers concurrently with a 3s timeout and a 60s TTL `ValidationCache` (`validation_cache.rs`) — an established pattern this change mirrors for models.

API providers already hold `reqwest::Client` instances and read keys from the OS keychain at request time (`keys::get(ACCOUNT_ANTHROPIC | ACCOUNT_OPENAI)`), and already POST to `api.anthropic.com` / `api.openai.com`. Adding a `GET /v1/models` call reuses all of this. CLIs have no stable non-interactive "list models" command, so they stay on the curated fallback.

## Goals / Non-Goals

**Goals:**
- Resolve API-provider model lists dynamically from `GET /v1/models`, cached with a TTL, with the curated arrays as an always-present fallback.
- Track and surface provenance (`provider` / `cache` / `fallback`), last-refresh time, and any refresh error, both in `ai_list_providers` and in the settings UI.
- Validate saved/requested models against the effective list, degrading gracefully (fall back to provider default) when a stored model disappears — never crash.
- Add `ai_refresh_models(provider)` for an explicit user-triggered refresh.

**Non-Goals:**
- CLI (Claude/Codex) dynamic discovery — no stable command exists; left as a future spike behind the same `ModelListing` contract.
- Free-text model entry (rejected in the issue for UX/runtime-error reasons).
- Removing the curated arrays or the local validation path.
- Persisting discovered lists to disk/sqlite — cache is in-memory only, session-scoped.

## Decisions

### Decision: Introduce `ModelListing` + `ModelSource`, resolved separately from `Capabilities`
`Capabilities` is a cheap synchronous `&'static` value used widely; making it async or heap-allocated would ripple through the codebase. Instead, add `async fn list_models(&self) -> ModelListing` to the `AiProvider` trait and attach the resolved `ModelListing` to `ProviderListEntry` (a `models` field). `Capabilities.available_models` stays as-is (curated fallback) for backward compatibility with existing consumers and tests.

`ModelListing { models: Vec<String>, source: ModelSource, refreshed_at: Option<i64>, error: Option<String> }`; `ModelSource` is a kebab-case serde enum `Provider | Cache | Fallback`.

*Alternative considered:* putting the dynamic list directly on `Capabilities`. Rejected — forces `capabilities()` to become async/allocating and breaks its `&'static` contract.

### Decision: `ModelCache` mirroring `ValidationCache`, TTL 5 min
Reuse the exact `Mutex<HashMap<ProviderId, (ModelListing, Instant)>>` pattern with `peek`/`insert`/`invalidate`/`invalidate_all`. TTL of 5 minutes (vs. validation's 60s) because model lists change far less often than credential validity, and each fetch is a full round-trip. When `peek` returns a live entry, `ai_list_providers` clones it and rewrites `source` to `Cache` (preserving `refreshed_at`/`error`) before returning. Registered as Tauri managed state in `lib.rs`, alongside `ValidationCache`.

*Alternative considered:* reuse `ValidationCache` for both. Rejected — different value type and TTL; separate struct is clearer.

### Decision: Discovery lives in each API provider, fallback is total
`AnthropicApi::list_models` → `GET /v1/models` (`x-api-key`, `anthropic-version: 2023-06-01`); `OpenAiApi::list_models` → `GET /v1/models` (`Authorization: Bearer`). Both wrap the call in a 3s `tokio::time::timeout`. Any failure path — missing key, timeout, non-2xx, parse error, network — returns the curated fallback with `source: Fallback` and a descriptive `error`. This guarantees the list is never empty and the app never hard-fails on discovery. Parsing extracts `data[].id` (OpenAI) / `data[].id` (Anthropic); OpenAI's list includes non-chat models, so filter conservatively (keep chat/gpt families) while always unioning-in the curated defaults so the provider default is present.

### Decision: Validation consults the effective list, `sanitize_model` gains a list parameter
The current `sanitize_model(provider_kebab, model)` checks static arrays only. Introduce an effective-list-aware check used by `ai_set_settings` and the `generate_sql`/chat model guard: when a dynamic list is available (cached/fresh), validate against it; otherwise fall back to the curated array (current behaviour). The `factory`/`resolve` paths that run synchronously and must not do network I/O keep using the curated-array `sanitize_model` for the "don't crash on retired model" guarantee, but the effective-list check is applied where a `ModelListing` is already in hand (command layer). A stored model absent from the effective list resolves to `None` (provider default) with a reason surfaced — matching today's graceful degradation.

*Alternative considered:* make `resolve()`/`factory` async and network-aware. Rejected — they run on hot, synchronous paths; keeping them curated-array-based avoids latency and preserves the offline guarantee, while the command layer does the richer check.

### Decision: `ai_refresh_models` invalidates then fetches
`ai_refresh_models(provider)` calls `ModelCache::invalidate(provider)`, then `provider.list_models()`, stores the result, and returns the `ModelListing`. It obeys the same fallback rules (no bypassing of the fallback). Frontend `api.ts` gets `refreshModels`, and `SettingsPanel` gets a per-provider refresh button plus a source indicator built from `models.source` / `refreshed_at` / `error`.

### Decision: `context_window` prefers remote metadata when available, else conservative
Keep the static mapping and the 100k conservative default for unknown IDs. If the discovery response exposes a per-model context window, that value may be preferred for that model. This is opportunistic — v1 may simply keep the conservative default for unlisted models since neither `/v1/models` response is guaranteed to include token limits.

## Risks / Trade-offs

- **[OpenAI `/v1/models` lists many non-chat models]** → Filter to chat-capable families and always union-in curated defaults so the dropdown stays usable and the default is present.
- **[Extra latency in `ai_list_providers` from model fetches]** → Bounded by the same 3s per-provider timeout, run concurrently with validation via `join_all`, and served from the 5-min `ModelCache` on the common path.
- **[Anthropic/OpenAI response schema drift]** → Parsing is defensive; any parse error routes to the curated fallback with an `error`, never a panic.
- **[Stored model silently vanishes from a provider]** → Effective-list validation resolves it to the provider default and surfaces a clear reason; the UI's source indicator explains the fallback.
- **[Dynamic list could let a user pick a model the chat endpoint later rejects]** → Acceptable; the existing per-request model guard and provider error handling still apply, and this is strictly better than a stale hardcoded list.

## Migration Plan

Additive and backward-compatible. New fields on `ProviderListEntry` (`models`) and the new `ai_refresh_models` command are new surface area; `capabilities.available_models` is retained so existing frontend/tests keep working during rollout. No sqlite migration (cache is in-memory). Rollback = revert the change; curated arrays remain the source of truth. Frontend can ship the source indicator/refresh incrementally since it degrades to the curated list when `models` is absent.

## Open Questions

- Do the current `/v1/models` responses for our accounts include context-window metadata? If not, keep the static `context_window` mapping for v1 and defer remote-window preference.
- Exact filtering rule for OpenAI's model list (which prefixes count as chat-capable) — confirm against a live response during implementation.
