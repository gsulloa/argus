## MODIFIED Requirements

### Requirement: Direct save flow

The viewer SHALL apply edits directly when the user presses `⌘S` (or activates the Save button) AND the buffer has at least one dirty entry. The viewer MUST:

- Invoke `postgres_apply_table_edits` with the buffer's serialized `EditOp[]` and `origin: "user"`.
- While the apply is in flight, disable the Save button and show a progress indicator on it.
- On apply success (`outcome: "ok"`), clear the buffer and refresh the viewer's row list (the simplest correct behavior is to re-fetch the first page; surgical row-replace is a follow-up).
- On `outcome: "op_failed"`, surface a non-blocking error banner above the grid containing the SQLSTATE code (when present), the error message, and the `failed_op_index` (e.g. `Op #2 failed: 23505 unique_violation`). The buffer MUST stay intact.
- On thrown `AppError` (validation / read-only), surface the same banner with the error message. The buffer MUST stay intact.

The viewer MUST NOT open a diff preview modal. The diff preview command (`postgres_preview_table_edits`) does not exist in this capability.

`⌘S` detection MUST use a `window`-level `keydown` listener that is active only while the table tab is the active tab. The listener MUST trigger the save whenever the table tab is active AND the currently focused element is `null`/`document.body` OR is contained within the table tab's root element, EXCEPT when the focused element is inside a CodeMirror editor (`.cm-editor`), in which case `⌘S` MUST be left to that editor. Focus being outside the data grid (including no element focused) MUST NOT prevent the save.

#### Scenario: Cmd-S applies the buffer directly

- **WHEN** the user has any dirty entries and presses `⌘S` while the table tab is active
- **THEN** `postgres_apply_table_edits` is invoked with the current `EditOp[]` and `origin: "user"`
- **AND** no preview modal is rendered

#### Scenario: Cmd-S saves when focus is outside the grid

- **WHEN** the user has dirty entries, clicks an empty area so no grid cell is focused (or focuses a toolbar control), and presses `⌘S` while the table tab is active
- **THEN** `postgres_apply_table_edits` is invoked with the current `EditOp[]` and `origin: "user"`

#### Scenario: Cmd-S is left to a focused CodeMirror editor

- **WHEN** focus is inside a `.cm-editor` surface within the tab and the user presses `⌘S`
- **THEN** the viewer does NOT dispatch `postgres_apply_table_edits` from the global listener

#### Scenario: Cmd-S is no-op when buffer is clean

- **WHEN** the user presses `⌘S` with no dirty entries
- **THEN** no command is dispatched

#### Scenario: Apply success refreshes the viewer

- **WHEN** the apply succeeds with 1 update + 1 insert + 1 delete
- **THEN** the buffer is cleared
- **AND** the viewer re-fetches its first page so the user sees the committed state

#### Scenario: Op-failure banner stays until dismissed or next save

- **WHEN** the apply returns `outcome: "op_failed"` with `failed_op_index: 2`, code `"23505"`, message `"unique_violation"`
- **THEN** an error banner appears above the grid showing `Op #3 failed: [23505] unique_violation` (1-based index for users)
- **AND** the buffer is unchanged
- **AND** the banner is dismissable; the next ⌘S also clears it
