## ADDED Requirements

### Requirement: Postgres run responses carry result editability

`postgres_run_sql`, each `status: "ok"` outcome of `postgres_run_sql_many`, and the
`postgres_run_sql_stream` `columns` event SHALL each carry one additional field on
their rows-shaped payload, per the `sql-result-editability` capability:

- `editability: ResultEditability` — either
  `{ status: "editable", schema, relation, pk_columns, pk_column_indexes, column_sources, enums }`
  or `{ status: "not_editable", reason }`.

The field is additive: `columns`, `rows`, `truncated_columns`, `truncated`,
`query_ms`, `row_cap`, `row_cap_source` and the `RunSqlResult` / `StreamEvent`
discriminants are otherwise unchanged. `kind: "affected"` results and the
`affected` / `done` / `error` stream events MUST NOT carry the field.

Provenance MUST be derived from the prepared statement's `RowDescription`
(`tokio_postgres::Column::table_oid()` / `column_id()`) rather than by parsing the
SQL text. Because OIDs are absolute, the resolved `schema` MUST be the relation's
real schema even when the statement referenced it unqualified through
`search_path`.

The relation is considered editable only when its `pg_class.relkind` is `'r'`
(ordinary table) or `'p'` (partitioned table).

#### Scenario: Single run of a keyed table reports editable

- **WHEN** `postgres_run_sql(id, "SELECT id, email FROM users", "user")` runs against `public.users` with PK `(id)`
- **THEN** the response includes `editability: { status: "editable", schema: "public", relation: "users", pk_columns: ["id"], pk_column_indexes: [0], column_sources: ["id", "email"], enums: {} }`

#### Scenario: Streaming columns event carries editability

- **WHEN** a `postgres_run_sql_stream` run of `SELECT id, email FROM users` emits its `columns` event
- **THEN** that event includes the `editability` field
- **AND** neither the `batch` nor the `done` event repeats it

#### Scenario: Each multi-statement outcome carries its own editability

- **WHEN** `postgres_run_sql_many(id, ["SELECT id FROM users", "SELECT count(*) FROM users"], "user")` runs
- **THEN** the first `status: "ok"` outcome carries `editability.status: "not_editable"` with `reason: "pk_not_selected"` or `"editable"` per the projection
- **AND** the second carries `editability: { status: "not_editable", reason: "no_base_table" }`

#### Scenario: Unqualified table name resolves to its real schema

- **WHEN** the connection's `search_path` is `app, public` and the user runs `SELECT id FROM users`, resolving to `app.users`
- **THEN** `editability.schema` is `"app"`

#### Scenario: Affected result carries no editability field

- **WHEN** `postgres_run_sql(id, "UPDATE users SET active = false", "user")` runs against a writable connection
- **THEN** the response is `{ kind: "affected", … }` with no `editability` key

#### Scenario: Editability resolution does not change run timing semantics

- **WHEN** the editability resolver's catalog query fails or times out during a `SELECT * FROM users` run
- **THEN** the run still returns `kind: "rows"` with its rows and `query_ms`
- **AND** `editability` is `{ status: "not_editable", reason: "no_base_table" }`

### Requirement: Inline cell editing in the SQL editor result grid

The result panel SHALL offer inline cell editing on a rows result when **all** of
the following hold:

1. the run is a single-statement run (not a `Run all` / multi-statement run),
2. the run has reached its terminal state (not streaming in flight),
3. the response's `editability.status` is `"editable"`, and
4. the tab's current connection is not `read_only`.

