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

### Requirement: Drag-to-select row range

The data grid SHALL support multi-row selection via vertical mouse drag inside the body region. The viewer MUST track selection as a pair `{ anchor: number | null, active: number | null }` where `anchor` is the row index where the drag started and `active` is the row index currently (or most recently) under the cursor. The set of selected indices MUST be derived as the inclusive range `[min(anchor, active), max(anchor, active)]`. When `anchor === null`, no rows are selected.

The grid body MUST NOT allow the browser's native text selection to engage during click or drag interactions on the row display path. The rendered row and cell elements (`.row`, `.cell` in the display path) MUST have `user-select: none` (with the `-webkit-user-select: none` prefix for Tauri Webview compatibility) applied via CSS. The row's primary-button `mousedown` handler MUST call `event.preventDefault()` after confirming `event.button === 0`, so the browser does not start a text-selection drag or other default mousedown behavior. The inline cell editor wrapper (`.cellEditing`) and the editor input element (`.cellEditor`, including textarea and select variants) MUST re-enable `user-select: text` so the user can select, copy, and edit text inside the active editor normally.

Mouse interaction MUST follow these rules:

- **Mouse-down on a row** (primary button only) sets `anchor = active = rowIndex` but does NOT yet visually commit a multi-row selection; the drag intent is unresolved until the cursor has moved at least 4 pixels (vertically OR horizontally) from the mouse-down position. The mousedown handler MUST call `event.preventDefault()` to suppress native text-selection and drag-image side effects. `event.preventDefault()` on mousedown MUST NOT prevent the subsequent synthesized `dblclick` event from firing, so the double-click-to-edit affordance on cells remains intact.
- **Mouse-move while in drag-pending state**: if the cursor has moved < 4px, the gesture is still a click; if it has moved ≥ 4px, the gesture transitions to drag-active and `active` updates on every subsequent mousemove to the row index under the cursor (computed from `scrollTop` and `clientY`, NOT from DOM presence — virtualized rows that are not mounted are still selectable).
- **Mouse-move near the body's top or bottom edge** (within 20px) while drag-active MUST trigger auto-scroll of the grid viewport in that direction, so the user can extend the selection past the visible viewport. Auto-scroll velocity MUST be proportional to how close the cursor is to the edge.
- **Mouse-up while drag-active** finalizes the selection at `[anchor, active]` and exits drag mode. The selection remains until cleared.
- **Mouse-up while drag-pending** (cursor never crossed the threshold) is treated as a click and MUST unconditionally set the selection to `{ anchor: rowIndex, active: rowIndex }`. Clicking a row that is already the sole selected row MUST be a no-op (the row remains selected). There is NO toggle-deselect-on-second-click behavior.
- **Mouse-up outside the grid**: the same finalization MUST apply (the grid listens for `mouseup` on `document` while drag is active so the gesture can complete even if the cursor leaves).

Inline cell editing MUST be reachable ONLY via a double-click on an editable cell (a cell that is not read-only and whose value is not a binary / envelope / no-PK marker). A single click on any cell — selected row or not, editable or read-only — MUST NOT enter inline edit mode. The `onDoubleClick` handler on the cell display element is the sole entry point to `onStartEdit`.

Selected rows MUST render with the same `data-selected="true"` attribute and `--accent-soft` background already used for single-row selection. No new design tokens are introduced. The selection MUST survive vertical scroll and tail pagination. The selection MUST be cleared when the user changes sort, filter, or page size (consistent with the existing buffer reset behavior on those events). The selection MUST be cleared when the user presses `Escape` outside of an active inline editor, or when the user clicks the `Clear` chip in the bottom bar (when present for 2+ row selections).

When the user clicks a different row without dragging, the previous selection is replaced by the new single-row selection (no Cmd/Shift extend in this capability).

#### Scenario: Click without drag selects a single row

- **WHEN** the user mouse-downs on row 5 and mouse-ups within 4px without moving
- **THEN** the selection is `{ anchor: 5, active: 5 }`
- **AND** only row 5 has `data-selected="true"`

#### Scenario: Drag from row 5 to row 8 selects rows 5..8

- **WHEN** the user mouse-downs on row 5, drags vertically down through rows 6 and 7, and mouse-ups on row 8
- **THEN** the selection is `{ anchor: 5, active: 8 }`
- **AND** rows 5, 6, 7, 8 all render with `data-selected="true"`

#### Scenario: Drag past the visible viewport triggers auto-scroll

- **WHEN** the user starts a drag at row 5 (visible) and moves the cursor to within 20px of the body's bottom edge
- **THEN** the grid's vertical scroll position advances downward continuously while the cursor stays in the edge zone
- **AND** `active` continues to update to the row index under the cursor as new rows scroll into view
- **AND** the auto-scroll stops when the cursor moves out of the edge zone or when the user releases the mouse

#### Scenario: Selection survives virtualization (drag into unmounted rows)

- **WHEN** the user drags from row 5 into row 9500 of a 10000-row buffer (rows 50–9499 are never DOM-mounted because of virtualization)
- **THEN** the selection is `{ anchor: 5, active: 9500 }`
- **AND** when the user later scrolls to any row in `[5, 9500]`, that row renders selected

#### Scenario: Drag below 4px threshold remains a click

- **WHEN** the user mouse-downs on row 5 and mouse-ups after moving the cursor only 2 pixels
- **THEN** the gesture is treated as a single click
- **AND** the selection is `{ anchor: 5, active: 5 }` (single row)

#### Scenario: Mouse-up outside the grid still finalizes the selection

- **WHEN** the user starts a drag on row 5, moves the cursor outside the grid (over the inspector panel or browser chrome) past the 4px threshold, and releases the mouse there
- **THEN** the selection is finalized at the last `active` value computed while the cursor was over the grid
- **AND** no drag state remains active

#### Scenario: Sort change clears the selection

- **WHEN** the user has rows 5..10 selected and changes the sort
- **THEN** the buffer is reset (existing behavior) and the selection becomes `{ anchor: null, active: null }`

#### Scenario: Escape clears the selection outside of an editor

- **WHEN** the user has rows 5..10 selected and no inline editor is active
- **AND** presses Escape
- **THEN** the selection becomes `{ anchor: null, active: null }`

#### Scenario: Click a different row replaces the selection

- **WHEN** the user has rows 5..10 selected and single-clicks row 20 without dragging
- **THEN** the selection becomes `{ anchor: 20, active: 20 }`

#### Scenario: Clicking the same row twice keeps it selected (no toggle-deselect)

- **WHEN** the user single-clicks row 5 and then single-clicks row 5 again without dragging
- **THEN** the selection remains `{ anchor: 5, active: 5 }` after both clicks
- **AND** row 5 still renders with `data-selected="true"`

#### Scenario: Dragging inside the grid does not highlight cell text

- **WHEN** the user mouse-downs on a cell that contains text (e.g., a `varchar` column with the value `"hello world"`) and drags horizontally and vertically across multiple cells and rows
- **THEN** no cell content is highlighted by the browser's native text selection (no blue / accent-tinted text selection appears within `.cell` elements)
- **AND** the drag is interpreted as a row-range selection per the standard drag rules
- **AND** `window.getSelection()?.toString()` returns an empty string after the drag completes

#### Scenario: Single click on an editable cell selects the row but does not enter edit mode

- **WHEN** the user single-clicks an editable cell (e.g., a non-PK `text` column in row 7)
- **THEN** the selection is `{ anchor: 7, active: 7 }`
- **AND** no inline editor is rendered (`editing` state remains `null`)
- **AND** the cell continues to render in the display path (showing the `DisplayContent` span, not an `<input>` / `<textarea>` / `<select>`)

#### Scenario: Double click on an editable cell enters edit mode

- **WHEN** the user double-clicks an editable cell in row 7, column `name`
- **THEN** the inline editor for `name` in row 7 is rendered with the cell's current value
- **AND** the editor input is focused and its text is auto-selected (per the existing `cur.select()` behavior)
- **AND** the row's selection state is unchanged by the double-click itself (selection follows the mousedown sequence)

#### Scenario: Double click on a read-only cell does not enter edit mode

- **WHEN** the user double-clicks a read-only cell (e.g., a PK column of a server row, or a `bytea` column, or a value envelope)
- **THEN** no inline editor is rendered
- **AND** the row's selection state follows the same rules as a single click (the row becomes the active single-row selection)

#### Scenario: Text inside the active inline editor is selectable

