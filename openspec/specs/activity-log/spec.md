# activity-log Specification

## Purpose
TBD - created by archiving change activity-log-panel. Update Purpose after archive.
## Requirements
### Requirement: Activity log entry payload

The system SHALL define a typed payload `ActivityLogEntry` emitted from the Rust backend after every Postgres command (success or failure). The payload MUST be serialized to the frontend as JSON with snake_case keys and SHALL contain:

- `v: number` — schema version (initial value `1`).
- `id: string` — UUID identifying this entry.
- `timestamp_unix_ms: number` — wall-clock time at emission.
- `connection_id: string | null` — UUID of the Postgres connection the operation targeted, or `null` when the operation has no bound connection (e.g. `postgres_test_connection` for unsaved params).
- `kind: string` — one of `"test_connection"`, `"connect"`, `"disconnect"`, `"list_schemas"`, `"list_relations"`, `"list_structure"`, `"list_table_extras"`, `"list_columns_bulk"`, `"query_table"`, `"count_table"`, `"apply_edits"`, `"run_sql"`.
- `origin: "auto" | "user"` — whether Argus initiated the call internally (`auto`) or the user did (`user`).
- `duration_ms: number` — elapsed wall time in Rust from command entry to emission.
- `status: "ok" | "err"` — whether the command returned a successful result or an error.
- `sql: string | null` — full SQL text when the command issued one (`query_table`, `count_table`, `run_sql`); for `apply_edits`, the concatenation of every per-op SQL statement separated by `"; "`, truncated to 4000 characters with a trailing `…` when needed; for `run_sql`, the exact SQL of the single statement that was executed (one entry per statement, even within a multi-statement run); `null` for catalog-only or lifecycle commands (including `list_columns_bulk`).
- `params: string[] | null` — bind parameters as `Debug`-formatted strings, each truncated to 200 characters with a trailing `…` marker on truncation. `null` when no parameters were bound; `null` for `apply_edits` (per-op params would balloon and the SQL field carries enough signal); `null` for `run_sql` (this surface does not accept binds from the UI in V1).
- `metric: { kind: "rows", value: number } | { kind: "count", value: number } | { kind: "affected", value: number } | { kind: "server_version", value: string } | { kind: "items", value: number } | null` — per-op secondary metric (see "Per-kind metric mapping").
- `error: { message: string, code: string | null } | null` — populated when `status === "err"`. `code` carries the SQLSTATE when present (forwarded from `AppError::Postgres`).

#### Scenario: Successful query emits a complete entry

- **WHEN** `postgres_query_table` returns successfully with 42 rows in 4 ms after issuing `SELECT … FROM "public"."users"`
- **THEN** an entry is emitted with `kind: "query_table"`, `status: "ok"`, `sql` containing the issued SELECT, `params` matching the bound values, `duration_ms` ≥ 4, `metric: { kind: "rows", value: 42 }`, `error: null`, `v: 1`

#### Scenario: Failing command emits an entry with error

- **WHEN** `postgres_count_table` fails with `AppError::Postgres { code: Some("42P01"), message }`
- **THEN** an entry is emitted with `status: "err"`, `error: { message, code: "42P01" }`, `metric: null`, `duration_ms` measuring time until failure

#### Scenario: Lifecycle command without SQL emits null sql/params

- **WHEN** `postgres_connect` returns successfully
- **THEN** the emitted entry has `sql: null`, `params: null`, and `metric: { kind: "server_version", value: "PostgreSQL 16.x ..." }`

#### Scenario: Apply edits concatenates SQL and nulls params

- **WHEN** `postgres_apply_table_edits` succeeds with 3 ops affecting 3 rows
- **THEN** an entry is emitted with `kind: "apply_edits"`, `status: "ok"`, `sql` containing all three statements separated by `"; "`, `params: null`, `metric: { kind: "rows", value: 3 }`

#### Scenario: Run sql for a SELECT emits an entry with rows metric

- **WHEN** `postgres_run_sql` returns `kind: "rows"` with 8 rows after issuing `SELECT id, name FROM "public"."users"`
- **THEN** an entry is emitted with `kind: "run_sql"`, `status: "ok"`, `origin: "user"`, `sql` containing the issued SELECT verbatim, `params: null`, `metric: { kind: "rows", value: 8 }`

#### Scenario: Run sql for an INSERT emits an entry with affected metric

- **WHEN** `postgres_run_sql` returns `kind: "affected"` with `affected_rows: 3` after issuing an INSERT
- **THEN** an entry is emitted with `kind: "run_sql"`, `status: "ok"`, `metric: { kind: "affected", value: 3 }`

