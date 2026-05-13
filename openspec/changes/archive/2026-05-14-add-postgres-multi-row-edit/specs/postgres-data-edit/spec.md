## ADDED Requirements

### Requirement: Bulk-edit mode in the inspector when multiple rows are selected

When the data grid has 2 or more rows selected (see `postgres-data-grid`, requirement "Drag-to-select row range") AND the **effective** selection (filtered as defined below) contains 2 or more rows, the inspector panel SHALL render in **bulk-edit mode** instead of its normal single-row view. The grid's inline cell editor MUST be suppressed while bulk-edit mode is active: double-clicking a cell MUST be a no-op.

**Effective selection filtering.** Before deciding which mode to render, the viewer MUST exclude from the selection:

- Rows whose `source` is `"insert"` (no server-assigned PK).
- Rows currently marked for delete in the edit buffer.
- Rows that lack a `rowKey`.

If the resulting effective count is `0` or `1`, the inspector MUST render in its existing single-row mode (and the row shown is the `active` row of the selection range), and the inline cell editor MUST be re-enabled.

If the relation has no primary key (`pkColumns === null`), the inspector MUST render a banner reading `Bulk edit unavailable on relations without a primary key` instead of editable fields. The Apply button MUST NOT be rendered in that case.

**Inspector header in bulk mode.** The inspector header MUST display `Inspector · <N> rows selected` where `<N>` is the effective count.

**Field rendering in bulk mode.** For every column of the relation:

- If the column is the relation's PK, `looksLikeBytea` of its `data_type`, OR at least one row in the effective selection has a cell envelope (`isCellEnvelope`) for that column, the column MUST be rendered read-only with a tooltip explaining why (PK / binary / envelope, respectively).
- If the connection is read-only, the column MUST be rendered read-only (consistent with the existing single-row inspector).
- Otherwise, the column MUST render an editable field using the same input types as the existing `InspectorEditableField` (boolean select, enum select, JSON/long-text textarea, numeric input, text input).

**Initial value of each editable field.**

- If every row in the effective selection has the same value in that column (compared by structural equality for objects/arrays, strict equality for scalars), the field MUST initialize with that common value in `pristine` state.
- If the rows have at least two distinct values in that column, the field MUST initialize empty (internal value `null`) with placeholder text `— multiple values —` styled `color: var(--muted); font-style: italic`.

**Per-field `touched` state.**

- Each editable field MUST track a local boolean `touched`, initially `false`.
- Any user interaction that changes the field's current value (typing into an input/textarea, picking a non-default option in a select, toggling a boolean) MUST set `touched = true`.
- A field with `touched === true` MUST render a distinguishing indicator: an accent-colored left border on the field AND a small filled dot (●) next to its label.
- A field with `touched === true` MUST render an `↺` revert button adjacent to its input. Clicking the revert button MUST set `touched = false` and reset the field's content to its pristine state (the common value, or empty + placeholder, as initialized).

**Apply footer.** When the inspector is in bulk-edit mode AND `pkColumns !== null`, a sticky footer MUST render at the bottom of the inspector body containing:

- A primary button `Apply to <N> rows` where `<N>` is the effective count. The button MUST be disabled when zero fields are touched, and enabled otherwise. Clicking the button MUST:
  1. Validate every touched field: JSON/JSONB columns MUST pass the same `validateJsonInput` strict-parse as the single-cell editor; any other per-type validation (numeric range, etc.) reuses the existing single-cell path. If any touched field fails validation, the apply MUST be aborted, the offending field MUST render its inline error UI (existing pattern: `danger` border + error text), and the buffer MUST NOT be mutated.
  2. Build `entries: Array<{ rowKey, column, value, pk, originalRow, originalColumns }>` of cardinality `M_touched × N_effective` (one entry per touched field, per eligible row), where `value` is the validated value from the field (or `null` for touched+empty), and `pk` is captured from each row's server cells.
  3. Invoke `buffer.bulkSetCellEdit(entries)` in a single dispatch.
  4. After a successful apply, reset every field to `touched = false` AND re-initialize each field's value from the (now updated) buffer-aware view of the same selected rows so that the inspector reflects the just-applied state in pristine.
- A secondary button `Cancel` MUST reset every touched field to pristine (`touched = false`, content reset) without modifying the buffer. The `Cancel` button does NOT clear the row selection.

