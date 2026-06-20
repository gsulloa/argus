## Why

The CloudWatch Logs Insights editor (`.cwlogs`) is the only query editor in Argus with no AI assistance — Postgres, MySQL, MSSQL, and Athena all ship a docked AI chat panel. Logs Insights' pipe syntax is unfamiliar to most users, so AI help would meaningfully lower the barrier. The runtime plumbing already exists (`EngineKind::Cloudwatch`, a context-engine–aware `ai_chat_send`, language-agnostic fenced-block extraction), but two assumptions in today's AI stack block a clean reuse: the SQL-generation prompt is hard-coded to emit **SQL**, and readiness requires a **context folder**. CloudWatch needs Logs Insights output and must work folder-free.

## What Changes

- Add a docked, resizable AI chat panel + ✨ toggle (with a readiness status dot) to the CloudWatch Logs Insights editor, matching the Athena/Postgres integration (panel open/width persistence, splitter drag, command-palette focus, attachable executed result).
- Make AI query generation **engine-aware**: for CloudWatch connections the providers are instructed to produce CloudWatch Logs Insights pipe syntax in a `cwlogs` block instead of SQL. SQL engines are unchanged.
- Make AI readiness **context-folder-optional**: a CloudWatch connection is "ready" once an AI provider is configured — no linked context folder required. All four providers (Claude Code, Codex CLI, Anthropic API, OpenAI API) must work folder-free.
- Teach the shared chat panel to **apply/insert non-SQL generated blocks** (`cwlogs`) into the editor, and to present the setup checklist correctly when the context folder is optional.
- Give the Logs Insights editor a **write capability** (`getSql`/`getCursor`/`setCursor`/`replaceBody`) so generated queries can be applied/inserted — the editor is read-only today.

## Capabilities

### New Capabilities
- `cloudwatch-insights-ai-chat`: AI chat panel integration for the CloudWatch Logs Insights editor — ✨ toggle + readiness dot, docked resizable panel with persisted state, context-folder-optional readiness bound to the tab's connection, attachable executed result, and apply/insert of generated Logs Insights queries.

### Modified Capabilities
- `ai-agent-guardrails`: the system-prompt language mandate becomes engine-aware so CloudWatch connections are instructed to emit CloudWatch Logs Insights syntax in a `cwlogs` block; SQL-family engines retain the existing SQL mandate.
- `ai-setup-readiness`: readiness may be satisfied by a configured provider alone for engines that do not require a context folder (CloudWatch); such connections never enter the `needs-context` state, and the degraded-no-context prohibition is lifted for them.
- `ai-chat-panel`: the panel applies/inserts generated `cwlogs` blocks (not only SQL), and its setup checklist reflects an optional context folder rather than requiring one.

## Impact

- **Frontend** — `modules/cloudwatch/insights/QueryTab.tsx`, `modules/cloudwatch/insights/Toolbar.tsx`, `modules/cloudwatch/insights/QueryEditor.tsx` (new editor handle methods), `modules/ai/useAiReadiness.ts` (context-optional derivation), `modules/ai/components/ChatPanel.tsx` (apply-language + setup checklist).
- **Backend (Rust)** — `modules/ai/types.rs` (`build_api_system_prompt`, `build_cli_system_prompt` become engine-aware; `ai-agent-guardrails` tests), and the four provider call sites threading `context_engine` into prompt construction (`anthropic_api.rs`, `openai_api.rs`, `claude_cli.rs`, `codex_cli.rs`). `extract_fenced_block` and the folder-free CLI path are unchanged.
- **No schema/DB changes, no new dependencies.** `context_engine` is already resolved from the connection row by `ai_chat_send`.
