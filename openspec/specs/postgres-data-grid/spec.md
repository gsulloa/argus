# postgres-data-grid Specification

## Purpose
TBD - created by archiving change view-table-data. Update Purpose after archive.
## Requirements
### Requirement: Query table command

The Postgres module SHALL expose a Tauri command `postgres_query_table(id, schema, relation, options, origin?)` that executes a paginated `SELECT` against a table, view, or materialized view and returns the rows together with the column metadata. The `options` payload MUST accept `{ limit: number, offset: number, order_by?: Array<{ column: string, direction: "asc" | "desc" }>, filter_tree?: FilterTree, raw_where?: string }` (snake_case keys). `filter_tree` and `raw_where` MUST be mutually exclusive — if both are provided the command MUST return `AppError::Validation { message: "filter_tree and raw_where are mutually exclusive" }` before dispatching SQL. If neither is provided, no `WHERE` clause is emitted. The optional `origin` argument MUST be `"user"` or `"auto"` and defaults to `"auto"` when absent; it is forwarded verbatim into the activity-log event for this command. The response payload MUST be `{ columns: Array<{ name: string, data_type: string, ordinal_position: number, is_nullable: boolean }>, rows: Array<Array<Value>>, applied: { limit: number, offset: number, order_by, filter_tree, raw_where }, query_ms: number, truncated_columns: string[] }`. Rows MUST be returned as JSON-serializable arrays in the same order as `columns`. Postgres values that do not have a natural JSON representation (e.g. `bytea`, large `text`) MAY be returned as a typed string envelope `{ kind: "binary"|"truncated", preview: string, byte_length?: number }` and the column name MUST then appear in `truncated_columns`. The command MUST acquire a connection from the existing pool registry, MUST quote the schema and relation identifiers safely, and MUST NOT open a new connection. The command MUST execute through the read-only-aware `executeQuery` path (it never mutates state). The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "query_table"`, `connection_id: <id>`, `origin: <origin argument>`, `sql: <issued SELECT text>`, `params: <bind params, Debug-formatted, each truncated to 200 chars>`, `metric: { kind: "rows", value: <returned row count> }` on success (`null` on failure), and `status` matching the result. Frontend call sites that initiate the command in response to a user gesture (opening a table, paging, refreshing, sort/filter changes) MUST pass `origin: "user"`; internal pre-fetches MUST pass `origin: "auto"` (or omit the argument).

#### Scenario: Default page returns up to limit rows in declared order

- **WHEN** the user invokes `postgres.queryTable(id, "public", "users", { limit: 200, offset: 0 })`
- **THEN** the response contains up to 200 rows, ordered by the relation's natural row order
- **AND** the `columns` array describes every column in `pg_attribute` ordinal-position order
- **AND** `applied.limit === 200` and `applied.offset === 0`
- **AND** the issued SQL contains no `WHERE` clause

#### Scenario: Order by single column descending

- **WHEN** the user invokes `postgres.queryTable(id, "public", "users", { limit: 200, offset: 0, order_by: [{ column: "created_at", direction: "desc" }] })`
- **THEN** the rows are ordered by `created_at` descending (NULLs last by Postgres default for `desc`)
- **AND** the issued SQL contains a quoted `ORDER BY "created_at" DESC` clause

#### Scenario: Multi-column sort respects array order

- **WHEN** the user invokes `postgres.queryTable` with `order_by: [{ column: "country", direction: "asc" }, { column: "created_at", direction: "desc" }]`
- **THEN** the rows are sorted first by `country` ascending and then by `created_at` descending

#### Scenario: filter_tree compiles to WHERE with AND root

- **WHEN** the user invokes `postgres.queryTable` with `filter_tree: { children: [{ kind: "condition", column: { kind: "named", name: "country" }, op: "=", value: "CL" }, { kind: "condition", column: { kind: "named", name: "deleted_at" }, op: "IS NULL" }] }`
- **THEN** the issued SQL has a `WHERE "country" = $1 AND "deleted_at" IS NULL` clause and the parameter is `"CL"`
- **AND** the response contains only rows matching both predicates

#### Scenario: raw_where is appended verbatim as the WHERE body

- **WHEN** the user invokes `postgres.queryTable` with `raw_where: "created_at > now() - interval '7 days' AND payload->>'source' = 'webhook'"`
- **THEN** the issued SQL has a `WHERE created_at > now() - interval '7 days' AND payload->>'source' = 'webhook'` clause
- **AND** the body is NOT parameterized (it is substituted verbatim)
- **AND** Postgres-level errors (syntax, unknown column) propagate to the caller as `AppError::Postgres`

#### Scenario: Setting both filter_tree and raw_where is rejected

- **WHEN** the user invokes `postgres.queryTable` with both `filter_tree` and `raw_where` set
- **THEN** the command returns `AppError::Validation { message: "filter_tree and raw_where are mutually exclusive" }`
- **AND** no SQL is dispatched to Postgres

#### Scenario: Identifiers are quoted, never interpolated

- **WHEN** the user requests a table whose name contains a double-quote (e.g. `we"ird`)
- **THEN** the issued SQL escapes the identifier as `"we""ird"` using the standard double-quote-doubling rule
- **AND** the command does not concatenate the identifier into the SQL via plain string interpolation

#### Scenario: Read-only connection still serves queries

- **WHEN** the user invokes `postgres.queryTable` against a connection whose pool is in `read_only` mode
- **THEN** the command succeeds and returns rows (this command does not mutate state)

#### Scenario: Unknown relation returns NotFound

- **WHEN** the user invokes `postgres.queryTable(id, "public", "does_not_exist", { limit: 200, offset: 0 })`
- **THEN** the command returns `AppError::Postgres { code: Some("42P01"), ... }` (SQLSTATE for `undefined_table`)

#### Scenario: User-initiated call carries origin user in the activity log

- **WHEN** the data-grid call site invokes `postgres.queryTable` with `origin: "user"` for the initial open of a table
- **THEN** the emitted `argus:activity-log` event has `origin: "user"`, `kind: "query_table"`, `sql` containing the SELECT, `params` matching the bound values, `metric: { kind: "rows", value: <row count> }`

#### Scenario: Origin defaults to auto when omitted

- **WHEN** any caller invokes `postgres.queryTable` without supplying the `origin` argument
- **THEN** the emitted `argus:activity-log` event has `origin: "auto"`

#### Scenario: Failed query emits an entry with truncated SQL/params and code

- **WHEN** `postgres.queryTable` is invoked against `"public"."does_not_exist"` and Postgres returns `42P01`
- **THEN** one `argus:activity-log` event is emitted with `kind: "query_table"`, `status: "err"`, `error.code: "42P01"`, `sql` populated with the attempted SELECT, `metric: null`

### Requirement: Filter operator set

The structured filter payload accepted by `postgres_query_table` (and `postgres_count_table`) SHALL be a `FilterTree` defined as `{ children: Array<FilterNode> }`. A `FilterNode` MUST be one of:

- `{ kind: "condition", column: ColumnRef, op: Operator, value?: Value | Array<Value> | { min: Value, max: Value } }`
- `{ kind: "or_group", children: Array<Condition> }` (a flat OR-group containing only condition leaves; the connector is implicitly OR; nesting another `or_group` inside an `or_group` MUST be rejected)

A `ColumnRef` is `{ kind: "named", name: string }` or `{ kind: "any_column" }`.

The `Operator` set MUST be one of: `=`, `!=`, `<`, `<=`, `>`, `>=`, `LIKE`, `NOT LIKE`, `ILIKE`, `NOT ILIKE`, `Contains`, `StartsWith`, `EndsWith`, `In`, `NotIn`, `BETWEEN`, `IS NULL`, `IS NOT NULL`. The backend MUST reject any other operator with `AppError::Validation`.

Per-operator value rules:

- `=`, `!=`, `<`, `<=`, `>`, `>=`, `LIKE`, `NOT LIKE`, `ILIKE`, `NOT ILIKE` — `value` is a single bound parameter passed verbatim. The user supplies their own `%` for `LIKE`-family.
- `Contains` — compiles to `ILIKE '%' || $n || '%'`. `value` is bound verbatim (no escaping of `%` / `_` in v1).
- `StartsWith` — compiles to `ILIKE $n || '%'`.
- `EndsWith` — compiles to `ILIKE '%' || $n`.
- `In`, `NotIn` — `value` MUST be a non-empty array of scalars. Compiles to `IN ($n, $n+1, ...)` / `NOT IN (...)` with each element bound. Empty arrays MUST be rejected with `AppError::Validation`.
- `BETWEEN` — `value` MUST be `{ min, max }`. Compiles to `BETWEEN $a AND $b`. Inclusive on both bounds.
- `IS NULL`, `IS NOT NULL` — `value` MUST be absent. Providing one MUST be rejected.