#### Scenario: Bulk columns command emits an entry with item count

- **WHEN** `postgres_list_columns_bulk` returns successfully with 8 relations totalling 47 columns
- **THEN** an entry is emitted with `kind: "list_columns_bulk"`, `status: "ok"`, `origin: "auto"`, `sql: null`, `params: null`, `metric: { kind: "items", value: 47 }`, `error: null`

### Requirement: Tauri event channel

The Postgres module SHALL emit each `ActivityLogEntry` via the Tauri event named `argus:activity-log`. The event MUST be emitted exactly once per command invocation, after the command's primary work completes (whether successfully or with error), and MUST NOT be batched, deduplicated, or coalesced.

#### Scenario: Event emitted on success

- **WHEN** `postgres_list_schemas` completes successfully
- **THEN** exactly one `argus:activity-log` event is emitted whose payload deserializes as a valid `ActivityLogEntry`

#### Scenario: Event emitted on error

- **WHEN** any covered Postgres command returns an `AppError`
- **THEN** exactly one `argus:activity-log` event is emitted with `status: "err"` before the error propagates to the frontend's `invoke()` call site

#### Scenario: Two concurrent commands emit two entries

- **WHEN** two Postgres commands run concurrently and both complete
- **THEN** two distinct `argus:activity-log` events are emitted, each with its own `id` and its own `duration_ms`

### Requirement: Per-kind metric mapping

Each command kind SHALL populate `metric` on success according to a fixed mapping:

| Kind | Metric on success |
|---|---|
| `query_table` | `{ kind: "rows", value: <row count> }` |
| `count_table` | `{ kind: "count", value: <count i64> }` |
| `connect` | `{ kind: "server_version", value: <serverVersion string> }` |
| `test_connection` | `{ kind: "server_version", value: <serverVersion string> }` (only when ok) |
| `list_schemas` | `{ kind: "items", value: <schemas length> }` |
| `list_relations` | `{ kind: "items", value: <tables + views + materialized_views> }` |
| `list_structure` | `{ kind: "items", value: <functions + types + extensions counts, treating None as 0> }` |
| `list_table_extras` | `{ kind: "items", value: <indexes + triggers, None → 0> }` |
| `list_columns_bulk` | `{ kind: "items", value: <total columns across all relations> }` |
| `apply_edits` | `{ kind: "rows", value: <total rows affected across all ops> }` |
| `run_sql` | `{ kind: "rows", value: <row count> }` for `RunSqlResult::Rows`; `{ kind: "affected", value: <affected_rows> }` for `RunSqlResult::Affected` |
| `disconnect` | `null` |

On failure (`status: "err"`), `metric` MUST be `null` regardless of kind. Note that `affected` is a metric variant introduced for `run_sql`; it is semantically distinct from `count` (which is reserved for the explicit `SELECT COUNT(*)` issued by `count_table`) and from `rows` (which is reserved for actual returned row sets).

#### Scenario: Connect carries the server version

- **WHEN** `postgres_connect` succeeds against a server reporting `PostgreSQL 16.2`
- **THEN** the emitted entry has `metric: { kind: "server_version", value: "PostgreSQL 16.2" }`

#### Scenario: List structure with one failed sub-query still reports items

- **WHEN** `postgres_list_structure` returns `{ functions: None, types: Some(7), extensions: Some(3), failures: [{ kind: "functions", … }] }`
- **THEN** the emitted entry has `status: "ok"` and `metric: { kind: "items", value: 10 }` (None counted as 0)
- **AND** `error` remains `null` because the command itself returned `Ok`

#### Scenario: Apply edits reports total rows affected

- **WHEN** `postgres_apply_table_edits` succeeds with 2 updates (1 row each) and 1 delete (1 row), 3 rows total
- **THEN** the emitted entry has `metric: { kind: "rows", value: 3 }`

#### Scenario: Bulk columns reports total cols across relations

- **WHEN** `postgres_list_columns_bulk` returns 5 relations with 4, 7, 12, 8, 16 columns respectively
- **THEN** the emitted entry has `metric: { kind: "items", value: 47 }`

#### Scenario: Run sql DDL reports zero affected

- **WHEN** `postgres_run_sql` runs `CREATE TABLE foo (id int)` and returns `{ kind: "affected", command_tag: "CREATE TABLE", affected_rows: 0 }`
- **THEN** the emitted entry has `metric: { kind: "affected", value: 0 }` and `status: "ok"`