**Selection-change ephemerality.** If the user changes the selection range while the inspector is in bulk-edit mode with touched fields, the touched state is discarded (the inspector remounts for the new selection). No confirmation dialog is required in this iteration.

**Backend.** The Tauri command `postgres_apply_table_edits` and the payload shape `EditOp` are NOT modified by this requirement. The `M_touched × N_eligible` entries collapse into `N_eligible` `EditOp.update` operations whose `changes` map contains all `M_touched` columns. The existing transactional apply commits atomically.

#### Scenario: 10 rows selected, one common-value column, two distinct-value columns

- **WHEN** the user has 10 server rows selected; column `status` is `"active"` in all 10 rows, column `priority` has 3 distinct values across the 10 rows, column `notes` has 7 distinct values
- **THEN** the inspector renders in bulk mode with `Inspector · 10 rows selected` in the header
- **AND** the `status` field initializes with value `"active"` in pristine state
- **AND** the `priority` field initializes empty with placeholder `— multiple values —`
- **AND** the `notes` field initializes empty with placeholder `— multiple values —`
- **AND** no field shows the touched indicator
- **AND** the Apply footer reads `Apply to 10 rows` and is disabled

#### Scenario: Touching a field enables Apply and shows the indicator

- **WHEN** the user types `archived` in the `status` field
- **THEN** the `status` field's left border becomes accent-colored, a ● dot appears next to its label, and an `↺` button appears next to its input
- **AND** the `Apply to 10 rows` button becomes enabled

#### Scenario: Touching multiple fields then applying writes all columns to all rows

- **WHEN** the user touches `status` (typed `archived`), `priority` (selected `low` in an enum), and clicks `Apply to 10 rows`
- **THEN** the edit buffer gains 10 `update` entries, one per eligible row, each with `changes: { status: "archived", priority: "low" }` and the row's own PK
- **AND** the dirty count in the bottom bar increases by 10
- **AND** `notes` is NOT in any of the `changes` (it was never touched)
- **AND** after apply, all fields are reset to `touched = false` and the inspector re-initializes (now `status` is `"archived"` in pristine, `priority` is `"low"` in pristine)

#### Scenario: Touched + empty applies NULL to all rows

- **WHEN** the user clicks the `notes` field (which shows the `— multiple values —` placeholder), types some text, then deletes everything so the field is empty (but touched remains true)
- **AND** clicks `Apply to 10 rows`
- **THEN** the buffer entry for `notes` writes `null` to all 10 eligible rows

#### Scenario: Revert button restores pristine state

- **WHEN** the user types `archived` in `status`, then clicks the `↺` button next to `status`
- **THEN** `status` re-shows its pristine common value `"active"`, the touched indicator disappears, and the `↺` button disappears
- **AND** if `status` was the only touched field, `Apply to 10 rows` becomes disabled again

#### Scenario: Cancel resets all touched fields without touching the buffer or the selection

- **WHEN** the user has touched `status` and `priority`, has 3 dirty cells from previous unrelated edits in the buffer, and clicks `Cancel`
- **THEN** the `status` and `priority` fields reset to pristine; the touched indicators disappear
- **AND** the 3 unrelated dirty cells remain in the buffer
- **AND** the row selection remains intact (rows 5..14 still highlighted)

#### Scenario: Invalid JSON in a touched field aborts the apply

- **WHEN** the user has touched `metadata` (jsonb) with text `{ "flag": ` (missing closing brace) and another field with valid content, and clicks `Apply to 10 rows`
- **THEN** the `metadata` field renders the danger-border + inline-error UI defined in requirement "JSON/JSONB edits validate as strict JSON on commit"
- **AND** the buffer is NOT mutated for any row or any column
- **AND** the touched state of all fields is preserved (no reset) so the user can fix and retry

#### Scenario: Selection drops to 1 effective row → inspector falls back to single-row mode

- **WHEN** the user has 10 rows selected, then drags to narrow the selection to a single row (or 8 of 10 are marked for delete and 1 is an insert, leaving 1 eligible)
- **THEN** the inspector remounts in single-row mode showing the active row
- **AND** the bulk Apply footer disappears
- **AND** the inline cell editor is re-enabled (double-click works again)

#### Scenario: No-PK relation hides the bulk editor

- **WHEN** the user selects 5 rows on a view (relation with `pkColumns === null`)
- **THEN** the inspector header still shows `Inspector · 5 rows selected`
- **AND** the body renders the banner `Bulk edit unavailable on relations without a primary key`
- **AND** no editable fields are rendered
- **AND** no Apply footer is rendered

