## MODIFIED Requirements

### Requirement: Sidebar DynamoDB connection rows

The sidebar's "Connections" section SHALL render each Dynamo connection as a row containing a Dynamo icon (kind-specific, distinct from the Postgres icon), the connection name, a status indicator (green dot when `useActiveConnections()` reports the id as connected, neutral dot when inactive, spinner while a connect call is in flight), and an `RO` badge when `params.read_only` is true. When `params.needs_credentials` is true, the row MUST display a small warning indicator (icon + tooltip "Session token expired").

The row's primary click handler SHALL behave as follows: on an inactive row it initiates `dynamo.connect`; on a row whose connection is in flight it is a no-op; on an active row it performs no destructive action. The row click MUST NOT dispatch `dynamo.disconnect`.

Disconnect MUST be reachable only from a dedicated `⏻` (power) button rendered on every active row, always visible (not hover-only), and sized to be a deliberate target distinct from the row body, or from the row's right-click context menu's `Disconnect` entry.

Right-clicking a row opens a context menu. On an active row the menu includes `New PartiQL query`, then a separator, then `Disconnect`, then a separator, then `Edit`, `Duplicate`, and `Delete`. Choosing `New PartiQL query` opens a free-form PartiQL editor tab for that connection (see the `dynamo-partiql-editor` capability). On an inactive row the menu includes only `Edit`, `Duplicate`, and `Delete` (no `New PartiQL query` entry, since the editor requires an active client).

The row's subtitle MUST display `region · <accountId>` when the connection is active and `region · <profile name>` or `region · access-keys` when the connection is inactive.

#### Scenario: Click on an inactive row connects

- **WHEN** the user clicks an inactive Dynamo connection row
- **THEN** `dynamo.connect(id)` is invoked; on success the active indicator turns green

#### Scenario: Click on an active row does not disconnect

- **WHEN** the user clicks the body of a Dynamo connection row whose connection is currently active
- **THEN** no `dynamo.disconnect` command is dispatched

#### Scenario: Disconnect button is always visible on active rows

- **WHEN** any Dynamo connection is active
- **THEN** that row renders a `⏻` button regardless of hover state, with a `title`/`aria-label` of "Disconnect"

#### Scenario: needs_credentials warning indicator

- **WHEN** a Dynamo connection's `params.needs_credentials` is `true`
- **THEN** the row displays a warning indicator next to the name with a tooltip explaining "Session token expired"

#### Scenario: RO badge visible when read-only

- **WHEN** a Dynamo connection has `params.read_only: true`
- **THEN** the row displays an `RO` badge next to the name

#### Scenario: Right-click context menu on active row

- **WHEN** the user right-clicks an active Dynamo connection row
- **THEN** a menu appears with `New PartiQL query`, `Disconnect`, `Edit`, `Duplicate`, and `Delete`

#### Scenario: New PartiQL query opens the editor

- **WHEN** the user chooses `New PartiQL query` from an active row's context menu
- **THEN** a free-form PartiQL editor tab opens for that connection

#### Scenario: Right-click context menu on inactive row

- **WHEN** the user right-clicks an inactive Dynamo connection row
- **THEN** a menu appears with `Edit`, `Duplicate`, and `Delete` (no `New PartiQL query` entry)

#### Scenario: Delete confirmation

- **WHEN** the user chooses `Delete` from the context menu and confirms
- **THEN** `connections.delete(id)` is invoked, the row disappears, and any active client for that id is dropped via `dynamo.disconnect`

#### Scenario: Subtitle for inactive profile-mode row

- **WHEN** a Dynamo connection is inactive with `auth: "profile"`, `profile: "argus-readonly"`, `region: "us-east-1"`
- **THEN** the row's subtitle reads `us-east-1 · argus-readonly`

#### Scenario: Subtitle for active row

- **WHEN** a Dynamo connection is active with `region: "eu-west-1"` and connect returned `accountId: "123456789012"`
- **THEN** the row's subtitle reads `eu-west-1 · 123456789012`