Per-column-type rules in the frontend:

- Numeric/date/timestamp columns: surface `=`, `!=`, `<`, `<=`, `>`, `>=`, `BETWEEN`, `In`, `NotIn`, plus `IS NULL` / `IS NOT NULL` if nullable.
- Text columns: surface `=`, `!=`, `LIKE`, `NOT LIKE`, `ILIKE`, `NOT ILIKE`, `Contains`, `StartsWith`, `EndsWith`, `In`, `NotIn`, plus null variants if nullable.
- Boolean columns: surface `=`, `!=`, plus null variants.
- Other types (uuid, json, enum, etc.): surface `=`, `!=`, `In`, `NotIn`, plus null variants.

Values MUST be passed as bound parameters in Structured mode, never interpolated. The frontend MUST surface every operator from the filter bar (not from a per-column header popover; see "Filter bar surface").

#### Scenario: Unknown operator is rejected

- **WHEN** the frontend forwards a condition with `op: "DROP"` (out of the allowed set)
- **THEN** the command returns `AppError::Validation` with a message naming the offending operator
- **AND** no SQL is dispatched to Postgres

#### Scenario: BETWEEN binds two parameters

- **WHEN** the user filters `created_at BETWEEN '2026-01-01' AND '2026-04-30'` via `{ op: "BETWEEN", value: { min: "2026-01-01", max: "2026-04-30" } }`
- **THEN** the issued SQL contains `WHERE "created_at" BETWEEN $1 AND $2` with both bounds bound as parameters
- **AND** rows whose `created_at` equals either bound are included

#### Scenario: Contains compiles to ILIKE with wildcards

- **WHEN** the user filters with `{ column: { kind: "named", name: "name" }, op: "Contains", value: "ana" }`
- **THEN** the issued SQL is `WHERE "name" ILIKE '%' || $1 || '%'` with `$1 = "ana"`
- **AND** the match is case-insensitive

#### Scenario: In binds N parameters

- **WHEN** the user filters with `{ column: { kind: "named", name: "status" }, op: "In", value: ["active", "pending", "trial"] }`
- **THEN** the issued SQL is `WHERE "status" IN ($1, $2, $3)` with parameters `"active"`, `"pending"`, `"trial"`

#### Scenario: Empty In array is rejected

- **WHEN** the user forwards `{ op: "In", value: [] }`
- **THEN** the command returns `AppError::Validation` and no SQL is dispatched

#### Scenario: IS NULL with a value is rejected

- **WHEN** the user forwards `{ op: "IS NULL", value: "x" }`
- **THEN** the command returns `AppError::Validation` and no SQL is dispatched

### Requirement: Count rows command

The Postgres module SHALL expose a Tauri command `postgres_count_table(id, schema, relation, filters?, origin?)` that returns `{ count: number, query_ms: number }` by issuing `SELECT COUNT(*) FROM <quoted-relation> [WHERE …]` against the connection's pool. The command MUST honor the same `filters` shape as `postgres_query_table` so the user can count exactly the rows they are filtering on. The optional `origin` argument MUST be `"user"` or `"auto"` and defaults to `"auto"`. The count MUST be exact (not estimated) — estimated counts already live on `pg_class.reltuples` and are surfaced by the schema browser; the explicit count is the user-driven escape hatch when they need certainty. The frontend MUST NOT call this command implicitly; it MUST fire only on user activation of the "Count rows" button, and that call site MUST pass `origin: "user"`. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "count_table"`, `connection_id: <id>`, `origin: <origin argument>`, `sql: <issued COUNT text>`, `params: <bind params, Debug-formatted>`, `metric: { kind: "count", value: <returned count> }` on success (`null` on failure), and `status` matching the result.

#### Scenario: Filtered count returns matching subset

- **WHEN** the user has filters `{ country = 'CL', deleted_at IS NULL }` active and clicks "Count rows"
- **THEN** the command returns the exact count of rows in the relation that match those filters
- **AND** that count is rendered next to the per-page count in the bottom bar

#### Scenario: Count is on demand, never automatic

- **WHEN** the user opens a table tab without clicking "Count rows"
- **THEN** the bar shows `Showing X rows · Page Y` and a `Count rows` button, but no total count and no implicit `SELECT COUNT(*)` is dispatched

#### Scenario: User-initiated count emits origin user

- **WHEN** the user clicks "Count rows" and the command returns 12,345
- **THEN** one `argus:activity-log` event is emitted with `kind: "count_table"`, `origin: "user"`, `status: "ok"`, `metric: { kind: "count", value: 12345 }`, `sql` containing the COUNT statement

#### Scenario: Failing count emits an entry with error

- **WHEN** the count fails because the relation no longer exists
- **THEN** one `argus:activity-log` event is emitted with `kind: "count_table"`, `status: "err"`, `error.code: "42P01"`, `metric: null`

### Requirement: Per-table viewer tab

The frontend SHALL register a tab kind `postgres-table-data` and SHALL render it when the user activates a table, view, or materialized view in the schema tree. The tab's payload MUST be `{ connectionId, connectionName, schema, relation, relationKind: "table" | "view" | "materialized-view" }`. The tab MUST have a stable id `pgtbl:<connectionId>:<schema>:<relation>` so that re-activating the same node focuses the existing tab rather than opening a duplicate. Activating any other object kind (function, type, extension, index, trigger) MUST continue to open the existing `postgres-object-placeholder` tab. The viewer tab MUST persist its scroll position across tab switches inside the same session (not across app restarts).

The viewer tab body SHALL render an internal sub-tabset with three tabs in this order: **Data**, **Structure**, **Raw**. The sub-tabset header MUST be a segmented control rendered above the body of all three subtabs and MUST be visible regardless of which subtab is active. Only one subtab is rendered at a time.

The Data subtab MUST host the existing data UI (filter bar, virtualized data grid, inspector, bottom bar, edit affordances) without behavior changes. The Structure and Raw subtabs MUST be rendered by components owned by the `postgres-table-structure` capability and receive `{ connectionId, schema, relation, relationKind }` as props.

The active subtab is per-tab in-memory state with these rules:

- A freshly opened table tab MUST start on **Data**.
- Switching to a different browser tab and back to the table tab MUST preserve the active subtab.
- Closing and reopening the table tab MUST reset the active subtab to **Data** (no persistence across tab close).
- The active subtab MUST NOT be persisted across app restarts.

While the table tab is focused AND the keyboard focus is not inside an `<input>`, `<textarea>`, or a CodeMirror editor, the following keyboard shortcuts MUST be active:

- `Cmd+1` (macOS) / `Ctrl+1` (other) → activate **Data**.
- `Cmd+2` / `Ctrl+2` → activate **Structure**.
- `Cmd+3` / `Ctrl+3` → activate **Raw**.

Switching subtabs MUST NOT trigger a `postgres_query_table`, `postgres_count_table`, or any data-grid fetch. The first activation of Structure or Raw is the only place a `postgres_table_structure` call is dispatched (see the `postgres-table-structure` capability for the contract).

#### Scenario: Activating a table opens the data viewer

- **WHEN** the user activates the table node `analytics.events`
- **THEN** a center-area tab of kind `postgres-table-data` opens with payload `{ connectionId, connectionName, schema: "analytics", relation: "events", relationKind: "table" }`
- **AND** the placeholder tab is NOT opened
- **AND** the active subtab is **Data**

#### Scenario: Activating a view opens the data viewer

- **WHEN** the user activates a view or materialized view node
- **THEN** the same `postgres-table-data` tab opens with `relationKind: "view"` or `"materialized-view"` respectively
- **AND** the active subtab is **Data**

#### Scenario: Activating a function still opens the placeholder

- **WHEN** the user activates a function, type, extension, index, or trigger node
- **THEN** the existing `postgres-object-placeholder` tab opens (this change does not implement those viewers)

#### Scenario: Reactivation focuses the existing tab

- **WHEN** the user activates the same table node a second time
- **THEN** the existing `postgres-table-data` tab is focused and no new tab is opened
- **AND** the active subtab is whatever it was before the user navigated away

#### Scenario: Sub-tabset header is always visible

