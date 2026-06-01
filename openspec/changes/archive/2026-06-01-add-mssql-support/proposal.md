## Why

Argus currently supports Postgres, MySQL/MariaDB, DynamoDB, and CloudWatch Logs. Microsoft SQL Server is the second-most-common closed-source relational database in enterprises and the dominant choice in many .NET / Windows shops. Users who run MS SQL Server (on-prem, Azure SQL Database, Azure SQL Managed Instance) cannot use Argus today and must switch to TablePlus / SSMS / Azure Data Studio for those connections. Adding MS SQL Server brings Argus to feature-parity with the third major SQL dialect and unlocks the same inspect / edit / query workflows already polished for Postgres and MySQL.

## What Changes

- New `kind: "mssql"` recognized by the connection registry, persisted alongside Postgres, MySQL, and DynamoDB entries in the existing SQLite store and the OS keychain.
- New `mssql` Rust module under `src-tauri/src/modules/mssql/` providing:
  - Typed `MssqlParams` (host, port, database, username, encrypt, trust_server_certificate, read_only, instance_name?, application_intent?) with validation and URL parsing for `mssql://` and `sqlserver://` strings (plus ADO.NET key=value connection-string parsing).
  - Connection pool registry (`MssqlPoolRegistry`) using the `tiberius` driver over `tokio` with `bb8` or a hand-rolled pool, rustls TLS, and read-only enforcement via `SET TRANSACTION ISOLATION LEVEL` / `ApplicationIntent=ReadOnly` semantics.
  - Tauri commands mirroring the MySQL / Postgres surface: test connection, connect / disconnect, list active, parse URL, list schemas / relations / structure / extras, query / count / edit table, run SQL (single + many, with `GO` batch handling), list table columns bulk, table primary key, table structure, procedure / function signatures.
  - Type binding layer for MS SQL Server types (`BIT`, `TINYINT`…`BIGINT`, `DECIMAL`, `MONEY`, `FLOAT`, `REAL`, `CHAR/VARCHAR/TEXT`, `NCHAR/NVARCHAR/NTEXT`, `DATE`, `TIME`, `DATETIME`, `DATETIME2`, `DATETIMEOFFSET`, `SMALLDATETIME`, `BINARY`, `VARBINARY`, `IMAGE`, `UNIQUEIDENTIFIER`, `XML`, `JSON` (2025+), `ROWVERSION/TIMESTAMP`, `GEOMETRY/GEOGRAPHY/HIERARCHYID` decode-only).
- New `mssql` frontend module under `src/modules/mssql/` providing a connection form, schema tree, data grid, inline editor, SQL editor, and structure subtab — all matching the existing UX with MS SQL Server-specific defaults (port `1433`, identifier quoting with square brackets, `Encrypt=true` default, `OUTPUT`-clause-based edit refresh, `sp_helptext` / system-views–based DDL).
- Connection list, command palette, table quick switcher, query history, saved queries, activity log, and column-width preferences all recognize MS SQL Server connections through the existing `kind`-discriminated routing.
- New Cargo dependencies: `tiberius` with `rustls`, `chrono`, `bigdecimal`, `time` features; `bb8` + `bb8-tiberius` (or hand-rolled pool); `tokio-util` for `Compat` wrappers.
- No breaking changes: existing Postgres, MySQL, and DynamoDB capabilities are untouched.

## Capabilities

### New Capabilities

- `mssql-connection`: Typed MS SQL Server params, URL parsing (`mssql://`, `sqlserver://`, ADO.NET key=value), test connection, persistent connect / disconnect, active-connection registry events, password storage in OS keychain, optional named-instance and `ApplicationIntent` handling.
- `mssql-schema-browser`: List schemas (within the current database), tables, views, procedures, functions, triggers, indexes, foreign keys, and table structure metadata via `INFORMATION_SCHEMA` + `sys.*` catalog views, with cancellation and per-query timeouts.
- `mssql-data-grid`: Query a table with structured filters, pagination (via `OFFSET ... FETCH NEXT`), ordering, value truncation, and type-aware result serialization. Mirrors the Postgres / MySQL grid contract.
- `mssql-data-edit`: Transactional insert / update / delete by primary key for MS SQL Server tables, using `OUTPUT INSERTED.* / DELETED.*` to refresh rows in the same round-trip; read-only enforcement; identity / `SCOPE_IDENTITY()` handling for auto-generated PKs.
- `mssql-sql-editor`: Execute single or multiple SQL statements against a MS SQL Server connection, return rows or affected-count outcomes, surface MS SQL Server error number + line, support `GO` batch separation (client-side splitter, not server SQL).
- `mssql-table-structure`: Reconstruct table DDL (columns, constraints, indexes, triggers, options) for the structure subtab using `sp_help` + `sys.*` catalog views + `OBJECT_DEFINITION()` for views / procedures.
- `mssql-columns-cache`: Bulk preload of all column metadata per database to power SQL editor autocomplete without per-table round-trips.

### Modified Capabilities

<!-- None. `connection-registry` already stores `kind` and `params` opaquely; each driver owns its own params validation, so no spec-level change is needed there. -->


## Impact

- **New code**: `src-tauri/src/modules/mssql/` (Rust), `src/modules/mssql/` (React / TS), new spec files under `openspec/changes/add-mssql-support/specs/mssql-*/`.
- **Cargo dependencies**: add `tiberius` with `rustls`, `chrono`, `bigdecimal`, `time`, `sql-browser-tokio` features; add `bb8` + `bb8-tiberius`; add `tokio-util` (`Compat` for AsyncRead/Write bridging). Keep `tokio-postgres`, `sqlx`, and the existing TLS stack untouched.
- **Tauri registration**: `src-tauri/src/lib.rs` registers `MssqlPoolRegistry` state and ~20 new `#[tauri::command]`s in `generate_handler!`.
- **Shared UI surfaces**: connection list, sidebar tabs, command palette, table quick switcher, saved queries, query history, activity log, column-width preferences all gain a `kind === "mssql"` branch alongside the existing `postgres` / `mysql` / `dynamodb` branches.
- **No DB migrations**: connection storage already stores `kind` and opaque `params_json`; no SQLite schema change needed.
- **Bundle size**: `tiberius` + TDS driver + `bb8` adds ~1.2–1.8 MB to the release binary; acceptable given parity goal. We accept three SQL driver libraries in the binary (tokio-postgres + sqlx + tiberius) — unifying is out of scope.
- **Security**: passwords stored in the OS keychain under the same `argus` service; TLS via `rustls` matching the Postgres / MySQL approach; `Encrypt=true` is the default for v1 to align with Microsoft's recommended posture (and Azure SQL requires TLS).
- **Tests**: new unit tests for params / url / binding; live integration tests gated behind a `live-mssql-tests` Cargo feature requiring `MSSQL_TEST_URL` (and optionally `MSSQL_TEST_TRUST_CERT=1` for self-signed local servers).
- **Auth**: SQL authentication only in v1. Windows Authentication (NTLM / Kerberos), Azure AD authentication, and Managed Identity are explicitly out of scope and deferred to a future change.
