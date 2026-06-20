## ADDED Requirements

### Requirement: Forced schema-reload accelerator

The Workspace window SHALL register a global `Cmd+R` (macOS) / `Ctrl+R` (other platforms) keyboard accelerator that forces a reload of the **focused** connection's schema/table tree. The handler MUST resolve the focused connection's engine and trigger that engine's existing refresh path — dropping the connection's schema/table cache entry and re-fetching — identical in effect to activating that connection's tree refresh button. The handler MUST call `preventDefault` so the native webview reload does not fire. When no connection is focused, the accelerator MUST be a no-op (it MUST still suppress the native reload). The accelerator MUST NOT fire while the user is typing in an input or textarea.

#### Scenario: Cmd+R reloads the focused connection's tree

- **WHEN** a connection is focused in the rail and the user presses `Cmd+R` / `Ctrl+R`
- **THEN** that connection's schema/table cache is dropped and its tree re-fetches
- **AND** the native webview reload does not occur

#### Scenario: Cmd+R with no focused connection is a safe no-op

- **WHEN** no connection is focused and the user presses `Cmd+R` / `Ctrl+R`
- **THEN** no refresh is triggered
- **AND** the native webview reload is still suppressed

#### Scenario: Accelerator routes to the focused engine

- **WHEN** the focused connection is a Postgres connection and the user presses `Cmd+R`
- **THEN** only the Postgres refresh path runs for that connection
- **AND** switching focus to a DynamoDB connection and pressing `Cmd+R` runs the DynamoDB refresh path instead
