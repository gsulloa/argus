## ADDED Requirements

### Requirement: Connection form reflects context-folder state live

The connection-config form SHALL render the `ContextFolderRow` from the **live** connection record held in the connections registry store, identified by connection id, rather than from the immutable connection snapshot captured when the form was opened. After the user links, creates-and-links, or unlinks a context folder while the form is open, the linked-path display, the "Shared with N" count, and the **Sync schema…** button SHALL appear, update, or disappear immediately — within the same open window and without requiring the user to Save the connection or close and reopen the configuration window. This applies uniformly to every engine connection form that mounts `ContextFolderRow` (Postgres, MySQL, MSSQL, DynamoDB, Athena, CloudWatch).

#### Scenario: Linking a folder shows the Sync button immediately

- **WHEN** the user opens the configuration window for a saved connection that has no context folder, and links an existing context folder via the row's picker
- **THEN** the linked path row and the **Sync schema…** button appear in the same open window immediately after the link succeeds
- **AND** the user does not need to Save the connection or reopen the window for them to appear

#### Scenario: Creating and linking a new folder updates state immediately

- **WHEN** the user creates a new context folder from the row and it is linked to the open connection
- **THEN** the row transitions from the unlinked state to the linked state in place, showing the new path and the **Sync schema…** button

#### Scenario: Unlinking a folder reverts the row immediately

- **WHEN** the user unlinks the context folder from a connection while its configuration window is open
- **THEN** the row reverts to the unlinked state (folder picker / reuse options) in the same open window, without requiring Save or reopen

#### Scenario: Live state holds across every engine form

- **WHEN** any of the Postgres, MySQL, MSSQL, DynamoDB, Athena, or CloudWatch connection forms is open in edit mode and a context folder is linked or unlinked
- **THEN** that form reflects the change immediately, sourcing `contextPath` from the live registry record rather than the form's opening snapshot
