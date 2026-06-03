# context-objects-browser Specification

## Purpose
TBD - created by archiving change context-folders-other-engines. Update Purpose after archive.
## Requirements
### Requirement: List documented objects for connection

The frontend SHALL expose, for each connection with a linked context folder, the set of documented objects parsed from the matching engine subtree. This applies uniformly to connections of kind `postgres`, `mysql`, `mssql`, and `dynamo`. The list SHALL update in response to `context://changed` events whose `kinds` include `"object"` for the connection's folder path.

#### Scenario: MySQL connection lists MySQL objects

- **WHEN** a MySQL connection is linked to a folder containing `mysql/sales/orders.md` and `mysql/sales/customers.md`
- **THEN** the documented-objects list for that connection contains `sales.orders` and `sales.customers` and no entries from other engine subtrees

#### Scenario: MSSQL connection lists MSSQL objects

- **WHEN** an MSSQL connection is linked to a folder containing `mssql/dbo/Users.md`
- **THEN** the documented-objects list contains `dbo.Users`

#### Scenario: Dynamo connection lists Dynamo tables

- **WHEN** a Dynamo connection is linked to a folder containing `dynamo/tables/sessions.md` and `dynamo/tables/audit-log.md`
- **THEN** the documented-objects list contains `sessions` and `audit-log` with no schema component

### Requirement: Inline badge on schema-tree nodes

For each schema-tree node that corresponds to a documented object (matched by engine-appropriate identity: `schema.name` for Postgres/MySQL/MSSQL, `name` for Dynamo), the engine's schema browser SHALL render a small `📄` caption-style badge after the node label. The badge applies to Postgres, MySQL, MSSQL, and Dynamo (`DynamoConnectionSubtree`'s table leaves). The badge SHALL only render when (a) the connection has a linked, available context folder, and (b) the node has a matching documented object.

#### Scenario: MySQL documented table shows badge

- **WHEN** the linked folder has `mysql/sales/orders.md` and the MySQL schema browser tree shows `sales > orders`
- **THEN** the `orders` node renders a `📄` badge after its label

#### Scenario: Dynamo documented table shows badge

- **WHEN** the linked folder has `dynamo/tables/sessions.md` and the Dynamo connection subtree shows a `sessions` leaf
- **THEN** the `sessions` leaf renders a `📄` badge after its label

#### Scenario: MSSQL undocumented table shows no badge

- **WHEN** the linked folder has no file matching `dbo.Products`
- **THEN** the `dbo > Products` node renders without a badge

### Requirement: Object doc panel

Selecting a schema-tree node that has a documented object SHALL surface a docs view for that node:

- For Postgres, MySQL, and MSSQL: a "Docs" subtab appears in the existing detail view's `SubtabHeader` alongside Data/Structure/Raw, rendering the `DocsSubtab` component.
- For Dynamo: the `DocsSubtab` component is rendered as a collapsible panel inside the existing data-view inspector, below the existing table metadata block. Expanded by default when the object has a doc.

The rendered content SHALL be the parsed object's Markdown body, a chip strip showing `human.tags` and `human.owners`, and a `📄 No DB match` warning label when `system.deleted_in_db` is `true`.

#### Scenario: MySQL Docs subtab renders body and chips

- **WHEN** the user selects a MySQL table whose doc has body `# orders\n\nThe orders table.\n` and `human: { tags: [pii], owners: ["@team-sales"] }`
- **THEN** the Docs subtab renders the body and shows chips `pii`, `@team-sales`

#### Scenario: Dynamo Docs panel appears in inspector

- **WHEN** the user opens a Dynamo table whose doc has a body
- **THEN** the data-view inspector renders a "Docs" panel below the existing metadata, expanded by default

#### Scenario: Undocumented object hides the Docs surface

- **WHEN** the selected node has no documented object
- **THEN** the detail view shows no Docs subtab (Postgres/MySQL/MSSQL) and no Docs panel (Dynamo)

### Requirement: Column-note decoration

The columns list (Postgres/MySQL/MSSQL structure subtab) and the attribute-definitions list (Dynamo inspector) SHALL render `human.column_notes[<name>]` as an annotation next to the matching column/attribute when the connection has a linked folder and the selected object has a documented entry. Names without a matching note SHALL render unchanged.

#### Scenario: MySQL column note appears next to column

- **WHEN** the selected MySQL table has `human.column_notes: { email: "lowercased before insert" }`
- **THEN** the `email` row in the structure subtab shows the note string as an inline annotation

#### Scenario: Dynamo attribute note appears next to attribute

- **WHEN** the selected Dynamo table has `human.column_notes: { user_id: "partition key; opaque UUID v4" }`
- **THEN** the `user_id` row in the inspector's attribute list shows the note string as an inline annotation

