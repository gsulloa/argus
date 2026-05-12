## MODIFIED Requirements

### Requirement: Query tab kind

The frontend SHALL register a tab kind `postgres-query` and SHALL render it in the center work area when the user activates a "New Query" entry point (sidebar button, palette command, double-click on a saved query). The tab payload MUST be `{ initialConnectionId?: string, initialConnectionName?: string, initialSql: string, savedQueryId?: string }`. The tab MUST have an id of the form `pgquery:<uuid>` where `<uuid>` is a fresh v4 UUID generated on tab creation; the id MUST NOT embed the connection id (the connection is mutable in runtime — see "Connection selector in editor toolbar").

The current connection of a tab MUST live in per-tab state (`useQueryTabState`), not in the tab payload or in the tab id. When the tab is created, the current connection is initialized from `initialConnectionId` (or from the most recently-used connection of the saved query if `savedQueryId` is provided and the persisted `last_connection_id` references an existing connection), or unset if neither is available.

The default tab title MUST be:
- The saved query's `name` when `savedQueryId` is provided.
- `Query <N>` otherwise, where `N` is a global running counter starting at 1 (no longer per-connection, since tabs are no longer bound to a connection). The counter resets when the app launches.

Activating "New Query" with no `savedQueryId` MUST always create a new tab (never focus an existing one). Activating "Open" on a saved query whose `savedQueryId` matches an already-open tab MUST focus the existing tab instead of creating a new one. The "Open in new tab" action on a saved query MUST always create a new tab.

#### Scenario: New Query opens a fresh tab without a saved query binding

- **WHEN** the user clicks `+ Query` from the sidebar
- **THEN** a center-area tab of kind `postgres-query` opens with payload `{ initialConnectionId: <current focused connection or undefined>, initialSql: "", savedQueryId: undefined }` and id `pgquery:<uuid>`
- **AND** the tab title is `Query <N>` for the next global counter value

#### Scenario: Opening a saved query reuses existing tab

- **WHEN** a `postgres-query` tab already exists with `state.savedQueryId === "abc"`
- **AND** the user double-clicks the saved query `abc` in the sidebar tree
- **THEN** the existing tab is focused (no new tab created)

#### Scenario: Opening a saved query in a new tab forces creation

- **WHEN** a `postgres-query` tab already exists with `state.savedQueryId === "abc"`
- **AND** the user selects `Open in new tab` from the context menu on saved query `abc`
- **THEN** a second `postgres-query` tab is created with `state.savedQueryId === "abc"` and a fresh `pgquery:<uuid>` id
- **AND** both tabs coexist in the tab strip

#### Scenario: Saved query restores last_connection_id when present

- **WHEN** the user opens saved query `abc` and its persisted `last_connection_id` is `conn-prod` which is a currently registered connection
- **THEN** the new tab's current connection is set to `conn-prod` and the editor toolbar's connection selector reflects this

#### Scenario: Saved query without a valid last connection opens with selector empty

- **WHEN** the user opens a saved query whose `last_connection_id` is null OR references a connection that no longer exists in the registry
- **THEN** the tab opens with no current connection and the editor toolbar's selector shows a placeholder prompting selection

## ADDED Requirements

### Requirement: Connection selector in editor toolbar

Each `postgres-query` tab SHALL render a connection selector control as the leftmost element of the editor toolbar (the same toolbar that hosts `Format` and `Save`). The selector MUST:

- Display the name of the currently-selected connection along with a status dot reusing the status visualization from the Connections sidebar (e.g. green when connected, gray when disconnected). When no connection is selected, the trigger shows the placeholder `Select connection…`.
- Open a dropdown listing every connection registered in the connection registry, ordered the same way as the Connections sidebar (groups respected). Each item shows the connection name and the same status dot.
- On selection, update the tab's `currentConnectionId` and `currentConnectionName` in `useQueryTabState`.

Switching connections MUST:

1. Reconfigure the autocomplete `Compartment` of the editor to re-bind `schemaCompletionSource` to `globalSchemaCache.getNamespace(newConnectionId)`, following the same debounce and shape-equality skip rules already specified in "Schema-aware autocomplete from in-memory cache".
2. Discard the current `runner.state` (any prior result was bound to the previous connection). The result panel reverts to the empty hint state.
3. NOT mark the tab as dirty (the saved query record does not track connection).
4. When `state.savedQueryId` is set, persist the new `currentConnectionId` to the saved query's `last_connection_id` via `saved_queries_update`, debounced 1000ms, fire-and-forget.

When the user invokes Run (`Mod-Enter`, `Mod-Shift-Enter`) with no connection selected, the frontend MUST surface a toast `Select a connection first.` and MUST NOT invoke `postgres_run_sql` or `postgres_run_sql_many`.

The selector's connection list MUST reactively update when connections are added, removed, renamed, or change connection state.

#### Scenario: Selector reflects current connection with status dot

- **WHEN** the tab's current connection is `prod_db` and it is connected
- **THEN** the selector trigger displays `prod_db` with a green status dot

#### Scenario: Changing connection re-binds autocomplete

- **WHEN** the user has the editor open with `prod_db` selected and types `SELECT * FROM public.` to confirm completions reflect `prod_db` schema
- **AND** the user changes the selector to `staging_db`
- **THEN** within ~100ms typing `SELECT * FROM public.` shows completions from `staging_db`'s schema cache (or empty if not loaded)
- **AND** the editor's syntax highlighting, undo history, and cursor are preserved

#### Scenario: Changing connection clears the result panel

- **WHEN** a result is displayed from a SELECT against `prod_db`
- **AND** the user changes the selector to `staging_db`
- **THEN** the result panel reverts to the empty hint state (`Press ⌘↩ to run · Tab to autocomplete`)
- **AND** the tab is NOT marked dirty by the connection change

