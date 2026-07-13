## ADDED Requirements

### Requirement: Entering edit mode without a change does not mark the cell dirty

When the grid is in editable mode, opening a cell's inline editor and leaving it without changing the content MUST NOT create a dirty buffer entry, and the cell MUST NOT render with the dirty-state (`--warning`) background. "Leaving without a
change" covers every editor-exit path that commits — blur, `Enter`, and `Tab` —
and every editor variant (text, numeric, JSON/JSONB textarea, boolean select,
enum select). The dirty highlight MUST be reserved for cells whose value the user
actually changed, so an edited cell is always visually distinguishable from a cell
that was only double-clicked.

This behavior MUST hold regardless of the column's data type. Because the inline
editor coerces its raw input into a typed `EditValue` on commit (e.g. a `numeric`
column whose server value is the string `"100.00"` is coerced to the number `100`;
a `jsonb` column's text is re-canonicalized), a naive `JSON.stringify` comparison
between the server value and the coerced commit value can differ even when the
user changed nothing. The implementation MUST prevent a spurious dirty entry in
these cases — either by not committing when the editor content is unchanged from
the value it opened with, or by making the buffer's drop-if-equals-original
collapse tolerant of numeric string↔number and canonicalized-JSON round-trips
(or both).

#### Scenario: Double-click then click away on a text cell stays clean

- **WHEN** the user double-clicks an editable `text` cell (opening the inline editor) and then clicks another cell without typing
- **THEN** the cell does NOT render with the dirty-state background
- **AND** the edit buffer contains no entry for that cell

#### Scenario: Double-click then commit an unchanged numeric cell stays clean

- **WHEN** a `numeric` cell's server value is `"100.00"` and the user double-clicks it and presses `Enter` (or `Tab`, or blurs) without editing the text
- **THEN** the cell does NOT render with the dirty-state background
- **AND** the edit buffer contains no entry for that cell (the numeric string↔number round-trip is recognized as unchanged)

#### Scenario: Double-click then commit an unchanged JSON cell stays clean

- **WHEN** a `jsonb` cell's server value is `{"a": 1}` and the user double-clicks it and commits without editing
- **THEN** the cell does NOT render with the dirty-state background
- **AND** the edit buffer contains no entry for that cell (canonicalized-JSON equality is recognized as unchanged)

#### Scenario: A real edit still marks the cell dirty

- **WHEN** the user double-clicks an editable cell, changes its value, and commits
- **THEN** the cell renders with the dirty-state background
- **AND** the edit buffer contains an `update` entry for that cell

#### Scenario: Editing a numeric cell then reverting to the original cleans the buffer

- **WHEN** the user edits a `numeric` cell whose server value is `"100.00"`, commits a different value, then re-opens the editor and commits `100.00` again
- **THEN** after the final commit the cell no longer renders the dirty-state background
- **AND** the edit buffer no longer contains an entry for that cell
