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
├── dynamo/tables/...
├── cloudwatch/groups/...
└── ai/{overview.md,glossary.md}
```

Object docs split frontmatter into two blocks: a `system:` block regenerated
by **Sync schema** (live introspection) and a `human:` block plus Markdown
body that the tool never touches. Sharing a folder across connections costs
one filesystem watcher (path-keyed registry); edits in your editor refresh
the UI within ~250 ms. Postgres, MySQL, MSSQL, and DynamoDB ship with full sync support;
CloudWatch is on the roadmap (same folder format).

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

**✨ Generate button:** appears in the Postgres SQL editor toolbar after a default provider is configured (or a per-connection override exists). Click it to open a docked chat panel on the right side of the SQL editor. The panel supports multi-turn conversation; CLI providers (Claude Code, Codex) show their reasoning and tool calls as they work. Use **AI: Focus chat panel** from the command palette (⌘K / Ctrl+K) to open the panel from anywhere.

Current scope: the ✨ button is wired into the Postgres editor only. MySQL, MSSQL, DynamoDB, and CloudWatch editors follow in a subsequent change.

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
