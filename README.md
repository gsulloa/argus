# Argus

A desktop tool for inspecting and editing data across multiple sources. Built on Tauri 2 (Rust backend + React frontend).

## Supported Sources

- **PostgreSQL** — Full feature set: connection management, schema browser, virtualized data grid with inline editing, SQL editor, table structure viewer.
- **MySQL / MariaDB** — MySQL ≥ 5.7, MariaDB ≥ 10.5. Supports schema browsing, virtualized data grid with inline editing, SQL editor with multi-statement runs, table structure viewer.
- **Microsoft SQL Server** — SQL Server 2017+, Azure SQL Database, Azure SQL Managed Instance. Supports schema browsing, virtualized data grid with inline editing, SQL editor with `GO` batch support, table structure viewer. SQL Authentication only in v1.
- **DynamoDB** — Table browsing and item scanning.
- **Amazon CloudWatch Logs** — Log group / stream browsing and querying.
- **Amazon Athena** — Serverless SQL over S3. Connection management (region, workgroup, S3 output location, AWS auth via profile or access keys); Glue-backed schema browser (databases → tables/views → columns); SQL editor running queries through the async Athena lifecycle (`StartQueryExecution` → poll → paginated fetch) with cancellation, multi-statement runs, bytes-scanned (cost) display, and CSV/JSONL/XLSX export; context-folder schema sync via Glue introspection; and context-folder-grounded AI SQL generation. No inline-editing data grid — clicking a table opens a `SELECT … LIMIT 100` preview. Default `AwsDataCatalog` catalog only in v1. AWS credentials stored in the OS keychain like DynamoDB.

## Context folders

Each connection can optionally link to a **context folder** on disk — a
structured directory of documentation and prefab queries that lives in the
service's git repo and can be shared across related connections (e.g. prod +
staging of the same service).

**One folder per project.** The recommended model is one shared root per
project, not one folder per connection. A project is simply the set of
connections that point at the same canonical root — a Postgres connection, a
DynamoDB connection, and an Athena connection for the same service all point at
`~/code/billing-service/argus-context/`; each engine's docs live in its own
subtree under that root (`postgres/`, `dynamo/`, `athena/`). When you link a
new connection to a context folder, Argus offers existing known folders first so
the natural path is to reuse an existing root rather than create a new one. The
folder is independent of connection groups — a connection keeps its context
folder regardless of which group it belongs to.

Layout (engine-segregated under a neutral root):

```
~/code/billing-service/argus-context/
├── context.yaml         # required: schema_version, name
├── README.md            # free-form prose for humans + AI
├── postgres/
│   ├── public/
│   │   └── users.md     # frontmatter + body, one per documented relation
│   └── queries/
│       ├── top-customers.sql
│       └── top-customers.meta.yaml
├── dynamo/
│   └── tables/
│       └── AppTable/
│           ├── table.md         # physical-table doc (kind: dynamo_table)
│           └── models/
│               ├── Order.md    # entity doc (kind: dynamo_model)
│               └── User.md
├── cloudwatch/groups/...
└── ai/{overview.md,glossary.md}
```

Object docs split frontmatter into two blocks: a `system:` block regenerated
by **Sync schema** (live introspection) and a `human:` block plus Markdown
body that the tool never touches. Sharing a folder across connections costs
one filesystem watcher (path-keyed registry); edits in your editor refresh
the UI within ~250 ms. Postgres, MySQL, MSSQL, and DynamoDB ship with full sync support;
CloudWatch is on the roadmap (same folder format).

### DynamoDB model docs (Single-Table Design)

For Single-Table Design tables, you can add **model docs** that describe the
logical entities stored in the table and how to query them. Model docs live at
`dynamo/tables/<table>/models/<Model>.md`, alongside (not replacing) the
physical-table doc at `dynamo/tables/<table>/table.md`.