- **WHEN** the table tab is open on any subtab
- **THEN** the segmented Data / Structure / Raw control is rendered at the top of the viewer body
- **AND** the currently active subtab is visually selected in the control

#### Scenario: Switching subtabs does not refetch data

- **WHEN** the Data subtab has loaded rows and the user clicks **Structure**
- **THEN** no new `postgres_query_table` invocation is dispatched
- **AND** when the user clicks **Data** again, the previously buffered rows and scroll position are still in place

#### Scenario: Subtab choice survives tab switching

- **WHEN** the user is on the Structure subtab of `public.users` and clicks a different browser tab, then clicks back to `public.users`
- **THEN** the Structure subtab is still active

#### Scenario: Closing the tab resets the subtab

- **WHEN** the user is on the Structure subtab of `public.users`, closes the tab, and reopens `public.users` from the schema browser
- **THEN** the table tab opens on the **Data** subtab

#### Scenario: Cmd+1 / Cmd+2 / Cmd+3 activate subtabs

- **WHEN** the table tab is focused, the focus is not inside an editor, and the user presses `Cmd+2` (macOS) or `Ctrl+2` (other)
- **THEN** the Structure subtab becomes active
- **AND** pressing `Cmd+1` returns to Data, `Cmd+3` switches to Raw

#### Scenario: Subtab shortcuts do not fire from inside an editor

- **WHEN** the user has keyboard focus inside the filter-bar Raw editor or inside an inline cell editor and presses `Cmd+2`
- **THEN** the active subtab does NOT change
- **AND** the keystroke is handled by the focused editor (or ignored)

### Requirement: Virtualized data grid

The viewer tab SHALL render the rows in a virtualized grid powered by `@tanstack/react-table` for column / row modeling and `@tanstack/react-virtual` for vertical row virtualization. The grid MUST keep DOM row count proportional to the visible viewport (not to the dataset size) so that loading 10k+ rows is smooth. The grid MUST display column names in `Geist Mono` (the codebase token), tabular numerals for numeric and date columns, and a single hairline divider between rows (per `DESIGN.md`). The active row MUST be highlighted with the `--accent-soft` background. Cell padding MUST be the compact density specified in `DESIGN.md` (`5px 12px`). Long values MUST be truncated with an ellipsis at the cell boundary; full content is shown via the inspector panel.

When the connection is writable AND the relation has a PK, the grid MUST also render in editable mode: cells edited via the buffer (kind `update` or `insert`) MUST be rendered with a dirty-state background distinct from `--accent-soft` (a softer warning hue, formalized in `DESIGN.md` as part of this change if not already present); rows marked for delete (kind `delete`) MUST be rendered with strike-through text and a faded foreground color; insert rows MUST be rendered at the top of the buffer with their dirty cells styled the same as updated cells.

#### Scenario: Loading 10k rows stays responsive

- **WHEN** the user has loaded a table with 10,000 buffered rows
- **THEN** the grid renders no more than `viewport_height / row_height + overscan` row DOM nodes at any time
- **AND** scrolling does not block the main thread for visibly long stalls

#### Scenario: Active row uses the accent-soft stripe

- **WHEN** the user clicks a row to select it
- **THEN** that row's background uses the `--accent-soft` token from `DESIGN.md`
- **AND** the inspector panel updates to that row

#### Scenario: Dirty cell has a distinct background

- **WHEN** the user edits a cell so that it is now in the buffer's `update` set
- **THEN** that cell renders with the dirty-state background
- **AND** the dirty-state background is visually distinct from the active-row `--accent-soft` highlight (so an active row with one dirty cell shows both states)

#### Scenario: Row marked for delete is rendered struck through

- **WHEN** the user marks a row for delete
- **THEN** that row's text is rendered with strike-through and a faded foreground color
- **AND** the row remains visible (not hidden) until commit

#### Scenario: Insert row appears at the top of the buffer

- **WHEN** the user clicks "Add row"
- **THEN** the new row appears as the first row in the visible buffer
- **AND** does not move when the active sort changes (insert rows keep their position until commit)

### Requirement: Scroll-to-load pagination

The viewer SHALL load additional pages by issuing `postgres_query_table` with an incremented `offset` whenever the user scrolls within `2 * page_size` rows of the loaded buffer's tail. While a page request is in flight the grid MUST display a subtle inline loading row at the buffer's tail. If the request fails, an inline error row with a Retry affordance MUST replace the loading row; activating Retry MUST re-issue the same request. Sort and filter changes MUST reset the buffer to the first page.

#### Scenario: Approaching the buffer tail triggers the next page

- **WHEN** the user has 200 rows loaded and scrolls so that row 100 (i.e. within `2 * 200` rows of the tail at row 200) becomes visible
- **THEN** `postgres.queryTable` is invoked with the next `offset = 200` and the same `limit`
- **AND** the new rows append to the buffer

#### Scenario: Sort change resets the buffer

- **WHEN** the user changes the sort while 1,000 rows are buffered
- **THEN** the buffer is cleared and the first page is re-fetched with the new `order_by`

#### Scenario: Filter change resets the buffer

- **WHEN** the user adds, removes, or edits a column filter
- **THEN** the buffer is cleared and the first page is re-fetched with the new `filters`

#### Scenario: In-flight loading row is shown at the tail

- **WHEN** a page request is in flight
- **THEN** a single loading row is rendered at the buffer's tail with a spinner; it is not selectable

#### Scenario: Failed page renders an inline retry

- **WHEN** a page request fails
- **THEN** the loading row is replaced by an error row with the typed error message and a Retry button
- **AND** activating Retry re-issues the same request without resetting the buffer

### Requirement: Per-table page size

The frontend SHALL persist a per-table page size under the settings key `pgTableLimit:<connectionId>:<schema>:<relation>` (number). When unset, the page size MUST default to 200 rows. A control in the viewer's bottom bar MUST let the user pick from `100 / 200 / 500 / 1000` and changes MUST persist immediately and reset the buffer to a fresh first page using the new size. The setting MUST be scoped per connection — two connections inspecting the same `<schema>.<relation>` MUST NOT share state.

#### Scenario: Default page size is 200

- **WHEN** the user opens a table tab for the first time and no setting is stored
- **THEN** the first `postgres.queryTable` invocation has `limit: 200`

#### Scenario: Changing page size persists and refetches

- **WHEN** the user changes the page-size selector to `500`
- **THEN** the buffer is cleared, a new first page is fetched with `limit: 500`
- **AND** the next time the user reopens that table in a future app session, the page size is still `500`

#### Scenario: Page size is per connection

- **WHEN** the user has set `1000` for `connectionA.public.users` and opens `connectionB.public.users`
- **THEN** `connectionB.public.users` uses the default `200`, not `1000`

### Requirement: Inspector panel

The viewer SHALL render an inspector panel pinned to the right of the grid. When a row is selected, the inspector MUST list every column from the response's `columns` array as a field showing `column name (data_type) → value`. Columns whose value was returned as a `truncated`/`binary` envelope MUST display the preview plus the original byte length. Long text values in the inspector MUST be scrollable inside their field, not truncated. When no row is selected, the inspector MUST display a hint such as "Select a row to inspect". The inspector MUST be horizontally resizable by dragging its left edge; the width MUST persist under `pgInspectorWidth` (a single global setting, not per-table) with a sensible minimum (e.g. 280px).

When the viewer is in editable mode, the inspector MUST reflect the buffer's dirty state for the selected row: cells that have been edited in the buffer MUST display the dirty value (not the server value), with a visual marker indicating the field is dirty. Editing inside the inspector MUST be supported as an alternative to inline grid editing for non-PK columns; changes commit to the buffer the same way (no direct DB writes). PK columns of existing rows MUST remain read-only in the inspector. Truncated/binary cells MUST remain read-only in the inspector regardless of mode.

#### Scenario: Selecting a row populates the inspector

- **WHEN** the user clicks any row in the grid
- **THEN** the inspector lists every column with its data type and value
- **AND** the field for a `text` column with a 5KB value is scrollable (not visually truncated)

#### Scenario: Truncated values show preview and byte length

- **WHEN** a column was returned as `{ kind: "truncated", preview, byte_length }`
- **THEN** the inspector field shows the preview plus a label like `5.2 KB`

#### Scenario: Width persists across sessions

- **WHEN** the user resizes the inspector to 420px
- **THEN** the next time the user opens any table viewer in any future app session, the inspector renders at 420px

#### Scenario: Inspector reflects dirty cell

