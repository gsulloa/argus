## MODIFIED Requirements

### Requirement: Filter row inclusion checkbox

The Structured filter row SHALL render a checkbox at its left edge whose checked state controls whether that row participates in `Apply All`. New rows MUST be created with `enabled = true`. The checkbox state MUST be part of the row's data model (a `enabled: boolean` field on each row) and MUST be persisted in the same model as `column` / `op` / `value`. Toggling the checkbox MUST update `draft` only (no auto-fetch). Per-row Apply (the row's `Apply` button and plain `Enter` inside the row) MUST set the target row's `enabled` to `true` in `draft` as part of the gesture, so that the row it commits to `applied` is always an enabled row — the checkbox state MUST NOT be able to turn a per-row Apply into a query that omits that row.

The unchecked state MUST be visually distinct (greyed input, no "Applied" green) but the row MUST remain fully editable.

#### Scenario: New row defaults to checked

- **WHEN** the user adds a new filter row via `+` or `⌘I`
- **THEN** the new row's checkbox is checked (`enabled = true`)

#### Scenario: Unchecked row is excluded from Apply All

- **WHEN** `draft` contains three rows (R1 checked, R2 unchecked, R3 checked) and the user presses `Apply All`
- **THEN** `applied.rows` contains only R1 and R3
- **AND** R2's value is unchanged in `draft`
- **AND** R2's checkbox stays unchecked

#### Scenario: Per-row Apply ignores checkbox state

- **WHEN** the user clicks the per-row Apply button on an unchecked, complete row R2
- **THEN** the gesture proceeds regardless of R2's checkbox — the checkbox never gates per-row Apply
- **AND** R2's checkbox becomes checked in `draft` (`enabled = true`), so the committed row can reach the query
- **AND** `applied.rows` becomes `[R2]` with `enabled = true`
- **AND** the wire payload carries a `filter_tree` containing R2's condition
- **AND** no other row in `draft` is modified

#### Scenario: Toggling checkbox marks draft dirty but doesn't re-fetch

- **WHEN** `draft === applied` and the user unchecks R1's checkbox
- **THEN** the dirty indicator appears (draft ≠ applied)
- **AND** `postgres.queryTable` is NOT invoked
- **AND** the grid contents are unchanged

### Requirement: Per-row Apply and Applied visual state

Every Structured filter row SHALL render a `Apply` / `Applied` button at its right edge (before the `+` / `−` controls). The button MUST show the label `Apply` (neutral / muted color) when the row is NOT part of `applied`, and `Applied` (green, using the `--success` token) when the row IS part of `applied`. A row is "part of `applied`" iff (a) the row is **complete** (it would survive the `draft` → payload conversion), AND (b) the row is `enabled`, AND (c) there exists a row in `applied.rows` whose `(column, op, value)` triple is structurally equal to the draft row's triple. An **incomplete** row or an **unchecked** row MUST always render the neutral `Apply` state even if its triple matches a row in `applied` — the green "Applied" state MUST never be shown for a row whose predicate did not reach the query.

When a row is in the Applied state:
- The button label MUST read `Applied`.
- The row's value input MUST render with the `--success-soft` background tint and a `--success` border.
- The button MUST remain clickable; clicking it MUST re-apply only that row (idempotent).

Activating the per-row Apply button on a **complete** row MUST set that row's `enabled` to `true` in `draft` and set `applied` to `{ rows: [thisRowWithEnabledTrue], combinator: draft.combinator }`. Apart from the target row's `enabled` flag, the button MUST NOT modify `draft` — it MUST NOT change `draft.combinator`, any other row, or the target row's `column` / `op` / `value`. After a per-row Apply with more than one draft row, the dirty indicator MUST reflect that `draft.rows.length !== applied.rows.length`.

Activating the per-row Apply button on an **incomplete** row MUST be a no-op with respect to both `draft` and `applied`: `applied` MUST retain whatever it held before the gesture, no fetch MUST be triggered, and the bar MUST surface a transient inline status explaining that the row is incomplete. The gesture MUST NOT commit an `applied` model that produces an empty wire payload.

Editing any of `column`, `op`, `value`, or `enabled` on an Applied row MUST cause the "part of `applied`" test to fail for that row, and the row's Applied state MUST drop to the neutral `Apply` state on the next render.

#### Scenario: Applied state is per-row and based on structural equality

- **WHEN** `applied.rows = [{ column: "status", op: "=", value: "ok", enabled: true }]`
- **AND** `draft.rows[0] = { column: "status", op: "=", value: "ok", enabled: true }`
- **AND** `draft.rows[1] = { column: "id", op: ">", value: "100", enabled: true }`
- **THEN** `draft.rows[0]` renders with the green Applied badge
- **AND** `draft.rows[1]` renders with the neutral Apply button

#### Scenario: Incomplete row never shows the Applied badge

- **WHEN** a draft row is incomplete (e.g. it has no concrete `value`) and a structurally-equal incomplete row also exists in `applied.rows`
- **THEN** the draft row renders with the neutral `Apply` label, NOT the green `Applied` badge
- **AND** the row's value input does NOT render with the `--success` tint

#### Scenario: Unchecked row never shows the Applied badge