Model docs can be created and edited two ways: **in-app** — open a Single-Table
Design table in the data-view, switch the query builder to **By model**, and use
the **＋ New** / **Edit** affordance next to the entity selector (on a table with
no models yet, a **Define a model** button bootstraps the first one). The editor
lets you name the entity, add/remove/reorder access patterns (index dropdown
sourced from the live table, `pk`/`sk` template inputs), edit a Markdown body,
and shows a compiled-key preview plus inline validation against the live table
schema before it writes — or **by hand**, editing the Markdown directly. Saving
from the editor preserves any hand-written `human:` block and Markdown body
byte-for-byte; if the connection has no linked context folder, the editor first
guides you to link or create one. When the table is offline, the editor falls
back to template-syntax checks only and warns that schema checks were skipped.

A model doc's `system:` block must contain:

| Field | Required | Description |
|-------|----------|-------------|
| `kind` | yes | `dynamo_model` |
| `name` | yes | Entity name (e.g. `Order`) |
| `access_patterns` | yes (non-empty) | List of access patterns — see below |

`physical_table` is **not** authored in frontmatter; Argus derives it from the
parent directory name (the `<table>` path segment) so it can never drift from
the file's location.

Each access pattern:

| Field | Required | Description |
|-------|----------|-------------|
| `index` | yes | `"table"` for the primary key, or the GSI/LSI name |
| `pk` | yes | Partition-key value template |
| `sk` | no | Sort-key value template |
| `name` | no | Human label shown in the UI (recommended when two patterns share an index) |

**Template syntax:** literal text with zero or more `${ident}` placeholders,
where `ident` matches `[A-Za-z_][A-Za-z0-9_]*`. A `$` not followed by `{`
is literal. An unterminated `${` is malformed and surfaces a load warning.

**How filtering works:** selecting an entity and access pattern in the
data-view exposes one input per distinct `${param}` across the pattern's `pk`
and `sk` templates. Filling all inputs produces an equality query. Leaving a
**trailing** parameter empty produces a `begins_with` prefix scan on string
(`S`) keys. Leaving the sort-key empty altogether (or supplying no `sk`) runs
a partition-only query. Numeric (`N`) keys do not support prefix matching;
a partially-filled numeric template is an error. Tables with no model docs
show only the raw query builder, unchanged.

A worked example lives in
`docs/context-folder-example/dynamo/tables/events/models/`.

### DynamoDB logical-name matching (CDK / per-environment tables)

By default Argus matches a DynamoDB context doc to a live table by **exact table
name**. That breaks when a tool like the AWS CDK gives the same logical table an
environment-specific stack prefix and a random per-deploy suffix
(`MyApp-dev-EventsTable-1A2B3C…`, `MyApp-prod-EventsTable-3M4N…`): one shared
context folder can't match across environments, and every deploy's new suffix
makes schema-sync create a brand-new file.