- **WHEN** the user edits a cell in the grid then selects that row
- **THEN** the inspector field for that column shows the dirty value (not the server value)
- **AND** the field has a visual dirty marker

#### Scenario: Inspector edit commits to buffer

- **WHEN** the user is on a writable connection, selects a row, and edits a non-PK field in the inspector
- **THEN** that change is reflected in the buffer (the corresponding grid cell renders with dirty highlight)
- **AND** no SQL is dispatched until the user runs `⌘S` (which applies the buffer directly via `postgres_apply_table_edits`)

### Requirement: Bottom bar status

The viewer SHALL display a bottom bar with: a row counter `Showing <N> rows · Page <P>` (where N is the current buffer size and P is the highest loaded page), the page-size selector, a `Count rows` button, an inline `query_ms` indicator from the most recent successful `postgres.queryTable`, and a clear-filters affordance when one or more filters are active. After the user clicks `Count rows`, the bar MUST replace `Showing <N> rows` with `Showing <N> of <Total> rows`, where Total is the result of `postgres_count_table` honoring the active filters. The total MUST be invalidated whenever the filter set changes (so the user must click `Count rows` again for the new filter set).

When the viewer is in editable mode, the bottom bar MUST also render: an "Add row" button (hidden on views/materialized views), a "Save" button enabled only when the buffer has dirty entries (showing `Save (<N>)` where N is the count of pending operations), and an unsaved-changes indicator. When the connection is read-only, the bottom bar MUST instead render a "Read-only connection — edits disabled" banner replacing the "Add row" / "Save" controls. When the relation has no PK on a writable connection, the bottom bar MUST render a "No primary key — existing rows are not editable" banner alongside the "Add row" button.

#### Scenario: Default bar shows partial info

- **WHEN** the user has 400 rows buffered across two pages and has not clicked `Count rows`
- **THEN** the bar reads `Showing 400 rows · Page 2`, plus the page-size selector, the `Count rows` button, and the most recent `query_ms`

#### Scenario: Count rows updates the indicator

- **WHEN** the user clicks `Count rows` and the count returns `12,345`
- **THEN** the bar reads `Showing 400 of 12,345 rows · Page 2`

#### Scenario: Filter change invalidates the count

- **WHEN** the bar shows `Showing 400 of 12,345 rows` and the user adds a new column filter
- **THEN** the bar reverts to `Showing <N> rows · Page <P>` and the user must click `Count rows` again to get a count under the new filters

#### Scenario: Save button reflects pending edit count

- **WHEN** the user has 2 dirty cells and has marked 1 row for delete
- **THEN** the bar's Save button reads `Save (3)` and is enabled

#### Scenario: Read-only banner replaces edit controls

- **WHEN** the user is viewing a table on a connection with `params.read_only: true`
- **THEN** the bottom bar does NOT render the "Add row" or "Save" controls
- **AND** the bar shows a banner reading "Read-only connection — edits disabled"

#### Scenario: No-PK banner appears alongside Add row

- **WHEN** the user is viewing a table without a PK on a writable connection
- **THEN** the bar shows the "Add row" button (insert is allowed)
- **AND** also shows a banner reading "No primary key — existing rows are not editable"

### Requirement: Read-only execution path

`postgres_query_table` and `postgres_count_table` MUST execute through the pool's read-only-aware execute helper (the same `executeQuery` path used by the schema browser) so that future read-only enforcement changes apply uniformly. They MUST NOT use any `executeMutation`-style helper. When the connection is writable AND the relation has a PK, the viewer SHALL expose mutation affordances (inline cell editing, "Add row", delete-on-`⌫`, `⌘S` to commit) routed through the `postgres-data-edit` capability commands. When the connection is `read_only: true`, mutation affordances MUST NOT be rendered AND the viewer MUST display a "Read-only connection — edits disabled" banner in the bottom bar.

Mutation affordances and the read-only banner are scoped to the **Data** subtab. The Structure and Raw subtabs are read-only on every connection and MUST NOT render an "edits disabled" banner of their own (the Structure / Raw surfaces never edit anything to begin with).

#### Scenario: Read-only flag does not block reads

- **WHEN** the user opens the viewer on a connection in `read_only: true`
- **THEN** rows load normally on the Data subtab and no error is surfaced
- **AND** no UI affordance for mutating the data is rendered (edit, add, delete affordances are hidden)
- **AND** the bottom bar shows the "Read-only connection — edits disabled" banner on the Data subtab only

#### Scenario: Writable connection exposes mutation affordances

- **WHEN** the user opens a table viewer on a connection with `params.read_only: false` for a relation that has a PK
- **THEN** double-clicking a non-PK cell on the Data subtab enters inline edit mode
- **AND** the bottom bar renders the "Add row" and "Save" controls

#### Scenario: Structure and Raw subtabs never render the edits-disabled banner

- **WHEN** the user is on the Structure or Raw subtab on a `read_only: true` connection
- **THEN** the "Read-only connection — edits disabled" banner is NOT shown on those subtabs
- **AND** no mutation affordances are rendered on those subtabs

### Requirement: Adhoc result grid sub-component

The `postgres-data-grid` capability SHALL expose a reusable read-only sub-component `<AdhocResultGrid columns rows onSelectRow />` consumable by other capabilities (notably `postgres-sql-editor`). The component MUST:

- Accept `columns: ColumnInfo[]` and `rows: Array<Array<Value>>` matching the same shape as `postgres_query_table`'s response (`ColumnInfo` has `name`, `data_type`, `ordinal_position`, `is_nullable`; `Value` MAY be a typed envelope `{ kind: "binary"|"truncated", … }`).
- Render the rows in a virtualized grid with the same DOM-row count behavior, styling tokens (`Geist Mono`, tabular numerals, hairline dividers, compact `5px 12px` cell padding), and active-row `--accent-soft` highlight as the table viewer's grid.
- Support row selection via click or keyboard arrow keys; the selected row index is reported through the `onSelectRow(rowIndex: number)` callback.
- Truncate long values with an ellipsis at the cell boundary; full content is shown via the consumer-provided inspector (the consumer reads the selected row and renders fields elsewhere).
- NOT include sort/filter controls, scroll-to-load pagination, edit affordances, or a bottom bar. It is purely a presentational virtualized grid.
- Render no rows and a configurable empty-state when `rows.length === 0`; the consumer passes the empty-state element via a `emptyState` prop.

The internal implementation MAY share a virtualization primitive with the existing editable table viewer grid; the public contract of `<AdhocResultGrid />` MUST be free of edit-related props.

#### Scenario: Adhoc grid renders rows with shared styling

- **WHEN** the consumer renders `<AdhocResultGrid columns={cols} rows={rs} onSelectRow={fn} />` with 50 rows and 4 columns
- **THEN** the grid renders with `Geist Mono`, hairline dividers between rows, and compact cell padding
- **AND** the active-row highlight uses `--accent-soft`

#### Scenario: Selecting a row invokes the callback

- **WHEN** the user clicks the third row
- **THEN** `onSelectRow(2)` is called once
- **AND** the third row's background uses `--accent-soft`

#### Scenario: Adhoc grid does not render edit affordances

- **WHEN** the consumer renders the adhoc grid against any data
- **THEN** there are no edit inputs, no `+` button, no Save button, no sort/filter chrome rendered by the component
- **AND** double-clicking a cell does not enter an edit mode

#### Scenario: Empty state is rendered when rows is empty

- **WHEN** the consumer renders `<AdhocResultGrid columns={cols} rows={[]} emptyState={<p>No rows</p>} />`
- **THEN** the grid renders the column header row and the consumer-provided empty state below it
- **AND** no virtualized row container is rendered

#### Scenario: Truncated/binary cells render as preview

- **WHEN** a cell value is `{ kind: "truncated", preview: "…", byte_length: 5300 }`
- **THEN** the cell shows the preview truncated to fit and the column appears in the consumer's truncated-columns awareness if applicable

### Requirement: Deterministic first-page load on viewer mount

The data viewer's loading state machine SHALL guarantee that, on a clean mount with the connection reachable and the relation accessible, the viewer transitions from `loading-first` to either `ready` (with rows populated) or `error` (with the error surfaced) without depending on any subsequent re-render, user interaction, or upstream state change. The transition MUST hold under React 18 StrictMode (mount → unmount → remount) so that development and production behave identically. Any in-flight cancellation token used to invalidate stale responses MUST NOT be allowed to invalidate the fetch issued by the initial mount when no concurrent reset has occurred.

