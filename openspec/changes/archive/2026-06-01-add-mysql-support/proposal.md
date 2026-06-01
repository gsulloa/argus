## Why

Argus today only supports Postgres as a relational source. Users who run MySQL or MariaDB-based systems cannot use Argus to inspect schemas, browse data, or run ad-hoc SQL, which forces them to switch tools. Adding MySQL brings Argus to feature-parity for the second most common open-source relational database and unlocks the same inspect/edit/query workflows already polished for Postgres.

## What Changes

- New `kind: "mysql"` recognized by the connection registry, persisted alongside Postgres and DynamoDB entries in the existing SQLite store and the OS keychain.
- New `mysql` Rust module under `src-tauri/src/modules/mysql/` providing:
  - Typed `MysqlParams` (host, port, database, username, ssl_mode, read_only) with validation and URL parsing for `mysql://` strings.
  - Connection pool registry (`MysqlPoolRegistry`) using `sqlx` MySQL driver with TLS modes and read-only enforcement.
  - Tauri commands mirroring the Postgres surface: test connection, connect/disconnect, list active, parse URL, list schemas/relations/structure/extras, query/count/edit table, run SQL (single + many), list table columns bulk, table primary key, table structure, function/procedure signatures.
  - Type binding layer for MySQL types (TINYINT, BIGINT, DECIMAL, JSON, ENUM, SET, BLOB, DATETIME, etc.).
- New `mysql` frontend module under `src/modules/mysql/` providing a connection form, schema tree, data grid, inline editor, SQL editor, and structure subtab — all matching the Postgres UX with MySQL-specific defaults (port `3306`, identifier quoting with backticks, `SHOW CREATE TABLE`–based DDL).
- Connection list, command palette, table quick switcher, query history, saved queries, activity log, and column-width preferences all recognize MySQL connections through the existing `kind`-discriminated routing.
- New Cargo dependencies: `sqlx` with `mysql`, `rustls`, `chrono`, `bigdecimal`, `time` features.
- No breaking changes: existing Postgres and DynamoDB capabilities are untouched.

## Capabilities

### New Capabilities

- `mysql-connection`: Typed MySQL params, URL parsing, test connection, persistent connect/disconnect, active-connection registry events, password storage in OS keychain.
- `mysql-schema-browser`: List databases (schemas), tables, views, routines, triggers, indexes, and table structure metadata via `INFORMATION_SCHEMA`, with cancellation and per-query timeouts.
- `mysql-data-grid`: Query a table with structured filters, pagination, ordering, value truncation, and type-aware result serialization. Mirrors the Postgres grid contract.
- `mysql-data-edit`: Transactional insert / update / delete by primary key for MySQL tables, with read-only enforcement and refreshed-row response.
- `mysql-sql-editor`: Execute single or multiple SQL statements against a MySQL connection, return rows or affected-count outcomes, surface MySQL error code + position, support statement splitting.
- `mysql-table-structure`: Reconstruct table DDL (columns, constraints, indexes, triggers, options) for the structure subtab using `SHOW CREATE TABLE` and `INFORMATION_SCHEMA`.
- `mysql-columns-cache`: Bulk preload of all column metadata per database to power SQL editor autocomplete without per-table round-trips.

### Modified Capabilities

<!-- None. `connection-registry` already stores `kind` and `params` opaquely; each driver owns its own params validation, so no spec-level change is needed there. -->


## Impact

- **New code**: `src-tauri/src/modules/mysql/` (Rust), `src/modules/mysql/` (React/TS), new spec files under `openspec/specs/mysql-*/`.
- **Cargo dependencies**: add `sqlx` with `runtime-tokio-rustls`, `mysql`, `chrono`, `bigdecimal`, `time`, `uuid`, `json` features. Keep `tokio-postgres` untouched.
- **Tauri registration**: `src-tauri/src/lib.rs` registers `MysqlPoolRegistry` state and ~25 new `#[tauri::command]`s in `generate_handler!`.
- **Shared UI surfaces**: connection list, sidebar tabs, command palette, table quick switcher, saved queries, query history, activity log, column-width preferences all gain a `kind === "mysql"` branch alongside the existing `postgres`/`dynamodb` branches.
- **No DB migrations**: connection storage already stores `kind` and opaque `params_json`; no SQLite schema change needed.
- **Bundle size**: `sqlx` + MySQL driver adds ~1.5–2 MB to the release binary; acceptable given parity goal.
- **Security**: passwords stored in the OS keychain under the same `argus` service; TLS via `rustls` matching the Postgres approach.
- **Tests**: new unit tests for params/url/binding; live integration tests gated behind a `live-mysql-tests` Cargo feature requiring `MYSQL_TEST_URL`.
