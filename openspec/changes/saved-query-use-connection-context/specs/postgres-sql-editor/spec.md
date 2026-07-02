## MODIFIED Requirements

### Requirement: Save action in editor toolbar

Each `postgres-query` tab SHALL render a `Save` button in the editor toolbar (to the right of the connection selector, before `Format`). The editor SHALL also bind `Mod-S` to the same action at `Prec.highest` so it cannot be intercepted by other extensions or browser defaults.

When invoked, the action MUST:

- **First save (no `state.savedQueryId`)**: open a modal `SaveAsModal` with a single field — `Name` (text input, required, pre-filled with the tab title if non-default). The modal MUST NOT prompt the user to choose a destination folder: the query is always saved into the current connection's linked context folder. On confirm:
  1. Invoke `context_save_query({ connection_id: <current connection id>, name, sql: <current editor text>, mode: "create" })`, writing the query into the connection's context folder.
  2. Update tab state so subsequent saves overwrite the same context query; set `tab.title = <name>`.
  3. Surface a brief success toast `Saved as "<name>"`.
  4. If the connection has no linked context folder, surface an informational toast prompting the user to link one and write nothing. If a query with the derived name already exists, surface an error toast and re-open the modal so the user can pick a different name.

- **Subsequent saves (`state.savedQueryId` present)**: directly invoke `saved_queries_update({ id, name: <state.editedName ?? savedName>, sql: <current editor text> })`. No modal. On success, update `savedSql` and `savedName` to the new values and bump the tab title if the name changed. Surface a brief toast `Saved`.

The action MUST be a no-op (silent, no toast, no command) if the tab is not dirty (current SQL and name equal the saved snapshot). The action MUST still be invokable when the editor is empty (an empty saved query is valid).

#### Scenario: First save opens a Name-only modal

- **WHEN** the user has a new tab with `SELECT 1` typed and no `savedQueryId`
- **AND** the user presses `Mod-S`
- **THEN** a `SaveAsModal` appears with Name pre-filled and no folder picker
- **AND** confirming with name `Test` invokes `context_save_query` with `{ connection_id, name: "Test", sql: "SELECT 1", mode: "create" }`
- **AND** the tab's title becomes `Test`

#### Scenario: First save without a linked context folder

- **WHEN** the current connection has no linked context folder and the user confirms the first save
- **THEN** an informational toast prompts the user to link a context folder
- **AND** no query file is written

#### Scenario: Subsequent save is direct overwrite

- **WHEN** a tab already has `state.savedQueryId = "abc"` and the user edits the SQL
- **AND** the user presses `Mod-S`
- **THEN** `saved_queries_update({ id: "abc", sql: <new sql>, name: <current name> })` is invoked
- **AND** no modal appears

#### Scenario: Save on clean tab is a no-op

- **WHEN** the tab's current SQL and name match the saved snapshot
- **AND** the user presses `Mod-S`
- **THEN** no command is invoked and no toast appears

#### Scenario: Mod-S binding wins over default keymap

- **WHEN** the editor is focused and the user presses `Mod-S`
- **THEN** the save action fires exactly once
- **AND** no browser "Save Page" dialog appears
- **AND** no other extension intercepts the keystroke