#### Scenario: Empty table renders empty state, not infinite spinner

- **WHEN** the user activates a table whose `SELECT` returns zero rows AND the underlying Tauri command resolves successfully
- **THEN** the viewer transitions out of `loading-first` to `ready`
- **AND** the spinner is no longer shown
- **AND** the data grid is rendered (visibly empty rather than the loading placeholder)

#### Scenario: Non-empty table renders rows on first mount

- **WHEN** the user activates a table whose `SELECT` returns N rows AND the underlying Tauri command resolves successfully
- **THEN** the viewer transitions to `ready`
- **AND** the grid renders all N returned rows in column order

#### Scenario: First-page error surfaces to the error banner

- **WHEN** the user activates a table AND the underlying Tauri command rejects with an `AppError`
- **THEN** the viewer transitions out of `loading-first` to `error`
- **AND** the error banner is shown with the error message and a retry control

#### Scenario: StrictMode mount/unmount/remount does not strand the viewer

- **WHEN** the viewer hook is mounted under `<React.StrictMode>` so that React invokes mount → cleanup → mount a second time
- **THEN** the second mount's first-page fetch reaches a `ready` (or `error`) terminal state
- **AND** the viewer does not remain stuck in `loading-first` after both mounts' fetches resolve

#### Scenario: Loading→ready transition does not require a side-effectful re-render

- **WHEN** the user activates a table AND no other state changes after mount (no filter change, no sort change, no page-size change, no async settings load)
- **THEN** the viewer still transitions to `ready` once the first-page fetch resolves
- **AND** the transition does not depend on `usePageSize` finishing its async load with a non-default value

### Requirement: Filter bar surface

The viewer tab SHALL render a filter bar pinned to the top of the data grid, above the column header row and below any tab title chrome. The filter bar MUST be the only filter surface in the data grid — there MUST NOT be a per-column header funnel or popover. Removing the popover MUST NOT remove the existing column-header sort affordance (sort remains accessible from the column header).

The bar MUST always be visible while a `postgres-table-data` tab is mounted; it MUST NOT auto-collapse on scroll. It MAY be collapsed manually by the user via a toggle (chevron) in the bar; the collapsed state MUST NOT discard any draft or applied filters.

The bar MUST contain, in order: a Mode toggle (Structured / Raw SQL), the body for the active mode (the conditions UI for Structured, the WHERE editor for Raw), and an action row with `Reset`, `Apply`, and `Open in SQL Editor`. The `Apply` button MUST be the rightmost primary control.

#### Scenario: Bar is the only filter surface

- **WHEN** the user opens a `postgres-table-data` tab
- **THEN** the filter bar is rendered above the data grid
- **AND** there is no funnel icon or filter popover trigger on any column header

#### Scenario: Sort affordance survives popover removal

- **WHEN** the user clicks a column header
- **THEN** the existing sort cycle (`asc → desc → none`) fires
- **AND** no filter popover is shown

#### Scenario: Collapsing the bar preserves state

- **WHEN** the bar has applied filters and the user toggles the bar collapsed, then expanded
- **THEN** all applied and draft filters are preserved exactly

### Requirement: Filter draft and applied state

`TableViewerTab` SHALL maintain two filter values for each tab: `draft` and `applied`. Only `applied` MUST be passed to `postgres_query_table` and `postgres_count_table`. Edits to the filter bar MUST update `draft` only. The bar MUST display a dirty indicator (a small `●` adjacent to the `Apply` button) whenever `draft` differs from `applied`. The bar MUST bind `Cmd+Enter` (macOS) / `Ctrl+Enter` (other) to "Apply" and `Esc` to "Discard draft" while focused. Pressing `Apply` MUST set `applied = draft`. Pressing `Reset` MUST set `draft` to the empty filter model AND set `applied` to the empty filter model in one update (clearing both at once). Discarding draft MUST set `draft = applied` (no fetch). Mode toggling rules are described under "Raw WHERE mode".

#### Scenario: Editing a row updates draft only

- **WHEN** the user adds a condition row and types into the value input
- **THEN** the bar dirty indicator becomes visible
- **AND** the data grid does NOT re-fetch
- **AND** `applied` is unchanged

#### Scenario: Apply commits draft and triggers fetch

- **WHEN** the user has a dirty draft and presses `Apply` (or `Cmd+Enter`)
- **THEN** `applied` becomes equal to `draft`
- **AND** the dirty indicator disappears
- **AND** `postgres.queryTable` is invoked with the new `applied` filters

#### Scenario: Esc discards draft to applied

- **WHEN** the user has a dirty draft and presses `Esc` while focused inside the bar
- **THEN** `draft` returns to the value of `applied`
- **AND** the dirty indicator disappears
- **AND** no fetch is triggered

#### Scenario: Reset clears both draft and applied

- **WHEN** the user has applied filters and presses `Reset`
- **THEN** both `draft` and `applied` become empty
- **AND** `postgres.queryTable` is invoked with no `filter_tree` and no `raw_where`

### Requirement: AND root with OR groups

The Structured filter model SHALL be a tree with an implicit `AND` root. Children of the root are either condition leaves or OR groups. An OR group MUST contain at least one condition leaf and MUST NOT contain another group (one level of nesting maximum). Removing the last condition from an OR group MUST collapse the group node out of the tree. The bar MUST expose two add affordances: `+ AND row` (adds a condition leaf as a sibling of root children) and `+ OR group` (adds an OR group with one empty condition row inside).

The compiled `WHERE` body MUST place each OR group in parentheses. An empty tree (no children) MUST result in no `WHERE` clause being emitted.

#### Scenario: Flat AND children compile to ANDed predicates

- **WHEN** the tree has three sibling condition leaves at root
- **THEN** the compiled WHERE is `<p1> AND <p2> AND <p3>` with no parens

#### Scenario: OR group compiles to a parenthesized OR

- **WHEN** the tree has one root condition and one OR group of two conditions
- **THEN** the compiled WHERE is `<p_root> AND (<p_or1> OR <p_or2>)`

#### Scenario: OR group with one condition still parenthesizes

- **WHEN** an OR group contains exactly one condition
- **THEN** the compiled WHERE wraps it as `(<p>)` (the parens make the boundary explicit; the result is semantically equivalent)

#### Scenario: Empty OR group is collapsed

- **WHEN** the user removes the last condition from an OR group
- **THEN** the OR group node is removed from the tree
- **AND** the compiled WHERE no longer contains it

#### Scenario: Cannot nest OR group inside OR group

- **WHEN** the frontend attempts to send a tree with an `or_group` inside another `or_group`
- **THEN** the backend returns `AppError::Validation` and no SQL is dispatched

#### Scenario: Empty tree emits no WHERE

- **WHEN** the user has no conditions and no OR groups
- **THEN** the issued SQL has no `WHERE` clause

### Requirement: Any column search

The Structured filter model SHALL accept a special `ColumnRef` `{ kind: "any_column" }` representing a search across every text-castable column of the relation. The frontend MUST surface "Any column" as the first option in the column picker. Operators allowed for `any_column` MUST be: `=`, `!=`, `LIKE`, `NOT LIKE`, `ILIKE`, `NOT ILIKE`, `Contains`, `StartsWith`, `EndsWith`. All other operators applied to `any_column` MUST be rejected by the backend with `AppError::Validation`.

The backend MUST expand an `any_column` condition by enumerating every column of the target relation whose `data_type` is text-castable (everything except `bytea` and composite/row types) and emitting:

```sql
(col1::text [op] $n OR col2::text [op] $n OR ...)
```

…where the same single bound parameter `$n` is shared across all branches. If the target relation has zero text-castable columns, the condition MUST compile to `FALSE`.

The frontend MUST display a small warning marker (e.g. a `⚠` icon with tooltip) on Any-column rows reading "Searches every text-castable column — slow on large tables."

#### Scenario: Any column with Contains expands across columns

- **WHEN** the user adds a condition `{ column: any_column, op: "Contains", value: "argus" }` against a relation with text-castable columns `name`, `email`, `notes`
- **THEN** the compiled WHERE is `("name"::text ILIKE '%' || $1 || '%' OR "email"::text ILIKE '%' || $1 || '%' OR "notes"::text ILIKE '%' || $1 || '%')`
- **AND** `$1 = "argus"`

#### Scenario: bytea and composite columns are skipped

- **WHEN** the relation has columns `name text`, `payload bytea`, `data my_composite_type`
- **AND** the user adds an Any-column condition
- **THEN** the compiled WHERE references only the `name` column

