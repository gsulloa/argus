## ADDED Requirements

### Requirement: Context folder integration

The Dynamo table browser SHALL surface context-folder documentation when the connection has a linked folder. Because Dynamo's detail view does not use the `SubtabHeader` pattern, the integration adapts:

- A `📄` badge SHALL render after the label of table leaves in `DynamoConnectionSubtree` that match a documented Dynamo table (`dynamo/tables/<name>.md`).
- The `DocsSubtab` SHALL be rendered as a collapsible panel inside the existing data-view inspector, below the existing table metadata block. The panel is expanded by default when the selected table has a documented entry; collapsed otherwise.
- Attribute notes from `human.column_notes` SHALL decorate the attribute-definitions list in the inspector.
- An unavailability banner SHALL appear above the `DynamoConnectionSubtree` when the linked folder is in `Unavailable` state.

#### Scenario: Tree leaf shows badge for documented table

- **WHEN** a Dynamo connection is linked to a folder containing `dynamo/tables/sessions.md`
- **AND** the `DynamoConnectionSubtree` renders a `sessions` leaf
- **THEN** the leaf renders a `📄` badge after its label

#### Scenario: Docs panel renders in inspector when expanded

- **WHEN** the user opens a Dynamo table whose doc has body `# sessions\n\nThe sessions table.\n` and `human: { tags: [auth] }`
- **THEN** the data-view inspector shows a Docs panel (expanded) rendering the body and a chip `auth`

#### Scenario: Docs panel hidden when no doc

- **WHEN** the user opens a Dynamo table that has no documented object
- **THEN** the inspector does not render a Docs panel

#### Scenario: Attribute notes decorate the attribute list

- **WHEN** the selected Dynamo table has `human.column_notes: { user_id: "partition key; opaque UUID v4" }`
- **THEN** the inspector's `user_id` attribute row shows the note string as an inline annotation

#### Scenario: Unavailability banner appears

- **WHEN** the Dynamo connection's linked folder has been deleted on disk
- **THEN** an unavailability banner is rendered above the `DynamoConnectionSubtree`
