## MODIFIED Requirements

### Requirement: Virtualized data grid

The viewer tab SHALL render the rows in a virtualized grid powered by `@tanstack/react-table` for column / row modeling and `@tanstack/react-virtual` for vertical row virtualization. The grid MUST keep DOM row count proportional to the visible viewport (not to the dataset size) so that loading 10k+ rows is smooth. The grid MUST display column names in `Geist Mono` (the codebase token), tabular numerals for numeric and date columns, and a single hairline divider between rows (per `DESIGN.md`). The active row MUST be highlighted with the `--accent-soft` background. Cell padding MUST be the compact density specified in `DESIGN.md` (`5px 12px`). Long values MUST be truncated with an ellipsis at the cell boundary; full content is shown via the inspector panel.

Each column's rendered width MUST be the effective width computed by the `column-width-preferences` capability: the user override if present, otherwise the type-derived base width returned by `baseWidthFor(categorize(column.data_type))`. Every column header MUST expose the resize hit area defined by `column-width-preferences`. The sticky-header and row-container widths MUST equal the sum of all effective column widths. Overrides MUST be persisted under `pgColumnWidths:<connectionId>:<schema>:<relation>`.

When the connection is writable AND the relation has a PK, the grid MUST also render in editable mode: cells edited via the buffer (kind `update` or `insert`) MUST be rendered with a dirty-state background distinct from `--accent-soft` (a softer warning hue, formalized in `DESIGN.md` as part of this change if not already present); rows marked for delete (kind `delete`) MUST be rendered with strike-through text and a faded foreground color; insert rows MUST be rendered at the top of the buffer with their dirty cells styled the same as updated cells. The inline edit input MUST fill the cell's effective width.

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

#### Scenario: Columns render at type-derived widths by default

- **WHEN** the viewer first opens a table whose columns are `id (uuid)`, `email (text)`, `created_at (timestamptz)`, `is_active (bool)` and no override record exists
- **THEN** the columns render at widths `[280, 200, 168, 88]` respectively
- **AND** the sticky header total width is 736px

#### Scenario: Resizing a column persists per relation

- **WHEN** the user drags the `email` header handle to set its width to 320px on `connectionA.public.users`
- **THEN** the record `pgColumnWidths:A:public:users` is updated to include `{ email: 320 }` and persisted via `useSetting`
- **AND** the next time the user opens `connectionA.public.users` in a future session, `email` renders at 320px
- **AND** opening `connectionA.public.orders` is unaffected

#### Scenario: Double-click on handle resets to type default

- **WHEN** the user has overridden `created_at` to 250px and then double-clicks its handle
- **THEN** the override is removed from `pgColumnWidths:A:public:users`
- **AND** `created_at` renders at 168px again

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
