## MODIFIED Requirements

### Requirement: Adhoc result grid sub-component

The `postgres-data-grid` capability SHALL expose a reusable sub-component `<AdhocResultGrid columns rows onSelectRow edit? />` consumable by other capabilities (notably `postgres-sql-editor`). The component MUST:

- Accept `columns: ColumnInfo[]` and `rows: Array<Array<Value>>` matching the same shape as `postgres_query_table`'s response (`ColumnInfo` has `name`, `data_type`, `ordinal_position`, `is_nullable`; `Value` MAY be a typed envelope `{ kind: "binary"|"truncated", … }`).
- Render the rows in a virtualized grid with the same DOM-row count behavior, styling tokens (`Geist Mono`, tabular numerals, hairline dividers, compact `5px 12px` cell padding), and active-row `--accent-soft` highlight as the table viewer's grid.
- Support row selection via click or keyboard arrow keys; the selected row index is reported through the `onSelectRow(rowIndex: number)` callback.
- Truncate long values with an ellipsis at the cell boundary; full content is shown via the consumer-provided inspector (the consumer reads the selected row and renders fields elsewhere).
- NOT include sort/filter controls, scroll-to-load pagination, row insert/delete affordances, or a bottom bar.
- Render no rows and a configurable empty-state when `rows.length === 0`; the consumer passes the empty-state element via a `emptyState` prop.
- Render each column at its effective width using the `column-width-preferences` capability with `storageKey: null` (in-memory only). Widths MUST reset whenever the `columns` prop's signature (`columns.map(c => c.name).join("|")`) changes. Every column header MUST expose the resize hit area; double-click MUST reset to the type-derived base width.

The component SHALL accept one **optional** `edit` prop carrying the configuration needed for inline cell editing:

```ts
interface AdhocGridEdit {
  buffer: UseEditBufferResult;          // the shared edit buffer
  columnSources: (string | null)[];     // aligned to `columns`; null = not editable
  pkColumns: string[];                  // PK column names, declared order
  pkColumnIndexes: number[];            // result-column index per PK column
  enumValuesByColumn: Record<string, string[]>; // keyed by BASE column name
  blockedReason: string;                // non-empty ⇒ every cell is read-only with this hover title
}
```

When `edit` is **absent**, the grid MUST behave exactly as the read-only grid did before this change: no editor opens on double-click, and the right-click menu is copy-only.

When `edit` is **present** and `blockedReason` is empty, the grid MUST:

- Render each cell through the shared inline-cell component so double-click opens the editor described by `postgres-data-edit`, "Editable mode in the data viewer".
- Treat a cell as read-only when `columnSources[colIndex] === null`, when the base column is in `pkColumns`, when the column's `data_type` is `bytea`, or when the cell value is a `{ kind: "binary" | "truncated" }` envelope. Read-only cells MUST carry a `title` naming the specific reason.
- Derive each row's buffer key from that row's values at `pkColumnIndexes` (never from the row index), and address every edit by the **base** column name from `columnSources` (never by the displayed column name).
- Paint cells with a pending edit using the same dirty highlight as the table viewer, and resolve `⌘C` copy and context-menu copy from the pending value rather than the server value.
- Enable the context menu's **Edit cell** entry for editable cells, and disable it with a reason for the rest.

When `edit` is present and `blockedReason` is non-empty, every cell MUST be read-only and MUST carry `blockedReason` as its `title`.

The component MUST NOT expose insert or delete affordances in any mode: no `+` gutter marker, no "Add row" control, and no `Backspace` / `Delete` delete-toggle binding.

The internal implementation MAY share a virtualization primitive and the inline-cell component with the existing editable table viewer grid.

#### Scenario: Adhoc grid renders rows with shared styling

- **WHEN** the consumer renders `<AdhocResultGrid columns={cols} rows={rs} onSelectRow={fn} />` with 50 rows and 4 columns
- **THEN** the grid renders with `Geist Mono`, hairline dividers between rows, and compact cell padding
- **AND** the active-row highlight uses `--accent-soft`

