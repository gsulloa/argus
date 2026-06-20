## MODIFIED Requirements

### Requirement: Connection selector in editor toolbar

Each `postgres-query` tab SHALL render a connection selector control as the leftmost element of the editor toolbar (the same toolbar that hosts `Format` and `Save`). The selector MUST:

- Display the name of the currently-selected connection along with a status dot reusing the status visualization from the Connections sidebar (e.g. green when connected, gray when disconnected). When no connection is selected, the trigger shows the placeholder `Select connection…`.
- Open a dropdown listing every connection registered in the connection registry, ordered the same way as the Connections sidebar (groups respected). Each item shows the connection name, the same status dot, and the connection's human-readable engine type label.
- Render the engine type label using the shared `engineLabel(kind)` helper (`PostgreSQL`, `MySQL`, `SQL Server`, `DynamoDB`, `Athena`, falling back to the raw `kind` for unknown engines). The label MUST appear beside the connection name as muted, neutral text (no accent color) and MUST NOT collapse or truncate the connection name. The trigger (collapsed) state is NOT required to show the type label.
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

#### Scenario: Dropdown items show the engine type label

- **WHEN** the dropdown is open and lists a Postgres connection `prod_db` and a DynamoDB connection `events`
- **THEN** the `prod_db` item shows the name `prod_db` with a muted `PostgreSQL` label
- **AND** the `events` item shows the name `events` with a muted `DynamoDB` label
- **AND** the type label does not truncate or hide either connection name

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
