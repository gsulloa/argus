## MODIFIED Requirements

### Requirement: Inline badge on schema-tree nodes

For each schema-tree node that corresponds to a documented object (matched by engine-appropriate identity: `schema.name` for Postgres/MySQL/MSSQL, `name` for Dynamo), the engine's schema browser SHALL render a small `📄` caption-style badge after the node label. For Dynamo, the node's live table name SHALL be folded through the connection's table-name normalization rule (see `dynamo-table-name-normalization`) before comparison, so a CDK-named live table matches its logical doc; when no rule is configured the comparison is exact, unchanged from before. The badge applies to Postgres, MySQL, MSSQL, and Dynamo (`DynamoConnectionSubtree`'s table leaves). The badge SHALL only render when (a) the connection has a linked, available context folder, and (b) the node has a matching documented object.

#### Scenario: MySQL documented table shows badge

- **WHEN** the linked folder has `mysql/sales/orders.md` and the MySQL schema browser tree shows `sales > orders`
- **THEN** the `orders` node renders a `📄` badge after its label

#### Scenario: Dynamo documented table shows badge

- **WHEN** the linked folder has `dynamo/tables/sessions.md` and the Dynamo connection subtree shows a `sessions` leaf
- **THEN** the `sessions` leaf renders a `📄` badge after its label

#### Scenario: Dynamo CDK-named leaf shows badge via normalized name

- **WHEN** the connection's rule strips `prefix: "MyApp-prod-"` and `suffix_pattern: "-[A-Z0-9]+$"`, the linked folder has `dynamo/tables/EventsTable.md`, and the Dynamo subtree shows a leaf for the live table `MyApp-prod-EventsTable-3M4N5O6P7Q8R`
- **THEN** that leaf renders a `📄` badge, matched via the normalized name `EventsTable`

#### Scenario: MSSQL undocumented table shows no badge

- **WHEN** the linked folder has no file matching `dbo.Products`
- **THEN** the `dbo > Products` node renders without a badge
