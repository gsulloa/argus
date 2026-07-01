## MODIFIED Requirements

### Requirement: Context menu and keyboard interactions on tree nodes

The panel MUST provide a right-click context menu and keyboard shortcuts on tree nodes:

**On a query node:**
- `Open` (default action; also bound to `Enter` and double-click): invokes the open flow per the `postgres-sql-editor` capability. The open flow MUST reliably surface the query's tab to the user — it MUST NOT silently no-op. Specifically:
  - When the query is bound to a **live** connection (`last_connection_id` references a connection in the registry), the open flow MUST switch the focused connection to that connection so the opened (or re-focused) tab is visible in the tab strip.
  - When the query has **no** `last_connection_id`, or references a connection that is not live, the open flow MUST open the tab against the currently focused connection when one exists.
  - When no connection is focused **and** the query resolves to no live connection, the open flow MUST NOT do nothing: it MUST surface a clear affordance directing the user to focus/select a connection (rather than swallowing the action).
- `Open in new tab`: forces a new tab even if one already exists for this query. The same tab-surfacing and connection-resolution rules above apply.
- `Rename` (also `F2`): activates inline rename.
- `Duplicate`: invokes `saved_queries_duplicate`.
- `Move to folder…`: opens a folder-picker modal.
- `Delete` (also `Backspace`/`Delete` key): opens a confirmation dialog; on confirm invokes `saved_queries_delete`.

**On a folder node:**
- `New query` and `New folder`: create children of this folder.
- `Rename` (also `F2`).
- `Delete`: if the folder is non-empty, confirmation dialog reads `Delete folder "<name>" and all <n> items inside?`. If empty, confirmation reads `Delete folder "<name>"?`. On confirm invokes `saved_queries_folder_delete`.

**On the empty area / root:**
- `New query`, `New folder`, `Collapse all`.

Inline rename: the row's label becomes a `<input>` pre-filled with the current name and selected. `Enter` commits via `saved_queries_update` or `saved_queries_folder_update`; `Escape` cancels; empty trimmed names cancel silently.

#### Scenario: F2 enters rename mode

- **WHEN** the user focuses a query node with the keyboard and presses F2
- **THEN** the label is replaced with an editable input pre-filled with the name and selected
- **AND** the input has focus

#### Scenario: Delete query confirms before invoking

- **WHEN** the user invokes `Delete` on a query node
- **THEN** a confirmation dialog appears reading `Delete query "<name>"?`
- **AND** invoking `saved_queries_delete` happens only on confirmation

#### Scenario: Delete non-empty folder shows count

- **WHEN** the user invokes `Delete` on a folder containing 1 subfolder + 3 queries
- **THEN** the confirmation dialog reads `Delete folder "<name>" and all 4 items inside?`

#### Scenario: Opening a query bound to a non-focused connection surfaces its tab

- **WHEN** connection A is focused and the user opens a saved query whose `last_connection_id` references live connection B
- **THEN** the focused connection switches to B
- **AND** the query's tab is visible and active in B's tab strip

#### Scenario: Opening a query with no live connection uses the focused connection

- **WHEN** a connection is focused and the user opens a saved query that has no `last_connection_id` (or references a connection that is not live)
- **THEN** the query's tab opens against the focused connection with an empty connection selector
- **AND** the tab is visible and active

#### Scenario: Opening a query with no resolvable connection and no focus is not silently dropped

- **WHEN** no connection is focused and the user opens a saved query that resolves to no live connection
- **THEN** the app surfaces an affordance directing the user to focus/select a connection
- **AND** the action is not silently discarded (no invisible tab, no no-op)
