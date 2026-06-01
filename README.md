# Argus

A desktop tool for inspecting and editing data across multiple sources. Built on Tauri 2 (Rust backend + React frontend).

## Supported Sources

- **PostgreSQL** — Full feature set: connection management, schema browser, virtualized data grid with inline editing, SQL editor, table structure viewer.
- **MySQL / MariaDB** — MySQL ≥ 5.7, MariaDB ≥ 10.5. Supports schema browsing, virtualized data grid with inline editing, SQL editor with multi-statement runs, table structure viewer.
- **Microsoft SQL Server** — SQL Server 2017+, Azure SQL Database, Azure SQL Managed Instance. Supports schema browsing, virtualized data grid with inline editing, SQL editor with `GO` batch support, table structure viewer. SQL Authentication only in v1.
- **DynamoDB** — Table browsing and item scanning.
- **Amazon CloudWatch Logs** — Log group / stream browsing and querying.

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
