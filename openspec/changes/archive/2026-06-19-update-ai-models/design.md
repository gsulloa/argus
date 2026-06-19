## Context

All advertised AI models live as four pairs of constants
(`*_DEFAULT_MODEL` + `*_MODELS`) at the top of
`src-tauri/src/modules/ai/caps.rs`, plus a `context_window_for(model)` match in
the same file. Both the Rust providers (via `Capabilities`) and the React
`SettingsPanel` (via `ai_list_providers`) read from this single source of truth,
so updating the lists is mostly a one-file edit.

The complication is persistence. `ai_settings` stores a per-provider model id
(e.g. `openai_api_model = "gpt-4o-mini"`), and `ai_connection_overrides` can store
a per-connection model. The `generate_sql` contract (ai-providers spec) rejects
any `model: Some(s)` that is not in `available_models` with
`AppError::Validation { "unsupported model: …" }`. Today the resolved model is
fed straight from settings into the provider, so removing `gpt-4o-mini`,
`gpt-4-turbo`, `o3-mini`, and `claude-opus-4-7` from the lists would turn every
existing install that selected one of them into a hard generation failure.

## Goals / Non-Goals

**Goals:**
- Advertise the current supported model set for each provider, with correct
  defaults and context windows.
- Never break an existing install: a persisted model id that is no longer offered
  must degrade gracefully to the provider default.
- Keep the `generate_sql` guard against genuinely bogus model ids intact.

**Non-Goals:**
- No database schema migration and no rewrite of stored rows.
- No new provider, no dynamic/remote model discovery (lists stay compile-time
  constants).
- No change to API-key storage, validation, or the chat/streaming pipeline.

## Decisions

### Decision 1: Sanitise the persisted model at resolution time, not in `generate_sql`

When resolving the model for a provider (`settings.rs::configured_model` and the
override path in `resolve()`), if the stored model id is `Some(s)` but `s` is not
in that provider's `available_models`, treat it as `None` (use `default_model`).

- **Why**: The resolution layer is the single funnel through which every persisted
  model passes before reaching a provider. Sanitising here fixes both the global
  default and per-connection overrides in one place, and leaves the
  `generate_sql` validation as a genuine guard for programmatic/bogus input
  (`gpt-9000`), preserving its existing scenario.
- **Alternative considered**: Relax `generate_sql` to silently fall back. Rejected
  — it weakens a deliberate contract and would hide real callers passing bad ids.
- **Alternative considered**: A data migration rewriting retired ids to the new
  default. Rejected — heavier, irreversible, and still leaves the door open to
  future drift; the resolution-time fallback is self-healing on every read.

### Decision 2: Keep models as compile-time constants

Continue listing models as `&'static [&'static str]` in `caps.rs` rather than
fetching them from the providers at runtime.

- **Why**: v1 simplicity; the UI and the `available_models.contains(default_model)`
  invariant stay trivially testable. Runtime discovery is a larger, separate
  effort.

### Decision 3: Context-window map gains the new ids, drops nothing

Add `claude-opus-4-8`, `gpt-5.1`, `gpt-5.1-mini`, `gpt-5.1-codex` to the
`context_window_for` match (Claude family and `gpt-5.1` family → 200k; `gpt-4o`
stays 128k). Retired ids may remain in the match harmlessly, but unreferenced arms
should be cleaned up to avoid dead constants.

## Risks / Trade-offs

- **Retired-id rows silently switch to the default model** → A user who had picked
  `gpt-4o-mini` now generates with `gpt-5.1` without an explicit prompt. Mitigation:
  the settings dropdown reflects the effective default on next open, so the change
  is visible; acceptable for a model-list refresh.
- **Model ids must exactly match what each CLI/API accepts** → A typo'd id passes
  the `contains(default_model)` test but fails at the provider. Mitigation: the ids
  in this change were confirmed with the user; provider `validate()` and a real
  generation will surface any mismatch immediately.
- **Context-window default fallback (100k) if an id is missed** → conservative and
  non-breaking; only affects payload sizing heuristics.

## Migration Plan

1. Edit `caps.rs` constants + `context_window_for`.
2. Add the resolution-time sanitisation in `settings.rs`.
3. Update Rust/TS tests and mocks referencing retired ids.
4. No DB migration; deploy is a normal app release. Rollback = revert the commit
   (stored rows are untouched and remain valid against the old lists).