To fix this, a DynamoDB connection can carry an optional **table-name
normalization rule** that folds a live physical name to a stable **logical
name** before any context lookup. Configure it in the connection form under
**Table name matching** (collapsed by default; empty = today's exact match).
Two mutually-exclusive forms:

- **Simple** — a literal `prefix` to strip plus a regex `suffix_pattern` to strip
  from the end. For the CDK example: prefix `MyApp-prod-`, suffix pattern
  `-[A-Z0-9]+$` folds `MyApp-prod-EventsTable-3M4N…` → `EventsTable`.
- **Advanced** — a single `regex` containing a named capture group `logical`,
  e.g. `^MyApp-prod-(?<logical>.+?)-[A-Z0-9]+$`.

The rule lives **on the connection**, not in the shared folder, because the
prefix is environment-specific — so the same folder
(`dynamo/tables/EventsTable/`, its `table.md` and `models/`, etc.) is reused by `dev`,
`staging`, and `prod` connections, each with its own prefix. A malformed regex
(or an advanced rule missing the `logical` group) is rejected when you test/save
the connection. A rule that doesn't match a given name degrades to exact match,
so a misconfiguration never hides every doc.

Normalization applies to every Dynamo context touch-point: the `📄` documented
badge in the schema tree, model listing (**By model** filtering), and
schema-sync (which writes `dynamo/tables/<logical>/table.md`, so a re-deploy with a new
suffix updates the same file instead of creating a duplicate). Legacy flat
`dynamo/tables/<logical>.md` files are still read and are automatically migrated
into the folder layout on the next sync. If two live tables
fold to the same logical name during one sync, the first wins and the rest are
skipped (surfaced in the sync report) rather than aborting the sync.

**Migration note:** enabling a rule does not rename files already on disk.
Folders synced before configuring a rule keep their old suffix-named files
(`MyApp-prod-EventsTable-XXXX.md`); remove those by hand after the first
logical-name re-sync.

A minimal example folder lives in `docs/context-folder-example/`.

## Amazon Athena setup

### IAM permissions

The IAM identity used to connect (either a named profile or static access keys) must have the following minimum permissions. The S3 actions are needed on both the query-result output bucket and any data buckets Athena reads.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AthenaQueryExecution",
      "Effect": "Allow",
      "Action": [
        "athena:StartQueryExecution",
        "athena:GetQueryExecution",
        "athena:StopQueryExecution",
        "athena:GetQueryResults",
        "athena:GetWorkGroup"
      ],
      "Resource": "*"
    },
    {
      "Sid": "GlueSchemaRead",
      "Effect": "Allow",
      "Action": [
        "glue:GetDatabases",
        "glue:GetTables",
        "glue:GetTable"
      ],
      "Resource": "*"
    },
    {
      "Sid": "S3QueryOutputAndData",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::your-query-results-bucket",
        "arn:aws:s3:::your-query-results-bucket/*",
        "arn:aws:s3:::your-data-bucket",
        "arn:aws:s3:::your-data-bucket/*"
      ]
    }
  ]
}
```

Replace `your-query-results-bucket` with the bucket backing the workgroup's S3 output location, and `your-data-bucket` with every bucket that holds the underlying table data. If an `access denied` error appears on test connection, the most common cause is a missing `athena:GetWorkGroup` or `s3:ListBucket` permission.

## AI providers

Four providers are supported. CLI providers (Claude Code, Codex) are spawned as local processes and can read context-folder content from disk. API providers (Anthropic, OpenAI) receive a serialised context payload over HTTP.

| Provider | Kind | Install |
|----------|------|---------|
| Claude Code | CLI | [anthropic.com/claude-code](https://www.anthropic.com/claude-code) |
| OpenAI Codex CLI | CLI | [github.com/openai/codex](https://github.com/openai/codex) |
| Anthropic API | API | No install — API key required |
| OpenAI API | API | No install — API key required |

**API keys** are stored in the OS keychain under service `argus`, accounts `ai:anthropic` and `ai:openai`. Keys are set (or cleared) via the **AI: Configure providers** command-palette entry — never stored on disk in plaintext.

**Configure providers:** open the command palette (⌘K / Ctrl+K), search for `AI: Configure providers`. The settings modal lists all four providers with live validation status, model dropdowns, and API key fields for the API providers. CLI providers show an install hint when the binary is not found on `PATH`.

**✨ Generate button:** is always present in the Postgres SQL editor toolbar. A small status dot on the button reflects readiness — green when AI is ready, amber when setup is still required. Clicking it always opens a docked chat panel on the right side of the SQL editor.

Chatting requires **both** prerequisites: a configured AI provider **and** a linked context folder. Until both are met, the panel opens in a setup mode showing a two-item checklist (AI provider, context folder), each with a direct call-to-action — *Configure providers* opens the AI settings modal, *Link context folder* opens the connection form. The chat input is hidden until both are satisfied; there is no longer a degraded "no context folder" chat mode (CLI/API providers are never invoked with an empty or temp-directory payload). Once both are configured the panel transitions to chat automatically.

The panel supports multi-turn conversation; CLI providers (Claude Code, Codex) show their reasoning and tool calls as they work. Use **AI: Focus chat panel** from the command palette (⌘K / Ctrl+K) to open the panel from anywhere.

**Attach query results:** after running a query, the chat composer offers an "Attach result" chip that hands the executed result rows (first 100 rows / 50 KB, larger results marked truncated) to the next message as context — useful for drill-down follow-ups. Multiple results can be attached and removed individually; attachments live only in the current chat session and are never written to disk.

Current scope: the ✨ button is wired into the Postgres editor only. MySQL, MSSQL, DynamoDB, and CloudWatch editors follow in a subsequent change.

**DynamoDB AI model inspector:** CLI providers (Claude Code and Codex) can scan an application source repository and propose `dynamo_model` drafts automatically. This is separate from the context folder — it reads a `project_source_path` pointing to the root of your application repo (e.g. `~/code/my-service`). That path is **local, per-connection state** stored in the app database, never in the shared, committable `context.yaml` (an absolute machine-specific path does not belong in a file you commit). Set it via `context_set_project_source` (exposed in the UI as a field in the context-folder settings); the picker prompts for it on first inspect. Folders created by older builds that still carry a `project_source_path` in `context.yaml` are migrated automatically on first use — the value moves into local storage and the key is stripped from `context.yaml`. When triggered, the agent Reads/Globs/Greps the repo for DynamoDB entity definitions — classes with `PK()`/`SK()` key-composition methods, ElectroDB entity schemas, dynamodb-toolbox schemas — and returns a JSON block of model proposals. The proposals are streamed to the frontend on the `ai-inspect-delta:<session_id>` channel as `InspectDelta` events and displayed in the model editor for review before any save; nothing is written automatically. API providers (Anthropic API, OpenAI API) cannot use this feature because they have no filesystem access.

**Troubleshooting `claude`/`codex` not found:** macOS does not pass your shell `PATH` to apps launched from Finder, the Dock, or the auto-updater — only `/usr/bin:/bin:/usr/sbin:/sbin` is available. Argus automatically inherits the login-shell PATH at startup by running `$SHELL -l`, so any `export PATH=…` in your `~/.zprofile` or `~/.bash_profile` will be picked up. If your CLI is only exported from an interactive `.zshrc`, move the `export` to `.zprofile` (or create a symlink in `/usr/local/bin`). As a last resort, launch the app with the binary path set explicitly: `ARGUS_CLAUDE_BIN=/abs/path/to/claude open -a Argus` (likewise `ARGUS_CODEX_BIN` for Codex).

## Prerequisites

- **Node.js** 20+
- **pnpm** 10+
- **Rust** stable (install via [rustup](https://rustup.rs))
- **Platform tooling** for Tauri 2 — see the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/)
- **Linux only**: `libsecret` for OS keychain integration. On Debian/Ubuntu: `sudo apt install libsecret-1-dev`. Without it, secret storage fails at startup.

## Run

```sh
pnpm install
pnpm tauri:dev
```

## Build

```sh
pnpm tauri:build
```

The bundle lands under `src-tauri/target/release/bundle/`.

## Release pipeline

Builds are produced automatically by GitHub Actions on every merge to `master`,
signed and notarized for macOS, and distributed to the team via auto-updater. The
one-time setup (Apple Developer cert, AWS release hosting via `ArgusReleasesStack`,
updater keypair, GH Secrets) is documented in [docs/release-setup.md](docs/release-setup.md).

## Project layout

```
argus/
├── src/                    # React frontend
│   ├── app/                # top-level composition
│   ├── platform/           # shell, command palette, connection registry
│   ├── modules/            # data-source modules (empty in V1)
│   └── components/         # primitive UI atoms
└── src-tauri/              # Rust backend
    ├── src/
    │   ├── error.rs        # shared AppError enum
    │   └── platform/       # storage, secrets, connections
    └── migrations/         # SQLite migrations
```

## Data locations

- **SQLite database**: `<app_data_dir>/argus.db`
- **Secrets**: OS keychain under service `argus`, account `connection:<id>`
- **Logs (release)**: rotating files in `<app_log_dir>`

## Running live integration tests

Unit tests run without any live server:

```sh
cd src-tauri && cargo test --lib
```

Live integration tests require a reachable server and are opt-in via Cargo features:

```sh
# PostgreSQL live tests
PG_TEST_URL="postgresql://user:pass@localhost/testdb" cargo test --features live-pg-tests

# MySQL / MariaDB live tests
MYSQL_TEST_URL="mysql://user:pass@localhost/testdb" cargo test --features live-mysql-tests

# MS SQL Server live tests (Docker recommended: mcr.microsoft.com/mssql/server:2022-latest)
# Set MSSQL_TEST_TRUST_CERT=1 when using a self-signed certificate (e.g., local Docker image).
MSSQL_TEST_URL="mssql://sa:YourPassword@localhost:1433/master" \
  MSSQL_TEST_TRUST_CERT=1 \
  cargo test --features live-mssql-tests
```
