## MODIFIED Requirements

### Requirement: Filter draft and applied state

`TableViewerTab` SHALL maintain two filter values for each tab: `draft` and `applied`, each of shape `FilterTree = { rows: FilterRow[], combinator: "AND" | "OR" }`. Only `applied` MUST be passed (after wire-shape conversion) to `postgres_query_table` and `postgres_count_table`. Edits to the filter bar (text input, operator changes, column changes, checkbox toggles, row insertions/removals, combinator menu picks) MUST update `draft` only. The bar MUST display a dirty indicator (a small `●` adjacent to the `Apply All` button) whenever `draft` differs from `applied`.

The `Apply All` button and the `⇧↵` / `⌘↵` / `⇧⌘↵` shortcuts commit the enabled-complete subset of `draft` to `applied`. Plain `Enter` (no modifier) and the per-row `Apply` button each commit exactly that single focused row to `applied` (see "Per-row Apply and Applied visual state" and "Filter bar keyboard shortcuts"). The `Unset` button resets `draft.rows` but does NOT touch `applied` (see "Filter bar footer Unset, Export, SQL").

The previous `Reset` button and `Esc` discard-draft shortcut are REMOVED. There is no single-keystroke "revert draft to applied" affordance in the new design.

Mode toggling is REMOVED — the bar has no Structured/Raw mode toggle. The filter bar is always in Structured mode. Switching to Raw is only reachable indirectly via `SQL` (footer button) which opens the SQL Editor with a compiled WHERE.

#### Scenario: Editing a row updates draft only

- **WHEN** the user types into a row's value input
- **THEN** the dirty indicator becomes visible
- **AND** the data grid does NOT re-fetch
- **AND** `applied` is unchanged

#### Scenario: Apply All commits draft and triggers fetch

- **WHEN** the user has a dirty draft and clicks `Apply All` (or presses `⇧↵` / `⌘↵`)
- **THEN** `applied` becomes equal to the enabled-complete subset of `draft.rows` joined by `draft.combinator`
- **AND** the dirty indicator disappears (because remaining draft rows match applied rows by structural equality)
- **AND** `postgres.queryTable` is invoked with the new `applied` filters

#### Scenario: Plain Enter commits only the focused row

- **WHEN** the user has three rows in `draft` and presses plain `Enter` (no modifier) while focus is inside the second row
- **THEN** `applied.rows === [thatRow]`
- **AND** `applied.combinator === draft.combinator`
- **AND** `draft` is unchanged

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
| `Enter` | Apply ONLY the focused row — commit exactly that single row to `applied` (`{ rows: [focusedRow], combinator: draft.combinator }`), identical to that row's per-row `Apply` button and INDEPENDENT of the row's `enabled` checkbox. The focused row is resolved from the active element's enclosing `[data-filter-row-index]`. If no enclosing row can be resolved, the handler falls back to Apply All using the current combinator. Suppressed when focus is in a `ChipInput` (`In` / `NotIn`) and the chip draft is non-empty (Enter commits the chip instead). |
| `⇧Enter` / `Shift+Enter` | Apply All using the current `draft.combinator` (does NOT force AND or OR) — commit the enabled-complete subset of `draft.rows`. Suppressed when focus is in a `ChipInput` and the chip draft is non-empty. |
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

#### Scenario: Plain Enter on a value input applies only the focused row

- **WHEN** `draft.rows` has two rows (R0 enabled+complete, R1 enabled+complete), focus is in row 1's value input, and the user presses `Enter` with no modifier
- **THEN** `applied` becomes `{ rows: [R1], combinator: draft.combinator }`
- **AND** `draft.combinator` is NOT changed
- **AND** `postgres.queryTable` is invoked with the new `applied` filter set

#### Scenario: Plain Enter applies the focused row even when its checkbox is unchecked

- **WHEN** `draft.rows` has R0 (enabled, already applied) and R1 (unchecked, newly typed), focus is in R1's value input, and the user presses `Enter` with no modifier
- **THEN** `applied` becomes `{ rows: [R1], combinator: draft.combinator }`
- **AND** R1's `enabled` flag is NOT changed by the Enter gesture

#### Scenario: Shift+Enter applies all enabled rows

- **WHEN** `draft.rows` has R0 (checked) and R1 (unchecked), focus is in R1's value input, and the user presses `Shift+Enter`
- **THEN** `applied` becomes the enabled-complete subset of `draft.rows` joined by `draft.combinator` (so `applied.rows` contains R0 but not R1)
- **AND** `draft.combinator` is NOT changed

#### Scenario: Enter in a ChipInput commits the chip instead of applying

- **WHEN** focus is in an `In` / `NotIn` chip input with non-empty draft text and the user presses `Enter`
- **THEN** the chip is committed
- **AND** neither per-row Apply nor Apply All is performed

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
- Shortcut hint strip: `Show: ⌘F`, `Insert: ⌘I`, `Remove: ⌘⇧I`, `Apply row: ↵`, `Apply All: ⇧↵`, `Up: ⌘↑`, `Down: ⌘↓`, `Columns: ⌘←`. Each hint MUST be rendered as a non-interactive label using the existing `FilterKeyHint` component. The `Apply row: ↵` and `Apply All: ⇧↵` hints MUST be present so the new per-row-Enter / Apply-All-Shift+Enter shortcuts are discoverable.
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

#### Scenario: Footer documents the Enter and Shift+Enter shortcuts

- **WHEN** the user inspects the filter-bar footer hint strip
- **THEN** a `Apply row: ↵` hint is rendered
- **AND** a `Apply All: ⇧↵` hint is rendered

#### Scenario: Export button is disabled

- **WHEN** the user inspects the footer `Export` button
- **THEN** it is disabled with `aria-disabled="true"` and tooltip `Export coming soon`
- **AND** clicking it performs no action

### Requirement: Filter Apply always refetches

Every commit from `draft` to `applied` (via **Apply All**, the `⇧↵` / `⌘↵` / `⇧⌘↵` shortcuts, the per-row **Apply** button, or plain `Enter` applying the focused row) MUST cause `postgres.queryTable` to be invoked, even when the resulting `applied` value is structurally equal to the previous `applied` value. The user's Apply gesture SHALL be treated as an explicit refresh signal, not merely as a state-equality trigger.

The implementation MUST NOT rely solely on structural equality of `applied` to decide whether to refetch. A monotonically-advancing token (or equivalent mechanism) MUST be threaded into the data-fetch dependency key so that pressing Apply with an unchanged filter model still produces a network round-trip and a fresh first page.

This requirement explicitly overrides any optimisation that would dedupe a fetch on the grounds that "the filter model didn't change". Edits to `draft` that never reach `applied` MUST still NOT trigger a fetch (the `Editing a row updates draft only` scenario in `Filter draft and applied state` is preserved).

#### Scenario: Re-applying the same filter value refetches

- **WHEN** the user has `applied.rows = [{column: "n", op: "=", value: "1"}]` showing a stale result set
- **AND** the user clears the value input to empty (still in `draft`, not committed)
- **AND** the user re-enters `"1"` and clicks `Apply All`
- **THEN** `applied` is structurally equal to its previous value
- **AND** `postgres.queryTable` is invoked again
- **AND** the grid displays the freshly-fetched rows, including any rows created externally since the previous Apply

#### Scenario: Plain Enter refetches even when the single row is unchanged

- **WHEN** `applied.rows === [R1]` and the user presses plain `Enter` while focused in the same `R1` in `draft`
- **THEN** `applied` is structurally equal to its previous value
- **AND** `postgres.queryTable` is invoked again

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
