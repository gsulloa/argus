# Manual QA Checklist — add-mssql-support

> **Status**: Pending — cannot be performed without a running MS SQL Server in the development environment.
> Run this checklist against a local Docker instance and, where noted, against Azure SQL Database before merging to master.

## Docker Setup (Local)

```sh
# Pull and start SQL Server 2022 Developer Edition.
docker run -e "ACCEPT_EULA=Y" -e "MSSQL_SA_PASSWORD=ArgusTest123!" \
  -p 1433:1433 --name argus-mssql-test -d \
  mcr.microsoft.com/mssql/server:2022-latest

# Wait ~10s for startup, then verify.
docker exec argus-mssql-test /opt/mssql-tools/bin/sqlcmd \
  -S localhost -U sa -P 'ArgusTest123!' -Q 'SELECT @@VERSION'
```

> Note: The Docker image uses a self-signed TLS certificate. Enable **Trust Server Certificate** in the Argus connection form when connecting to it.

## Connection Management

- [ ] Open new MS SQL Server connection — Form view shows: Host, Port (default 1433), Database, Username, Password, Encrypt (Off / On / Strict), Trust Server Certificate toggle, optional Instance Name field
- [ ] Open new MS SQL Server connection — URL view accepts `mssql://sa:pass@localhost:1433/master`
- [ ] Open new MS SQL Server connection — URL view accepts `sqlserver://sa:pass@localhost/master`
- [ ] Open new MS SQL Server connection — URL view accepts `jdbc:sqlserver://localhost:1433;databaseName=master;user=sa;password=pass`
- [ ] Open new MS SQL Server connection — URL view accepts ADO.NET key=value string (`Server=localhost;Database=master;User Id=sa;Password=pass;Encrypt=false`)
- [ ] Test connection — success path returns SQL Server version string and latency
- [ ] Test connection — wrong password returns error code 18456
- [ ] Test connection — nonexistent database returns error code 4060
- [ ] Test connection — unreachable host returns connection error (no error code / code: null)
- [ ] Test connection — Encrypt=Strict with a self-signed cert + Trust Server Certificate=false returns TLS handshake error
- [ ] Test connection — Encrypt=On + Trust Server Certificate=true succeeds against Docker local instance
- [ ] Save connection (without connecting)
- [ ] Save & Connect — opens the schema tree
- [ ] Connect from an existing saved connection
- [ ] Disconnect a single connection
- [ ] Disconnect-all confirmation dialog appears and clears all active connections
- [ ] RO badge appears in sidebar for connections opened with ApplicationIntent=ReadOnly

## Schema Browser

- [ ] Browse schema tree: schemas listed; system schemas (sys, INFORMATION_SCHEMA, db_*, guest) hidden by default
- [ ] Toggle "Show System Schemas" reveals sys and INFORMATION_SCHEMA
- [ ] Expand a schema: "Data" group (Tables, Views) and "Structure" group (Procedures, Functions, Triggers, Sequences) appear
- [ ] Expand a table: Indexes, Triggers, Foreign Keys, Check Constraints, Default Constraints sub-nodes appear
- [ ] Indexed views appear in the Data group alongside regular views
- [ ] Estimated row counts shown for tables (from sys.dm_db_partition_stats)
- [ ] Database picker at top of schema tree lists accessible databases; switching reloads schema tree
- [ ] Per-kind failure badge appears when a sub-query fails (e.g. permission denied on sequences)
- [ ] Retry on cancellation (code: null) — click retry re-runs only the failed section
- [ ] Schema search (case-insensitive substring filter) — Esc clears, match count visible
- [ ] `Schema: Refresh` palette command clears and reloads all cached data

## Data Grid

- [ ] Query a table — rows load and display
- [ ] Apply filter for every operator: =, !=, <, <=, >, >=, LIKE, NOT LIKE, Contains, StartsWith, EndsWith, In, NotIn, BETWEEN, IS NULL, IS NOT NULL
- [ ] Case-insensitive toggle on string filters works (LOWER() wrapping in T-SQL)
- [ ] Spatial / ROWVERSION / SQL_VARIANT filter ops are disabled (greyed out) in the filter bar
- [ ] Order toggle (ASC / DESC) on column headers
- [ ] Pagination: OFFSET FETCH NEXT works; row count badge shows approximate count
- [ ] BIT column displays as boolean (true / false), not 0 / 1
- [ ] TINYINT column displays as integer (0–255), NOT boolean (unlike MySQL TINYINT(1))
- [ ] BIGINT values beyond ±2^53 display as string, not truncated number
- [ ] BINARY / VARBINARY column shows base64 preview or truncation envelope
- [ ] UNIQUEIDENTIFIER column shows canonical lowercase UUID string
- [ ] DATETIMEOFFSET column shows ISO 8601 string with ±HH:MM offset preserved
- [ ] DATETIME / DATETIME2 column shows ISO 8601 string without timezone
- [ ] XML column shows raw XML string in inspector
- [ ] JSON column shows parsed JSON tree in inspector
- [ ] GEOMETRY / GEOGRAPHY column shows WKT string (read-only in grid)
- [ ] HIERARCHYID column shows .ToString() string (read-only in grid)
- [ ] SQL_VARIANT column shows CONVERT(NVARCHAR(MAX)) string (read-only in grid)
- [ ] ROWVERSION / TIMESTAMP column shows base64-encoded value (read-only in grid, no edit affordance)
- [ ] IDENTITY column has read-only badge in grid header (no edit affordance for the IDENTITY column itself)
- [ ] Computed column has read-only badge in grid header

