## MODIFIED Requirements

### Requirement: dynamo_model document format

The context-folder system SHALL recognize a document kind `dynamo_model` describing a Single-Table Design entity. A `dynamo_model` document MUST use the same `---`-delimited `system:` / `human:` frontmatter structure as existing object docs and MUST live at `dynamo/tables/<table>/models/<Model>.md`. Its `system:` block MUST contain `kind: dynamo_model`, `name` (the entity name), and `access_patterns` (a non-empty list). The owning physical table SHALL be derived from the parent directory name (`<table>`) and populated into `system.physical_table`; it MUST NOT be required from frontmatter. Each access pattern MUST contain `index` (the literal string `"table"` for the primary key, or the name of a GSI/LSI) and `pk` (a template string), and MAY contain `name` (a human label) and `sk` (a template string). A template string is literal text interpolated with zero or more parameter placeholders of the form `${ident}` where `ident` matches `[A-Za-z_][A-Za-z0-9_]*`; a literal `$` not followed by `{` is literal text, and an unterminated `${` is malformed.

#### Scenario: Well-formed model doc parses into an object

- **WHEN** the folder contains `dynamo/tables/AppTable/models/Order.md` whose `system.kind` is `dynamo_model`, `name` is `Order`, and `access_patterns` lists `{ index: "table", pk: "USER#${userId}", sk: "ORDER#${orderId}" }`
- **THEN** parsing the context folder yields a parsed object carrying `kind: "dynamo_model"`, `physical_table: "AppTable"` derived from the directory, and the access-pattern list with their `pk`/`sk` templates intact

#### Scenario: Table doc file and models directory coexist

- **WHEN** the folder contains both `dynamo/tables/AppTable/table.md` (the table doc) and `dynamo/tables/AppTable/models/Order.md` (a model doc)
- **THEN** both parse successfully into distinct objects and the model doc does not shadow or overwrite the table doc

#### Scenario: Multiple access patterns on the same index are preserved

- **WHEN** an `Order` model declares two access patterns both with `index: "GSI1"` — one named `"Orders by status"` with `sk: "STATUS#${status}"` and one named `"Orders by date"` with `sk: "DATE#${createdAt}"`
- **THEN** both access patterns are parsed and retained as distinct entries with their `name` values

#### Scenario: Malformed model doc surfaces a warning

- **WHEN** a file under `dynamo/tables/<table>/models/` has `kind: dynamo_model` but is missing `physical_table` or has an empty `access_patterns` list, or contains a template with an unterminated `${`
- **THEN** the parse adds a load warning identifying the file and does not abort parsing of the rest of the folder

### Requirement: Recursive parsing of model docs

The context parser SHALL read the physical-table (`dynamo_table`) doc from `dynamo/tables/<table>/table.md` and SHALL walk the sibling `dynamo/tables/<table>/models/` subdirectory for every physical table, parsing each `*.md` file there as a `dynamo_model` document. For backward compatibility the parser SHALL also recognize a legacy flat `dynamo/tables/<table>.md` as the physical-table doc; when both a legacy flat `dynamo/tables/<table>.md` and a `dynamo/tables/<table>/table.md` exist for the same table, the folder doc (`table.md`) wins and the flat one is ignored. Model docs MUST NOT shadow or replace the physical-table doc; both coexist in the parsed context.

#### Scenario: Models parsed alongside the physical-table doc

- **WHEN** the folder contains `dynamo/tables/AppTable/table.md` (a `dynamo_table` doc) and `dynamo/tables/AppTable/models/Order.md` and `dynamo/tables/AppTable/models/User.md`
- **THEN** the parsed context contains the `dynamo_table` object for `AppTable` and two `dynamo_model` objects (`Order`, `User`) both referencing `physical_table: AppTable`

#### Scenario: Legacy flat table doc is still parsed

- **WHEN** the folder contains only a legacy flat `dynamo/tables/Events.md` (a `dynamo_table` doc) with no `dynamo/tables/Events/` directory
- **THEN** parsing produces the `dynamo_table` object for `Events`, exactly as before this change

#### Scenario: Folder table doc wins over legacy flat doc

- **WHEN** the folder contains both a legacy flat `dynamo/tables/Events.md` and a `dynamo/tables/Events/table.md`
- **THEN** the parsed context contains a single `dynamo_table` object for `Events` sourced from `dynamo/tables/Events/table.md`, and the legacy flat file is ignored

#### Scenario: Table without a models subdirectory is unaffected

- **WHEN** a table doc `dynamo/tables/Events/table.md` exists with no `dynamo/tables/Events/models/` directory
- **THEN** parsing produces the `dynamo_table` object for `Events` and no model objects
