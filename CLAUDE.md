# Argus

A Tauri 2 desktop app for inspecting and editing data across multiple sources.

## Supported Sources

- **PostgreSQL** — Full feature set: connection management, schema browser, virtualized data grid with inline editing, SQL editor, table structure viewer.
- **MySQL / MariaDB** — MySQL ≥ 5.7, MariaDB ≥ 10.5. Supports schema browsing, virtualized data grid with inline editing, SQL editor with multi-statement runs, table structure viewer.
- **Microsoft SQL Server** — SQL Server 2017+, Azure SQL Database, Azure SQL Managed Instance. Supports schema browsing, virtualized data grid with inline editing, SQL editor with `GO` batch support, table structure viewer. SQL Authentication only in v1.
- **DynamoDB** — Table browsing and item scanning.
- **Amazon CloudWatch Logs** — Connection (region, AWS auth via profile/access-keys) + log-group/stream browser + raw event tail viewer + Logs Insights editor (`.cwlogs`, async `StartQuery` → poll → fetch lifecycle, dynamic columns, records/bytes-scanned cost, CSV/JSONL/XLSX export); context-folder schema sync via `CloudwatchIntrospector` (groups → `cloudwatch/groups/<name>.md`, `/`→`__` filename folding). No inline-editing data grid — logs are immutable. AWS credentials in OS keychain like DynamoDB.
- **Amazon Athena** — Serverless SQL over S3 via the async query lifecycle (`StartQueryExecution` → poll → paginated fetch). Glue-backed schema browser (databases → tables/views → columns); SQL editor with multi-statement runs, bytes-scanned (cost) display, and CSV/JSONL/XLSX export. No inline-editing data grid — table click opens a `SELECT … LIMIT 100` preview. Context-folder schema sync via Glue introspection (`AthenaIntrospector`); context-folder-grounded AI SQL generation. Default `AwsDataCatalog` catalog only in v1; AWS credentials in OS keychain like DynamoDB.

## Context folders (cross-engine)

Each connection can optionally link to a **context folder** on disk holding
structured documentation (object docs with `system:` / `human:` frontmatter)
and prefab queries. The guiding model is **"the context folder is the project"**:
multiple connections of any engine (Postgres, MySQL, MSSQL, DynamoDB, Athena, CloudWatch)
share one root; each engine's docs live under its own subtree within that root
(`<root>/<engine>/<schema>/`). A folder is **independent of connection groups** —
a connection retains its `context_path` regardless of which group it belongs to.
One filesystem watcher per canonical path; the link/setup flow offers existing
known folders first (reuse-first). Full layout, format, and behaviour: see
`README.md` "Context folders" and `docs/context-folder-example/`. Schema-sync
ships for Postgres, MySQL, MSSQL, DynamoDB, Athena, and CloudWatch (`introspect_adapters.rs`);
CloudWatch groups sync to `cloudwatch/groups/<name>.md` with `/`→`__` filename folding. DynamoDB connections may carry an optional
per-connection **table-name normalization rule** (`DynamoParams.table_match`,
applied via `context/normalize.rs`) that folds CDK-style physical names
(`MyApp-prod-EventsTable-3M4N…`) to a logical name (`EventsTable`) before every
context match and sync write, so one shared folder serves all environments.

## AI providers (cross-engine)

Four providers are supported: **Claude Code** and **OpenAI Codex CLI** (local process, reads context folder from disk) and **Anthropic API** and **OpenAI API** (HTTP, context serialised as payload). API keys live in the OS keychain under service `argus`, accounts `ai:anthropic` and `ai:openai`; keys are set via the **AI: Configure providers** command-palette entry, never in plaintext on disk. The ✨ button in the Postgres SQL editor toolbar toggles a docked chat panel; CLI providers stream tool-call events as they work, enabling multi-turn conversation. Use **AI: Focus chat panel** from the palette to open the panel from anywhere. Executed query results can be attached as context for the next message (composer "Attach result" chip, capped at 100 rows / 50 KB, session-only, never persisted); they ride the `attached_results` field on `ChatRequest` and serialise into each provider's prompt (`AttachedResult` in `modules/ai/types.rs`). Full install instructions and provider details: see `README.md` "AI providers".

## Design System

Always read `DESIGN.md` before making any visual or UI decisions. All font choices, colors, spacing, border radii, motion, and aesthetic direction are defined there. Do not deviate without explicit user approval.

A live preview of the system rendered against the real Argus shell lives at `design/preview.html` — open it in a browser when you need to see how a token reads in context.

In QA or design-review mode, flag any code that doesn't match `DESIGN.md` (wrong fonts, wrong accent color, thick borders, decorative gradients, bubbly radii, AI-slop layouts).
