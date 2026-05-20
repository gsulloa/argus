## MODIFIED Requirements

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

## ADDED Requirements

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
