## ADDED Requirements

### Requirement: Persistent storage of every executed SQL statement

The platform SHALL persist a row in a dedicated SQLite table for every SQL statement executed via `postgres_run_sql` or via a non-skipped step of `postgres_run_sql_many`. Each row MUST capture enough information to reconstruct the run later without joining other tables: a fresh UUID `id`, the originating `connection_id` (binary UUID), a `connection_name` snapshot taken at insert time from the connection registry, the full `sql` text, the `origin` field (`"user"` or `"auto"`) propagated from the run command, the resulting `status` (`"ok"` or `"err"`), the `started_at` timestamp in unix milliseconds (matching the activity-log convention), the `duration_ms` measured end-to-end, and the outcome metadata: `row_count` for `kind: "rows"` results, `command_tag` for `kind: "affected"` results, and `error_code` (SQLSTATE) plus `error_message` for failures. Skipped statements in a multi-run MUST NOT be persisted.

The persistence MUST happen before the run command returns to the frontend and MUST occur in the same execution path as the existing `argus:activity-log` emission so that there is exactly one history row per emitted `kind: "run_sql"` event.

#### Scenario: A successful SELECT writes a single row with row_count

- **WHEN** the user runs `SELECT id FROM "public"."users" LIMIT 5` against a writable connection
- **THEN** exactly one new row exists in `query_history` with `status: "ok"`, `row_count: 5`, `command_tag: null`, `error_code: null`, `error_message: null`, the `connection_id` of the active connection, and `connection_name` equal to that connection's name at the moment of execution

#### Scenario: A successful INSERT writes a single row with command_tag

- **WHEN** the user runs `INSERT INTO "public"."users" (name) VALUES ('a'), ('b'), ('c')`
- **THEN** exactly one new row exists in `query_history` with `status: "ok"`, `command_tag: "INSERT 0 3"`, `row_count: null`

#### Scenario: A failing statement writes a row with status err and error fields

- **WHEN** the user runs `SELEC 1`
- **THEN** exactly one new row exists in `query_history` with `status: "err"`, `error_code: "42601"`, `error_message` matching the Postgres message verbatim, `row_count: null`, `command_tag: null`

#### Scenario: Multi-run with skipped statements only persists executed steps

- **WHEN** the user runs `postgres.runSqlMany(id, ["SELECT 1", "SELEC 2", "SELECT 3"], "user")` (the second statement has a typo)
- **THEN** exactly two new rows exist in `query_history`: one with `status: "ok"` and `sql: "SELECT 1"`, one with `status: "err"` and `sql: "SELEC 2"` and `error_code: "42601"`
- **AND** no row exists for the third (skipped) statement

#### Scenario: Origin is propagated

- **WHEN** the user runs a query with `origin: "user"`
- **THEN** the persisted row has `origin: "user"`
- **WHEN** the same statement is run with `origin: "auto"`
- **THEN** the persisted row has `origin: "auto"`

### Requirement: Connection name is snapshotted at insert time

When persisting a `query_history` row, the platform MUST copy the active connection's display name into the `connection_name` column of the row. Subsequent renames or deletions of that connection MUST NOT alter previously persisted rows.

#### Scenario: Renaming a connection does not rewrite history

- **WHEN** a connection named `local-pg` has run several queries
- **AND** the user renames the connection to `local-postgres`
- **THEN** existing `query_history` rows still report `connection_name: "local-pg"`
- **AND** new rows recorded after the rename report `connection_name: "local-postgres"`

#### Scenario: Deleting a connection preserves history rows

- **WHEN** a connection named `temp-db` has 12 history rows
- **AND** the user deletes the connection from the registry
- **THEN** all 12 history rows still exist in `query_history` with `connection_name: "temp-db"`

### Requirement: Listing API with filters and pagination

The platform SHALL expose a Tauri command `query_history_list({ connection_ids?, since?, until?, search?, status?, limit, offset })` returning `{ entries: HistoryEntry[], total: number }`. Filters MUST behave as follows:

- `connection_ids` (optional array of UUID strings): include only rows whose `connection_id` matches any of the listed ids. Omitted or empty means no filter.
- `since` (optional unix ms): include only rows with `started_at >= since`.
- `until` (optional unix ms): include only rows with `started_at <= until`.
- `search` (optional string): case-insensitive substring match against the `sql` column (`LIKE '%search%'`).
- `status` (optional `"ok" | "err"`): include only rows with the matching status.
- `limit` (required, 1..1000, default 200 when caller omits): maximum number of entries to return.
- `offset` (required, default 0): number of matching rows to skip before returning.

Results MUST be ordered by `started_at DESC` with `id DESC` as a stable tie-breaker. The `total` field MUST be the count of rows matching the filters BEFORE `limit`/`offset` are applied, so the UI can render `X of Y` indicators.

#### Scenario: Listing with no filters returns the most recent N rows

- **WHEN** there are 500 rows in the table and the caller invokes `query_history_list({ limit: 50, offset: 0 })`
- **THEN** the response has `entries.length === 50`, ordered by most recent first, and `total === 500`

#### Scenario: Filter by connection ids

- **WHEN** the table has rows for connections `A`, `B`, `C` and the caller invokes `query_history_list({ connection_ids: ["A", "C"], limit: 200, offset: 0 })`
- **THEN** every entry has `connection_id` in `{A, C}`
- **AND** `total` equals the count of A+C rows in the table

#### Scenario: Filter by date range

- **WHEN** the caller invokes `query_history_list({ since: T0, until: T1, limit: 200, offset: 0 })`
- **THEN** every entry has `started_at >= T0 && started_at <= T1`

#### Scenario: Filter by substring search is case-insensitive

- **WHEN** the table contains a row with `sql: "SELECT * FROM Orders"` and the caller invokes `query_history_list({ search: "orders", limit: 200, offset: 0 })`
- **THEN** that row appears in `entries`

#### Scenario: Filter by status returns only matching rows

- **WHEN** the caller invokes `query_history_list({ status: "err", limit: 200, offset: 0 })`
- **THEN** every entry has `status: "err"`

#### Scenario: Pagination returns the correct slice

- **WHEN** filters match 500 rows and the caller invokes `query_history_list({ limit: 100, offset: 100 })`
- **THEN** `entries.length === 100`, `total === 500`, and the entries are the 101st through 200th most recent rows

### Requirement: Delete and clear APIs

The platform SHALL expose a Tauri command `query_history_delete(id)` that deletes a single row by its `id` and returns `void`. The platform SHALL ALSO expose a command `query_history_clear({ connection_ids?, since?, until?, search?, status? })` that deletes every row matching the given filters (same filter semantics as `query_history_list`) and returns `{ deleted: number }`. Calling `query_history_clear({})` with no filters MUST delete every row.

#### Scenario: Deleting a single entry by id

- **WHEN** a row with id `R1` exists and the caller invokes `query_history_delete("R1")`
- **THEN** the row no longer exists
- **AND** subsequent `query_history_list` responses do not include it

#### Scenario: Clear with filters scopes the deletion

- **WHEN** the table has 200 rows of which 30 are for connection `A` and the caller invokes `query_history_clear({ connection_ids: ["A"] })`
- **THEN** the response is `{ deleted: 30 }`
- **AND** rows for other connections are untouched

#### Scenario: Clear with no filters removes everything

- **WHEN** the table has 1234 rows and the caller invokes `query_history_clear({})`
- **THEN** the response is `{ deleted: 1234 }`
- **AND** the table is empty

### Requirement: Retention enforcement at startup

On application startup, after running pending migrations and BEFORE the first user-driven SQL run completes, the platform SHALL prune `query_history` entries that violate either of the configured retention bounds:

