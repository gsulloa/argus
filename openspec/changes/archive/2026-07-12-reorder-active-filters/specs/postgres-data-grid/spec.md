## ADDED Requirements

### Requirement: Reorderable filter rows

The filter bar SHALL let the user reorder the rows in the `draft` filter list via
drag-and-drop, so the visual order of rows reflects the user's own grouping or
priority. Each `ConditionRow` MUST expose a dedicated drag handle rendered as the
row's leading control; only the handle initiates a drag (the row's checkbox,
column picker, operator picker, value input, per-row Apply, and `−`/`+` buttons
MUST remain independently clickable). Pointer-initiated drags MUST require a small
movement threshold (activation distance) before a reorder begins, so a plain click
on any inline control never starts a drag.

Reordering MUST be **result-neutral**: because the enabled-and-complete rows are
joined under a single root combinator (`AND`/`OR`) which is commutative, changing
row order MUST NOT change which rows are returned by `postgres_query_table` /
`postgres_count_table`. The only effects of a reorder are the visual row order and
the order of predicates in the compiled `WHERE` preview.

A completed reorder MUST update `draft` only (like every other filter-bar edit),
via a pure `moveRow(tree, from, to)` mutation that moves one row to a new index and
leaves `combinator` unchanged. It MUST therefore mark the bar dirty when the
resulting `draft` row order differs from `applied`, and it MUST be persisted with
the existing per-table filter storage so the order survives reloads even if the
user never applies. Applying (per-row Apply, Apply All, or the combinator menu)
MUST continue to work unchanged and commit the current `draft` order into
`applied`.

Reordering MUST be keyboard-accessible: the drag handle MUST be focusable and,
when focused, MUST allow moving the row up or down the list using the keyboard.

To support a stable sortable list, every `FilterRow` MUST carry a **client-only**
stable `id`. This `id` MUST be minted when a row is created and backfilled for any
persisted row that lacks one when the filter is loaded. The `id` MUST NOT be
emitted on the wire (`filter_tree` children continue to carry only
`column`/`op`/`value`) and MUST NOT affect dirty detection or the per-row
"Applied" badge (row equality continues to compare `column`/`op`/`value` and, for
dirty detection, `enabled`).

#### Scenario: Dragging a row changes its position

- **WHEN** the draft has three rows `[A, B, C]` and the user drags row `C`'s handle
  and drops it above row `A`
- **THEN** the draft row order becomes `[C, A, B]`
- **AND** only `draft` is updated (`applied` is unchanged)
- **AND** the dirty indicator becomes visible because `draft` order now differs
  from `applied`

#### Scenario: Reordering does not change query results

- **WHEN** the user reorders enabled-and-complete rows and then applies the filter
- **THEN** the compiled `WHERE` joins the same predicates under the same combinator
  in the new order
- **AND** the set of rows returned by `postgres_query_table` is identical to the
  set returned before the reorder

#### Scenario: Clicking an inline control does not start a drag

- **WHEN** the user clicks (without dragging past the activation distance) on a
  row's value input, operator picker, checkbox, Apply, `−`, or `+` control
- **THEN** no reorder occurs and the clicked control behaves normally

#### Scenario: Keyboard reordering of the focused row

- **WHEN** the user focuses a row's drag handle and issues the keyboard
  move-down gesture
- **THEN** that row moves one position toward the end of the list
- **AND** the change updates `draft` only and marks the bar dirty

#### Scenario: Reordered order persists across reloads without Apply

- **WHEN** the user reorders rows but never presses Apply, then reopens the same
  table tab
- **THEN** the filter bar renders the rows in the reordered order (restored from
  the persisted `draft`)

#### Scenario: Row identity is client-only and not sent on the wire

- **WHEN** the draft rows each carry a stable client-only `id` and the user applies
  the filter
- **THEN** the `filter_tree` children sent to `postgres_query_table` contain only
  `column`, `op`, and `value` (no `id`)
- **AND** the dirty indicator and per-row "Applied" badge are unaffected by the
  presence of the `id`

#### Scenario: Legacy persisted rows are backfilled with an id

- **WHEN** a persisted filter is loaded whose rows were saved before row ids
  existed (rows without an `id`)
- **THEN** each such row is assigned a fresh stable `id` on load
- **AND** the row's `column`, `op`, `value`, and `enabled` are otherwise unchanged
