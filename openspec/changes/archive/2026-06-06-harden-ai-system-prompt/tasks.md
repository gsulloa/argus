## 1. Prompt builders (types.rs)

- [x] 1.1 Remove `build_system_prompt`; add `build_api_system_prompt(payload: &AiPayload) -> AppResult<String>` that assembles output from an ordered `Vec<String>` of delimited sections — (1) role + SQL-only/no-execution restrictions, (2) serialized context payload — joined at the end. No filesystem/disk-read language. Add a clearly-marked comment reserving the trailing position for a future appended section (#62 attachments) and noting the intended `attachments` parameter extension
- [x] 1.2 Add `build_cli_system_prompt(context_path: &Path) -> String`: SQL-only, no-execution clause, names context folder (`manifest.json`, `overview.md`, `glossary.md`, `objects/`, `queries/`) as primary source and `../` as secondary
- [x] 1.3 Unit test `build_api_system_prompt`: asserts SQL-only clause, no-execution clause, absence of filesystem/disk-read language, AND that the role/restriction section appears before the context section (stable order, #62 seam)
- [x] 1.4 Unit test `build_cli_system_prompt`: asserts SQL-only clause, no-execution clause, context-folder reference, and parent-directory (`../`) clause

## 2. claude_cli.rs — argv builder + flags

- [x] 2.1 Extract a pure `build_claude_argv(prompt, model, resume_id, system_prompt, tools) -> Vec<String>` from the inline `Command` construction in `spawn_claude_stream_json`
- [x] 2.2 Have `spawn_claude_stream_json` build its `Command` from `build_claude_argv`, passing `--system-prompt <cli prompt>` and `--tools "Read Glob Grep"`
- [x] 2.3 Apply system prompt + tools on the `--resume` path AND the full-history-replay fallback path in `chat()`
- [x] 2.4 Update `generate_sql()` to use `build_cli_system_prompt(&cwd)` via `--system-prompt` + `--tools "Read Glob Grep"`; remove its `build_cli_prompt` call
- [x] 2.5 Remove `build_cli_prompt` and its `build_cli_prompt_contains_user_request` test
- [x] 2.6 Update the pinned-schema header comment with the verified claude CLI version/date for `--system-prompt` and `--tools`
- [x] 2.7 Constructed-argv test: assert `build_claude_argv` output contains `--system-prompt`, the SQL-only text, and `--tools` with the read-only set (covering both resume and non-resume inputs)

## 3. codex_cli.rs

- [x] 3.1 Drop the `build_cli_prompt` import; in `chat()` build the prompt as `format!("{system}\n\n{history}")` using `build_cli_system_prompt(&cwd)` + `flatten_history_for_cli(turns)`
- [x] 3.2 Update `generate_sql()` to prepend `build_cli_system_prompt(&cwd)` to the user prompt
- [x] 3.3 Verify codex tests still compile (flatten-history tests unaffected); add an assertion that the system prompt precedes history in the built prompt

## 4. API providers

- [x] 4.1 `anthropic_api.rs`: swap `build_system_prompt` → `build_api_system_prompt` on both `generate_sql` and `chat` paths; update import
- [x] 4.2 `openai_api.rs`: swap `build_system_prompt` → `build_api_system_prompt` on both paths; update import
- [x] 4.3 Confirm `system_chars = system_prompt.len()` stays measured over the builder's full output (no per-section estimate); leave `estimate_tokens` / `trim_turns_to_fit` otherwise untouched (#62 token-budget seam)

## 4b. Coordination seams (#62) — keep additive

- [x] 4b.1 Do NOT modify `ChatRequest` (types.rs:105) and do NOT alter the structure of `flatten_history_for_cli` / per-turn content construction — both are #62 insertion points; keep all edits additive
- [x] 4b.2 Add a code comment at the last-user-turn content construction marking it as #62's result-table prefix insertion point

## 5. Verify

- [x] 5.1 `cargo build` and `cargo test -p <crate> modules::ai` pass
- [x] 5.2 Manual smoke: one chat turn per provider returns a fenced ` ```sql ` block; confirm claude cannot run `psql` (Bash unavailable) when prompted to execute