#### Scenario: Selecting a row invokes the callback

- **WHEN** the user clicks the third row
- **THEN** `onSelectRow(2)` is called once
- **AND** the third row's background uses `--accent-soft`

#### Scenario: Adhoc grid does not render edit affordances

- **WHEN** the consumer renders the adhoc grid **without an `edit` prop** against any data
- **THEN** there are no edit inputs, no `+` button, no Save button, no sort/filter chrome rendered by the component
- **AND** double-clicking a cell does not enter an edit mode
- **AND** the right-click menu offers only Copy cell / Copy row(s)

#### Scenario: Grid with the edit prop opens an editor on double-click

- **WHEN** the consumer renders the grid with `edit` supplied, `blockedReason: ""`, `columnSources: ["id", "email"]`, `pkColumns: ["id"]`, `pkColumnIndexes: [0]`, and the user double-clicks an `email` cell
- **THEN** an inline editor opens with the current value selected

#### Scenario: Edits are keyed by primary key, not row index

- **WHEN** the user commits an edit on the row whose `id` is `7`, and the consumer then re-renders with the same rows in a different order
- **THEN** the dirty highlight follows the row with `id = 7`
- **AND** `buffer.toEditOps()` emits `{ kind: "update", pk: { id: 7 }, changes: { email: … } }`

#### Scenario: Edits are keyed by base column, not displayed name

- **WHEN** `columns` is `[{name: "pk"}, {name: "mail"}]`, `columnSources` is `["id", "email"]`, and the user edits a `mail` cell
- **THEN** the emitted op has `changes: { "email": … }` and `pk: { "id": … }`

#### Scenario: Unsourced and key columns are read-only

- **WHEN** `columnSources` is `["id", "email", null]` and `pkColumns` is `["id"]`
- **THEN** double-clicking the first column's cell or the third column's cell opens no editor
- **AND** each carries a `title` naming its reason
- **AND** double-clicking a second-column cell opens the editor

#### Scenario: blockedReason makes every cell read-only

- **WHEN** the consumer supplies `edit` with `blockedReason: "Read-only connection — edits disabled"`
- **THEN** no cell opens an editor on double-click
- **AND** every data cell's `title` is `Read-only connection — edits disabled`

#### Scenario: Copy reflects the pending edit

- **WHEN** a cell has a pending edit and the user copies it with ⌘C or the context menu
- **THEN** the clipboard holds the pending value, not the server value

#### Scenario: Insert and delete are never offered

- **WHEN** the grid is rendered with `edit` supplied and the user selects a row and presses `Backspace`
- **THEN** no row is marked for deletion and the buffer is unchanged

#### Scenario: Empty state is rendered when rows is empty

- **WHEN** the consumer renders `<AdhocResultGrid columns={cols} rows={[]} emptyState={<p>No rows</p>} />`
- **THEN** the grid renders the column header row and the consumer-provided empty state below it
- **AND** no virtualized row container is rendered

#### Scenario: Truncated/binary cells render as preview

- **WHEN** a cell value is `{ kind: "truncated", preview: "…", byte_length: 5300 }`
- **THEN** the cell shows the preview truncated to fit and the column appears in the consumer's truncated-columns awareness if applicable
- **AND** the cell is read-only even when `edit` is supplied

#### Scenario: Adhoc widths are in-memory and reset on column-shape change

- **WHEN** the consumer renders the adhoc grid with columns `[a, b, c]` and the user resizes column `b` to 280px
- **THEN** the in-memory record contains `{ b: 280 }` and `b` renders at 280px
- **AND** when the consumer re-renders with a new columns prop `[a, b, d]`, the record is cleared and all columns render at their type-derived base widths
- **AND** no entry is persisted to disk via `useSetting`
