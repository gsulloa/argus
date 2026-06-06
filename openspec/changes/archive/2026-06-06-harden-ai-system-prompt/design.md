## Context

The AI module (`src-tauri/src/modules/ai/`) hosts four providers behind the `AiProvider` trait, each implementing `generate_sql` and `chat`. Prompt construction is inconsistent today:

| | `generate_sql()` | `chat()` |
|---|---|---|
| `claude_cli` | `build_cli_prompt(prompt)` | flatten history / latest prompt — **no system prompt** |
| `codex_cli` | `build_cli_prompt(prompt)` | `flatten_history_for_cli(turns)` — **no system prompt** |
| `anthropic_api` | `build_system_prompt(payload)` | `build_system_prompt(payload)` |
| `openai_api` | `build_system_prompt(payload)` | `build_system_prompt(payload)` |

Two asymmetries cause the observed failures: CLI `chat()` ships with no guardrails at all, and even where a prompt exists it neither forbids self-execution nor names the context folder as authoritative.

Verified facts (claude CLI `2.1.152`):
- `--system-prompt <prompt>` replaces the session system prompt; `--append-system-prompt <prompt>` appends to the default.
- `--tools <list>` restricts the built-in tool set (`--tools "Read Glob Grep"` yields read-only filesystem access, no Bash).
- codex `exec` has **no** system-prompt flag; it takes a single positional `PROMPT`. Its `-s read-only` sandbox blocks filesystem writes but not network, so it cannot fully prevent a `psql` connection — the prompt remains load-bearing for codex.

Two in-flight changes (`add-ai-providers`, `add-ai-chat-panel`) still touch these same files and are not yet archived.

## Goals / Non-Goals

**Goals:**
- One tight, SQL-only, no-execution system prompt on every turn of every provider.
- Hard tool-level guarantee on claude that it cannot run a database CLI (read-only tools only).
- CLI prompt names the context folder (primary) and `../` (secondary) as information sources; API prompt uses the embedded payload and avoids filesystem language.
- Constructed-argv unit-testability for the claude spawn.

**Non-Goals:**
- Per-connection prompt customization / settings UI.
- An API tool-use protocol (separate change).
- Runtime checks that `../` exists or is readable (passive instruction is enough).
- Sandboxing codex's network access (out of our control; prompt-enforced).

## Decisions

### Decision 1: Two builders, not one
Split into `build_api_system_prompt(payload) -> AppResult<String>` and `build_cli_system_prompt(context_path: &Path) -> String`, both in `types.rs`. **Why:** API providers receive the schema as a serialized JSON payload embedded in the prompt and have no disk access to the context folder; telling them to "read `objects/`" is nonsense. CLI providers run with `cwd` set to the context folder and *should* read it. The two audiences need different wording, so one builder cannot serve both honestly. `build_system_prompt` and `build_cli_prompt` are removed. *Alternative considered:* one builder with a `mode` flag — rejected as it muddies both prompts and invites the filesystem-language leak we're trying to prevent.

### Decision 2: claude uses `--system-prompt` (replace) + `--tools "Read Glob Grep"`
Replace claude's default agent prompt entirely with our tight prompt, and restrict tools to read-only. **Why:** claude's default prompt is oriented toward editing files and running commands — exactly the agentic behavior we're suppressing. Replacing gives a cleaner, more controllable agent; restricting tools makes "do not execute SQL" enforceable rather than merely requested (defense-in-depth). Read/Glob/Grep still let the agent read the context folder.

