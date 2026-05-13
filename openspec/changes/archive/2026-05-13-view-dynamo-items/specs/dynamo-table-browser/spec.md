## MODIFIED Requirements

### Requirement: Activating a table node opens the data view tab

The frontend SHALL respond to activation (Enter, single click, or double click — equivalent) on any table leaf by opening or focusing a center-area tab of `kind: "dynamo-data-view"` with payload `{ connectionId, connectionName, tableName, describe }` and stable id `dynamotbl:<connectionId>:<tableName>`. The payload's `describe` field MUST be the cached `TableDescription` for that table, or `null` if the describe has not yet loaded. When opened with a `null` describe, the data view tab MUST fire `dynamo.describeTable` itself and render the result on its Metadata sub-view on arrival. Activating the same leaf a second time MUST focus the existing tab; it MUST NOT open a duplicate. The data view's full set of affordances (Tabla / JSON modes, structured query builder, pagination, inspector, count, metadata sub-view) is defined by the `dynamo-data-view` capability. The retired `dynamo-table-placeholder` tab kind MUST NOT be used; any session-persisted tab records referencing it MUST be rewritten on load to `kind: "dynamo-data-view"` with their `describe` payload preserved.

#### Scenario: Click opens the data view tab

- **WHEN** the user activates the leaf for `events`
- **THEN** a tab with id `dynamotbl:<connectionId>:events` and kind `dynamo-data-view` opens
- **AND** the tab payload includes `tableName: "events"` and the cached `describe`

#### Scenario: Activating the same leaf twice focuses the existing tab

- **WHEN** the user activates the same leaf a second time
- **THEN** the existing tab is focused; a new tab is NOT opened

#### Scenario: Open with no cached describe fetches on mount

- **WHEN** the user activates a leaf whose describe has not yet completed
- **THEN** the data view tab opens with the Metadata sub-view in a loading state and invokes `dynamo.describeTable(id, tableName)`
- **AND** when the call returns, the Metadata sub-view renders the metadata

#### Scenario: Refresh button re-fires describe

- **WHEN** the user opens the Metadata sub-view of the data view tab and clicks "Refresh metadata"
- **THEN** `dynamo.describeTable(id, tableName)` is invoked once and the sub-view body updates with the new result

#### Scenario: Persisted placeholder tab is migrated on load

- **WHEN** the app launches with a session-persisted tab record of kind `dynamo-table-placeholder` for id `dynamotbl:<connectionId>:events`
- **THEN** the tab record is rewritten in-place to kind `dynamo-data-view`, its payload's `describe` is preserved, and the tab opens as a data view
