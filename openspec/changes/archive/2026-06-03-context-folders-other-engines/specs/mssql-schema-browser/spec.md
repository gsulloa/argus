## ADDED Requirements

### Requirement: Context folder integration

The MSSQL schema browser SHALL surface context-folder documentation when the connection has a linked folder: a `📄` badge after the label of tree nodes that match a documented relation, a "Docs" subtab in the detail view rendering the parsed object's body and `human:` chips, column-note decoration in the structure subtab, and an unavailability banner above the tree when the folder is in `Unavailable` state. All four surfaces consume the existing shared components from `src/modules/context/components/` and the `useContextObjects` / `useContextObject` hooks.

#### Scenario: Tree shows badge for documented relation

- **WHEN** an MSSQL connection is linked to a folder containing `mssql/dbo/Users.md`
- **AND** the schema browser renders the `dbo` schema's tables
- **THEN** the `Users` node renders a `📄` badge after its label

#### Scenario: Docs subtab visible when relation has doc

- **WHEN** the user selects `dbo.Users` and the relation has a documented object
- **THEN** the detail view's `SubtabHeader` includes a "Docs" entry
- **AND** activating it renders the `DocsSubtab` with the body and chips

#### Scenario: Column notes decorate structure subtab

- **WHEN** the selected relation has `human.column_notes: { Email: "lowercased before insert" }`
- **THEN** the structure subtab's `Email` row shows the note string as an inline annotation

#### Scenario: Unavailability banner appears

- **WHEN** an MSSQL connection is linked to a folder whose root has been deleted on disk
- **THEN** an unavailability banner is rendered above the schema tree
