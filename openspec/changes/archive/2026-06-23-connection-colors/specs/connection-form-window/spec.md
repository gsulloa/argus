## MODIFIED Requirements

### Requirement: Form intent prefill

The window SHALL receive its open intent (mode `create` or `edit`, the target engine kind, and for edit the connection id) and render accordingly. In `create` mode the form SHALL start empty for the chosen engine; in `edit` mode it SHALL prefill from the existing connection's stored metadata, including its assigned color (or "no color"). The form SHALL present a color picker offering the fixed connection-colors palette plus a "no color" option. The intent MUST NOT be carried in the window URL.

#### Scenario: Create mode starts empty

- **WHEN** the form window opens in `create` mode for the `postgres` engine
- **THEN** the Postgres connection form is shown with empty fields
- **AND** the color picker defaults to "no color"

#### Scenario: Edit mode prefills

- **WHEN** the form window opens in `edit` mode for an existing connection
- **THEN** the form is prefilled with that connection's name, params, and context path as stored

#### Scenario: Edit mode prefills the color

- **WHEN** the form window opens in `edit` mode for a connection whose stored color is `green`
- **THEN** the color picker shows `green` as selected

### Requirement: Submit persists and notifies the opener, then closes

On successful submission the window SHALL persist the connection via the existing `connections.create` / `connections.update` commands (secret/keychain handling unchanged), including the selected color (or `null` for "no color"), emit an event that causes the Manager and Workspace (if present) to refresh their connection lists, and then close itself. On cancel the window SHALL close without persisting. If persistence fails, the window SHALL remain open, surface the error, and preserve the entered values for retry.

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

#### Scenario: Submitting a chosen color persists it

- **WHEN** the user selects the `violet` swatch and submits the form
- **THEN** the persisted connection's color is `violet`
- **AND** the refreshed connection list reflects the violet color

#### Scenario: Cancel closes without persisting

- **WHEN** the user cancels the form window
- **THEN** the window closes
- **AND** no `connections.create` or `connections.update` is invoked

#### Scenario: Persistence failure preserves the draft

- **WHEN** submission fails (e.g. validation rejected by the backend or a keychain error)
- **THEN** the window stays open and shows the error
- **AND** the entered values are preserved for retry