#### Scenario: Run sql truncated SELECT reports the cap as rows

- **WHEN** `postgres_run_sql` returns `kind: "rows"` truncated at 10,000
- **THEN** the emitted entry has `metric: { kind: "rows", value: 10000 }`

### Requirement: Multi-statement run emits one entry per executed statement

When `postgres_run_sql_many` executes a list of statements, the backend SHALL emit one `argus:activity-log` event for each statement that actually executes (i.e. each statement whose `status` is `"ok"` or `"err"`). Statements that are skipped because a prior statement errored MUST NOT emit an event. Each emitted event MUST follow the same payload shape as a single `postgres_run_sql` event, with the `sql` field containing only that statement's SQL text and `metric` reflecting that statement's outcome.

#### Scenario: All-success three-statement run emits three entries

- **WHEN** `postgres_run_sql_many` executes `["SELECT 1", "SELECT 2", "SELECT 3"]` and all succeed
- **THEN** three `argus:activity-log` events are emitted in order, each with `kind: "run_sql"`, `status: "ok"`, and the `sql` field equal to the corresponding statement
- **AND** each event has its own distinct `id` and `duration_ms`

#### Scenario: Failure halts emission for skipped statements

- **WHEN** `postgres_run_sql_many` executes `["SELECT 1", "SELEC 2", "SELECT 3"]`
- **THEN** exactly two `argus:activity-log` events are emitted: one with `status: "ok"` for `SELECT 1`, one with `status: "err"` and `error.code: "42601"` for `SELEC 2`
- **AND** no event is emitted for `SELECT 3` because it was skipped

### Requirement: Frontend listener and ring buffer

The frontend SHALL subscribe to `argus:activity-log` exactly once at app initialization. Received entries MUST be appended to an in-memory ring buffer with capacity 1000. When the buffer reaches capacity, the oldest entry MUST be evicted on each new arrival. The buffer MUST NOT be persisted to disk; it MUST start empty on every app launch. The buffer SHALL be exposed through a React Context that provides:

- `entries: ActivityLogEntry[]` (oldest-first ordering).
- `counts: { user: number, auto: number, total: number }` derived from the current buffer.
- `clear(): void` — empties the buffer.

#### Scenario: First entry appears in the buffer

- **WHEN** the user is connected and the frontend has just received its first `argus:activity-log` event
- **THEN** the Context exposes `entries.length === 1` with that entry

#### Scenario: Buffer caps at 1000 entries

- **WHEN** the buffer already contains 1000 entries and a new event arrives
- **THEN** the new entry is appended and the oldest entry is dropped; the buffer length stays at 1000

#### Scenario: Buffer is empty on app launch

- **WHEN** the user quits Argus while the buffer holds 200 entries and relaunches
- **THEN** on relaunch the buffer is empty before any new commands run

#### Scenario: Counts reflect origin filter

- **WHEN** the buffer holds 12 entries with `origin: "auto"` and 3 with `origin: "user"`
- **THEN** the Context's `counts` is `{ user: 3, auto: 12, total: 15 }`

### Requirement: Bottom activity-log panel

The frontend SHALL render a collapsible activity-log panel positioned between the center work area and the status bar. The panel MUST:

- Be closed by default on first launch and persist its open/closed state under settings key `activityLog.open`.
- When open, occupy a height of `activityLog.height` pixels (default `220`, range `120` to `480`), persisted across launches.
- Be resizable by dragging a 4px handle along its top edge.
- Be hidden from the layout (no DOM space consumed) when closed; expanded with a `--duration-long` (300ms) ease transition when toggled.
- Render its rows using `Geist Mono` for the SQL and timestamp columns, per `DESIGN.md`.
- Use `var(--surface)` for the panel background, `var(--border)` for the top divider and per-row hairlines, and respect the compact density tokens (`5px 12px` cell padding equivalent).

#### Scenario: Closed by default on first launch

- **WHEN** the user launches Argus for the first time
- **THEN** the activity-log panel is not visible and no DOM nodes for its row content are rendered

#### Scenario: Toggling persists across launches

- **WHEN** the user opens the panel, resizes it to 300px, and quits
- **AND** the user relaunches Argus
- **THEN** the panel re-opens at 300px

#### Scenario: Height clamps to allowed range

- **WHEN** the user drags the resize handle aiming for 80px
- **THEN** the panel height clamps to the minimum 120px

### Requirement: Activity-log row rendering

