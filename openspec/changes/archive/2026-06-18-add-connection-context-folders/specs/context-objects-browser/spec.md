## MODIFIED Requirements

### Requirement: List documented objects for connection

The frontend SHALL expose, for each connection with a linked context folder, the set of documented objects parsed from the matching engine subtree. The list SHALL update in response to `context://changed` events whose `kinds` include `"object"` for the connection's folder path.

#### Scenario: Postgres connection lists postgres objects

- **WHEN** a Postgres connection is linked to a folder containing `postgres/public/users.md` and `postgres/billing/invoices.md`
- **THEN** the documented-objects list for that connection contains `public.users` and `billing.invoices` and no entries from other engine subtrees

#### Scenario: File edit refreshes the list

- **WHEN** the documented-objects list contains `public.users`
- **AND** a `context://changed` event for the linked folder arrives with `kinds: ["object"]`
- **THEN** the list re-reads from the registry and re-renders

### Requirement: Inline badge on schema-tree nodes

For each schema-tree node that corresponds to a documented object (matched by engine-appropriate identity: `schema.name` for relational engines, `name` for Dynamo/CloudWatch), the schema browser SHALL render a small `📄` caption-style badge after the node label. The badge SHALL only render when (a) the connection has a linked, available context folder, and (b) the node has a matching documented object.

#### Scenario: Documented table shows badge

- **WHEN** the linked folder has `postgres/public/users.md` and the schema browser tree shows `public > users`
- **THEN** the `users` node renders a `📄` badge after its label

#### Scenario: Undocumented table shows no badge

- **WHEN** the linked folder has no file matching `public.orders`
- **THEN** the `public > orders` node renders without a badge

#### Scenario: No folder linked, no badges

- **WHEN** a connection has no linked context folder
- **THEN** no nodes in its schema tree render a `📄` badge

#### Scenario: Folder unavailable, no badges

- **WHEN** a connection's linked folder is in `Unavailable` state
- **THEN** no nodes in its schema tree render a `📄` badge
- **AND** a banner above the tree explains the folder is missing

### Requirement: Object doc panel

Selecting a schema-tree node that has a documented object SHALL surface a "Docs" tab in the existing detail view for that node. The tab SHALL render the parsed object as: the Markdown body rendered as HTML; a chip strip showing `human.tags` and `human.owners`; and a `📄 No DB match` warning label when `system.deleted_in_db` is `true`.

#### Scenario: Docs tab renders body and chips

- **WHEN** the user selects `public.users` whose doc has body `# users\n\nThe user table.\n` and `human: { tags: [pii, core], owners: ["@team-identity"] }`
- **THEN** the Docs tab renders the body as HTML and shows chips `pii`, `core`, `@team-identity`

#### Scenario: Deleted-in-DB warning

- **WHEN** the selected object's `system.deleted_in_db` is `true`
- **THEN** the Docs tab renders a warning label "No DB match"

#### Scenario: Undocumented object hides the Docs tab

- **WHEN** the selected schema-tree node has no documented object
- **THEN** the detail view shows no Docs tab

### Requirement: Column-note decoration

The columns list in the existing per-engine structure view SHALL render `human.column_notes[<column-name>]` as an annotation next to the matching column when the connection has a linked folder and the selected object has a documented entry. Columns without a matching note SHALL render unchanged.

#### Scenario: Column note appears next to column

- **WHEN** the selected object has `human.column_notes: { email: "lowercased before insert" }`
- **THEN** the `email` column row in the structure view shows the note string as an inline annotation

#### Scenario: Columns without notes unchanged

- **WHEN** an object has `human.column_notes: { email: "..." }` and the table has columns `id`, `email`, `created_at`
- **THEN** only the `email` row shows an annotation; `id` and `created_at` render as today
