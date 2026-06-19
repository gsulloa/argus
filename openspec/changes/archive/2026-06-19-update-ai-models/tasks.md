## 1. Update model constants (caps.rs)

- [x] 1.1 Set `CLAUDE_CLI_DEFAULT_MODEL` to `"claude-opus-4-8"` and `CLAUDE_CLI_MODELS` to `["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]`
- [x] 1.2 Set `ANTHROPIC_API_DEFAULT_MODEL` to `"claude-opus-4-8"` and `ANTHROPIC_API_MODELS` to `["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]`
- [x] 1.3 Set `CODEX_CLI_DEFAULT_MODEL` to `"gpt-5.1"` and `CODEX_CLI_MODELS` to `["gpt-5.1", "gpt-5.1-codex"]`
- [x] 1.4 Set `OPENAI_API_DEFAULT_MODEL` to `"gpt-5.1"` and `OPENAI_API_MODELS` to `["gpt-5.1", "gpt-5.1-mini", "gpt-4o"]`
- [x] 1.5 Update `context_window` (real fn name): `claude-opus-4-8` and all `gpt-5.1*` ids → 200000, `gpt-4o` → 128000; remove arms for retired ids (`claude-opus-4-7`, `gpt-4o-mini`, `gpt-4-turbo`, `o3-mini`)

## 2. Persisted model fallback at resolution

- [x] 2.1 Added `caps::sanitize_model`; `factory::configured_model` (the real global-model funnel) now returns `None` (→ default) when the stored model id is not in the provider's `available_models`
- [x] 2.2 Applied the same sanitisation in `settings.rs::resolve()` for both the per-connection override branch and the default-provider branch
- [x] 2.3 Confirmed `generate_sql` still rejects a `model: Some(s)` not in `available_models` (guard left intact)

## 3. Tests — Rust

- [x] 3.1 Added unit tests asserting each provider's `default_model` + `available_models` match the new lists and `available_models.contains(default_model)`
- [x] 3.2 Added tests for `context_window` on the new ids (200000 / 128000) and the unknown-id default
- [x] 3.3 Added resolution tests: retired global model (`gpt-4o-mini`) and retired override (`claude-opus-4-7`) resolve to `None` (provider then applies its default); still-valid model preserved
- [x] 3.4 Updated existing tests referencing retired ids in `settings.rs`, `codex_cli.rs` to current ids; kept intentionally-invalid ids in `openai_api.rs` / `codex_cli.rs` rejection tests

## 4. Frontend

- [x] 4.1 `SettingsPanel.tsx` model dropdown now preselects `default_model` when the configured model is not in `available_models` and never renders a selected entry absent from the list
- [x] 4.2 Updated mocks in `SettingsPanel.test.tsx` and `ChatPanel.test.tsx` to the new model ids; added a test for the retired-model → default fallback in the dropdown

## 5. Verify

- [x] 5.1 `cargo test modules::ai` (149 pass; 1 pre-existing keychain-pollution flake that passes in isolation) and `npx vitest run src/modules/ai` (82 pass) — all green
- [x] 5.2 Built the app, opened **AI: Configure providers**, and confirmed each provider lists the new models with the correct default selected (manual GUI check — verified by user)
