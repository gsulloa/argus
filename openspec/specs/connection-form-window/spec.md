# connection-form-window Specification

## Purpose
TBD - created by archiving change independent-modal-windows. Update Purpose after archive.
## Requirements
### Requirement: Connection form opens in a dedicated window

The connection create/edit form SHALL be presented in a dedicated native window (label `connection-form`), not as an in-window dialog overlay. Triggering "new connection" (after the kind picker selects an engine) or "edit connection" SHALL open or focus this window. The window SHALL be sized for the form's content and be resizable, and MUST NOT render the form as an overlay inside the Manager or Workspace window.

#### Scenario: New connection opens the form window

- **WHEN** the user selects an engine in the connection kind picker
- **THEN** a `connection-form` window opens (or is focused if already open) showing the create form for that engine
- **AND** no connection-form dialog overlay is rendered inside the Manager or Workspace window

#### Scenario: Edit connection opens the form window

- **WHEN** the user triggers "edit" on an existing connection
- **THEN** the `connection-form` window opens (or is focused if already open) showing the edit form prefilled with that connection's values

### Requirement: Single-instance window with focus

At most one `connection-form` window SHALL exist at a time. Triggering the form while the window already exists MUST reuse and focus the existing window rather than creating a second one. When re-triggered with a different intent (e.g. editing a different connection), the window SHOULD update to reflect the new intent before focusing; if it does not, it MUST at minimum focus the existing window without error.

#### Scenario: Re-trigger focuses the existing window

- **WHEN** a `connection-form` window is already open and the user triggers "new connection" again
- **THEN** no second `connection-form` window is created
- **AND** the existing window is shown and focused

#### Scenario: Re-trigger with a new edit target

- **WHEN** a `connection-form` window is open editing connection A and the user triggers "edit" on connection B
- **THEN** the existing window is focused
- **AND** the window reflects connection B's values, or otherwise focuses without error

### Requirement: Form intent prefill

The window SHALL receive its open intent (mode `create` or `edit`, the target engine kind, and for edit the connection id) and render accordingly. In `create` mode the form SHALL start empty for the chosen engine; in `edit` mode it SHALL prefill from the existing connection's stored metadata. The intent MUST NOT be carried in the window URL.

#### Scenario: Create mode starts empty

- **WHEN** the form window opens in `create` mode for the `postgres` engine
- **THEN** the Postgres connection form is shown with empty fields

#### Scenario: Edit mode prefills

- **WHEN** the form window opens in `edit` mode for an existing connection
- **THEN** the form is prefilled with that connection's name, params, and context path as stored

### Requirement: Submit persists and notifies the opener, then closes

On successful submission the window SHALL persist the connection via the existing `connections.create` / `connections.update` commands (secret/keychain handling unchanged), emit an event that causes the Manager and Workspace (if present) to refresh their connection lists, and then close itself. On cancel the window SHALL close without persisting. If persistence fails, the window SHALL remain open, surface the error, and preserve the entered values for retry.

#### Scenario: Successful create refreshes the opener and closes

- **WHEN** the user submits a valid new connection in the form window
- **THEN** the connection is created via `connections.create`
- **AND** the Manager (and Workspace, if present) refresh their connection list to include it
- **AND** the form window closes

#### Scenario: Successful edit refreshes the opener and closes

- **WHEN** the user submits a valid edit in the form window
- **THEN** the connection is updated via `connections.update`
- **AND** the opener's connection list reflects the updated values
- **AND** the form window closes

#### Scenario: Cancel closes without persisting

- **WHEN** the user cancels the form window
- **THEN** the window closes
- **AND** no `connections.create` or `connections.update` is invoked

#### Scenario: Persistence failure preserves the draft

- **WHEN** submission fails (e.g. validation rejected by the backend or a keychain error)
- **THEN** the window stays open and shows the error
- **AND** the entered values are preserved for retry