- **WHEN** an inline editor is active on a `text` cell containing `"hello world"`
- **AND** the user click-drags inside the input element to select the substring `"hello"`
- **THEN** the input's native text selection covers `"hello"` and `window.getSelection()` (or the input's `selectionStart`/`selectionEnd`) reflects that range
- **AND** the row-level drag-to-select state machine is NOT engaged (the editor's stopPropagation / focus behavior keeps the row mousedown handler inert)

### Requirement: Virtualized data grid

The viewer tab SHALL render the rows in a virtualized grid powered by `@tanstack/react-table` for column / row modeling and `@tanstack/react-virtual` for vertical row virtualization. The grid MUST keep DOM row count proportional to the visible viewport (not to the dataset size) so that loading 10k+ rows is smooth. The grid MUST display column names in `Geist Mono` (the codebase token), tabular numerals for numeric and date columns, and a single hairline divider between rows (per `DESIGN.md`). Rows belonging to the active selection range (see "Drag-to-select row range") MUST be highlighted with the `--accent-soft` background. Cell padding MUST be the compact density specified in `DESIGN.md` (`5px 12px`). Long values MUST be truncated with an ellipsis at the cell boundary; full content is shown via the inspector panel.

Each column header MUST render the column name as its primary content. The header MUST NOT render an inline `data_type` chip alongside the name; the data type MUST remain discoverable via (a) the header cell's `title` attribute (`<name> : <data_type>`), and (b) the Structure subtab. The header MUST continue to render the sort badge (when sorted) and the resize hit area defined by `column-width-preferences`.

Each column's rendered width MUST be the effective width computed by the `column-width-preferences` capability: the user override if present, otherwise `Math.max(typeBaseWidth, headerFloorWidth)` where:
- `typeBaseWidth` is the type-derived base width returned by `baseWidthFor(categorize(column.data_type))`.
- `headerFloorWidth` is the measured pixel width of the column name in the header font, plus a fixed allowance for header padding, the resize hit area, and the optional key/sort badges (so that the column name renders without ellipsis at default widths for any reasonable name length).

The measurement MUST be deterministic and offline (e.g., a cached canvas measurement using the header's computed font), and MUST NOT trigger synchronous layout on every render. The header floor MUST NOT be persisted to disk — it is recomputed from the column name on every mount, and user overrides (manual resize or double-click reset) take precedence as today. The sticky-header and row-container widths MUST equal the sum of all effective column widths. Overrides MUST be persisted under `pgColumnWidths:<connectionId>:<schema>:<relation>`.

When the connection is writable AND the relation has a PK, the grid MUST also render in editable mode: cells edited via the buffer (kind `update` or `insert`) MUST be rendered with a dirty-state background distinct from `--accent-soft` (a softer warning hue, formalized in `DESIGN.md` as part of this change if not already present); rows marked for delete (kind `delete`) MUST be rendered with strike-through text and a faded foreground color; insert rows MUST be rendered at the top of the buffer with their dirty cells styled the same as updated cells. The inline edit input MUST fill the cell's effective width.

#### Scenario: Loading 10k rows stays responsive

- **WHEN** the user has loaded a table with 10,000 buffered rows
- **THEN** the grid renders no more than `viewport_height / row_height + overscan` row DOM nodes at any time
- **AND** scrolling does not block the main thread for visibly long stalls

#### Scenario: Selected rows use the accent-soft stripe

- **WHEN** the user selects rows 5..10
- **THEN** each of rows 5, 6, 7, 8, 9, 10 has its background using the `--accent-soft` token from `DESIGN.md`
- **AND** the inspector panel updates to the `active` row of the selection

#### Scenario: Dirty cell has a distinct background

- **WHEN** the user edits a cell so that it is now in the buffer's `update` set
- **THEN** that cell renders with the dirty-state background
- **AND** the dirty-state background is visually distinct from the selection `--accent-soft` highlight (so a selected row with one dirty cell shows both states)

#### Scenario: Row marked for delete is rendered struck through

- **WHEN** the user marks a row for delete
- **THEN** that row's text is rendered with strike-through and a faded foreground color
- **AND** the row remains visible (not hidden) until commit

#### Scenario: Insert row appears at the top of the buffer

- **WHEN** the user clicks "Add row"
- **THEN** the new row appears as the first row in the visible buffer
- **AND** does not move when the active sort changes (insert rows keep their position until commit)

#### Scenario: Headers render only the column name (no inline type chip)

- **WHEN** the viewer renders a column whose name is `email` and whose `data_type` is `text`
- **THEN** the header cell visibly displays the text `email` and no other inline copy beyond the optional sort badge
- **AND** hovering the header surfaces a tooltip with `email : text`
- **AND** the Structure subtab continues to list the same column with its full `data_type`

#### Scenario: Short column names render at type-derived base widths

- **WHEN** the viewer first opens a table with columns `id (uuid)` and `email (text)` and no override record exists
- **AND** the measured `headerFloorWidth` for both names is strictly less than their `typeBaseWidth`
- **THEN** `id` renders at the uuid base width (280px) and `email` renders at the text base width (200px)

#### Scenario: Long column names expand the default width so the header is not truncated

- **WHEN** the viewer first opens a table with a `text` column named `customer_external_identifier` and no override record exists
- **AND** the measured `headerFloorWidth` for that name exceeds the text base width (200px)
- **THEN** the column renders at `headerFloorWidth` (not at 200px)
- **AND** the header cell displays the column name without ellipsis truncation

#### Scenario: User override still wins over the header floor

- **WHEN** the user has previously resized `email` to 96px on `connectionA.public.users`
- **AND** the measured `headerFloorWidth` for `email` is 140px
- **THEN** `email` renders at 96px (the override), even though it would now be ellipsis-truncated
- **AND** double-click on the resize handle resets the column to `Math.max(typeBaseWidth, headerFloorWidth)`

#### Scenario: Resizing a column persists per relation

- **WHEN** the user drags the `email` header handle to set its width to 320px on `connectionA.public.users`
- **THEN** the record `pgColumnWidths:A:public:users` is updated to include `{ email: 320 }` and persisted via `useSetting`
- **AND** the next time the user opens `connectionA.public.users` in a future session, `email` renders at 320px
- **AND** opening `connectionA.public.orders` is unaffected

#### Scenario: Double-click on handle resets to the effective default

- **WHEN** the user has overridden `created_at` to 250px and then double-clicks its handle
- **THEN** the override is removed from `pgColumnWidths:A:public:users`
- **AND** `created_at` renders at `Math.max(typeBaseWidth, headerFloorWidth)`

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

### Requirement: Add row reveals the newly inserted row in the viewport

When the user clicks the bottom-bar "Add row" button on an editable Postgres table viewer, the grid SHALL ensure the newly inserted buffer row (which renders at index 0, prepended above the server rows) is visible in the viewport without further user action. The viewer MUST scroll the grid's vertical viewport to the top (`scrollTop = 0`, or equivalent virtualizer call), in the same gesture that adds the insert row to the buffer and updates the row selection to `{ anchor: 0, active: 0 }`. The scroll MUST occur synchronously with the click handler (not deferred behind an asynchronous effect), so the user perceives the new row appearing in one frame.

The scroll MUST NOT fire when "Add row" is disabled or hidden (read-only connections, views, materialized views). The scroll MUST NOT affect the inspector panel's scroll position or the horizontal scroll position of the grid.

#### Scenario: Add row scrolls a deeply-scrolled grid back to the top

- **WHEN** the user has scrolled the data grid such that row index 500 is at the top of the viewport
- **AND** the user clicks the "Add row" button in the bottom bar
- **THEN** the grid's vertical scroll position becomes 0
- **AND** the newly inserted (kind `insert`) row is visible at the top of the viewport
- **AND** the row selection is `{ anchor: 0, active: 0 }`

#### Scenario: Add row at the top is a no-op for scroll position

- **WHEN** the user's grid is already scrolled to the top (`scrollTop === 0`)
- **AND** the user clicks "Add row"
- **THEN** the scroll position remains at 0
- **AND** the new insert row appears at the top of the viewport

#### Scenario: Add row does not scroll when the button is hidden

- **WHEN** the viewer is open on a materialized view (where "Add row" is not rendered)
- **AND** the user has no programmatic way to trigger `onAddRow`
- **THEN** the grid's scroll position is not affected by any "Add row" path

### Requirement: Inspector panel

The viewer SHALL render an inspector panel pinned to the right of the grid. When a row is selected, the inspector MUST list every column from the response's `columns` array as a field showing `column name (data_type) → value`. Columns whose value was returned as a `truncated`/`binary` envelope MUST display the preview plus the original byte length. Long text values in the inspector MUST be scrollable inside their field, not truncated. When no row is selected, the inspector MUST display a hint such as "Select a row to inspect". The inspector MUST be horizontally resizable by dragging its left edge; the width MUST persist under `pgInspectorWidth` (a single global setting, not per-table) with a sensible minimum (e.g. 280px).

When the viewer is in editable mode, the inspector MUST reflect the buffer's dirty state for the selected row: cells that have been edited in the buffer MUST display the dirty value (not the server value), with a visual marker indicating the field is dirty. Editing inside the inspector MUST be supported as an alternative to inline grid editing for non-PK columns; changes commit to the buffer the same way (no direct DB writes). PK columns of existing rows MUST remain read-only in the inspector. Truncated/binary cells MUST remain read-only in the inspector regardless of mode.

**Live commit semantics (single-row mode).** When the inspector is in single-row mode (effective selection of 0 or 1 row), every editable field MUST commit its current value to the edit buffer on every user-driven value change (the input's `onChange` / `change` event), not on blur. This applies to ALL field types: boolean select, enum select, numeric input, text input, and the long-text / JSON-or-JSONB textarea. As a consequence, when the user types or picks a value in any single-row inspector field, the corresponding grid cell MUST re-render with the dirty marker and the new display value before the user releases focus.

For the long-text / JSON textarea specifically: the buffer MUST receive the raw `text` value on every change. JSON strict-parse validation (`validateJsonInput`) MUST NOT block the commit during typing; it MUST run on blur ONLY for the purpose of setting the inline error / smart-quote warning UI. The authoritative JSON validation for save still happens at apply time (Cmd-S) per the existing `postgres-data-edit` rules — an invalid JSON value sitting in the buffer is accepted at the inspector level but rejected at flush.

For the numeric input: the same tolerant parsing currently used by the in-grid editor (`parseInputValue`) applies on every change — fully-parseable inputs coerce to `number`, partial inputs (e.g. `"-"`, `"3."`) remain as strings, and the empty string resolves to `null`.

**Bulk-edit mode is OUT OF SCOPE for live-commit semantics.** When the effective selection is 2 or more rows, the bulk inspector's Apply/Cancel gate from the `postgres-data-edit` capability ("Bulk-edit mode in the inspector when multiple rows are selected") remains in force. Fields stay in their local touched/pristine state until Apply is clicked. This requirement does NOT modify that behavior.

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

#### Scenario: Typing in a single-row inspector text field updates the grid live

- **WHEN** the user selects a single row and types `hello` into a `text` column field in the inspector
- **THEN** after each keystroke (`h`, `he`, `hel`, `hell`, `hello`) the grid cell for that column re-renders with the dirty marker and the cumulative display value
- **AND** the user does NOT need to blur or tab out of the field for the grid to update
- **AND** the inspector's input retains focus and the cursor position throughout

#### Scenario: Typing in a single-row inspector JSON textarea updates the grid live

- **WHEN** the user selects a single row and types `{"a":1}` into a `jsonb` column field in the inspector
- **THEN** after each keystroke the grid cell shows the cumulative raw text as the dirty display value
- **AND** the inspector textarea does NOT render an inline JSON error during typing (the strict-parse check only runs on blur)
- **AND** if the user blurs the textarea with mid-typed text like `{"a":` (invalid JSON), the inspector renders its existing inline JSON error UI
- **AND** the buffer continues to hold the invalid raw text; Cmd-S would surface a strict-parse error per the existing apply-time validation

#### Scenario: Numeric input in the inspector updates the grid per keystroke with tolerant parsing

- **WHEN** the user selects a single row and types `3.14` into a `numeric` column field in the inspector
- **THEN** after typing `3` the grid cell shows `3` with the dirty marker
- **AND** after typing `3.` the grid cell shows `3.` (still a string in the buffer; tolerant parse)
- **AND** after typing `3.14` the grid cell shows `3.14` (a `number` in the buffer)
- **AND** clearing the field shows `NULL` in the grid cell with the dirty marker

#### Scenario: Reverting an inspector edit to the original value cleans up the buffer

- **WHEN** the user types `hello` then deletes the 5 characters so the inspector field again shows the server value
- **THEN** after the final keystroke the grid cell no longer renders the dirty marker
- **AND** the buffer no longer contains an entry for that cell (the reducer collapses an edit equal to the original)

#### Scenario: External buffer change re-syncs the inspector field

- **WHEN** the user has selected row 5, then opens the in-grid editor for the `name` cell of row 5 and types `world`
- **THEN** the inspector's `name` field updates to show `world` (the existing `lastSyncedValueRef` re-sync continues to work under per-keystroke commits)

#### Scenario: Bulk-edit mode still uses Apply/Cancel (out of scope for this requirement)

- **WHEN** the user selects 3+ eligible rows so the inspector enters bulk-edit mode
- **THEN** typing into a bulk field does NOT commit to the buffer per keystroke
- **AND** the grid does NOT show dirty markers on the affected rows until the user clicks `Apply to <N> rows`
- **AND** the bulk inspector's behavior follows the `postgres-data-edit` capability's "Bulk-edit mode in the inspector when multiple rows are selected" requirement unchanged

### Requirement: Bottom bar status

The viewer SHALL display a bottom bar with: a row counter `Showing <N> rows · Page <P>` (where N is the current buffer size and P is the highest loaded page), the page-size selector, a `Count rows` button, an inline `query_ms` indicator from the most recent successful `postgres.queryTable`, and a clear-filters affordance when one or more filters are active. After the user clicks `Count rows`, the bar MUST replace `Showing <N> rows` with `Showing <N> of <Total> rows`, where Total is the result of `postgres_count_table` honoring the active filters. The total MUST be invalidated whenever the filter set changes (so the user must click `Count rows` again for the new filter set).

When the viewer is in editable mode, the bottom bar MUST also render: an "Add row" button (hidden on views/materialized views), a "Save" button enabled only when the buffer has dirty entries (showing `Save (<N>)` where N is the count of pending operations), and an unsaved-changes indicator. When the connection is read-only, the bottom bar MUST instead render a "Read-only connection — edits disabled" banner replacing the "Add row" / "Save" controls. When the relation has no PK on a writable connection, the bottom bar MUST render a "No primary key — existing rows are not editable" banner alongside the "Add row" button.

When the selection range contains 2 or more rows, the bottom bar MUST render a selection chip to the left of the dirty-count indicator showing `<N> rows selected` followed by a `Clear` button. The chip MUST use `--accent-soft` as background and `--accent` as text color (tokens from `DESIGN.md`). The `Clear` button MUST reset the selection to `{ anchor: null, active: null }` without modifying the edit buffer. The chip MUST NOT be rendered when the selection contains 0 or 1 row (zero-noise rule).

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

#### Scenario: Selection chip appears when 2+ rows are selected

- **WHEN** the user has selected rows 5..12 by dragging
- **THEN** the bottom bar renders a chip `8 rows selected · Clear` to the left of the dirty-count indicator
- **AND** the chip uses `--accent-soft` background and `--accent` text color

#### Scenario: Selection chip is hidden for single-row selection

- **WHEN** the user has selected exactly one row
- **THEN** the bottom bar does NOT render the selection chip

#### Scenario: Clear button clears selection without touching the buffer

- **WHEN** the user has rows 5..12 selected and 3 dirty cells in the buffer
- **AND** clicks the chip's `Clear` button
- **THEN** the selection becomes `{ anchor: null, active: null }`
- **AND** the 3 dirty cells remain in the buffer
- **AND** the chip disappears (selection count is 0)

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
- Render each column at its effective width using the `column-width-preferences` capability with `storageKey: null` (in-memory only). Widths MUST reset whenever the `columns` prop's signature (`columns.map(c => c.name).join("|")`) changes. Every column header MUST expose the resize hit area; double-click MUST reset to the type-derived base width.

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

#### Scenario: Adhoc widths are in-memory and reset on column-shape change

- **WHEN** the consumer renders the adhoc grid with columns `[a, b, c]` and the user resizes column `b` to 280px
- **THEN** the in-memory record contains `{ b: 280 }` and `b` renders at 280px
- **AND** when the consumer re-renders with a new columns prop `[a, b, d]`, the record is cleared and all columns render at their type-derived base widths
- **AND** no entry is persisted to disk via `useSetting`

### Requirement: Deterministic first-page load on viewer mount

The data viewer's loading state machine SHALL guarantee that, on a clean mount with the connection reachable and the relation accessible, the viewer transitions from `loading-first` to either `ready` (with rows populated) or `error` (with the error surfaced) without depending on any subsequent re-render, user interaction, or upstream state change. The transition MUST hold under React 18 StrictMode (mount → unmount → remount) so that development and production behave identically.

The first-page fetch's stale-response check MUST NOT discard a response whose underlying query parameters match the viewer's current `(connectionId, schema, relation, pageSize, orderBy, applied)` tuple. Specifically: the cancellation identity used to determine whether a response is stale MUST be derived from the canonical params themselves (advanced synchronously when params change), NOT from a separate counter advanced through a reducer dispatch that can fall out of phase with the params under React batching. As a corollary, when the per-relation persisted settings (`pgTableFilter:*`, `pgTableOrderBy:*`, `pgPageSize:*`, etc.) resolve from disk *after* the viewer mounts and update the params in the same render cycle that the first-page fetch effect fires, the resulting fetch MUST either be applied (if its params still match) or superseded by a fresh fetch that itself reaches a terminal state. The viewer MUST NOT remain in `loading-first` after the backend has responded.

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

#### Scenario: Cold-mount disk-load race does not strand the viewer

- **WHEN** the user activates a table whose `(connectionId, schema, relation)` has no entry in the `useSetting` in-memory cache, so that the persisted filter, order-by, and page-size settings each complete their disk read asynchronously and update the viewer's params after the first render
- **AND** the underlying `postgres_query_table` Tauri command resolves successfully with N rows
- **THEN** the viewer transitions out of `loading-first` to `ready`
- **AND** the grid renders the returned rows
- **AND** no in-flight response whose params match the viewer's current params is silently discarded

#### Scenario: Stale-by-params response is still discarded

- **WHEN** the first-page fetch is in flight against params P1
- **AND** the user changes the filter / sort / page size to P2 before the response arrives
- **THEN** the response carrying P1 results is discarded
- **AND** a fresh fetch against P2 is issued and reaches a terminal state

### Requirement: Filter bar surface

The viewer tab SHALL conditionally render a filter bar pinned above the column header row and below any tab title chrome. The filter bar MUST be the only filter surface in the data grid — there MUST NOT be a per-column header funnel or popover. Removing the popover MUST NOT remove the existing column-header sort affordance (sort remains accessible from the column header).

The bar MUST be **hidden by default** when a `postgres-table-data` tab is first opened (no persisted preference). When hidden, the bar MUST NOT reserve vertical space — the column header row MUST sit flush against the upper tab chrome. The user MUST be able to toggle the bar visible via either (a) the `Filter` icon button in the subtab header chrome, or (b) the `⌘F` (macOS) / `Ctrl+F` (other) keyboard shortcut. Visibility MUST be persisted per-table (see "Filter bar visibility persistence"). The previous chevron-collapse control inside the bar's header is REMOVED — there is no "collapse but stay reserving space" intermediate state.

When visible, the bar MUST contain, top to bottom: a vertical stack of filter rows (each row: checkbox, column picker, operator picker, value input, Apply / Applied button, `−`, `+`), and a single-line footer strip (see "Filter bar footer Unset, Export, SQL"). When visible with no persisted rows, the bar MUST render exactly one empty row (the default empty state).

The `⌘F` shortcut MUST resolve as follows (the handler MUST call `preventDefault()` unless explicitly noted, and MUST be scoped to the active table tab on the `Data` subtab):
- If the bar is **hidden**: show the bar AND move focus to the first row's value input.
- If the bar is **visible** and focus is **outside** the bar: move focus to the first row's value input.
- If the bar is **visible** and focus is **inside** the bar: hide the bar (preserve `draft` and `applied`).

The handler MUST NOT fire on the `Structure` or `Raw` subtab. The handler MUST NOT fire when focus is inside a CodeMirror editor surface (allowing CodeMirror's built-in search to open).

#### Scenario: Bar is hidden by default

- **WHEN** the user opens a `postgres-table-data` tab for the first time
- **THEN** the filter bar is not rendered
- **AND** the column header row sits immediately under the subtab header chrome (no reserved space)

#### Scenario: Bar is the only filter surface

- **WHEN** the user toggles the bar visible
- **THEN** the filter bar is rendered above the data grid
- **AND** there is no funnel icon or filter popover trigger on any column header

#### Scenario: Sort affordance survives popover removal

- **WHEN** the user clicks a column header
- **THEN** the existing sort cycle (`asc → desc → none`) fires
- **AND** no filter popover is shown

#### Scenario: Cmd+F shows a hidden bar and focuses the first row

- **WHEN** the bar is hidden and the user presses `⌘F` (macOS) / `Ctrl+F` (other) while the Data subtab is active
- **THEN** the filter bar becomes visible
- **AND** keyboard focus moves to the first row's value input (or the column picker if the value input is not yet present, per implementation)
- **AND** no browser/webview "find in page" UI appears

#### Scenario: Cmd+F focuses an already-visible bar

- **WHEN** the bar is visible, focus is somewhere in the grid, and the user presses `⌘F`
- **THEN** keyboard focus moves into the first row of the bar
- **AND** the bar's visibility is unchanged

#### Scenario: Cmd+F hides a focused bar

- **WHEN** the bar is visible, focus is inside one of its inputs, and the user presses `⌘F`
- **THEN** the bar becomes hidden
- **AND** `draft` and `applied` are preserved
- **AND** focus moves to a sensible fallback (the data grid root, or the tab root)

#### Scenario: Cmd+F does not fire from inside a CodeMirror editor

- **WHEN** focus is inside any CodeMirror surface and the user presses `⌘F`
- **THEN** the filter bar handler does NOT fire
- **AND** CodeMirror's built-in search panel opens

#### Scenario: Cmd+F is scoped to the active tab and Data subtab

- **WHEN** two `postgres-table-data` tabs are open, the active tab is Tab A on its Data subtab, and the user presses `⌘F`
- **THEN** only Tab A's filter bar visibility / focus changes
- **WHEN** the user is on the Structure or Raw subtab of a `postgres-table-data` tab and presses `⌘F`
- **THEN** the filter bar handler does NOT fire

### Requirement: Filter draft and applied state

`TableViewerTab` SHALL maintain two filter values for each tab: `draft` and `applied`, each of shape `FilterTree = { rows: FilterRow[], combinator: "AND" | "OR" }`. Only `applied` MUST be passed (after wire-shape conversion) to `postgres_query_table` and `postgres_count_table`. Edits to the filter bar (text input, operator changes, column changes, checkbox toggles, row insertions/removals, combinator menu picks) MUST update `draft` only. The bar MUST display a dirty indicator (a small `●` adjacent to the `Apply All` button) whenever `draft` differs from `applied`.

The `Apply All` button and the `⌘↵` / `⇧⌘↵` shortcuts commit `draft` to `applied`. The per-row `Apply` button commits exactly that single row to `applied` (see "Per-row Apply and Applied visual state"). The `Unset` button resets `draft.rows` but does NOT touch `applied` (see "Filter bar footer Unset, Export, SQL").

The previous `Reset` button and `Esc` discard-draft shortcut are REMOVED. There is no single-keystroke "revert draft to applied" affordance in the new design.

Mode toggling is REMOVED — the bar has no Structured/Raw mode toggle. The filter bar is always in Structured mode. Switching to Raw is only reachable indirectly via `SQL` (footer button) which opens the SQL Editor with a compiled WHERE.

#### Scenario: Editing a row updates draft only

- **WHEN** the user types into a row's value input
- **THEN** the dirty indicator becomes visible
- **AND** the data grid does NOT re-fetch
- **AND** `applied` is unchanged

#### Scenario: Apply All commits draft and triggers fetch

- **WHEN** the user has a dirty draft and clicks `Apply All` (or presses `⌘↵`)
- **THEN** `applied` becomes equal to the enabled-complete subset of `draft.rows` joined by `draft.combinator`
- **AND** the dirty indicator disappears (because remaining draft rows match applied rows by structural equality)
- **AND** `postgres.queryTable` is invoked with the new `applied` filters

#### Scenario: Esc no longer discards draft

- **WHEN** the user has a dirty draft and presses `Esc` while focused inside the bar
- **THEN** `draft` is unchanged
- **AND** the dirty indicator remains visible
- **AND** no fetch is triggered

#### Scenario: Per-row Apply replaces the active filter with that single row

- **WHEN** the user has three rows in `draft` and clicks the per-row Apply button on the second row
- **THEN** `applied.rows === [thatRow]`
- **AND** `applied.combinator === draft.combinator`
- **AND** `draft` is unchanged

#### Scenario: There is no Reset button

- **WHEN** the user inspects the filter bar's UI
- **THEN** there is no `Reset` button anywhere in the bar (footer or otherwise)
- **AND** the closest equivalent is `Unset` which clears `draft.rows` only (see "Filter bar footer Unset, Export, SQL")

### Requirement: Filter bar visibility persistence

The viewer SHALL persist the filter bar's open/hidden state as a per-table viewer setting. The store key MUST be `filter_bar_visible` and MUST be scoped by `(connection_id, schema, relation)`. The default value MUST be `false` (hidden). Toggling the bar via the UI affordance or the `⌘F` shortcut MUST write the new value to the store synchronously so a subsequent reopen of the same table reflects the user's last choice. Toggling MUST NOT discard the in-memory `draft` filter rows — they MUST be preserved across hide/show within the same tab session. Toggling MUST NOT modify `applied` — a tab with applied filters remains filtered even while the bar is hidden.

The toggle MUST be reachable via:
- A `Filter` icon button rendered in the table tab's subtab header chrome (right side, aligned with other tab-chrome controls).
- The `⌘F` (macOS) / `Ctrl+F` (other) keyboard shortcut while the table tab is focused and the active subtab is `Data`, scoped per the rules in the "Filter bar surface" requirement.

#### Scenario: Bar defaults to hidden on first open

- **WHEN** the user opens a `postgres-table-data` tab for a table with no persisted `filter_bar_visible` setting
- **THEN** the filter bar is not rendered (no vertical space is reserved)
- **AND** the `Filter` icon button in the subtab header chrome shows the inactive state

#### Scenario: Visibility survives table reopen

- **WHEN** the user opens table `users`, toggles the filter bar visible, then closes the tab
- **AND** later reopens table `users` on the same connection
- **THEN** the filter bar is rendered visible on reopen

#### Scenario: Hiding preserves draft and applied state

- **WHEN** the user has a dirty draft (e.g. one new row with value `"foo"`) AND has applied filters from earlier, and toggles the bar hidden
- **AND** subsequently toggles the bar visible again
- **THEN** the draft rows are restored exactly as before hiding
- **AND** `applied` is unchanged throughout
- **AND** the data grid was never re-fetched purely from the hide/show toggle

#### Scenario: Hiding does NOT clear applied filters

- **WHEN** the user has applied filters that produce a filtered grid and toggles the bar hidden
- **THEN** the grid remains filtered
- **AND** the `BottomBar` filter count badge still shows the number of applied filters

### Requirement: Filter row inclusion checkbox

The Structured filter row SHALL render a checkbox at its left edge whose checked state controls whether that row participates in `Apply All`. New rows MUST be created with `enabled = true`. The checkbox state MUST be part of the row's data model (a `enabled: boolean` field on each row) and MUST be persisted in the same model as `column` / `op` / `value`. Toggling the checkbox MUST update `draft` only (no auto-fetch). The checkbox state MUST NOT affect per-row Apply — the per-row Apply button MAY be activated on an unchecked row and MUST behave the same as on a checked row.

The unchecked state MUST be visually distinct (greyed input, no "Applied" green) but the row MUST remain fully editable.

#### Scenario: New row defaults to checked

- **WHEN** the user adds a new filter row via `+` or `⌘I`
- **THEN** the new row's checkbox is checked (`enabled = true`)

#### Scenario: Unchecked row is excluded from Apply All

- **WHEN** `draft` contains three rows (R1 checked, R2 unchecked, R3 checked) and the user presses `Apply All`
- **THEN** `applied.rows` contains only R1 and R3
- **AND** R2's value is unchanged in `draft`

#### Scenario: Per-row Apply ignores checkbox state

- **WHEN** the user clicks the per-row Apply button on an unchecked row R2
- **THEN** `applied.rows` becomes `[R2]` regardless of R2's `enabled` flag

#### Scenario: Toggling checkbox marks draft dirty but doesn't re-fetch

- **WHEN** `draft === applied` and the user unchecks R1's checkbox
- **THEN** the dirty indicator appears (draft ≠ applied)
- **AND** `postgres.queryTable` is NOT invoked
- **AND** the grid contents are unchanged

### Requirement: Per-row Apply and Applied visual state

Every Structured filter row SHALL render a `Apply` / `Applied` button at its right edge (before the `+` / `−` controls). The button MUST show the label `Apply` (neutral / muted color) when the row is NOT part of `applied`, and `Applied` (green, using the `--success` token) when the row IS part of `applied`. A row is "part of `applied`" iff there exists a row in `applied.rows` whose `(column, op, value)` triple is structurally equal to the draft row's triple, regardless of either row's `enabled` flag.

When a row is in the Applied state:
- The button label MUST read `Applied`.
- The row's value input MUST render with the `--success-soft` background tint and a `--success` border.
- The button MUST remain clickable; clicking it MUST re-apply only that row (idempotent).

Activating the per-row Apply button MUST set `applied` to `{ rows: [thisRow], combinator: draft.combinator }`. The button MUST NOT modify `draft`. After a per-row Apply with more than one draft row, the dirty indicator MUST reflect that `draft.rows.length !== applied.rows.length`.

Editing any of `column`, `op`, `value`, or `enabled` on an Applied row MUST cause structural equality with `applied` to break for that row, and the row's Applied state MUST drop to the neutral `Apply` state on the next render.

#### Scenario: Applied state is per-row and based on structural equality

- **WHEN** `applied.rows = [{ column: "status", op: "=", value: "ok", enabled: true }]`
- **AND** `draft.rows[0] = { column: "status", op: "=", value: "ok", enabled: true }`
- **AND** `draft.rows[1] = { column: "id", op: ">", value: "100", enabled: true }`
- **THEN** `draft.rows[0]` renders with the green Applied badge
- **AND** `draft.rows[1]` renders with the neutral Apply button

#### Scenario: Editing an applied row drops the Applied badge

- **WHEN** a row is in the Applied state and the user changes its `value` from `"ok"` to `"okay"`
- **THEN** the row's Applied badge becomes the neutral `Apply` label
- **AND** the row's input loses the green tint

#### Scenario: Per-row Apply replaces the active filter with that single row

- **WHEN** `draft` contains three rows and the user clicks the per-row Apply button on the second row (`{ column: "status", op: "=", value: "ok" }`)
- **THEN** `applied.rows === [{ column: "status", op: "=", value: "ok", enabled: ... }]`
- **AND** `applied.combinator === draft.combinator`
- **AND** `draft` is unchanged
- **AND** the dirty indicator shows that `draft ≠ applied`
- **AND** `postgres.queryTable` is invoked with the single-row `filter_tree`

#### Scenario: Per-row Apply on an Applied row is idempotent

- **WHEN** a row is already in the Applied state and the user clicks its `Applied` button
- **THEN** `applied.rows` still equals `[thatRow]`
- **AND** no observable state changes (the fetch is debounced / deduped by the data hook)

### Requirement: Apply All with persistent root combinator

The filter bar SHALL render an `Apply All` button at its bottom-right. The button is composed of two affordances: a primary click area labeled `Apply All` and a chevron (`▾`) that opens a menu. The menu MUST contain exactly two items, in order:

1. `Apply All Checked Filters with AND – Default` with shortcut `⌘↵`
2. `Apply All Checked Filters with OR` with shortcut `⇧⌘↵`

The active combinator (`draft.combinator`) MUST be reflected in the menu with a `✓` checkmark next to the corresponding item. Activating either menu item MUST first set `draft.combinator` to the corresponding value (`"AND"` or `"OR"`), then immediately perform Apply All.

Activating the primary click area MUST perform Apply All using whatever value `draft.combinator` currently holds. The button label MUST stay `Apply All` regardless of combinator; the active combinator is signaled only via the menu's checkmark (and OPTIONALLY a small text suffix like `(OR)` when `draft.combinator === "OR"` — implementation MAY add this for clarity).

Pressing plain `Enter` (no modifier) while focus is inside the filter bar MUST perform Apply All using whatever value `draft.combinator` currently holds — identical to clicking the primary `Apply All` click area. Plain `Enter` MUST NOT modify `draft.combinator`. Plain `Enter` MUST NOT fire when:
- focus is inside a CodeMirror surface (the bar's Raw editor MUST take Enter for itself); or
- focus is inside the `ChipInput` editor used by `In` / `NotIn` operators AND the chip draft input is non-empty (Enter in that context commits the in-progress chip and MUST NOT propagate to Apply All).

When the chip draft input is empty AND the user presses plain `Enter`, the handler MUST behave like pressing Enter anywhere else in the bar (Apply All).

`draft.combinator` MUST persist across Applies (it does NOT reset to `"AND"` after each Apply). The combinator MUST be persisted in per-table viewer settings under `filter_root_combinator` (default `"AND"`), scoped by `(connection_id, schema, relation)`. The persisted value MUST be reloaded when the tab is reopened.

Apply All MUST set `applied` to:
```
{
  rows: draft.rows.filter(r => r.enabled && isComplete(r)),
  combinator: draft.combinator
}
```
A row is `complete` when `column` is set, `op` is set, AND the operator has a non-empty `value` (where required by the operator — `IS NULL` / `IS NOT NULL` do not require a value).

If the filtered subset is empty, the Apply All MUST send no `filter_tree` (no WHERE clause) and the bar MUST surface an unobtrusive inline status reading `No filters enabled` for ~2 seconds.

#### Scenario: Apply All joins only checked complete rows

- **WHEN** `draft` has rows R1 (checked, complete), R2 (unchecked, complete), R3 (checked, incomplete value), R4 (checked, complete)
- **AND** `draft.combinator === "AND"`
- **AND** the user clicks `Apply All`
- **THEN** `applied.rows === [R1, R4]`
- **AND** `applied.combinator === "AND"`
- **AND** the compiled WHERE is `<p_R1> AND <p_R4>`

#### Scenario: Cmd+Enter applies with AND – Default

- **WHEN** focus is inside the filter bar and the user presses `⌘↵` (macOS) / `Ctrl+Enter` (other)
- **THEN** `draft.combinator` is set to `"AND"`
- **AND** Apply All is performed
- **AND** the menu's `Apply All Checked Filters with AND – Default` item shows the `✓` checkmark on next open

#### Scenario: Shift+Cmd+Enter applies with OR

- **WHEN** focus is inside the filter bar and the user presses `⇧⌘↵`
- **THEN** `draft.combinator` is set to `"OR"`
- **AND** Apply All is performed
- **AND** the menu's `Apply All Checked Filters with OR` item shows the `✓` checkmark on next open

#### Scenario: Plain Enter applies with current combinator

- **WHEN** focus is inside a filter row's value input, `draft.combinator === "OR"`, and the user presses `Enter` with no modifier
- **THEN** Apply All is performed
- **AND** `applied.combinator === "OR"` (the persisted combinator is unchanged)
- **AND** `postgres.queryTable` is invoked with the new `applied` filter set

#### Scenario: Plain Enter in ChipInput with draft commits chip and does not apply

- **WHEN** a filter row uses the `In` operator, focus is in its `ChipInput` text input, the user has typed `pending` (chip not yet committed), and presses `Enter`
- **THEN** the chip `pending` is committed to that row's `value` array
- **AND** the chip draft input is cleared
- **AND** Apply All is NOT performed
- **AND** the data grid does NOT re-fetch

#### Scenario: Plain Enter in ChipInput with empty draft applies

- **WHEN** a filter row uses the `In` operator, focus is in its `ChipInput` text input, the chip draft is empty, and the user presses `Enter`
- **THEN** Apply All is performed using the current `draft.combinator`

#### Scenario: Combinator persists across reopens

- **WHEN** the user picks `OR` via the chevron menu, closes the tab, and reopens the same table later
- **THEN** the reopened tab loads `filter_root_combinator === "OR"` from per-table settings
- **AND** the primary `Apply All` button applies with OR by default

#### Scenario: Apply All with no enabled complete rows clears filters with inline status

- **WHEN** all `draft.rows` are unchecked OR incomplete and the user presses `Apply All`
- **THEN** `applied.rows === []`
- **AND** `postgres.queryTable` is invoked with no `filter_tree` and no `raw_where`
- **AND** the bar shows the inline status `No filters enabled` for ~2 seconds, then dismisses it

### Requirement: Filter bar keyboard shortcuts

While the filter bar is visible AND focus is somewhere inside the bar AND focus is NOT inside a CodeMirror surface, the following keyboard shortcuts MUST be active. Each handler MUST call `preventDefault()`. The handlers MUST NOT fire when the bar is hidden.

| Shortcut | Action |
|---|---|
| `⌘F` / `Ctrl+F` | Toggle visibility (see "Filter bar surface") |
| `⌘I` / `Ctrl+I` | Insert a new empty row immediately below the focused row (or at the end if focus is not on a row). New row defaults: `enabled = true`, `column = any_column`, `op = Contains`, `value = ""`. Focus moves to the new row's column picker. |
| `⌘⇧I` / `Ctrl+Shift+I` | Remove the focused row. If the focused row is the last remaining row, clear its fields to the default empty state instead of removing it. Focus moves to the row above (or stays on the cleared row if it was last). |
| `⌘↑` / `Ctrl+↑` | Move focus to the same logical control (column / op / value) of the row above the focused row. No wrap at top. |
| `⌘↓` / `Ctrl+↓` | Move focus to the same logical control of the row below the focused row. No wrap at bottom. |
| `⌘←` / `Ctrl+←` | Open the column picker dropdown on the focused row. No-op if focus is not on a row. |
| `Enter` | Apply All using the current `draft.combinator` (does NOT force AND or OR). Suppressed when focus is in `ChipInput` and the chip draft is non-empty (Enter commits the chip instead). |
| `⌘↵` / `Ctrl+Enter` | Apply All with AND – Default (see "Apply All with persistent root combinator") |
| `⇧⌘↵` / `Ctrl+Shift+Enter` | Apply All with OR |

`Esc` MUST NOT have a filter-bar-level handler in the new design (the bar does not bind it). The surrounding tab MAY still bind `Esc` for unrelated affordances.

#### Scenario: Cmd+I inserts a row below the focused row

- **WHEN** `draft.rows` has three rows, focus is in row 1's value input, and the user presses `⌘I`
- **THEN** `draft.rows.length === 4`
- **AND** the new row is at index 2 (between former rows 1 and 2)
- **AND** the new row has `enabled = true`, `column = any_column`, `op = Contains`, `value = ""`
- **AND** focus moves to the new row's column picker

#### Scenario: Cmd+Shift+I removes the focused row

- **WHEN** `draft.rows` has three rows, focus is in row 1 (zero-indexed), and the user presses `⌘⇧I`
- **THEN** `draft.rows.length === 2`
- **AND** the rows formerly at indexes 0 and 2 remain (former row 1 is gone)
- **AND** focus moves to the new row 0 (the row that was above)

#### Scenario: Cmd+Shift+I on last row clears instead of removing

- **WHEN** `draft.rows` has exactly one row, focus is inside it, and the user presses `⌘⇧I`
- **THEN** `draft.rows.length === 1`
- **AND** the surviving row has the default empty state (`enabled = true`, `column = any_column`, `op = Contains`, `value = ""`)
- **AND** focus stays on that row's column picker (or wherever the default focus target is)

#### Scenario: Cmd+Down navigates to the same control on the next row

- **WHEN** focus is in row 0's value input and the user presses `⌘↓`
- **THEN** focus moves to row 1's value input

#### Scenario: Cmd+Down at the bottom is a no-op

- **WHEN** focus is in the last row's value input and the user presses `⌘↓`
- **THEN** focus stays where it is (no wrap)

#### Scenario: Cmd+← opens the column picker of the focused row

- **WHEN** focus is in row 0's value input and the user presses `⌘←`
- **THEN** row 0's column picker dropdown opens
- **AND** keyboard focus is in the dropdown's search input

#### Scenario: Plain Enter on a scalar value input applies all

- **WHEN** focus is in row 0's text value input, the row is enabled and complete, and the user presses `Enter` with no modifier
- **THEN** Apply All is performed
- **AND** `draft.combinator` is NOT changed
- **AND** `postgres.queryTable` is invoked with the new `applied` filter set

#### Scenario: Shortcuts do not fire when bar is hidden

- **WHEN** the filter bar is hidden and the user presses `⌘I` while focus is in the grid
- **THEN** the filter bar does NOT appear
- **AND** no row is inserted
- **AND** the keystroke is allowed to fall through to any other handler

#### Scenario: Shortcuts do not steal CodeMirror keys

- **WHEN** focus is inside a CodeMirror surface (e.g. SQL editor in another tab area) and the user presses `⌘F`
- **THEN** the filter bar handler does NOT fire
- **AND** CodeMirror's built-in search panel opens

### Requirement: Filter bar footer Unset, Export, SQL

The filter bar SHALL render a footer strip with the following controls, in order from left to right:

- `Export` button — disabled / placeholder. `aria-disabled="true"`. Tooltip: `Export coming soon`. Clicking it MUST be a no-op.
- `SQL` button — opens a new `postgres-query` tab on the same connection with a prefilled SELECT reflecting the current `applied` filter set (same behavior as the prior `Open in SQL Editor` action). The button MUST use `applied`, NOT `draft`.
- Shortcut hint strip: `Show: ⌘F`, `Insert: ⌘I`, `Remove: ⌘⇧I`, `Apply All: ⌘↵`, `Up: ⌘↑`, `Down: ⌘↓`, `Columns: ⌘←`. Each hint MUST be rendered as a non-interactive label using the existing `FilterKeyHint` component.
- `Operator: [Unset]` — a button labeled `Unset`. Activating it MUST reset all `draft.rows` to a single empty row (`enabled = true`, `column = any_column`, `op = Contains`, `value = ""`). It MUST NOT modify `applied`. It MUST NOT modify `draft.combinator`. To clear the active filtering, the user must subsequently press `Apply All`.
- `Apply All ▾` (covered by the "Apply All with persistent root combinator" requirement).

The gear icon (`⚙`) visible in some reference designs MUST NOT be rendered.

#### Scenario: Unset clears draft rows to a single empty row

- **WHEN** `draft.rows` has three populated rows AND `applied` has those same three rows AND the user clicks `Unset`
- **THEN** `draft.rows.length === 1`
- **AND** the single remaining row has the default empty state
- **AND** `draft.combinator` is unchanged
- **AND** `applied` is unchanged (the grid remains filtered)
- **AND** the dirty indicator now reflects `draft ≠ applied`

#### Scenario: Unset followed by Apply All clears the active filter

- **WHEN** the user clicks `Unset` then immediately clicks `Apply All`
- **THEN** `applied.rows === []`
- **AND** the grid is unfiltered

#### Scenario: SQL button uses applied, not draft

- **WHEN** the user has dirty draft rows (different from `applied`) and clicks `SQL`
- **THEN** the opened SQL editor tab is prefilled with a SELECT that uses the current `applied` filter set
- **AND** the unapplied draft does NOT appear in the prefilled SQL

#### Scenario: Export button is disabled

- **WHEN** the user clicks the `Export` button
- **THEN** nothing happens (no menu, no file write, no error)
- **AND** the button presents with `aria-disabled="true"`

### Requirement: Flat root combinator

The Structured filter model SHALL be a tree with a flat list of condition rows joined by a single root combinator. The model MUST be:
```
interface FilterRow {
  enabled: boolean;
  column: ColumnRef;
  op: Operator;
  value?: FilterValue;
}
interface FilterTree {
  rows: FilterRow[];
  combinator: "AND" | "OR";
}
```
Nesting (sub-groups, OR groups) MUST NOT be expressible in the new model. The frontend MUST emit `filter_tree` on the wire as `{ children: [...condition_leaves], combinator }` where each child is a `kind: "condition"` `FilterNode` mirrored from a `FilterRow` (the `enabled` flag is filtering-side only and is NOT emitted on the wire). The wire `combinator` field MUST equal `draft.combinator` at the time of Apply.

The compiled `WHERE` body MUST join enabled-and-complete row predicates with `" AND "` or `" OR "` based on the wire `combinator`. The expression MUST NOT add outer parentheses (a flat list does not need them). An empty `rows` payload (all rows disabled or incomplete) MUST result in no `WHERE` clause being emitted (see "Apply All with persistent root combinator").

#### Scenario: Flat AND children compile to ANDed predicates

- **WHEN** the wire `filter_tree` has three condition children and `combinator === "AND"`
- **THEN** the compiled WHERE is `<p1> AND <p2> AND <p3>` with no outer parens

#### Scenario: Flat OR children compile to ORed predicates

- **WHEN** the wire `filter_tree` has three condition children and `combinator === "OR"`
- **THEN** the compiled WHERE is `<p1> OR <p2> OR <p3>` with no outer parens

#### Scenario: Single row is emitted without redundant parens

- **WHEN** the wire `filter_tree` has exactly one condition child and `combinator === "AND"`
- **THEN** the compiled WHERE is `<p1>` (no parens)

#### Scenario: Frontend never emits or_group children

- **WHEN** the user creates filters via the new bar
- **THEN** no row in the emitted `filter_tree.children` has `kind === "or_group"`

### Requirement: Any column search

The Structured filter model SHALL accept a special `ColumnRef` `{ kind: "any_column" }` representing a search across every text-castable column of the relation. The frontend MUST surface "Any column" as the first option in the column picker. Operators allowed for `any_column` MUST be: `=`, `!=`, `LIKE`, `NOT LIKE`, `ILIKE`, `NOT ILIKE`, `Contains`, `StartsWith`, `EndsWith`. All other operators applied to `any_column` MUST be rejected by the backend with `AppError::Validation`.

The backend MUST expand an `any_column` condition by enumerating every column of the target relation whose `data_type` is text-castable (everything except `bytea` and composite/row types) and emitting:

```sql
(col1::text [op] $n OR col2::text [op] $n OR ...)
```

…where the same single bound parameter `$n` is shared across all branches. If the target relation has zero text-castable columns, the condition MUST compile to `FALSE`.

The frontend MUST NOT display a performance-warning marker on Any-column rows. The previous `⚠` icon with the tooltip "Searches every text-castable column — slow on large tables." is REMOVED for visual parity with the reference design and to reduce noise. The slow-search caveat moves to documentation.

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

#### Scenario: No performance warning is rendered on Any-column rows

- **WHEN** the user picks `Any column` in a filter row's column picker
- **THEN** no `⚠` icon and no performance-warning tooltip is rendered on the row

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

The frontend SHALL persist the filter bar's `draft` and `applied` `FilterModel` per `(connectionId, schema, relation)` tuple under the settings key `pgTableFilter:<connectionId>:<schema>:<relation>`. The persisted record MUST contain both halves of the bar's state (`{ draft, applied }`) as a single coherent JSON object, so a partial-write (one half stale, the other fresh) is impossible. The persisted record MUST include the root `combinator` field for each tree; when reading a persisted record written before this change (no `combinator` field present), the loader MUST coerce it to `"AND"`.

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

#### Scenario: Persisted record without combinator field is loaded as AND

- **WHEN** the user opens a table whose persisted filter record was written before this change (no `combinator` field on the tree)
- **THEN** the loader coerces both `draft.tree.combinator` and `applied.tree.combinator` to `"AND"`
- **AND** the filter bar renders the tree with the `AND` toggle selected
- **AND** the compiled WHERE matches the pre-change behavior

#### Scenario: Combinator round-trips through persistence

- **WHEN** the user toggles the root combinator to `"OR"` and applies, then quits and re-launches Argus
- **THEN** the persisted record contains `combinator: "OR"` on both `draft.tree` and `applied.tree`
- **AND** reopening the table restores the toggle in the `OR` position

### Requirement: Per-table sort persistence

The frontend SHALL persist the table viewer's `orderBy` per `(connectionId, schema, relation)` tuple under the settings key `pgTableOrder:<connectionId>:<schema>:<relation>` (a JSON array of `{ column, direction }`). The persisted state MUST distinguish "no order has ever been selected for this relation" (the setting key is absent) from "the user has explicitly chosen an empty order" (the key is present with value `[]`).

When the setting key is absent (no user selection yet):
- if the relation has a primary key, the effective `orderBy` MUST default to every primary-key column in `desc` direction, in primary-key definition order;
- if the relation has no primary key (including views and other PK-less relations), the effective `orderBy` MUST default to the empty array (the relation's natural row order).

A persisted value MUST be used verbatim and MUST NOT be overwritten by the primary-key default — this includes a persisted explicit empty array `[]`, which MUST continue to issue SQL with no `ORDER BY` clause. Because the default is derived from the asynchronously-loaded primary key, when nothing is persisted the first-page fetch MUST NOT be issued with an empty order and then immediately re-fetched with the primary-key default; the viewer MUST defer the first-page fetch until the primary key has resolved so the relation opens with a single fetch carrying the correct order. When a persisted value exists, the first-page fetch MUST NOT wait on the primary key.

The persisted sort MUST survive the same lifecycle events as the persisted filter (tab switches, tab close/reopen, app restarts). The persisted sort MUST be cleared only by the same explicit user gestures that change it: clicking a column header to cycle sort, or removing a sort via the existing sort UX. There is no separate "reset sort" affordance — the user's existing column-header gesture is the manual control.

The setting MUST be scoped per connection — two connections inspecting the same `<schema>.<relation>` MUST NOT share sort state.

#### Scenario: Default sort is primary key descending

- **WHEN** the user opens a table tab for `public.users` (primary key `id`) for the first time and no setting is stored
- **THEN** the issued SQL contains `ORDER BY "id" DESC`
- **AND** the viewer issues exactly one first-page fetch (no preceding fetch with an empty order)

#### Scenario: Composite primary key defaults to all columns descending

- **WHEN** the user opens a table whose primary key is `(tenant_id, created_at)` for the first time with no setting stored
- **THEN** the issued SQL contains `ORDER BY "tenant_id" DESC, "created_at" DESC`

#### Scenario: Relation without a primary key defaults to no order

- **WHEN** the user opens a view, or a table with no primary key, for the first time with no setting stored
- **THEN** the issued SQL contains no `ORDER BY` clause

#### Scenario: Explicit empty order is respected over the default

- **WHEN** the relation has a primary key `id` and the persisted setting for the relation is an explicit empty array `[]`
- **THEN** the issued SQL contains no `ORDER BY` clause (the default is not applied)

#### Scenario: Sort persists across tab switches and restarts

- **WHEN** the user sets `order_by: [{ column: "created_at", direction: "desc" }]` on `public.users` and switches tabs
- **AND** the user returns (or quits Argus and relaunches and reopens the table)
- **THEN** the same `order_by` is restored and the issued SQL contains `ORDER BY "created_at" DESC`

#### Scenario: Sort is per connection

- **WHEN** the user has `created_at desc` persisted on `connectionA.public.users` and opens `connectionB.public.users` (primary key `id`) for the first time with nothing persisted
- **THEN** `connectionB.public.users` issues SQL ordered by its own default `ORDER BY "id" DESC`, not by `created_at` from connection A

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

### Requirement: Filter Apply always refetches

Every commit from `draft` to `applied` (via **Apply All**, the `⌘↵` / `⇧⌘↵` shortcuts, or the per-row **Apply** button) MUST cause `postgres.queryTable` to be invoked, even when the resulting `applied` value is structurally equal to the previous `applied` value. The user's Apply gesture SHALL be treated as an explicit refresh signal, not merely as a state-equality trigger.

The implementation MUST NOT rely solely on structural equality of `applied` to decide whether to refetch. A monotonically-advancing token (or equivalent mechanism) MUST be threaded into the data-fetch dependency key so that pressing Apply with an unchanged filter model still produces a network round-trip and a fresh first page.

This requirement explicitly overrides any optimisation that would dedupe a fetch on the grounds that "the filter model didn't change". Edits to `draft` that never reach `applied` MUST still NOT trigger a fetch (the `Editing a row updates draft only` scenario in `Filter draft and applied state` is preserved).

#### Scenario: Re-applying the same filter value refetches

- **WHEN** the user has `applied.rows = [{column: "n", op: "=", value: "1"}]` showing a stale result set
- **AND** the user clears the value input to empty (still in `draft`, not committed)
- **AND** the user re-enters `"1"` and clicks `Apply All`
- **THEN** `applied` is structurally equal to its previous value
- **AND** `postgres.queryTable` is invoked again
- **AND** the grid displays the freshly-fetched rows, including any rows created externally since the previous Apply

#### Scenario: Per-row Apply refetches even when the single row is unchanged

- **WHEN** `applied.rows === [R1]` and the user clicks the per-row Apply on the same `R1` in `draft`
- **THEN** `applied` is structurally equal to its previous value
- **AND** `postgres.queryTable` is invoked again

#### Scenario: Empty Apply with already-empty applied still refetches

- **WHEN** `applied.rows === []` (no filters) and the user presses `Apply All` from a draft with no enabled-complete rows
- **THEN** `postgres.queryTable` is invoked again with no `filter_tree` and no `raw_where`
- **AND** the inline `No filters enabled` status appears (existing behaviour preserved)

#### Scenario: Editing draft without Apply still does not fetch

- **WHEN** the user types into a row's value input without pressing Apply
- **THEN** `postgres.queryTable` is NOT invoked
- **AND** `applied` is unchanged

### Requirement: Reload current table query

The Postgres table viewer (Data subtab) SHALL provide a user-initiated **Reload** affordance that refetches the first page of the current relation, preserving the active filter model, sort order, and page size. Reload MUST be exposed as BOTH (a) a visible icon button placed in the SubtabHeader next to the Filter toggle (Data subtab only), and (b) a global keyboard shortcut **⌘R** (macOS) / **Ctrl+R** (Linux/Windows) bound while the table-viewer tab is the active tab.

The Reload button MUST use the lucide `RotateCw` icon at 13px, MUST render only when `active === "data"` (the Data subtab is selected), and MUST be disabled while `status === "loading-first"` or `status === "loading-first-retrying"`. When disabled, the icon MUST animate (continuous rotation) to indicate that a refetch is in progress. When the button is hovered, the title attribute MUST read `"Reload (⌘R)"`.

Triggering Reload (button click or shortcut) MUST advance the tab's `applyToken` monotonically (`setApplyToken((t) => t + 1)`), so the existing deps-key invalidation in `useTableData` causes an unconditional refetch even when the applied filter model is structurally equal to the previous one. Reload MUST NOT modify the draft or applied filter model, MUST NOT modify the sort or page size, MUST NOT clear the row selection, MUST NOT mutate the edit buffer, and MUST NOT change the current subtab.

The ⌘R / Ctrl+R shortcut MUST fire even when focus is inside an `<input>`, `<textarea>`, or `<select>` element (mirroring Dynamo's `whenInInput: true` behavior). The shortcut MUST be ignored when focus is inside a CodeMirror editor surface (detected via `document.activeElement.closest(".cm-editor")`). The shortcut handler MUST call `event.preventDefault()` whenever it acts, to suppress the browser/Tauri default reload behavior. The shortcut MUST only fire when the tab is the active tab (gated by the existing `active` prop and root-contains-focus guard).

#### Scenario: Reload button is visible on the Data subtab next to the Filter toggle

- **WHEN** the user opens a Postgres table viewer tab
- **THEN** the SubtabHeader renders a Reload icon button (lucide `RotateCw`, 13px) immediately after the Filter toggle
- **AND** hovering the button shows the title `"Reload (⌘R)"`

#### Scenario: Reload button is hidden on non-Data subtabs

- **WHEN** the user switches to the Structure, Raw, or Docs subtab
- **THEN** the Reload button is not rendered

#### Scenario: Clicking Reload refetches the first page

- **WHEN** the user clicks the Reload button while `status === "ready"`
- **THEN** the tab's `applyToken` is incremented by 1
- **AND** `useTableData` issues a fresh `postgres_query_table` request with the current `limit`, `offset: 0`, `order_by`, and `applied` filter model
- **AND** the request payload is identical to what would have been sent had the user pressed Apply with the same filter values

#### Scenario: ⌘R fires the same refetch as the button

- **WHEN** the Postgres table viewer tab is active and the user presses ⌘R (or Ctrl+R on non-macOS)
- **THEN** the same refetch is issued and `applyToken` is incremented by 1
- **AND** the browser/Tauri default page-reload behavior does NOT occur (the handler called `preventDefault()`)

#### Scenario: ⌘R fires from input focus

- **WHEN** the user is focused inside a filter-bar value input and presses ⌘R
- **THEN** the refetch is issued
- **AND** the input's text content is NOT cleared or modified

#### Scenario: ⌘R is suppressed when CodeMirror has focus

- **WHEN** the user is focused inside a CodeMirror editor (e.g. a raw SQL surface mounted in the same tab) and presses ⌘R
- **THEN** no refetch is issued
- **AND** the default browser action (if any) MAY proceed

#### Scenario: Reload button is disabled and spins during first-page load

- **WHEN** the table viewer is in `status === "loading-first"` (or `"loading-first-retrying"`)
- **THEN** the Reload button is disabled and its icon rotates continuously
- **AND** clicking it has no effect

#### Scenario: Reload preserves filter, sort, page size, edit buffer, and selection

- **GIVEN** the user has applied a filter `country = 'CL'`, sorted by `created_at DESC`, set page size to 100, selected three rows, and made one uncommitted row edit
- **WHEN** the user triggers Reload
- **THEN** the refetched first page reflects the same filter, sort, and page size
- **AND** the edit buffer still contains the uncommitted edit
- **AND** the row selection is preserved
- **AND** the active subtab remains "data"

#### Scenario: Reload does not fire from inactive tabs

- **GIVEN** two Postgres table viewer tabs are open, only the second is active
- **WHEN** the user presses ⌘R
- **THEN** only the active (second) tab refetches
- **AND** the inactive (first) tab does not issue a new request

### Requirement: Explicit NULL assignment for nullable non-select columns

The Postgres data viewer SHALL let the user explicitly assign `NULL` to a nullable column that is edited through a free-form editor — a plain text `<input>`, a long-text / JSON-or-JSONB `<textarea>`, or a numeric `<input>` — in both the inline grid cell editor (`CellEditor`) and the Inspector panel editable fields. The committed value MUST be a JSON `null`, carried into the edit buffer exactly like any other edited value and bound by the backend as a typed SQL `NULL` (no new backend path is introduced).

The NULL affordance MUST be a visible control (a `NULL` toggle button, matching the MySQL/MSSQL editors' pattern and using existing `DESIGN.md` tokens — no new tokens). The control MUST be rendered ONLY when the column's `is_nullable` is `true`, consistent with the existing boolean/enum NULL options. When the control is active:

- the free-form input MUST be visually marked as holding `NULL` (e.g. disabled input with a muted treatment and the toggle shown in its active state), and
- committing the editor (Enter / Tab / blur for the grid editor, or the live-commit / Apply path for the Inspector) MUST write `null` to the buffer regardless of any prior typed text.

When the control is inactive, committing follows the existing rules for that column type. In particular, the empty string `""` and `NULL` MUST remain distinct values for `text` / `varchar` columns: an empty, non-NULL text input MUST commit `""`, never `null`. Toggling the control off (or typing into the input) MUST clear the NULL state and restore normal editing.

Boolean and enum columns are NOT affected by this requirement — they already expose a NULL choice through their `<select>` options.

This requirement does NOT alter the Inspector's single-row live-commit timing rules or the bulk-edit Apply/Cancel gate; the NULL control plugs into whichever commit flow is already in force. PK columns of existing rows and truncated/binary cells MUST NOT render the control (they remain read-only).

#### Scenario: Setting a nullable date cell to NULL in the inline grid editor

- **WHEN** the user opens the inline editor on a nullable `date` column such as `delivery_date` (rendered as a text input) and activates the `NULL` toggle, then commits
- **THEN** the buffer records `null` for that cell
- **AND** the grid cell re-renders showing `NULL` with the dirty marker
- **AND** flushing the buffer issues an `UPDATE` that sets the column to SQL `NULL`

#### Scenario: NULL toggle is hidden for non-nullable columns

- **WHEN** the user opens the inline editor on a `NOT NULL` `text` column
- **THEN** no `NULL` toggle is rendered
- **AND** the editor behaves exactly as before this change

#### Scenario: Empty text input stays an empty string, not NULL

- **WHEN** the user opens the inline editor on a nullable `text` column, clears the field to `""`, leaves the `NULL` toggle inactive, and commits
- **THEN** the buffer records the empty string `""` (not `null`)
- **AND** the grid cell shows an empty value rather than `NULL`

#### Scenario: Toggling NULL on then off restores the typed text

- **WHEN** the user has typed `hello` into a nullable `text` editor, activates the `NULL` toggle (the input becomes disabled and shows the NULL state), then deactivates the toggle
- **THEN** the input is re-enabled showing `hello`
- **AND** committing records `hello` in the buffer

#### Scenario: Setting a nullable text field to NULL from the single-row Inspector

- **WHEN** the user selects a single row and activates the `NULL` toggle on a nullable `text` field in the Inspector
- **THEN** the buffer immediately records `null` for that cell (per the single-row live-commit rule)
- **AND** the corresponding grid cell re-renders showing `NULL` with the dirty marker
- **AND** no SQL is dispatched until the user runs `⌘S`

#### Scenario: Setting a column to NULL for many rows from the bulk Inspector

- **WHEN** the user selects 2 or more rows and activates the `NULL` toggle on a nullable column field in the bulk Inspector, then clicks Apply
- **THEN** the buffer records `null` for that column on every selected row
- **AND** the Apply/Cancel gate behavior from the `postgres-data-edit` capability is unchanged (nothing is committed until Apply)

#### Scenario: NULL control is absent on read-only fields

- **WHEN** the Inspector renders a PK field of an existing row, or a truncated/binary cell
- **THEN** no `NULL` toggle is rendered and the field remains read-only

