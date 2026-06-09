## MODIFIED Requirements

### Requirement: Direct save flow

The viewer SHALL apply edits directly when the user presses `⌘S` (or activates the Save button) AND the buffer has at least one dirty entry. The viewer MUST:

- Invoke `mssql_apply_table_edits` with the buffer's serialized `EditOp[]` and `origin: "user"`.
- While the apply is in flight, disable the Save button and show a progress indicator.
- On success, clear the buffer and refresh the viewer (the simplest correct behavior is to re-fetch the first page).
- On `AppError::Mssql`, surface a non-blocking error banner above the grid containing the numeric code (when present), the message, the line number (when present), and the `failed_op_index` (e.g. `Op #2 failed: [2627] Violation of PRIMARY KEY constraint 'PK_users'`). The buffer MUST stay intact.
- On `AppError::Validation` (read-only / payload / IDENTITY on insert), surface the same banner with the validation message. The buffer MUST stay intact.

The viewer MUST NOT open a diff preview modal in v1.

`⌘S` detection MUST use a `window`-level `keydown` listener that is active only while the table tab is the active tab — NOT the root `div`'s `onKeyDown` handler. The listener MUST trigger the save whenever the table tab is active AND the currently focused element is `null`/`document.body` OR is contained within the table tab's root element, EXCEPT when the focused element is inside a CodeMirror editor (`.cm-editor`), in which case `⌘S` MUST be left to that editor. Focus being outside the data grid (including no element focused) MUST NOT prevent the save. The non-save key handling (`⌫` delete, `⌘Z` undo, `⌘R` reload) MAY remain on the root `div`'s `onKeyDown`.

#### Scenario: Cmd-S applies the buffer directly

- **WHEN** the user has any dirty entries and presses `⌘S` while the table tab is active
- **THEN** `mssql_apply_table_edits` is invoked with the current `EditOp[]` and `origin: "user"`

#### Scenario: Cmd-S saves when focus is outside the grid

- **WHEN** the user has dirty entries, clicks an empty area so no grid cell is focused (or focuses a toolbar control), and presses `⌘S` while the table tab is active
- **THEN** `mssql_apply_table_edits` is invoked with the current `EditOp[]` and `origin: "user"`

#### Scenario: Cmd-S is left to a focused CodeMirror editor

- **WHEN** focus is inside a `.cm-editor` surface within the tab and the user presses `⌘S`
- **THEN** the viewer does NOT dispatch `mssql_apply_table_edits` from the global listener

#### Scenario: Cmd-S is no-op when buffer is clean

- **WHEN** the user presses `⌘S` with no dirty entries
- **THEN** no command is dispatched

#### Scenario: Apply success refreshes the viewer

- **WHEN** the apply succeeds with 1 update + 1 insert + 1 delete
- **THEN** the buffer is cleared and the viewer re-fetches its first page

#### Scenario: Op-failure banner shows numeric code and 1-based op index

- **WHEN** the apply returns `AppError::Mssql { code: Some(2627), failed_op_index: 2, message: "Violation of PRIMARY KEY constraint 'PK_users'" }`
- **THEN** a banner appears above the grid reading `Op #3 failed: [2627] Violation of PRIMARY KEY constraint 'PK_users'`
- **AND** the buffer is unchanged
