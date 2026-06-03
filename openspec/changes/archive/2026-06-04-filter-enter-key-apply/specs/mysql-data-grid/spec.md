## MODIFIED Requirements

### Requirement: Apply All with persistent root combinator

The filter bar SHALL render an `Apply All` button composed of a primary click area labeled `Apply All` and a chevron menu. The menu MUST contain:

1. `Apply All Checked Filters with AND – Default` with shortcut `⌘↵`
2. `Apply All Checked Filters with OR` with shortcut `⇧⌘↵`

The active combinator MUST be reflected in the menu with a `✓` checkmark. Activating either menu item MUST first set `draft.combinator` then immediately perform Apply All.

Pressing plain `Enter` (no modifier) while focus is inside a filter row's value input MUST perform Apply All using whatever value `draft.combinator` currently holds — identical to clicking the primary `Apply All` click area. Plain `Enter` MUST NOT modify `draft.combinator`.

`draft.combinator` MUST persist across Applies. The combinator MUST be persisted per-table under `filter_root_combinator` (default `"AND"`).

Apply All MUST set `applied` to `{ rows: draft.rows.filter(r => r.enabled && isComplete(r)), combinator: draft.combinator }`. A row is `complete` when `column` is set, `op` is set, AND the operator has a non-empty `value` (where required).

If the filtered subset is empty, Apply All MUST send no `filter` (no WHERE clause) and the bar MUST surface an unobtrusive inline status `No filters enabled` for ~2 seconds.

#### Scenario: Apply All joins only checked complete rows

- **WHEN** `draft` has rows R1 (checked, complete), R2 (unchecked, complete), R3 (checked, incomplete), R4 (checked, complete) and `draft.combinator === "AND"`
- **AND** the user clicks `Apply All`
- **THEN** `applied.rows === [R1, R4]`
- **AND** the compiled WHERE is `<p_R1> AND <p_R4>`

#### Scenario: Cmd+Enter applies with AND

- **WHEN** focus is inside the filter bar and the user presses `⌘↵`
- **THEN** `draft.combinator` is set to `"AND"` and Apply All is performed

#### Scenario: Shift+Cmd+Enter applies with OR

- **WHEN** focus is inside the filter bar and the user presses `⇧⌘↵`
- **THEN** `draft.combinator` is set to `"OR"` and Apply All is performed

#### Scenario: Plain Enter applies with current combinator

- **WHEN** focus is in a filter row's value input, `draft.combinator === "OR"`, and the user presses `Enter` with no modifier
- **THEN** Apply All is performed
- **AND** `applied.combinator === "OR"` (the persisted combinator is unchanged)
- **AND** `mysql.queryTable` is invoked with the new `applied` filter

#### Scenario: Combinator persists across reopens

- **WHEN** the user picks `OR`, closes the tab, and reopens the table
- **THEN** the reopened tab loads `filter_root_combinator === "OR"`

### Requirement: Filter bar keyboard shortcuts

While the filter bar is visible AND focus is inside the bar AND focus is NOT inside a CodeMirror surface, the following keyboard shortcuts MUST be active. Each handler MUST call `preventDefault()`.

| Shortcut | Action |
|---|---|
| `⌘F` / `Ctrl+F` | Toggle visibility |
| `⌘I` / `Ctrl+I` | Insert a new empty row below the focused row. Defaults: `enabled = true`, `column = any_column`, `op = CONTAINS`, `value = ""`. Focus moves to the new row's column picker. |
| `⌘⇧I` / `Ctrl+Shift+I` | Remove the focused row. If last, clear to default empty state. |
| `⌘↑` / `Ctrl+↑` | Move focus to same logical control of row above. No wrap at top. |
| `⌘↓` / `Ctrl+↓` | Move focus to same logical control of row below. No wrap at bottom. |
| `⌘←` / `Ctrl+←` | Open the column picker dropdown on the focused row. |
| `Enter` | Apply All using the current `draft.combinator` (does NOT force AND or OR). Fires from any filter-row value input. |
| `⌘↵` / `Ctrl+Enter` | Apply All with AND |
| `⇧⌘↵` / `Ctrl+Shift+Enter` | Apply All with OR |

#### Scenario: Cmd+I inserts a row below the focused row

- **WHEN** `draft.rows` has three rows, focus is in row 1's value input, and the user presses `⌘I`
- **THEN** `draft.rows.length === 4`
- **AND** the new row is at index 2
- **AND** the new row has the default empty state with `op = CONTAINS`

#### Scenario: Cmd+Down navigates to the same control on the next row

- **WHEN** focus is in row 0's value input and the user presses `⌘↓`
- **THEN** focus moves to row 1's value input

#### Scenario: Cmd+← opens the column picker of the focused row

- **WHEN** focus is in row 0's value input and the user presses `⌘←`
- **THEN** row 0's column picker dropdown opens

#### Scenario: Plain Enter on a value input applies all

- **WHEN** focus is in row 0's text value input, the row is enabled and complete, and the user presses `Enter` with no modifier
- **THEN** Apply All is performed
- **AND** `draft.combinator` is NOT changed
- **AND** `mysql.queryTable` is invoked with the new `applied` filter