**Tooling caveat discovered during implementation:** `--tools` restricts only built-in tools — it does **not** disable MCP servers. With a globally-configured DB MCP server, the agent could still execute SQL despite `--tools`. We therefore also pass `--strict-mcp-config` (with no `--mcp-config`), which loads zero MCP servers (`"mcp_servers":[]` confirmed in the CLI `init` event). Separately, `--tools` is **variadic** (`--tools <tools...>`), so the positional prompt must be guarded with a `--` option terminator or the flag swallows it (claude then errors `Input must be provided …`). Both `--strict-mcp-config` and the `--` terminator are part of the constructed argv on every claude spawn path. *Alternatives considered:* `--append-system-prompt` (issue #59's original wording) keeps the default coding-agent scaffolding and only layers a "please don't" on top — weaker; rejected per explicit user decision. Tool restriction without prompt replacement — leaves the misleading default prompt in place; rejected.

### Decision 3: codex prepends the system prompt to flattened history
codex `exec` has no system-prompt flag, so build the positional prompt as `format!("{system}\n\n{history}")` using `build_cli_system_prompt(context_path)` + `flatten_history_for_cli(turns)`. **Why:** only injection point available. *Alternative:* `-s read-only` sandbox — kept as a possible future hardening but insufficient alone (doesn't block network SQL), so not relied upon here.

### Decision 4: Extract `build_claude_argv(...) -> Vec<String>`
Pull the inline `Command` argument construction in `spawn_claude_stream_json` (and the `generate_sql` spawn) into a pure function returning the argv vector, then have the spawn code feed it into `Command`. **Why:** the issue wants a test asserting `--system-prompt` and `--tools` reach `claude`, but the current code builds `Command` inline with no testable surface. A pure argv builder makes the flags assertable without spawning a real binary (the existing tests deliberately avoid faking a `claude` on PATH). *Alternative:* integration test with a fake binary — rejected as racy in the parallel test runner, consistent with the existing test comments.

### Decision 5: Section-assembled API prompt with a reserved trailing seam (coordination with #62)

`build_api_system_prompt` assembles its output from an ordered `Vec<String>` of delimited sections joined at the end, rather than one monolithic `format!`. The fixed order is:

```
┌─ 1. Role + hard restrictions (SQL-only, no execution)   ← #59
├─ 2. Context payload  (serialized AiPayload = the context folder)
└─ [reserved] last section — appended content             ← #62 (attached query results)
```

**Why:** #62 ("attach executed query results to chat") needs to append a section that must always sit *last* — closest to the user's current question, first to be truncated, and never ahead of the context the agent reasons over. A monolithic format string would force #62 to rewrite the builder; ordered sections + a documented trailing seam make its change a localized edit. #62 will extend the signature to `build_api_system_prompt(payload, attachments: &[AttachedResult])` (its type) and push the attachments section before the final join.

**On the context folder vs. `AiPayload` question (#62 asked):** `AiPayload` is `{ manifest, overview, glossary, objects, queries }` — i.e. the *serialized context folder itself*. For API providers (no disk access) the payload is the only transport for folder content, so the API prompt has **one** context section, not a separate "docs" and "schema" pair. For CLI providers the agent reads the folder from disk and the payload is not embedded. Folder and payload are the same information over two transports — they complement, they don't replace. So section 3 in #62's sketch (separate "schema payload") collapses into section 2 for the API path.

**Token budget seam:** `system_chars` is `system_prompt.len()` of the builder's complete output (already true today). Because #62's attachments are composed *inside* the builder's returned string, they are counted automatically — no per-feature estimate is added. This change does not touch `estimate_tokens` / `trim_turns_to_fit` beyond the builder rename.

**CLI seam:** `flatten_history_for_cli` keeps its structure and per-turn content construction unchanged. claude receives the system prompt via the `--system-prompt` flag (history flatten untouched); codex prepends `"{system}\n\n{history}"`. The last user turn's content remains the documented spot where #62 prepends a markdown result table.

**Merge order:** #59 first (base; the issue says so), #62 rebases on top. The seams above are the contract.

### Decision 6: Apply on both claude paths
Thread the system prompt and `--tools` flags through `spawn_claude_stream_json` so both the `--resume` branch and the full-history-replay branch carry them. Passing `--system-prompt` again on resume is idempotent and harmless. **Why:** the resume branch is the common case in multi-turn chat; omitting it there would reintroduce the unguarded agent.

## Risks / Trade-offs

- **[Replacing claude's system prompt loses built-in tool conventions]** → We only enable Read/Glob/Grep, whose usage is simple and injected separately from the system prompt; our prompt doesn't need to teach tool mechanics. Low risk.
- **[codex cannot be tool-restricted the way claude can]** → Accept prompt-only enforcement for codex; document that `-s read-only` is a future hardening. The SQL-only clause is still present, matching the issue's stated floor.
- **[Tool restriction may surface extra Read/Glob tool-call events in the chat panel]** → Acceptable, arguably useful (shows the agent consulting context). No code change needed; panel already renders tool events.
- **[Merge churn with the two in-flight AI changes]** → Sequence this change to land after `add-ai-providers` and `add-ai-chat-panel` archive; if picked up while chat-panel is still open, fold the edits onto that branch.
- **[Flag drift if the claude CLI schema changes]** → Flags verified against `2.1.152`; the `claude_cli.rs` header already documents a pinned-schema convention — update it with the verified date.
- **[Seam drift with #62]** → If the API prompt stops being section-ordered or the trailing slot is consumed, #62's attachments would land ahead of context. Mitigation: the stable-section-order requirement is specced and unit-tested (role-before-context, attachments-last reserved), so a regression is caught before #62 rebases. Keep `ChatRequest` and `flatten_history_for_cli` additive-only.

## Migration Plan

No data migration. Pure prompt/argv behavior change. Rollback is reverting the diff; no persisted state is affected. Manual smoke test: run a chat turn on each provider, confirm the agent returns a fenced SQL block and (for claude) that attempting to make it run `psql` fails because Bash is unavailable.

## Open Questions

- None blocking. Future: whether codex should additionally pass `-s read-only`, and whether the API providers should eventually gain a tool-use protocol (tracked separately).
