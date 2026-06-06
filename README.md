# Argus

A desktop tool for inspecting and editing data across multiple sources. Built on Tauri 2 (Rust backend + React frontend).

## Supported Sources

- **PostgreSQL** — Full feature set: connection management, schema browser, virtualized data grid with inline editing, SQL editor, table structure viewer.
- **MySQL / MariaDB** — MySQL ≥ 5.7, MariaDB ≥ 10.5. Supports schema browsing, virtualized data grid with inline editing, SQL editor with multi-statement runs, table structure viewer.
- **Microsoft SQL Server** — SQL Server 2017+, Azure SQL Database, Azure SQL Managed Instance. Supports schema browsing, virtualized data grid with inline editing, SQL editor with `GO` batch support, table structure viewer. SQL Authentication only in v1.
- **DynamoDB** — Table browsing and item scanning.
- **Amazon CloudWatch Logs** — Log group / stream browsing and querying.

## Context folders

Each connection can optionally link to a **context folder** on disk — a
structured directory of documentation and prefab queries that lives in the
service's git repo and can be shared across related connections (e.g. prod +
staging of the same service).

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
│       ├── AppTable.md          # physical-table doc (kind: dynamo_table)
│       └── AppTable/
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
physical-table doc at `dynamo/tables/<table>.md`.

A model doc is hand-authored. Its `system:` block must contain:

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

A minimal example folder lives in `docs/context-folder-example/`.

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

Current scope: the ✨ button is wired into the Postgres editor only. MySQL, MSSQL, DynamoDB, and CloudWatch editors follow in a subsequent change.

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
one-time setup (Apple Developer cert, R2 bucket, updater keypair, GH Secrets) is
documented in [docs/release-setup.md](docs/release-setup.md).

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