#### Scenario: Read-only connection in bulk selection shows read-only fields

- **WHEN** the user is on a read-only connection and selects 5 rows
- **THEN** the inspector shows the 5-row bulk view but every field is read-only (consistent with the existing single-row read-only behavior)
- **AND** no Apply footer is rendered

#### Scenario: A bulk apply collapses into one EditOp.update per row with multiple columns in changes

- **WHEN** the user applies a bulk edit touching `status` and `priority` over 10 eligible rows, then presses `⌘S`
- **THEN** `postgres_apply_table_edits` is invoked with `edits: EditOp[]` of length 10, each entry being `{ kind: "update", pk: {...}, changes: { status: <v1>, priority: <v2> } }`
- **AND** all 10 ops commit in a single transaction

#### Scenario: Inline cell editor is suppressed while bulk-edit mode is active

- **WHEN** the user has 5 eligible rows selected (effective count ≥ 2) and double-clicks any non-PK cell in the grid
- **THEN** no inline editor opens
- **AND** the grid cells render with `cursor: default` (not `text`)

#### Scenario: Single `⌘Z` reverts the entire bulk apply

- **WHEN** the user has applied a bulk edit of `status = "archived"` + `priority = "low"` over 10 rows (10 buffer entries), then presses `⌘Z` once
- **THEN** all 10 entries are removed from the buffer in a single undo step
- **AND** none of the 50 affected cells render with the dirty-state background

## MODIFIED Requirements

### Requirement: Insert and delete affordances

The viewer SHALL render an "Add row" button in the bottom bar that, when activated, appends a new empty row to the buffer with kind `insert` and immediately enters inline edit mode on its first non-default column. The button MUST be hidden on read-only connections AND on relations with no PK (since INSERT is allowed without a PK, the button stays visible for tables with no PK — only relations that are views/materialized-views hide it).

The viewer SHALL accept the `Backspace` (`⌫`) key when one or more rows are selected AND no inline editor is active. Pressing `⌫` MUST toggle the delete mark on every row currently in the selection range. The action MUST be no-op on read-only connections. For each row in the selection range:

- If the row is an `insert` row (kind `insert` in the buffer), the row MUST be removed from the buffer entirely (consistent with the single-row behavior).
- Else if the row is a server row with a PK and is NOT already marked for delete, the row MUST be marked for delete using its PK.
- Else if the row is already marked for delete, the row's delete mark MUST be cleared (undelete).

All toggles produced by a single `⌫` press MUST be applied as a single batched action in the buffer (one undo entry, one React render), regardless of how many rows the selection contains. For relations with no PK, `⌫` MUST be no-op on server rows in the selection (delete of existing rows requires a PK); `insert` rows in the selection MUST still be removable.

#### Scenario: Add row inserts an editable empty row

- **WHEN** the user clicks "Add row"
- **THEN** a new row appears at the top of the buffer with kind `insert`
- **AND** an inline editor opens on the first editable column

#### Scenario: Add row hidden on a view

- **WHEN** the relation is a view (`relationKind: "view"`)
- **THEN** the "Add row" button is not rendered

#### Scenario: Backspace marks delete on the selection range

- **WHEN** the user selects rows 5..14 (10 server rows, none deleted) and presses `⌫`
- **THEN** all 10 rows are marked for delete (rendered with strike-through)
- **AND** the buffer records a single undo entry for the bulk toggle
- **AND** pressing `⌘Z` once reverts all 10 delete marks

#### Scenario: Backspace toggles mixed selection in one action

- **WHEN** the user selects rows 5..14 where row 7 is already marked for delete, row 5 is an `insert` row, and the others are clean server rows
- **AND** presses `⌫`
- **THEN** row 5 is removed from the buffer (insert removal)
- **AND** row 7's delete mark is cleared (undelete)
- **AND** rows 6, 8, 9, 10, 11, 12, 13, 14 are newly marked for delete
- **AND** the action is recorded as a single undo entry

#### Scenario: Backspace is no-op on read-only connection

- **WHEN** the user attempts the same action on a connection where `params.read_only: true`
- **THEN** no rows are marked for delete

#### Scenario: Backspace is no-op on server rows of a no-PK relation

- **WHEN** the user has selected rows 5..14 on a view (no PK) and presses `⌫`
- **THEN** no server rows are marked for delete
- **AND** any `insert` rows in the selection are still removed