- Entries older than `queryHistory.retentionDays` days MUST be deleted (default `30`, sourced from settings).
- After the age-based pass, if the remaining row count exceeds `queryHistory.retentionMaxRows` (default `10000`), the oldest rows beyond that cap MUST be deleted so that exactly `retentionMaxRows` rows remain.

Both settings MUST be persisted in the existing `settings` table under their respective keys; missing keys MUST default to the values above without writing them. The retention pass MUST NOT block the main thread for more than ~50ms in the typical case (10k row pruning).

#### Scenario: Old entries are pruned at startup

- **WHEN** the table has 100 entries with `started_at` older than 30 days and 200 entries within 30 days
- **AND** `queryHistory.retentionDays` is unset (defaults to 30)
- **AND** the user launches the app
- **THEN** after startup the table contains exactly 200 entries, all with `started_at >= now - 30 days`

#### Scenario: Cap is applied after age pass

- **WHEN** the table has 12000 entries all within the retention window
- **AND** `queryHistory.retentionMaxRows` is unset (defaults to 10000)
- **AND** the user launches the app
- **THEN** after startup the table contains exactly 10000 entries (the most recent 10000)

#### Scenario: Custom retention values are honored

- **WHEN** the user has set `queryHistory.retentionDays` to `7` and `queryHistory.retentionMaxRows` to `500`
- **AND** the table has 50 entries older than 7 days and 600 within 7 days
- **THEN** at next startup the table contains exactly 500 entries, all within the last 7 days

### Requirement: Query History tab kind