When those conditions hold, the panel MUST render `<AdhocResultGrid />` with its
edit configuration supplied, so that double-clicking a cell opens the same inline
editor the table viewer uses (per `postgres-data-edit`, "Editable mode in the data
viewer"): typed input coercion, explicit NULL toggle for nullable columns, enum
`<select>` for enum columns, JSON/JSONB validation on commit, `Enter`/`Tab` to
commit, `Escape` to cancel, and a dirty-cell highlight.

The following cells MUST stay read-only even on an editable result:

- any cell whose `column_sources` entry is `null` (computed / aliased expression),
- any cell whose base column is one of `pk_columns` (the row's identity),
- `bytea` columns and any cell whose value arrived as a `{ kind: "binary" | "truncated" }` envelope.

Row insertion and row deletion MUST NOT be offered in this grid: there is no `+`
gutter affordance, no "Add row" control, and `Backspace` / `Delete` MUST NOT mark
rows for deletion. Cell UPDATE is the only supported operation.

#### Scenario: Double-click opens the editor on an editable result

- **WHEN** the user runs `SELECT id, email FROM users` on a writable connection and double-clicks an `email` cell
- **THEN** an inline text editor opens with the current value selected

#### Scenario: Commit marks the cell dirty

- **WHEN** the user edits that `email` cell to `ana@example.com` and presses `Enter`
- **THEN** the editor closes, the cell shows `ana@example.com` with the dirty highlight
- **AND** the panel's pending-edit count reads `1`

#### Scenario: Escape cancels without dirtying

- **WHEN** the user opens the editor on a cell, types a new value, and presses `Escape`
- **THEN** the cell reverts to its server value with no dirty highlight
- **AND** the pending-edit count is unchanged

#### Scenario: Opening and closing the editor unchanged does not dirty the cell

- **WHEN** the user double-clicks a cell and presses `Enter` without changing anything
- **THEN** no pending edit is recorded

#### Scenario: Primary-key cells are not editable

- **WHEN** the user double-clicks the `id` cell of a result from `SELECT id, email FROM users`
- **THEN** no editor opens
- **AND** the cell's hover title reads `Primary key — not editable`

#### Scenario: Computed columns are not editable

- **WHEN** the result came from `SELECT id, email, upper(email) AS shout FROM users` and the user double-clicks a `shout` cell
- **THEN** no editor opens
- **AND** the cell's hover title reads `Computed column — not editable`

#### Scenario: Enum column offers a select

- **WHEN** the user double-clicks a cell of an enum-typed base column
- **THEN** the editor is a `<select>` listing that enum's labels in declared order

#### Scenario: Insert and delete are not offered

- **WHEN** an editable result is displayed and the user selects a row and presses `Backspace`
- **THEN** no row is marked for deletion
- **AND** no "Add row" control is rendered anywhere in the result panel

### Requirement: Non-editable result cells explain themselves on hover

When a rows result is displayed but inline editing is not available, every data
cell SHALL carry a `title` tooltip naming the reason, so a double-click that does
nothing is explained rather than silent. The copy MUST be derived from the response's
`editability.reason` (or from local state for the two client-side cases):

| Condition | Hover copy |
| --- | --- |
| `no_base_table` | `Not editable — this result isn't a plain table projection` |
| `multiple_tables` | `Not editable — the result mixes columns from more than one table` |
| `not_a_table` | `Not editable — views and materialized views can't be edited here` |
| `no_primary_key` | `Not editable — <schema>.<relation> has no primary key` |
| `pk_not_selected` | `Not editable — add the primary key to the SELECT list to edit these rows` |
| `duplicate_projection` | `Not editable — the same column is selected more than once` |
| connection is `read_only` | `Read-only connection — edits disabled` |
| multi-statement run | `Not editable — results from a multi-statement run are read-only` |
| streaming still in flight | `Not editable while the query is still loading` |

Double-clicking a non-editable cell MUST NOT open an editor, MUST NOT emit a toast,
and MUST NOT change the selection state beyond what a single click already does.

#### Scenario: Missing primary key names the fix

- **WHEN** the user runs `SELECT email FROM users` (PK `id` not selected) and hovers a cell
- **THEN** the tooltip reads `Not editable — add the primary key to the SELECT list to edit these rows`

#### Scenario: Join result explains the mix

- **WHEN** the user runs `SELECT u.id, o.total FROM users u JOIN orders o ON o.user_id = u.id` and hovers a cell
- **THEN** the tooltip reads `Not editable — the result mixes columns from more than one table`

#### Scenario: Read-only connection takes precedence over the wire reason

- **WHEN** the connection is `read_only` and the result's `editability.status` is `"editable"`
- **THEN** every cell's tooltip reads `Read-only connection — edits disabled`
- **AND** no editor opens on double-click

#### Scenario: Double-click on a non-editable cell is inert

- **WHEN** the user double-clicks a cell of a non-editable result
- **THEN** no editor opens, no toast appears, and no error is logged

### Requirement: Save and discard pending result-grid edits

While the result grid holds pending edits, the result panel header SHALL render a
`Discard` control and a `Save (<n>)` control beside the existing export menu, where
`<n>` is the number of dirty rows. `Save` MUST render disabled (labelled `Save`)
when the buffer is clean, and MUST NOT render at all when the result is not
editable. **No keyboard shortcut is bound to this action** — `⌘S` in a query tab
continues to save the *query*, unchanged.

`Save` MUST commit through the existing `postgres_apply_table_edits(connection_id,
schema, relation, edits, "user")` command from `postgres-data-edit`, using the
`schema` and `relation` from the response's `editability` payload and one
`{ kind: "update", pk, changes }` op per dirty row. `changes` MUST be keyed by base
column name.

On `outcome: "ok"` the panel MUST clear the buffer and re-run the same statement —
with its original SQL text and editor start offset preserved — so the user sees
committed values. On `outcome: "op_failed"` the panel MUST show a dismissable banner
above the grid reading `Op #<1-based index> failed: [<code>] <message>` and MUST
leave the buffer intact so the user can correct and retry. A thrown `AppError` MUST
surface on the same banner using its message.

`Discard` MUST clear the buffer without confirmation when it is invoked directly by
the user from this control.

#### Scenario: Save commits and refreshes

- **WHEN** the user has two dirty rows in an editable result and clicks `Save (2)`
- **THEN** `postgres_apply_table_edits` is invoked once with two `update` ops and `origin: "user"`
- **AND** on success the pending-edit count returns to zero and the same statement is re-run

#### Scenario: Re-run after save preserves the statement offset

- **WHEN** a save succeeds for a result produced by the second statement in the editor document
- **THEN** the re-run executes that same statement text
- **AND** a subsequent syntax error's "Show in editor" still jumps to that statement's original offset

#### Scenario: Op failure keeps the buffer

- **WHEN** the apply returns `{ outcome: "op_failed", failed_op_index: 0, code: "23505", message: "duplicate key value violates unique constraint" }`
- **THEN** a banner above the grid reads `Op #1 failed: [23505] duplicate key value violates unique constraint`
- **AND** the two dirty cells remain dirty and editable

#### Scenario: Save is absent on a non-editable result

- **WHEN** the result's `editability.status` is `"not_editable"`
- **THEN** neither `Save` nor `Discard` is rendered in the result header

#### Scenario: Cmd-S still saves the query

- **WHEN** the result grid holds pending edits and the user presses `⌘S`
- **THEN** the query-save flow runs as before
- **AND** the result-grid buffer is untouched

#### Scenario: Discard clears the buffer

- **WHEN** the user clicks `Discard` with three dirty rows
- **THEN** all cells revert to their server values and the count returns to zero

### Requirement: Pending result-grid edits are guarded against loss

A dirty result-grid buffer SHALL be treated with the same care as a dirty
table-viewer buffer. While the buffer holds pending edits, the query tab MUST:

- publish a dirty-summary entry for the tab (label `<schema>.<relation> (result)`)
  so the disconnect-confirmation dialog can name what would be lost,
- intercept tab close and show the shared discard-confirmation dialog rather than
  closing directly,
- intercept a new run (`⌘↩`, `Run all`, or the post-save re-run's user-initiated
  equivalent) and show the same dialog, and
- intercept a connection switch in the tab's connection selector and show the same
  dialog.

Confirming the dialog discards the buffer and proceeds with the requested action.
Cancelling leaves both the buffer and the current result untouched. The re-run that
the panel performs itself immediately after a successful save is NOT a user-initiated
run and MUST NOT prompt.

#### Scenario: Closing the tab with pending edits prompts

- **WHEN** the user closes a query tab whose result grid has one dirty row
- **THEN** the discard-confirmation dialog appears and the tab stays open
- **AND** confirming discards the edits and closes the tab

#### Scenario: Re-running with pending edits prompts

- **WHEN** the user presses `⌘↩` with two dirty rows in the result grid
- **THEN** the discard-confirmation dialog appears and the query is not dispatched
- **AND** cancelling leaves the two dirty rows intact

#### Scenario: Switching connection with pending edits prompts

- **WHEN** the user picks a different connection in the toolbar selector with pending result edits
- **THEN** the discard-confirmation dialog appears before the connection changes

#### Scenario: Post-save re-run does not prompt

- **WHEN** a save succeeds and the panel re-runs the statement
- **THEN** no discard dialog appears

#### Scenario: Dirty result buffer is named in the disconnect dialog

- **WHEN** the result grid of a query tab against `public.users` has pending edits and the user disconnects that connection
- **THEN** the confirmation dialog names `public.users (result)`

## MODIFIED Requirements

### Requirement: Result panel for rows and affected outcomes

Each `postgres-query` tab SHALL render a result panel below the editor. The panel MUST:

- Render a hint state when no run has occurred yet in this tab. The hint MUST advertise both run and autocomplete shortcuts so the user discovers them on first use; the recommended copy is `Press ⌘↩ to run · Tab to autocomplete`.
- Render a virtualized data grid (the `<AdhocResultGrid />` provided by `postgres-data-grid`) for `kind: "rows"` results, displaying the `columns` and `rows` from the response. **The grid is read-only unless the conditions in "Inline cell editing in the SQL editor result grid" are met, in which case the panel supplies the grid's edit configuration derived from the response's `editability` payload.** **For a streaming run, the grid MUST render as soon as the `columns` event arrives and MUST append rows progressively as each `batch` event is received — the user sees the first rows without waiting for the run to complete; while the run is in flight the grid stays read-only.** The grid MUST support **row-range selection** (via a row-number gutter: plain click, shift-click, and drag) as well as single-cell selection, and the current row selection MUST drive the shell's right inspector (when the inspector is expanded) — a single-row selection shows one row, a multi-row selection shows all selected rows. **The result-panel inspector remains read-only regardless of the grid's edit mode.** The grid MUST support ⌘C / Ctrl+C copy (single cell or the selected row range as TSV), ⌘A / Ctrl+A select-all, and a right-click context menu (Copy cell / Copy row(s), plus **Edit cell when that cell is editable**), per the `grid-cell-copy`, `grid-row-copy`, `grid-row-selection`, `grid-select-all`, and `grid-context-menu` capabilities. **Copy MUST reflect any pending edit for a cell rather than its server value, matching the table viewer.** Column widths inside the grid MUST default to the type-derived base widths defined by `column-width-preferences` and MUST be user-resizable; resizing MUST NOT persist to disk across runs or sessions, but MUST persist within the same `<AdhocResultGrid />` instance for as long as the columns prop shape is unchanged.
- **While a streaming run is in flight, display a progress indicator above the grid showing the live count of rows received so far (e.g. `Loading… 3,412 rows`). The indicator MUST clear when the run reaches its terminal event.**
- Render a compact summary line for `kind: "affected"` results: `<command_tag> · <affected_rows> rows affected · <query_ms> ms`. Example: `INSERT 0 3 · 3 rows affected · 12 ms`.
- Display the shared `<TruncationBanner />` above the grid whenever the result is `truncated`, per the `sql-result-row-cap` capability. The banner MUST name the response's `row_cap` rather than a hardcoded `10,000`. Once the streaming `done` event carries `truncated: true` the run reaches its terminal state and the banner renders exactly as it does for a non-streaming run; while a run is still in flight no banner is shown, since no cap information exists until that terminal event. Its dialect clause is `LIMIT`. **A truncated result MAY still be edited: rows are addressed by primary key, so the rows that were returned are exactly the rows that can be written.**

The panel's height MUST be resizable via a drag handle on its top edge (between editor and panel) within bounds 120–800px; the height MUST persist per tab id under settings key `pgQueryResultHeight:<tabId>` while the tab exists.

#### Scenario: Empty state on fresh tab advertises run + autocomplete

- **WHEN** a `postgres-query` tab is opened and no run has been executed
- **THEN** the panel shows the hint `Press ⌘↩ to run · Tab to autocomplete`
- **AND** no grid is rendered

#### Scenario: Rows result renders the adhoc grid

- **WHEN** a SELECT returns 50 rows with 4 columns
- **THEN** the panel renders an `<AdhocResultGrid />` with those 50 rows and 4 columns
- **AND** selecting a row from the gutter populates the shell's right inspector with that row's column-value list

#### Scenario: Grid populates progressively during a streaming run

- **WHEN** a streaming SELECT is in flight and has delivered its `columns` event plus two `batch` events totaling 800 rows
- **THEN** the grid is already rendered showing those 800 rows
- **AND** a progress indicator reads `Loading… 800 rows`
- **AND** the run has not yet reached its terminal event

#### Scenario: Grid is read-only while streaming

- **WHEN** a streaming SELECT of an editable projection is still in flight and the user double-clicks a cell
- **THEN** no editor opens
- **AND** the cell's hover title reads `Not editable while the query is still loading`

#### Scenario: Progress indicator clears on completion

- **WHEN** a streaming SELECT reaches its `done` event with `row_count: 800`
- **THEN** the `Loading…` progress indicator is no longer shown
- **AND** the grid shows all 800 rows

#### Scenario: Multi-row selection drives the inspector

- **WHEN** the user selects a range of rows (e.g. rows 2–4) via the gutter in the result grid
- **THEN** the shell's right inspector shows the column-value view for all selected rows

#### Scenario: Result inspector stays read-only on an editable result

- **WHEN** the result is editable and the user selects one row
- **THEN** the inspector shows the row's fields with no editable inputs and no bulk-edit affordance

#### Scenario: Copy selected rows from the result grid

- **WHEN** the user selects rows 2–4 in the result grid and presses ⌘C
- **THEN** those three rows are copied to the clipboard as TSV

#### Scenario: Copy reflects a pending edit

- **WHEN** the user has a pending edit changing `email` to `ana@example.com` on row 2 and copies that row with ⌘C
- **THEN** the copied TSV contains `ana@example.com`, not the server value

#### Scenario: Affected result renders the compact summary

- **WHEN** an INSERT returns `{ kind: "affected", command_tag: "INSERT 0 3", affected_rows: 3, query_ms: 12 }`
- **THEN** the panel shows `INSERT 0 3 · 3 rows affected · 12 ms`
- **AND** no grid is rendered

#### Scenario: Truncation banner surfaces above the grid

- **WHEN** a streaming SELECT reaches its `done` event with `truncated: true`, `row_cap: 10000`, `row_cap_source: "setting"`
- **THEN** a banner reads `Showing the first 10,000 rows — the result hit Argus's row limit. Raise the limit or add a LIMIT clause.` above the grid
- **AND** it offers a **Raise limit** action

#### Scenario: Truncation banner names a raised cap

- **WHEN** a run comes back with `truncated: true`, `row_cap: 100000`, `row_cap_source: "setting"`
- **THEN** the banner names `100,000` rows, not `10,000`

#### Scenario: Truncated editable result is still editable

- **WHEN** a run comes back `truncated: true` with `editability.status: "editable"` on a writable connection
- **THEN** the returned rows can be edited and saved normally
- **AND** the truncation banner is shown above the grid

#### Scenario: Adhoc grid column widths reset when columns prop changes

- **WHEN** the user runs `SELECT id, email FROM users`, resizes `email` to 320px, then runs `SELECT id, email, status FROM users` in the same tab
- **THEN** the new result re-renders the grid with `id`, `email`, and `status` at their type-derived base widths
- **AND** the previous 320px override for `email` is discarded