#### Scenario: Run with no connection selected is rejected client-side

- **WHEN** the tab has no current connection and the user presses `Mod-Enter` with non-empty SQL
- **THEN** a toast `Select a connection first.` appears
- **AND** neither `postgres_run_sql` nor `postgres_run_sql_many` is invoked

#### Scenario: Selector persists last_connection_id for saved query

- **WHEN** a tab has `state.savedQueryId = "abc"` and the user changes the connection to `staging_db`
- **THEN** within ~1 second `saved_queries_update({ id: "abc", last_connection_id: "<staging_db uuid>" })` is invoked
- **AND** the tab is NOT marked dirty

### Requirement: Save action in editor toolbar

Each `postgres-query` tab SHALL render a `Save` button in the editor toolbar (to the right of the connection selector, before `Format`). The editor SHALL also bind `Mod-S` to the same action at `Prec.highest` so it cannot be intercepted by other extensions or browser defaults.

When invoked, the action MUST:

- **First save (no `state.savedQueryId`)**: open a modal `SaveAsModal` with two fields — `Name` (text input, required, pre-filled with the tab title if non-default) and `Folder` (a tree picker of `saved_query_folders`, defaulting to the value stored in settings key `savedQueries:lastUsedFolder` or root if unset). The modal MUST provide a `+ New folder…` affordance that inline-creates a child folder under the current selection. On confirm:
  1. Invoke `saved_queries_create({ folder_id, name, sql: <current editor text>, last_connection_id: <current connection id or null> })`.
  2. Update tab state: `savedQueryId = record.id`, `savedSql = record.sql`, `savedName = record.name`, `savedFolderId = record.folder_id`. Set `tab.title = record.name`.
  3. Persist `savedQueries:lastUsedFolder = folder_id` in settings.
  4. Surface a brief success toast `Saved as "<name>"`.

- **Subsequent saves (`state.savedQueryId` present)**: directly invoke `saved_queries_update({ id, name: <state.editedName ?? savedName>, sql: <current editor text> })`. No modal. On success, update `savedSql` and `savedName` to the new values and bump the tab title if the name changed. Surface a brief toast `Saved`.

The action MUST be a no-op (silent, no toast, no command) if the tab is not dirty (current SQL and name equal the saved snapshot). The action MUST still be invokable when the editor is empty (an empty saved query is valid).

#### Scenario: First save opens the modal

- **WHEN** the user has a new tab with `SELECT 1` typed and no `savedQueryId`
- **AND** the user presses `Mod-S`
- **THEN** a `SaveAsModal` appears with Name pre-filled, Folder defaulting to the last used folder
- **AND** confirming with name `Test` invokes `saved_queries_create` with `{ name: "Test", sql: "SELECT 1", folder_id, last_connection_id }`
- **AND** the tab's title becomes `Test` and its `state.savedQueryId` is set

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

### Requirement: Dirty state tracking and unsaved-changes confirmation

Each `postgres-query` tab SHALL track a `dirty: boolean` derived from:

- For tabs with `state.savedQueryId`: `dirty = (currentSql !== savedSql) || (currentName !== savedName)`.
- For tabs without `state.savedQueryId`: `dirty = currentSql.trim().length > 0`.

The dirty state MUST surface visually as a leading `●` character before the tab title in the tab strip. The tooltip on the dirty indicator MUST read `Unsaved changes`.

Changing the current connection MUST NOT affect `dirty`. Successfully running the query MUST NOT clear `dirty`. Only a successful `Save` (or reverting edits to match the saved snapshot) clears `dirty`.

When the user attempts to close a `dirty` tab via `Mod-W` or the tab close button:

- If the tab has `state.savedQueryId`: show a confirmation dialog `Discard unsaved changes to "<name>"?` with buttons `Discard` (destructive) and `Cancel` (default). Only `Discard` proceeds with closing.
- If the tab has NO `state.savedQueryId` (never-saved scratch buffer with content): close immediately without prompt (preserves the existing "Tab close discards buffer without confirm" behavior for ad-hoc queries).

After closing in either case, the `pgQueryBuffer:<tabId>` settings key MUST still be removed per the existing requirement.

#### Scenario: Editing a saved query marks it dirty

- **WHEN** a tab is bound to a saved query and the user types one character into the editor
- **THEN** the tab title is prefixed with `● `
- **AND** the tooltip on the dot reads `Unsaved changes`

#### Scenario: Reverting edits clears dirty

- **WHEN** a tab is dirty because of one edit
- **AND** the user undoes that edit so the buffer matches `savedSql` again
- **THEN** the leading `● ` disappears from the tab title

#### Scenario: Saving clears dirty

- **WHEN** a dirty tab is saved via `Mod-S`
- **THEN** the leading `● ` disappears immediately on success

#### Scenario: Connection change does not mark dirty

- **WHEN** a clean tab (no `● `) has the connection switched via the toolbar selector
- **THEN** the tab remains clean (no `● `)

#### Scenario: Closing dirty saved query prompts to discard

- **WHEN** a tab has `state.savedQueryId` set and is dirty, and the user presses `Mod-W`
- **THEN** a confirmation dialog `Discard unsaved changes to "<name>"?` appears
- **AND** clicking `Cancel` keeps the tab open
- **AND** clicking `Discard` closes the tab and removes the `pgQueryBuffer:<tabId>` key

#### Scenario: Closing dirty ad-hoc tab is immediate

- **WHEN** a tab has no `state.savedQueryId` and is dirty (non-empty SQL)
- **AND** the user presses `Mod-W`
- **THEN** the tab closes immediately without a prompt
- **AND** the `pgQueryBuffer:<tabId>` key is removed
