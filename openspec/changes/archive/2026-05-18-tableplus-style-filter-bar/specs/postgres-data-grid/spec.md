## ADDED Requirements

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

## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: Raw WHERE mode

**Reason:** The Structured/Raw mode toggle adds significant surface area and a CodeMirror dependency in the filter bar for a power-user case that is better served by `Open in SQL Editor` (renamed to `SQL` in the new footer). Removing the mode toggle simplifies the bar and aligns with the TablePlus reference design, which has no equivalent.

**Migration:** Persisted `FilterModel`s with `mode === "raw"` MUST be reset to the empty Structured model on first load by the new code path (no salvage of the raw WHERE string). Users who relied on Raw can paste their WHERE into the SQL Editor via the `SQL` footer button, which now opens a SELECT prefilled with the compiled WHERE from the current `applied` set (or just `SELECT * FROM <relation>` when `applied` is empty).

### Requirement: AND root with OR groups

**Reason:** Nested OR groups doubled the filter tree's expressiveness at the cost of significant UI complexity (the `OrGroup` component, the `FilterNode` union, separate `+ AND row` vs `+ OR group` affordances, parenthesization in `compileWhere`). The reference TablePlus design uses a single flat list joined by one combinator, which covers ~95% of realistic ad-hoc filter cases. The remaining 5% have a clean escape hatch via `SQL`.

**Migration:** The behavior covered by this requirement is replaced by the "Flat root combinator" requirement (ADDED in this change). Persisted `FilterTree`s containing any `or_group` child MUST be reset to the empty tree on first load. The `combinator` field semantics are preserved (default `"AND"`, optionally `"OR"`), and on the wire the `FilterTree` shape stays backward-compatible: the backend Rust enum still accepts `or_group` variants from older clients; the new frontend simply never emits them.
