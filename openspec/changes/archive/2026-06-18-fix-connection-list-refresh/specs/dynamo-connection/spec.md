## ADDED Requirements

### Requirement: Connection list refresh on save

The Dynamo connection form SHALL persist creates, updates, and duplicates through the `useConnections()` React context wrappers (whose contract is to invoke `connectionsApi.create` / `connectionsApi.update` and then refresh the in-memory connection list before resolving), rather than calling `connectionsApi` directly. After a successful Save, Save & Connect, edit, or duplicate, the sidebar Connections section MUST reflect the change within the same app session without requiring an app restart or a manual refresh action by the user.

#### Scenario: Saving a new Dynamo connection updates the sidebar immediately

- **WHEN** the user opens the Dynamo connection form, fills valid fields, clicks "Save", and the dialog closes
- **THEN** the sidebar Connections section displays the new connection row in the same app session, with no restart and no other user-triggered refresh

#### Scenario: Editing an existing Dynamo connection updates the sidebar immediately

- **WHEN** the user opens the Dynamo connection form in edit mode, renames the connection, clicks "Save", and the dialog closes
- **THEN** the sidebar Connections section displays the updated name in the same app session, with no restart

#### Scenario: Duplicating a Dynamo connection updates the sidebar immediately

- **WHEN** the user duplicates an existing Dynamo connection via the form's duplicate mode and clicks "Save"
- **THEN** the sidebar Connections section displays the new duplicated row in the same app session, with no restart

#### Scenario: Form does not import the raw connections API

- **WHEN** the Dynamo connection form module is inspected
- **THEN** it does not import or call `connectionsApi.create` or `connectionsApi.update` directly; persistence is performed exclusively through the `useConnections()` context's `create` / `update` methods
