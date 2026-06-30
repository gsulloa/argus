## MODIFIED Requirements

### Requirement: Query tab kind

The frontend SHALL register a tab kind `postgres-query` and SHALL render it in the center work area when the user activates a "New Query" entry point (sidebar button, palette command, double-click on a saved query). The tab payload MUST be `{ initialConnectionId?: string, initialConnectionName?: string, initialSql: string, savedQueryId?: string }`. The tab MUST have an id of the form `pgquery:<uuid>` where `<uuid>` is a fresh v4 UUID generated on tab creation; the id MUST NOT embed the connection id (the connection is mutable in runtime — see "Connection selector in editor toolbar").

When opening a `postgres-query` tab, the shell MUST route the tab to the per-connection tab set identified by the payload's `initialConnectionId` when present, and MUST do so regardless of whether any connection is currently focused. Only when the payload carries no `initialConnectionId` MAY the shell fall back to the currently focused connection. The shell MUST NOT require a focused connection to open a `postgres-query` tab that already names its connection in the payload. (This makes the `Open` / `Open in new tab` / double-click actions on a saved query reliable even when the saved-queries panel is shown without a focused connection.)

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

#### Scenario: Saved query opens its tab when no connection is focused

- **WHEN** no connection is currently focused
- **AND** the user double-clicks (or selects `Open` / `Open in new tab` on) a Postgres saved query `abc` whose `last_connection_id` is `conn-prod`, a currently registered connection
- **THEN** a `postgres-query` tab is created in the `conn-prod` tab set loaded with the saved query's SQL
- **AND** the open action is not a silent no-op

#### Scenario: Saved query tab routes to its own connection, not the focused one

- **WHEN** connection `conn-a` is focused
- **AND** the user opens a Postgres saved query bound to `conn-prod`
- **THEN** the new `postgres-query` tab is created in the `conn-prod` tab set (identified by the payload `initialConnectionId`), not in the focused `conn-a` set

#### Scenario: Saved query restores last_connection_id when present

- **WHEN** the user opens saved query `abc` and its persisted `last_connection_id` is `conn-prod` which is a currently registered connection
- **THEN** the new tab's current connection is set to `conn-prod` and the editor toolbar's connection selector reflects this

#### Scenario: Saved query without a valid last connection opens with selector empty

- **WHEN** the user opens a saved query whose `last_connection_id` is null OR references a connection that no longer exists in the registry
- **THEN** the tab opens with no current connection and the editor toolbar's selector shows a placeholder prompting selection
