## MODIFIED Requirements

### Requirement: Activating a node opens an object placeholder tab

The frontend SHALL respond to node activation (Enter key, single click, or double click — equivalent in V1) on any object node by opening or focusing a center-area tab. Activation on a table, view, or materialized view node MUST open or focus a tab of kind `postgres-table-data` (defined by the `postgres-data-grid` capability) with payload `{ connectionId, connectionName, schema, relation, relationKind: "table" | "view" | "materialized-view" }` and stable id `pgtbl:<connectionId>:<schema>:<relation>`. Activation on any other object kind (function, type, extension, index, trigger) MUST open or focus a tab of kind `postgres-object-placeholder` with payload `{ connectionId, schema, kind, name }` plus any kind-specific identifiers (such as a function's full signature) and the existing stable id pattern. Activation on group nodes (Data, Structure, Indexes, Triggers) MUST NOT open a tab; it MUST only toggle expansion.

#### Scenario: Click a table opens the data viewer tab

- **WHEN** the user activates a table node `analytics.events`
- **THEN** a center-area tab of kind `postgres-table-data` opens with payload `{ connectionId, connectionName, schema: "analytics", relation: "events", relationKind: "table" }`
- **AND** the placeholder tab is NOT opened

#### Scenario: Click a view opens the data viewer tab

- **WHEN** the user activates a view or materialized view node
- **THEN** the same `postgres-table-data` tab opens with `relationKind: "view"` or `"materialized-view"` respectively

#### Scenario: Click a function opens the placeholder tab

- **WHEN** the user activates a function node
- **THEN** a center-area tab of kind `postgres-object-placeholder` opens with payload `{ connectionId, schema, kind: "function", name, signature }`
- **AND** the tab's body shows a placeholder text identifying the object and stating that the viewer is not implemented yet

#### Scenario: Click a type, extension, index, or trigger opens the placeholder tab

- **WHEN** the user activates a type, extension, index, or trigger node
- **THEN** a center-area tab of kind `postgres-object-placeholder` opens with the corresponding payload

#### Scenario: Activating the same node twice focuses the existing tab

- **WHEN** the user activates the same object node a second time (regardless of whether it routes to `postgres-table-data` or `postgres-object-placeholder`)
- **THEN** the existing tab is focused; a new tab is not opened

#### Scenario: Group node activation does not open a tab

- **WHEN** the user activates the "Data", "Structure", "Indexes", or "Triggers" group node
- **THEN** the group toggles expansion; no tab is opened