#### Scenario: Any column with disallowed operator is rejected

- **WHEN** the frontend forwards `{ column: any_column, op: "BETWEEN", value: { min: 1, max: 10 } }`
- **THEN** the command returns `AppError::Validation` and no SQL is dispatched

#### Scenario: Any column with no text-castable columns compiles to FALSE

- **WHEN** the relation has only `bytea` columns and the user adds an Any-column condition
- **THEN** the compiled WHERE is `(FALSE)`
- **AND** the query returns zero rows

#### Scenario: Any-column row shows a performance warning

- **WHEN** the user adds an Any-column condition row
- **THEN** the row renders a `⚠` icon with the tooltip "Searches every text-castable column — slow on large tables."

### Requirement: Raw WHERE mode

The filter bar SHALL include a Mode toggle with two options: `Structured` and `Raw SQL`. Switching modes MUST follow these rules:

- **Structured → Raw SQL:** The bar MUST seed the Raw editor with the result of the TS-side `compileWhere(draft)` (the equivalent SQL `WHERE` body for the current Structured draft). No data is lost.
- **Raw SQL → Structured:** The bar MUST display a confirmation dialog reading "Switch to structured? Your raw WHERE will be discarded." with `Cancel` (default) and `Switch` actions. On `Switch`, the Raw body MUST be cleared and the Structured tree MUST be reset to empty. On `Cancel`, the mode does not change.

The Raw editor MUST be a CodeMirror 6 instance configured with the Postgres SQL dialect for syntax highlighting only. It MUST NOT bind run shortcuts (`Cmd+Enter` is reserved for Apply at the bar level), MUST NOT enable autocomplete, and MUST NOT enforce a leading `WHERE` keyword (a leading `WHERE ` typed by the user MUST be trimmed once before being sent as `raw_where`). An empty Raw body MUST be sent as `raw_where: undefined` (no WHERE clause).

#### Scenario: Switching Structured to Raw seeds the editor

- **WHEN** the Structured draft compiles to `"country" = 'CL' AND ("status" = 'active' OR "status" = 'pending')`
- **AND** the user toggles to Raw SQL mode
- **THEN** the Raw editor is seeded with that exact body

#### Scenario: Switching Raw to Structured prompts before discarding

- **WHEN** the user has a non-empty Raw body and toggles to Structured
- **THEN** a confirm dialog is shown with `Cancel` as the default action
- **AND** Cancel keeps the mode as Raw and preserves the body
- **AND** Switch resets the Structured tree to empty AND clears the Raw body

#### Scenario: Empty Raw body sends no raw_where

- **WHEN** the user is in Raw mode with an empty editor and presses Apply
- **THEN** `postgres.queryTable` is invoked with `raw_where: undefined` and no `filter_tree`

#### Scenario: Leading WHERE keyword is trimmed

- **WHEN** the user types `WHERE created_at > now()` in the Raw editor and presses Apply
- **THEN** `raw_where` is sent as `"created_at > now()"` (the leading `WHERE ` is stripped once)
- **AND** the issued SQL has a single `WHERE created_at > now()` clause

#### Scenario: Postgres errors surface from Raw

- **WHEN** the user types a syntactically invalid WHERE (e.g. `created_at >`) and presses Apply
- **THEN** the command returns `AppError::Postgres` with the syntax error
- **AND** the bar surfaces the error inline near the Raw editor (not via a global toast)

### Requirement: Open in SQL Editor

The filter bar SHALL include an `Open in SQL Editor` action that opens a new `postgres-query` tab on the same connection with a prefilled SELECT reflecting the current `applied` filter set. The action MUST NOT require the user to apply pending draft changes first; if there is a dirty draft, the action uses `applied` (the drafted predicates are not opened). The generated SQL MUST be:

```
SELECT * FROM "<schema>"."<relation>"
[WHERE <where>]
[ORDER BY <orders>]
LIMIT <current_page_size>
```

Where:
- `<where>` is the TS-compiled WHERE body for `applied` (Structured) or the raw `applied.raw_where` body (Raw). If `applied` is empty, the WHERE clause is omitted.
- `<orders>` is the current ORDER BY for the tab's sort, comma-separated. Omitted when there is no active sort.
- `<current_page_size>` is the active per-table page size (the same value used by `useTableData`).

The new tab MUST be created via the existing `postgres-query` tab payload (`{ connectionId, connectionName, sql }`) and MUST be focused on creation.

#### Scenario: Empty applied opens a SELECT with no WHERE

- **WHEN** the user clicks "Open in SQL Editor" with no applied filters
- **THEN** a new `postgres-query` tab opens with `sql = 'SELECT * FROM "public"."users" LIMIT 200'` (no WHERE)
- **AND** the tab is focused

#### Scenario: Structured applied prefills a parameterless WHERE

- **WHEN** `applied.filter_tree` compiles to `"country" = 'CL' AND ("status" = 'active' OR "status" = 'pending')`
- **AND** the user clicks "Open in SQL Editor"
- **THEN** the prefilled SQL contains `WHERE "country" = 'CL' AND ("status" = 'active' OR "status" = 'pending')`
- **AND** the prefilled SQL has no `$n` placeholders (literals are inlined for display)

#### Scenario: Raw applied prefills the raw body

- **WHEN** `applied.raw_where = "created_at > now() - interval '7 days'"`
- **AND** the user clicks "Open in SQL Editor"
- **THEN** the prefilled SQL contains `WHERE created_at > now() - interval '7 days'`

#### Scenario: Active sort is included

- **WHEN** the tab has `order_by = [{ column: "created_at", direction: "desc" }]` and applied filters
- **THEN** the prefilled SQL includes `ORDER BY "created_at" DESC` after the WHERE

#### Scenario: Dirty draft does not influence the prefill

- **WHEN** the user has a dirty draft (different from applied) and clicks "Open in SQL Editor"
- **THEN** the prefilled SQL reflects `applied`, not `draft`

### Requirement: Per-table filter persistence

The frontend SHALL persist the filter bar's `draft` and `applied` `FilterModel` per `(connectionId, schema, relation)` tuple under the settings key `pgTableFilter:<connectionId>:<schema>:<relation>`. The persisted record MUST contain both halves of the bar's state (`{ draft, applied }`) as a single coherent JSON object, so a partial-write (one half stale, the other fresh) is impossible.

The persisted filter MUST survive: switching to a different tab and back, closing the table tab and reopening it, switching to a different connection and back, and restarting the app. The persisted filter MUST NOT be cleared by any of those events.

The persisted filter MUST be cleared *only* when the user explicitly invokes one of:
- the filter bar's `Reset` button,
- the bottom bar's `Clear filters` chip / affordance.

When the persisted filter references a column that no longer exists (schema drift), the system MUST surface the resulting `AppError::Postgres` through the same UI paths as today (inline near the Raw editor when in Raw mode; the existing first-load error banner when in Structured mode). The system MUST NOT auto-prune predicates or silently drop the persisted filter on schema drift.

The setting MUST be scoped per connection — two connections inspecting the same `<schema>.<relation>` MUST NOT share filter state.

#### Scenario: Default filter is empty

- **WHEN** the user opens a table tab for the first time and no setting is stored
- **THEN** the filter bar shows the empty filter model (no rows, no raw body) and `applied` is empty
- **AND** the first `postgres.queryTable` invocation has neither `filter_tree` nor `raw_where`

#### Scenario: Filter persists across tab switches

- **WHEN** the user has applied a Structured filter on `public.users` and clicks a different tab
- **AND** the user clicks back to the `public.users` tab
- **THEN** both the filter bar `draft` and the `applied` filter are restored exactly as they were
- **AND** the data grid reflects the restored `applied` filter (no spurious empty-filter fetch is visible)

#### Scenario: Filter persists across tab close + reopen

- **WHEN** the user has applied a filter on `public.users`, closes that tab, and reopens `public.users` from the schema browser
- **THEN** the filter bar shows the previously applied filter as both `draft` and `applied`

#### Scenario: Filter persists across app restart

- **WHEN** the user has applied a filter on `public.users` and quits Argus
- **AND** the user re-launches Argus and opens `public.users`
- **THEN** the filter bar shows the previously applied filter as both `draft` and `applied`

#### Scenario: Mid-edit draft persists on tab switch

- **WHEN** the user has typed a partial value into a filter row but has NOT pressed Apply, and switches tabs
- **AND** the user returns to the table's tab
- **THEN** the unapplied draft is preserved exactly (including the dirty indicator showing draft ≠ applied)

