# Argus

A Tauri 2 desktop app for inspecting and editing data across multiple sources.

## Supported Sources

- **PostgreSQL** — Full feature set: connection management, schema browser, virtualized data grid with inline editing, SQL editor, table structure viewer.
- **MySQL / MariaDB** — MySQL ≥ 5.7, MariaDB ≥ 10.5. Supports schema browsing, virtualized data grid with inline editing, SQL editor with multi-statement runs, table structure viewer.
- **Microsoft SQL Server** — SQL Server 2017+, Azure SQL Database, Azure SQL Managed Instance. Supports schema browsing, virtualized data grid with inline editing, SQL editor with `GO` batch support, table structure viewer. SQL Authentication only in v1.
- **DynamoDB** — Table browsing and item scanning.
- **Amazon CloudWatch Logs** — Log group / stream browsing and querying.

## Context folders (cross-engine)

Each connection can optionally link to a **context folder** on disk holding
structured documentation (object docs with `system:` / `human:` frontmatter)
and prefab queries. Folders are engine-segregated under a neutral root and
shareable across connections (one filesystem watcher per canonical path).
Full layout, format, and behaviour: see `README.md` "Context folders" and
`docs/context-folder-example/`. Schema-sync ships for Postgres, MySQL, MSSQL,
and DynamoDB (`introspect_adapters.rs`); CloudWatch is on the roadmap.

## AI providers (cross-engine)

Four providers are supported: **Claude Code** and **OpenAI Codex CLI** (local process, reads context folder from disk) and **Anthropic API** and **OpenAI API** (HTTP, context serialised as payload). API keys live in the OS keychain under service `argus`, accounts `ai:anthropic` and `ai:openai`; keys are set via the **AI: Configure providers** command-palette entry, never in plaintext on disk. The ✨ button in the Postgres SQL editor toolbar toggles a docked chat panel; CLI providers stream tool-call events as they work, enabling multi-turn conversation. Use **AI: Focus chat panel** from the palette to open the panel from anywhere. Executed query results can be attached as context for the next message (composer "Attach result" chip, capped at 100 rows / 50 KB, session-only, never persisted); they ride the `attached_results` field on `ChatRequest` and serialise into each provider's prompt (`AttachedResult` in `modules/ai/types.rs`). Full install instructions and provider details: see `README.md` "AI providers".

## Design System

Always read `DESIGN.md` before making any visual or UI decisions. All font choices, colors, spacing, border radii, motion, and aesthetic direction are defined there. Do not deviate without explicit user approval.

A live preview of the system rendered against the real Argus shell lives at `design/preview.html` — open it in a browser when you need to see how a token reads in context.

In QA or design-review mode, flag any code that doesn't match `DESIGN.md` (wrong fonts, wrong accent color, thick borders, decorative gradients, bubbly radii, AI-slop layouts).