The frontend SHALL register a tab kind `query-history` whose tab id is the literal string `"history"`. Activating the tab — from the sidebar entry, from the command palette, or programmatically — MUST be single-instance: if a tab with id `"history"` already exists, the shell MUST focus that existing tab instead of creating a new one. The tab title MUST be `History`. The tab payload MUST be `null` (filters and selection are owned by the tab's own state).

The tab MUST render a virtualized list of history entries (most recent first) using the same virtualization primitive used elsewhere in the shell, with each row showing: a timestamp formatted as locale time + short date, the `connection_name` rendered as a pill, a single-line SQL preview truncated with ellipsis, and an outcome summary (`<duration_ms> ms · <row_count> rows` or `<duration_ms> ms · <command_tag>` for `kind: "affected"`, or `<duration_ms> ms · error` for failures). The full SQL MUST be available in a tooltip and in a detail panel when a row is selected.

The tab MUST expose a filter bar with: a multi-select connection picker (listing every distinct `connection_id` present in history, including ones whose connection no longer exists in the registry, marked `(deleted)`), a date-range picker with presets (Today, Last 7 days, Last 30 days, Custom), a search input (text, debounced ≥150ms) bound to the `search` filter, and an "Errors only" toggle bound to `status: "err"`. Changing any filter MUST re-fetch from `query_history_list` with the active filter set.

#### Scenario: Sidebar entry opens the History tab

- **WHEN** the user clicks the `History` entry in the sidebar's Plataforma section
- **THEN** a tab with id `"history"`, kind `"query-history"`, and title `History` opens in the center work area

#### Scenario: Opening History a second time focuses the existing tab

- **WHEN** a History tab is already open and the user activates the sidebar entry again
- **THEN** the existing tab is focused
- **AND** no second tab is created

#### Scenario: Recent rows render at the top

- **WHEN** the History tab opens with 500 entries in the table
- **THEN** the most recent entry is the first row visible
- **AND** scrolling reveals older entries

#### Scenario: Filter changes refresh the list

- **WHEN** the user types `select` into the search input
- **THEN** within 200ms the list refreshes and shows only entries whose SQL contains `select` (case-insensitive)

#### Scenario: Errors-only toggle filters by status

- **WHEN** the user activates the "Errors only" toggle
- **THEN** the list shows only entries with `status: "err"`
- **AND** deactivating the toggle restores the full list

#### Scenario: Deleted-connection filter shows the snapshotted name

- **WHEN** the table contains rows for a connection whose registry entry has been deleted
- **THEN** the connection picker lists that connection by its snapshotted `connection_name` followed by `(deleted)` in muted styling

### Requirement: Open in editor opens a fresh query tab

The History tab SHALL render a primary action on each row labeled `Open in editor` (icon button + double-click + Enter when row is focused) that calls the `postgres-query` open helper with `{ connectionId, connectionName, sql }` taken from the history row. This MUST always create a new `postgres-query` tab (never reuse an existing one), exactly as specified by `postgres-sql-editor`'s "Query tab kind" requirement. When the row's `connection_id` no longer exists in the connection registry, the action MUST be disabled and a tooltip `Connection no longer registered` MUST be shown; a secondary action `Copy SQL` MUST remain available.

#### Scenario: Opening a row creates a new query tab pre-loaded with the SQL

- **WHEN** the user double-clicks a history row whose connection is registered
- **THEN** a new `postgres-query` tab opens with that connection
- **AND** the editor's document equals the row's `sql` field
- **AND** the existing History tab remains open in the background

#### Scenario: Opening a row whose connection was deleted is disabled

- **WHEN** the user clicks `Open in editor` on a row whose `connection_id` no longer exists in the connection registry
- **THEN** the action is disabled with tooltip `Connection no longer registered`
- **AND** no new tab is created

#### Scenario: Copy SQL works regardless of connection state

- **WHEN** the user clicks `Copy SQL` on any history row
- **THEN** the row's full `sql` text is placed on the system clipboard

### Requirement: Clear history action

The History tab SHALL render a `Clear history` button in the filter bar that, when clicked, opens a confirmation modal showing the count of entries that match the current filters (or the total count if no filters are active). Confirming the modal MUST invoke `query_history_clear` with the active filters and refresh the list.

#### Scenario: Clear with no filters confirms with total count

- **WHEN** there are 8432 entries in the table and no filters are active
- **AND** the user clicks `Clear history`
- **THEN** a modal asks `Delete all 8,432 history entries?` with confirm and cancel actions

#### Scenario: Clear with filters scopes the confirmation and the deletion

- **WHEN** the user has filtered to one connection (matching 320 entries) and clicks `Clear history`
- **THEN** the modal asks `Delete 320 filtered history entries?`
- **AND** confirming deletes only those 320 entries, leaving the rest untouched

### Requirement: Sidebar Plataforma section with History entry

The shell sidebar SHALL render a section labeled `Plataforma`, positioned below the existing `Connections` section, containing at minimum a single clickable row labeled `History` with a clock-style icon. Clicking the row MUST activate the History tab using the same single-instance semantics as the command palette entry.

The Plataforma section MUST share the same visual language as `Connections` (per `app-shell`'s sidebar requirements: same flat group treatment, same row paddings, same scroll context). When the section grows in the future to host additional entries (e.g., Settings), each entry MUST follow the same pattern.

#### Scenario: Plataforma section is visible below Connections

- **WHEN** the user opens Argus
- **THEN** the sidebar shows `Connections` followed by `Plataforma`
- **AND** `Plataforma` contains a single row labeled `History`

#### Scenario: Clicking History opens the tab

- **WHEN** the user clicks the `History` row in the Plataforma section
- **THEN** the History tab is focused (or opened if absent)

### Requirement: Command palette entry for History

The platform SHALL register a command in the command palette with id `argus.history.open`, label `History: Open`, group `History`, and keywords including `recent`, `queries`, `log`. Activating the command MUST open or focus the History tab using the same single-instance semantics as the sidebar entry.

#### Scenario: Command palette finds History: Open

- **WHEN** the user opens the palette and types `hist`
- **THEN** `History: Open` appears in the results

#### Scenario: Activating the command opens the tab

- **WHEN** the user activates `History: Open` from the palette
- **THEN** the History tab is focused (or opened if absent)
- **AND** the palette closes