#### Scenario: Reset clears the persisted filter

- **WHEN** the user has applied filters and clicks `Reset` in the filter bar
- **THEN** both `draft` and `applied` become empty
- **AND** the next time the user reopens that table the filter is still empty (the persisted record was cleared)

#### Scenario: BottomBar Clear filters clears the persisted filter

- **WHEN** the user has applied filters and clicks the bottom bar's `Clear filters` chip
- **THEN** both `draft` and `applied` become empty and the persisted record is cleared

#### Scenario: Filter is per connection

- **WHEN** the user has applied a filter for `connectionA.public.users` and opens `connectionB.public.users`
- **THEN** `connectionB.public.users` shows the empty filter model, not `connectionA`'s filter

#### Scenario: Schema drift surfaces a Postgres error and does not auto-clear

- **WHEN** the persisted filter references a column that no longer exists in the relation
- **AND** the user opens that table
- **THEN** the data grid surfaces an `AppError::Postgres` (e.g. `42703 undefined_column`) through the existing error UX
- **AND** the persisted filter is unchanged (the user can choose to `Reset` or to fix the predicate)

### Requirement: Per-table sort persistence

The frontend SHALL persist the table viewer's `orderBy` per `(connectionId, schema, relation)` tuple under the settings key `pgTableOrder:<connectionId>:<schema>:<relation>` (a JSON array of `{ column, direction }`). When unset, the order MUST default to the empty array (the relation's natural row order).

The persisted sort MUST survive the same lifecycle events as the persisted filter (tab switches, tab close/reopen, app restarts). The persisted sort MUST be cleared only by the same explicit user gestures that change it: clicking a column header to cycle sort, or removing a sort via the existing sort UX. There is no separate "reset sort" affordance — the user's existing column-header gesture is the manual control.

The setting MUST be scoped per connection — two connections inspecting the same `<schema>.<relation>` MUST NOT share sort state.

#### Scenario: Default sort is empty

- **WHEN** the user opens a table tab for the first time and no setting is stored
- **THEN** the issued SQL contains no `ORDER BY` clause

#### Scenario: Sort persists across tab switches and restarts

- **WHEN** the user sets `order_by: [{ column: "created_at", direction: "desc" }]` on `public.users` and switches tabs
- **AND** the user returns (or quits Argus and relaunches and reopens the table)
- **THEN** the same `order_by` is restored and the issued SQL contains `ORDER BY "created_at" DESC`

#### Scenario: Sort is per connection

- **WHEN** the user has `created_at desc` on `connectionA.public.users` and opens `connectionB.public.users`
- **THEN** `connectionB.public.users` issues SQL with no `ORDER BY` clause

### Requirement: Per-relation state isolation across tab switches

When the same `TableViewerTab` React instance is rendered with a different `(connectionId, schema, relation)` triple — which happens when the user switches between two open `postgres-table-data` tabs of different relations, since `TabContent` reuses the renderer instance — the bar's `draft`, `applied`, and `orderBy` MUST reflect the *new* triple's persisted state on first paint, NOT the previous triple's state.

The persistence pipeline (`useSetting` and the hooks built on it) MUST detect the key change synchronously during render and re-derive `value` and `isLoaded` from the per-key memory cache (or default) before the render commits. No setter call is required to refresh the value; the change of arguments alone MUST be sufficient.

#### Scenario: Switching between two open table tabs shows the correct filter

- **WHEN** the user has table A and table B open as separate `postgres-table-data` tabs
- **AND** table A has applied filter X persisted, table B has applied filter Y persisted
- **AND** the user switches from tab A to tab B
- **THEN** on the first paint after the switch the filter bar shows filter Y, not filter X

#### Scenario: Switching between two open tabs shows the correct sort

- **WHEN** the user has tab A (orderBy `[created_at desc]`) and tab B (orderBy `[]`) open
- **AND** the user switches from tab A to tab B
- **THEN** the data grid issues SQL with no `ORDER BY` clause for tab B; tab A's sort does not bleed

#### Scenario: Returning to the original tab restores its filter

- **WHEN** the user switches from tab A (filter X) to tab B (filter Y) and back to tab A
- **THEN** the filter bar on tab A shows filter X again

#### Scenario: First paint of the new tab is not stale

- **WHEN** the user switches between two open table tabs
- **THEN** there is no frame in which the filter bar shows the previous tab's filter
- **AND** the data grid does NOT issue a `queryTable` call with the previous tab's `applied` filter against the new tab's relation

### Requirement: Type-aware structured filter parameter binding

When `postgres_query_table` (and `postgres_count_table`) compile a `filter_tree` to SQL, the backend SHALL bind every parameter using a Rust type compatible with the resolved Postgres data type of the referenced column. Binding MUST consult the column metadata fetched via `list_columns` for the same relation; the structured filter MUST NOT bind an integer JSON value as Rust `i64` for an `int4`/`int2` column, MUST NOT bind a string JSON value verbatim for a `uuid`/`date`/`timestamp`/`timestamptz`/`numeric`/`json`/`jsonb`/`bytea` column without a placeholder cast, and MUST NOT propagate `tokio_postgres` `error serializing parameter N` errors that originate purely from a Rust↔Postgres type-name mismatch.

The minimum supported mapping (Postgres column type → Rust bind type, placeholder shape) MUST be:

- `smallint`/`int2` → `i16`, placeholder `$N`
- `integer`/`int`/`int4` → `i32`, placeholder `$N`
- `bigint`/`int8` → `i64`, placeholder `$N`
- `real`/`float4` → `f32`, placeholder `$N`
- `double precision`/`float8` → `f64`, placeholder `$N`
- `numeric`/`decimal` → `String`, placeholder `$N::numeric`
- `boolean`/`bool` → `bool`, placeholder `$N`
- `text`/`character varying`/`varchar`/`character`/`bpchar`/`name`/`citext` → `String`, placeholder `$N`
- `uuid` → `String`, placeholder `$N::uuid`
- `date` → `String`, placeholder `$N::date`
- `time without time zone` → `String`, placeholder `$N::time`
- `time with time zone` → `String`, placeholder `$N::timetz`
- `timestamp without time zone` → `String`, placeholder `$N::timestamp`
- `timestamp with time zone` → `String`, placeholder `$N::timestamptz`
- `bytea` → `String`, placeholder `$N::bytea`
- `json` → `String`, placeholder `$N::json`
- `jsonb` → `String`, placeholder `$N::jsonb`

For any column data type not listed above, the backend MUST fall back to binding `String` with placeholder `$N::<canonical-type-name>` so Postgres performs the conversion. The canonical type name is the value returned by `information_schema.columns.data_type` (or equivalent), lowercased and with parameterized modifiers stripped (e.g. `varchar(255)` → `varchar`).

For the pattern operators (`LIKE`, `NOT LIKE`, `ILIKE`, `NOT ILIKE`, `Contains`, `StartsWith`, `EndsWith`), parameters MUST always bind as Rust `String` with a plain `$N` placeholder regardless of the column type — the column reference itself is unchanged from today's behavior. The frontend MUST continue to surface these operators only on text-family columns.

For the `any_column` branch, parameters MUST continue to bind as Rust `String` with a plain `$N` placeholder; the column itself is cast to `::text` per the existing requirement.

For `IN` / `NOT IN`, every array element MUST bind with the same column-typed coercion as `=`. For `BETWEEN`, both `min` and `max` MUST bind with the same column-typed coercion as `=`.

JSON-shape validation MUST run before boxing. If a value cannot be coerced to the column's bind type, the backend MUST return `AppError::Validation { message: "expected <kind> for column '<name>', got '<repr>'" }` where `<kind>` is one of `integer`, `number`, `numeric`, `boolean`, `string`, and `<repr>` is a short rendering of the offending JSON value. Numeric inputs MAY arrive as `JsonValue::String` (frontend escape hatch for very large numbers) and MUST be parsed with the target type's range check before binding. `JsonValue::Null` continues to be rejected with the existing "use IS NULL / IS NOT NULL" message.

If a `filter_tree` references a named column that does not appear in the resolved column list for the relation, the backend MUST return `AppError::Validation { message: "filter references unknown column '<name>'" }` before dispatching SQL. The `any_column` ref is exempt (no name to resolve).

#### Scenario: Integer column with int4 binds as i32