Each row in the activity-log panel SHALL display, left to right: timestamp (HH:mm:ss.SSS, mono), connection label (or `—` when `connection_id` is null), kind, summary (truncated SQL when present, otherwise the kind label), duration_ms (right-aligned, with ms suffix), and status/metric column. Row height MUST be a single line. Long SQL MUST be truncated at 120 characters with a trailing `…`; the full SQL is shown only when the user clicks the row to expand it. Failed entries MUST display the error message in the status column with `var(--danger)` color.

When a row is expanded, the panel SHALL show below it a detail block with: the full SQL (if any), a numbered list of bind parameters (if any), the per-op metric value formatted long-form, and the full error message + SQLSTATE code (if status is err). Clicking the row again or pressing Esc with the row focused MUST collapse it.

#### Scenario: Compact row stays single line

- **WHEN** the panel renders an entry with a 500-character SQL
- **THEN** the row shows the first 120 characters of the SQL followed by `…`; row height matches the other rows

#### Scenario: Expanding a row reveals full SQL and params

- **WHEN** the user clicks a query_table entry whose SQL has 350 characters and 3 bind params
- **THEN** the row expands to show the complete SQL on multiple lines and the three bind params as a numbered list (1, 2, 3)

#### Scenario: Failed entry uses danger color

- **WHEN** an entry has `status: "err"` and `error.message: "relation does not exist"`
- **THEN** the row's status column renders the message in `var(--danger)`

### Requirement: Origin filter (auto vs user)

The activity-log panel SHALL provide an "Show internal activity" toggle in its header. When the toggle is off (default), entries with `origin: "auto"` MUST be hidden from the rendered list. When the toggle is on, all entries are shown. The toggle's state MUST persist across launches under settings key `activityLog.showAuto` (default `false`). Toggling MUST NOT clear or modify the underlying buffer.

#### Scenario: Auto entries hidden by default

- **WHEN** the buffer contains 5 entries with `origin: "auto"` and 2 with `origin: "user"`, and `activityLog.showAuto` is unset
- **THEN** only 2 rows are rendered in the panel

#### Scenario: Toggling reveals auto entries without losing user entries

- **WHEN** the user activates the "Show internal activity" toggle
- **THEN** the panel renders all 7 entries; the 2 user entries remain in their original positions

#### Scenario: Toggle state persists

- **WHEN** the user enables the toggle, quits, and relaunches
- **THEN** on relaunch the toggle is enabled and auto entries are visible again

### Requirement: Status bar entry point

The status bar SHALL render an "Activity Log" affordance on its right side that:

- Shows a counter `Logs (N)` where N is the number of entries currently visible under the active origin filter (so the count matches what the panel would render if opened).
- Shows a chevron icon: `⌃` (up) when the panel is closed, `⌄` (down) when open.
- Is keyboard-accessible (focusable button, activated by Enter/Space).
- Toggles `activityLog.open` on activation.

#### Scenario: Counter reflects visible entries

- **WHEN** the buffer holds 10 user entries and 30 auto entries with the auto filter off
- **THEN** the status-bar affordance reads `Logs (10)`

#### Scenario: Counter updates as new events arrive

- **WHEN** a new `argus:activity-log` event arrives that matches the active filter
- **THEN** the counter increments by 1 within a single render frame

#### Scenario: Chevron flips when toggled

- **WHEN** the user clicks the affordance while the panel is closed
- **THEN** the panel opens and the chevron switches from `⌃` to `⌄`

### Requirement: Auto-stick to bottom on new entries

When the user has not scrolled the panel away from its bottom edge (within 32 pixels of the tail), new arriving entries SHALL cause the panel to scroll to keep the newest entry visible. When the user has scrolled up beyond that threshold, the panel MUST NOT auto-scroll, preserving the user's reading position. A subtle "N new" indicator MUST appear at the bottom edge while auto-scroll is paused; clicking it MUST scroll to the tail and resume auto-stick.

#### Scenario: Auto-stick at the tail

- **WHEN** the panel is open, scrolled to the bottom, and a new entry arrives
- **THEN** the panel auto-scrolls so the new entry is visible

#### Scenario: User scrolls up to read

- **WHEN** the user scrolls up so the bottom is 200px out of view
- **AND** new entries arrive
- **THEN** the scroll position does not change; a `N new` indicator becomes visible at the panel's bottom edge

#### Scenario: Resume tail follows the indicator

- **WHEN** the indicator reads `12 new` and the user clicks it
- **THEN** the panel scrolls to the tail, the indicator disappears, and auto-stick resumes

