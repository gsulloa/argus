## MODIFIED Requirements

### Requirement: Right-click context menu on a table leaf

Right-clicking a table leaf SHALL open a context menu with these items in order: `Open` (equivalent to activation), `Open in PartiQL editor`, `Copy table name` (copies `tableName` to the clipboard), `Copy ARN` (copies the table ARN to the clipboard). `Open in PartiQL editor` MUST open a free-form PartiQL editor tab for the leaf's connection pre-filled with `SELECT * FROM "<tableName>"` (see the `dynamo-partiql-editor` capability). `Copy ARN` MUST prefer the cached `describe.tableArn` when available; if the describe has not loaded, `Copy ARN` MUST reconstruct the ARN locally from the connection's `region` and `accountId` (both available from the active client envelope) and the leaf's `tableName`, using the format `arn:aws:dynamodb:<region>:<accountId>:table/<tableName>`.

#### Scenario: Open item is equivalent to activation

- **WHEN** the user right-clicks a leaf and chooses `Open`
- **THEN** the same placeholder tab opens or is focused as a click would have done

#### Scenario: Open in PartiQL editor pre-fills a SELECT

- **WHEN** the user right-clicks the leaf `events` and chooses `Open in PartiQL editor`
- **THEN** a PartiQL editor tab opens for that connection with its body pre-filled with `SELECT * FROM "events"`

#### Scenario: Copy table name

- **WHEN** the user chooses `Copy table name` from the menu for the leaf `events`
- **THEN** the clipboard contains the literal string `events`

#### Scenario: Copy ARN with cached describe

- **WHEN** the user chooses `Copy ARN` for a leaf whose describe is cached with `table_arn: "arn:aws:dynamodb:us-east-1:123456789012:table/events"`
- **THEN** the clipboard contains exactly that ARN

#### Scenario: Copy ARN without cached describe reconstructs locally

- **WHEN** the user chooses `Copy ARN` for a leaf whose describe is not yet loaded, in a connection with `region: "eu-west-1"` and `accountId: "999988887777"`, for the leaf `orders`
- **THEN** the clipboard contains `arn:aws:dynamodb:eu-west-1:999988887777:table/orders`
