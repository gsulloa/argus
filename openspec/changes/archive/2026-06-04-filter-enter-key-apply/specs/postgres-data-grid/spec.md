## MODIFIED Requirements

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
