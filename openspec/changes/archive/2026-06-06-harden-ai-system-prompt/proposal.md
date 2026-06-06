## Why

The AI agent is too loosely briefed. CLI providers (`claude_cli`, `codex_cli`) run `chat()` with **no system-level guardrails** — the agent only learns its job from whatever the user typed — and the API providers' one-line system prompt never forbids the agent from running queries or wandering off-task. In practice the agent (1) executes SQL itself via shell tools instead of returning it for Argus to run, (2) ignores the on-disk context folder because nothing names it as authoritative, and (3) never looks at parent-directory cross-connection docs. We want a single tight system prompt applied to **every turn, on every provider**, plus a hard tool-level guarantee on `claude` that it cannot run a database CLI even if it tries.

## What Changes

- **Two distinct system-prompt builders** replace the current pair of loose prompts:
  - `build_api_system_prompt(payload)` — strict, SQL-only, no filesystem language (API providers receive the context as a serialized payload, not files on disk). Assembled as **ordered, delimited sections** — (1) role + hard SQL-only restrictions, (2) context payload (the serialized context folder) — with a documented extension point reserving the **last** section for future appended content (see Coordination with #62).
  - `build_cli_system_prompt(context_path)` — SQL-only, no-execution, points the agent at the context folder (`cwd`) as the primary source and `../` as the secondary source for cross-connection docs.
- **CLI `chat()` gets a system prompt on every turn** — today it has none. Applied on both the `--resume` and full-history-replay paths for claude, and on every turn for codex.
- **claude is restricted to read-only tools** via `--tools "Read Glob Grep"` — it can read the context folder but literally cannot spawn Bash/`psql`/`mysql`/`sqlcmd`. Defense-in-depth alongside the prompt.
- **claude uses `--system-prompt` (full replace), not `--append`** — the agent runs on our tight SQL-only prompt instead of claude's default coding-agent prompt. **BREAKING** relative to issue #59's wording, which specified `--append-system-prompt`; chosen deliberately for a cleaner, more controllable agent.
- **`build_cli_prompt` is removed** — `generate_sql` and `chat` both adopt the new builders; codex prepends the system prompt to its flattened history (`"{system}\n\n{history}"`).
- **API providers swap** `build_system_prompt` → `build_api_system_prompt` on both `generate_sql` and `chat` paths. No other API changes.
- **A pure `build_claude_argv(...)` helper** is extracted from the inline `Command` construction so the constructed argv (system prompt + tool restriction flags) is unit-testable.
- **No change to `ChatRequest`** and **no structural change to `flatten_history_for_cli`** — both are seams another change (#62) builds on; see Coordination.

## Coordination with change #62 (`attach query results to chat`)

#62 lands *on top of* this change (this is the base; #62 rebases). To keep the merge trivial, this change guarantees the following seams:

1. **Section-ordered API prompt.** `build_api_system_prompt` emits stable, delimited sections in a fixed order, and reserves the **final** section for appended content. #62 will add an `attachments: &[AttachedResult]` parameter (its own type) and render attached query results as the last section — never before the context. Assembly is structured so adding that parameter is a localized edit, not a rewrite.
2. **Token budget over the final string.** `system_chars` is measured as `system_prompt.len()` of the builder's *complete* output. #62's attachments, once composed into that output, are counted automatically — neither feature estimates its slice separately.
3. **CLI insertion point preserved.** `flatten_history_for_cli` keeps its current structure and per-turn content construction; the last user turn's content remains the documented insertion point where #62 prepends a markdown result table.
4. **Behavioral invariant reinforced, not broken.** This change makes the agent *strictly* SQL-emitting (claude tool-restricted to read-only). It introduces no path where the agent executes SQL — which is exactly the invariant #62's data model depends on.

**Answer to #62's open question** (does the context folder replace or complement `AiPayload`?): For **API** providers the context folder *is* the payload — `AiPayload { manifest, overview, glossary, objects, queries }` is the serialized folder; there is no separate "schema payload," so the API prompt has a single context section, not two. For **CLI** providers the folder lives on disk and the prompt points at it (the payload is not embedded). The folder and payload are the same information over two transports — complement, not replace.

## Capabilities

### New Capabilities
- `ai-agent-guardrails`: The system-prompt contract and tool-access restrictions that pin the AI agent to emitting SQL only, never executing it, and treating the context folder (and its parent) as the authoritative information source — uniformly across all four providers.

### Modified Capabilities
<!-- No archived AI spec exists yet (add-ai-providers / add-ai-chat-panel are still in-flight),
     so there is no published requirement to modify. This change introduces a fresh capability. -->

## Impact

- **Code**: `src-tauri/src/modules/ai/types.rs` (prompt builders), `claude_cli.rs` (argv builder, `--system-prompt`, `--tools`, both chat paths + generate_sql), `codex_cli.rs` (prepend system prompt, drop `build_cli_prompt` dep), `anthropic_api.rs` + `openai_api.rs` (builder rename).
- **Behavior**: The agent can no longer execute SQL from the claude CLI (tool-enforced); all providers now consistently emit fenced ` ```sql ` blocks for Argus to run.
- **Sequencing**: Depends on `--append`/`--system-prompt` + `--tools` flags pinned against claude CLI `2.1.152` (verified). Should land **after** `add-ai-providers` and `add-ai-chat-panel` archive (both in-flight) to avoid merge churn in the same files.
- **No** migration, settings, UI, or DESIGN.md changes. Per-connection prompt customization and an API tool-use protocol remain out of scope.