- **WHEN** `applied.rows = [{ column: "status", op: "=", value: "ok", enabled: true }]` and the user unchecks the structurally-equal `draft.rows[0]`
- **THEN** `draft.rows[0]` renders with the neutral `Apply` label, NOT the green `Applied` badge
- **AND** the row's value input does NOT render with the `--success` tint
- **AND** the dirty indicator is shown (draft ≠ applied)

#### Scenario: Editing an applied row drops the Applied badge

- **WHEN** a row is in the Applied state and the user changes its `value` from `"ok"` to `"okay"`
- **THEN** the row's Applied badge becomes the neutral `Apply` label
- **AND** the row's input loses the green tint

#### Scenario: Per-row Apply replaces the active filter with that single row

- **WHEN** `draft` contains three enabled rows and the user clicks the per-row Apply button on the second row (`{ column: "status", op: "=", value: "ok" }`)
- **THEN** `applied.rows === [{ column: "status", op: "=", value: "ok", enabled: true }]`
- **AND** `applied.combinator === draft.combinator`
- **AND** `draft` is unchanged (the row was already enabled)
- **AND** the dirty indicator shows that `draft ≠ applied`
- **AND** `postgres.queryTable` is invoked with the single-row `filter_tree`

#### Scenario: Per-row Apply on an unchecked row enables it and filters the query

- **WHEN** `draft.rows = [R0 (checked, applied), R1 (unchecked, complete)]` and the user clicks R1's per-row Apply button
- **THEN** R1's checkbox becomes checked in `draft`
- **AND** `applied` becomes `{ rows: [R1 with enabled = true], combinator: draft.combinator }`
- **AND** `postgres.queryTable` is invoked with a `filter_tree` containing R1's condition (NOT with an absent `filter_tree`)
- **AND** R1 renders with the green `Applied` badge

#### Scenario: Per-row Apply on an incomplete row leaves the applied filter in force

- **WHEN** `applied.rows = [R0]` and the user clicks the per-row Apply button on an incomplete row R1 (e.g. empty value)
- **THEN** `applied.rows` still equals `[R0]`
- **AND** `draft` is unchanged (R1's checkbox is NOT toggled)
- **AND** no fetch is triggered
- **AND** the bar shows a transient inline status stating the row is incomplete
- **AND** R1 continues to render the neutral `Apply` label

#### Scenario: Per-row Apply on an Applied row is idempotent

- **WHEN** a row is already in the Applied state and the user clicks its `Applied` button
- **THEN** `applied.rows` still equals `[thatRow]`
- **AND** the row stays checked
- **AND** no observable state changes (the fetch is debounced / deduped by the data hook)

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
| `Enter` | Apply ONLY the focused row — identical to that row's per-row `Apply` button (see "Per-row Apply and Applied visual state"): set the focused row's `enabled` to `true` in `draft`, then commit `{ rows: [focusedRow with enabled = true], combinator: draft.combinator }` to `applied`. If the focused row is **incomplete**, the gesture is a no-op on both models and the bar surfaces a transient inline status instead. The focused row is resolved from the active element's enclosing `[data-filter-row-index]`. If no enclosing row can be resolved, the handler falls back to Apply All using the current combinator. Suppressed when focus is in a `ChipInput` (`In` / `NotIn`) and the chip draft is non-empty (Enter commits the chip instead). |
| `⇧Enter` / `Shift+Enter` | Apply All using the current `draft.combinator` (does NOT force AND or OR) — commit the enabled-complete subset of `draft.rows`. Never changes any row's `enabled` flag. Suppressed when focus is in a `ChipInput` and the chip draft is non-empty. |
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

- **WHEN** `draft.rows` has R0 (checked, already applied) and R1 (unchecked, complete, newly typed), focus is in R1's value input, and the user presses `Enter` with no modifier
- **THEN** R1's `enabled` flag becomes `true` in `draft` and its checkbox renders as checked
- **AND** `applied` becomes `{ rows: [R1 with enabled = true], combinator: draft.combinator }`
- **AND** `postgres.queryTable` is invoked with a `filter_tree` containing R1's condition — the query MUST NOT go out with an absent `filter_tree`
- **AND** R1 renders the green `Applied` badge
- **AND** R0's `enabled` flag and value are unchanged in `draft`

#### Scenario: Plain Enter on an incomplete row does not wipe the applied filter

- **WHEN** `applied.rows = [R0]`, focus is in an incomplete row R1's value input, and the user presses `Enter` with no modifier
- **THEN** `applied.rows` still equals `[R0]`
- **AND** `draft` is unchanged
- **AND** no fetch is triggered
- **AND** the bar shows a transient inline status stating the row is incomplete

#### Scenario: Shift+Enter applies all enabled rows

- **WHEN** `draft.rows` has R0 (checked) and R1 (unchecked), focus is in R1's value input, and the user presses `Shift+Enter`
- **THEN** `applied` becomes the enabled-complete subset of `draft.rows` joined by `draft.combinator` (so `applied.rows` contains R0 but not R1)
- **AND** `draft.combinator` is NOT changed
- **AND** R1's `enabled` flag stays `false`

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