- **WHEN** the user invokes `postgres.queryTable(id, "inventory", "movement", { limit: 200, offset: 0, filter_tree: { children: [{ kind: "condition", column: { kind: "named", name: "product_id" }, op: "=", value: 20528 }] } })` and `inventory.movement.product_id` is `int4`
- **THEN** the issued SQL contains `WHERE "product_id" = $1` with the parameter bound as Rust `i32(20528)`
- **AND** the query succeeds and returns the matching rows
- **AND** no `error serializing parameter` is raised

#### Scenario: Smallint column binds as i16

- **WHEN** the user filters `{ column: { kind: "named", name: "tier" }, op: "=", value: 3 }` on an `int2` column `tier`
- **THEN** the parameter is bound as Rust `i16(3)` and the query succeeds

#### Scenario: Bigint column binds as i64

- **WHEN** the user filters `{ column: { kind: "named", name: "id" }, op: "=", value: 9223372036854775000 }` on an `int8` column
- **THEN** the parameter is bound as Rust `i64`

#### Scenario: UUID column receives a placeholder cast

- **WHEN** the user filters `{ column: { kind: "named", name: "user_id" }, op: "=", value: "550e8400-e29b-41d4-a716-446655440000" }` on a `uuid` column
- **THEN** the issued SQL contains `WHERE "user_id" = $1::uuid` and the parameter is bound as Rust `String`
- **AND** Postgres parses the cast and the query succeeds

#### Scenario: Timestamptz column receives a placeholder cast

- **WHEN** the user filters `{ column: { kind: "named", name: "created_at" }, op: ">=", value: "2026-01-01T00:00:00Z" }` on a `timestamp with time zone` column
- **THEN** the issued SQL contains `WHERE "created_at" >= $1::timestamptz` and the parameter is bound as Rust `String`

#### Scenario: Numeric column binds via string with cast

- **WHEN** the user filters `{ column: { kind: "named", name: "price" }, op: "<", value: 19.99 }` on a `numeric(10,2)` column
- **THEN** the issued SQL contains `WHERE "price" < $1::numeric` and the parameter is bound as Rust `String("19.99")`
- **AND** the query succeeds and returns rows with `price` strictly less than `19.99`

#### Scenario: BETWEEN on a date column casts both bounds

- **WHEN** the user filters `{ column: { kind: "named", name: "due_date" }, op: "BETWEEN", value: { min: "2026-03-01", max: "2026-03-31" } }` on a `date` column
- **THEN** the issued SQL contains `WHERE "due_date" BETWEEN $1::date AND $2::date` with both parameters bound as Rust `String`

#### Scenario: IN on an integer column binds each element as i32

- **WHEN** the user filters `{ column: { kind: "named", name: "status_code" }, op: "In", value: [200, 201, 204] }` on an `int4` column
- **THEN** the issued SQL contains `WHERE "status_code" IN ($1, $2, $3)` and each parameter is bound as Rust `i32`

#### Scenario: ILIKE on a text column binds as plain string

- **WHEN** the user filters `{ column: { kind: "named", name: "description" }, op: "Contains", value: "argus" }` on a `text` column
- **THEN** the issued SQL contains `WHERE "description" ILIKE '%' || $1 || '%'` (no cast) and the parameter is bound as Rust `String("argus")`

#### Scenario: any_column search keeps text cast on column

- **WHEN** the user filters `{ column: { kind: "any_column" }, op: "Contains", value: "x" }`
- **THEN** the issued SQL casts every column reference to `::text` (existing behavior) and binds the parameter as Rust `String` with placeholder `$N`

#### Scenario: Mismatched value type returns a clear validation error

- **WHEN** the user invokes `postgres.queryTable` with `filter_tree: { children: [{ kind: "condition", column: { kind: "named", name: "product_id" }, op: "=", value: "abc" }] }` on an `int4` column
- **THEN** the command returns `AppError::Validation { message: "expected integer for column 'product_id', got 'abc'" }` and no SQL is dispatched

#### Scenario: Stringified large integer is accepted

- **WHEN** the user invokes `postgres.queryTable` with `value: "20528"` (string form) on an `int4` column
- **THEN** the parameter is parsed and bound as Rust `i32(20528)` and the query succeeds

#### Scenario: Out-of-range integer is rejected

- **WHEN** the user filters with `value: 99999999999` on an `int4` column (max `2147483647`)
- **THEN** the command returns `AppError::Validation` with a message indicating the value is out of range for the column type and no SQL is dispatched

#### Scenario: Unknown column in filter is rejected before SQL dispatch

- **WHEN** the user invokes `postgres.queryTable` with `filter_tree` referencing a column name that does not exist on the relation
- **THEN** the command returns `AppError::Validation { message: "filter references unknown column '<name>'" }` and no SQL is dispatched

#### Scenario: Unsupported column type falls back to placeholder cast

- **WHEN** the user filters `{ column: { kind: "named", name: "addr" }, op: "=", value: "192.168.1.1" }` on an `inet` column (not in the explicit mapping table)
- **THEN** the issued SQL contains `WHERE "addr" = $1::inet` with the parameter bound as Rust `String`
- **AND** Postgres parses the cast and the query succeeds

#### Scenario: Same coercion applies to count_table

- **WHEN** the user invokes `postgres.countTable` with the same `filter_tree` shape used in `postgres.queryTable`
- **THEN** the bound parameters and placeholder shapes match exactly what `postgres.queryTable` produces for the same filter


### Requirement: Table viewer tab state survives tab switches without refetch

A `postgres-table-data` tab SHALL retain its full in-memory state across any sequence of tab activations and deactivations within the same app session. The retained state MUST include:

- The fetched row buffer (every page loaded so far) and pagination cursor.
- The columns metadata returned by the most recent successful `postgres_query_table`.
- The selected row index (if any) and the inspector panel state.
- The unsaved edit buffer (pending row edits not yet applied).
- The active sub-tab (Data / Structure / Raw) and the data-grid scroll position.
- The filter "draft" state in the filter bar (text not yet applied) and any local UI state (column widths, inspector width).

Switching away from the tab and back MUST NOT dispatch any `postgres_query_table` or `postgres_count_table` invocation. The activity log MUST NOT show new `query_table` or `count_table` events as a result of tab activation alone.

A refetch of the first page MAY only be triggered by:
- A change to one of the query inputs that already resets the data buffer per the existing reset rules — applied filter, order-by, or page size.
- An explicit user-initiated refresh affordance (if/when one exists).
- The very first time the tab is rendered after being opened (the initial load).

Closing the tab MUST discard all retained state for that tab. Reopening the same `(connectionId, schema, relation)` afterward MUST behave as a fresh first-time open (fresh fetch, no carry-over from the previously closed tab).

#### Scenario: Returning to a table tab shows the same rows with no new fetch

- **WHEN** the user opens `public.users`, scrolls partway down the data grid, selects row 17, switches to another tab, then switches back to `public.users`
- **THEN** the data grid shows exactly the same rows as before
- **AND** the scroll position is preserved
- **AND** row 17 is still the selected row
- **AND** no new `postgres_query_table` event appears in the activity log between deactivation and reactivation

#### Scenario: Unsaved edits survive a tab switch

- **WHEN** the user edits a cell in `public.users` without applying, switches to another tab, then switches back
- **THEN** the edited cell still shows the pending value with its "dirty" indicator
- **AND** the global edit-buffer indicator still reflects the unsaved change

#### Scenario: Applying a filter still refetches

- **WHEN** the user is on a returned-to table tab and applies a new filter
- **THEN** a fresh `postgres_query_table` is dispatched per the existing reset rules
- **AND** the row buffer is replaced with the new result

#### Scenario: Many tabs open, switching cycles without IPC

- **WHEN** five different table tabs are open and the user cycles ⌃Tab through all of them
- **THEN** zero `postgres_query_table` or `postgres_count_table` events are emitted during the cycle
- **AND** each tab shows its previously loaded rows on activation

#### Scenario: Closing and reopening a table tab refetches

- **WHEN** the user closes the `public.users` tab and then reopens `public.users` from the schema browser
- **THEN** a fresh `postgres_query_table` is dispatched (first-time-open behavior)
- **AND** the previously-loaded rows from the closed tab are NOT used

#### Scenario: Hidden table tab does not respond to keyboard shortcuts

- **WHEN** two table tabs A and B are open, B is active, and the user presses `Cmd+2` to activate the Structure subtab
- **THEN** only tab B's Structure subtab activates
- **AND** tab A's Structure subtab is unchanged

