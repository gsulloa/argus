# postgres-data-grid Specification

## Purpose
TBD - created by archiving change view-table-data. Update Purpose after archive.
## Requirements
### Requirement: Query table command

The Postgres module SHALL expose a Tauri command `postgres_query_table(id, schema, relation, options, origin?)` that executes a paginated `SELECT` against a table, view, or materialized view and returns the rows together with the column metadata. The `options` payload MUST accept `{ limit: number, offset: number, order_by?: Array<{ column: string, direction: "asc" | "desc" }>, filters?: Array<Filter> }` (snake_case keys). The optional `origin` argument MUST be `"user"` or `"auto"` and defaults to `"auto"` when absent; it is forwarded verbatim into the activity-log event for this command. The response payload MUST be `{ columns: Array<{ name: string, data_type: string, ordinal_position: number, is_nullable: boolean }>, rows: Array<Array<Value>>, applied: { limit: number, offset: number, order_by, filters }, query_ms: number, truncated_columns: string[] }`. Rows MUST be returned as JSON-serializable arrays in the same order as `columns`. Postgres values that do not have a natural JSON representation (e.g. `bytea`, large `text`) MAY be returned as a typed string envelope `{ kind: "binary"|"truncated", preview: string, byte_length?: number }` and the column name MUST then appear in `truncated_columns`. The command MUST acquire a connection from the existing pool registry, MUST quote the schema and relation identifiers safely, and MUST NOT open a new connection. The command MUST execute through the read-only-aware `executeQuery` path (it never mutates state). The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "query_table"`, `connection_id: <id>`, `origin: <origin argument>`, `sql: <issued SELECT text>`, `params: <bind params, Debug-formatted, each truncated to 200 chars>`, `metric: { kind: "rows", value: <returned row count> }` on success (`null` on failure), and `status` matching the result. Frontend call sites that initiate the command in response to a user gesture (opening a table, paging, refreshing, sort/filter changes) MUST pass `origin: "user"`; internal pre-fetches MUST pass `origin: "auto"` (or omit the argument).

#### Scenario: Default page returns up to limit rows in declared order

- **WHEN** the user invokes `postgres.queryTable(id, "public", "users", { limit: 200, offset: 0 })`
- **THEN** the response contains up to 200 rows, ordered by the relation's natural row order
- **AND** the `columns` array describes every column in `pg_attribute` ordinal-position order
- **AND** `applied.limit === 200` and `applied.offset === 0`

#### Scenario: Order by single column descending

- **WHEN** the user invokes `postgres.queryTable(id, "public", "users", { limit: 200, offset: 0, order_by: [{ column: "created_at", direction: "desc" }] })`
- **THEN** the rows are ordered by `created_at` descending (NULLs last by Postgres default for `desc`)
- **AND** the issued SQL contains a quoted `ORDER BY "created_at" DESC` clause

#### Scenario: Multi-column sort respects array order

- **WHEN** the user invokes `postgres.queryTable` with `order_by: [{ column: "country", direction: "asc" }, { column: "created_at", direction: "desc" }]`
- **THEN** the rows are sorted first by `country` ascending and then by `created_at` descending

#### Scenario: Filters compose with AND

- **WHEN** the user invokes `postgres.queryTable` with `filters: [{ column: "country", op: "=", value: "CL" }, { column: "deleted_at", op: "IS NULL" }]`
- **THEN** the issued SQL has a `WHERE "country" = $1 AND "deleted_at" IS NULL` clause and the parameter is `"CL"`
- **AND** the response contains only rows matching both predicates

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

The `Filter` payload accepted by `postgres_query_table` SHALL be one of: `{ column, op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "LIKE" | "NOT LIKE", value }`, `{ column, op: "IS NULL" | "IS NOT NULL" }`, or `{ column, op: "BETWEEN", min, max }`. The backend MUST reject any other operator with `AppError::Validation`. `LIKE` / `NOT LIKE` MUST receive the value verbatim (the user supplies their own `%`). `BETWEEN` MUST be inclusive on both bounds. Values MUST be passed as bound parameters, never interpolated. The frontend MUST surface every operator from the column header filter UI; numeric and date-typed columns MUST additionally surface `BETWEEN`; nullable columns MUST surface `IS NULL` and `IS NOT NULL`.

#### Scenario: Unknown operator is rejected

- **WHEN** the frontend forwards a filter with `op: "DROP"` (out of the allowed set)
- **THEN** the command returns `AppError::Validation` with a message naming the offending operator
- **AND** no SQL is dispatched to Postgres

#### Scenario: BETWEEN binds two parameters

- **WHEN** the user filters `created_at BETWEEN '2026-01-01' AND '2026-04-30'`
- **THEN** the issued SQL contains `WHERE "created_at" BETWEEN $1 AND $2` with both bounds bound as parameters
- **AND** rows whose `created_at` equals either bound are included

#### Scenario: Header filter UI matches column type

- **WHEN** the user opens the header filter on an integer-typed column
- **THEN** the UI offers `=`, `!=`, `<`, `<=`, `>`, `>=`, `BETWEEN`, and (if nullable) `IS NULL` / `IS NOT NULL`
- **AND** does NOT offer `LIKE` / `NOT LIKE`

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

#### Scenario: Activating a table opens the data viewer

- **WHEN** the user activates the table node `analytics.events`
- **THEN** a center-area tab of kind `postgres-table-data` opens with payload `{ connectionId, connectionName, schema: "analytics", relation: "events", relationKind: "table" }`
- **AND** the placeholder tab is NOT opened

#### Scenario: Activating a view opens the data viewer

- **WHEN** the user activates a view or materialized view node
- **THEN** the same `postgres-table-data` tab opens with `relationKind: "view"` or `"materialized-view"` respectively

#### Scenario: Activating a function still opens the placeholder

- **WHEN** the user activates a function, type, extension, index, or trigger node
- **THEN** the existing `postgres-object-placeholder` tab opens (this change does not implement those viewers)

#### Scenario: Reactivation focuses the existing tab

- **WHEN** the user activates the same table node a second time
- **THEN** the existing `postgres-table-data` tab is focused and no new tab is opened

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

#### Scenario: Read-only flag does not block reads

- **WHEN** the user opens the viewer on a connection in `read_only: true`
- **THEN** rows load normally and no error is surfaced
- **AND** no UI affordance for mutating the data is rendered (edit, add, delete affordances are hidden)
- **AND** the bottom bar shows the "Read-only connection — edits disabled" banner

#### Scenario: Writable connection exposes mutation affordances

- **WHEN** the user opens a table viewer on a connection with `params.read_only: false` for a relation that has a PK
- **THEN** double-clicking a non-PK cell enters inline edit mode
- **AND** the bottom bar renders the "Add row" and "Save" controls

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