## Inline Editing

- [ ] Edit a row inline — dirty highlight appears on changed cell
- [ ] Apply edits — refreshed values appear via OUTPUT INSERTED.* without full reload
- [ ] Insert a new row — IDENTITY PK fills in from OUTPUT INSERTED.*
- [ ] Attempting to insert with an explicit IDENTITY column value shows validation error (not sent to server)
- [ ] Delete a row via the grid
- [ ] Discard pending edits dialog appears and cancels correctly
- [ ] Apply error highlights the failed op index and shows SQL Server error code/message
- [ ] Unique constraint violation shows error code 2627
- [ ] FK constraint violation shows error code 547
- [ ] NOT NULL violation shows error code 515
- [ ] Read-only connection prevents edits (lock icon, no Apply button)
- [ ] Table with INSTEAD OF trigger: trigger-degradation banner appears once per session; edits still work (slower)
- [ ] After trigger-degradation: SCOPE_IDENTITY() correctly identifies inserted row on tables without OUTPUT
- [ ] GEOMETRY / GEOGRAPHY / HIERARCHYID / SQL_VARIANT / ROWVERSION write attempt shows validation error pointing to SQL editor

## SQL Editor

- [ ] Run a single SELECT statement — results appear in grid
- [ ] Run a single INSERT/UPDATE/DELETE — affected row count shown with command_tag
- [ ] Run multi-statement SQL (SELECT 1; SELECT 2;) — both results shown in tabs
- [ ] Error in one statement shows error code, line number, and optional procedure name
- [ ] Error line highlights the correct line in the editor (red gutter marker)
- [ ] `GO` separator splits into two batches; each batch runs independently
- [ ] `GO 3` runs the preceding batch 3 times in sequence
- [ ] `go` (lowercase) is accepted as a batch separator
- [ ] `GO` with trailing `--` comment is accepted
- [ ] CREATE PROCEDURE in same batch after another statement — rejected with "must be first in its batch; insert a GO separator"
- [ ] CREATE PROCEDURE in first position of its batch (after GO) — succeeds
- [ ] Read-only mode: error 3906/3908 surfaces friendly "Database is in a read-only state" message
- [ ] Autocomplete suggests bracket-wrapped column names from columns cache
- [ ] T-SQL formatter (`sql-formatter` with `transactsql` dialect) formats on demand
- [ ] Export actions (CSV / JSON Lines / XLSX) work on rows results
- [ ] SQL query history persists across app restarts with `kind: "mssql"`
- [ ] Saved queries work with `kind: "mssql"`

## Structure Subtab

- [ ] Open Structure subtab — Columns section shows type, nullability, IDENTITY badge, computed badge, sparse badge
- [ ] Primary Key section shows PK column(s)
- [ ] Unique Constraints section shows constraints
- [ ] Foreign Keys section shows FK with is_disabled / is_not_trusted chips
- [ ] Indexes section shows clustered/non-clustered, included columns, filter predicate
- [ ] Triggers section shows trigger names
- [ ] Check Constraints section shows constraints
- [ ] Default Constraints section shows defaults
- [ ] Table Options section shows memory-optimized flag, temporal type, lock escalation
- [ ] Open Raw subtab for a table — shows synthesized CREATE TABLE DDL with "v1 approximation" disclaimer banner
- [ ] Open Raw subtab for a view — shows OBJECT_DEFINITION output verbatim
- [ ] Open Raw subtab for a procedure — shows OBJECT_DEFINITION output verbatim
- [ ] Open Raw subtab for an encrypted object — shows "Object is encrypted; definition unavailable" banner
- [ ] Partial-failure inline retry for a section that timed out

## Azure SQL (if target available)

- [ ] Connect to Azure SQL Database (engine_edition = 5)
- [ ] Connect with `ApplicationIntent=ReadOnly` and verify secondary replica routing
- [ ] Read-only replica prevents mutations (AppError validation "connection is read-only")

## General

- [ ] Activity log entry created for each command (connect, query, edit, run SQL)
- [ ] Activity log filter by `kind_namespace: "mssql"` shows only MS SQL Server entries
- [ ] Query history persists across app restarts
- [ ] Column widths persist per `(connectionId, schema, relation, column)` with `msColumnWidths:` prefix
- [ ] App does not crash on rapid connect/disconnect cycles
- [ ] Large result sets (>1000 rows) show truncation envelope correctly
- [ ] Table quick switcher (`Cmd+K`) shows MS SQL Server tables from the bulk columns cache
- [ ] `New SQL Query Here` from schema tree emits `SELECT TOP 100 * FROM [schema].[table];`
- [ ] Cancellation during long-running query (WAITFOR DELAY) returns within ~1s with "query cancelled" message
