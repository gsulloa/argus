## ADDED Requirements

### Requirement: dynamo_model document format

The context-folder system SHALL recognize a document kind `dynamo_model` describing a Single-Table Design entity. A `dynamo_model` document MUST use the same `---`-delimited `system:` / `human:` frontmatter structure as existing object docs and MUST live at `dynamo/tables/<table>/models/<Model>.md`. Its `system:` block MUST contain `kind: dynamo_model`, `name` (the entity name), and `access_patterns` (a non-empty list). The owning physical table SHALL be derived from the parent directory name (`<table>`) and populated into `system.physical_table`; it MUST NOT be required from frontmatter. Each access pattern MUST contain `index` (the literal string `"table"` for the primary key, or the name of a GSI/LSI) and `pk` (a template string), and MAY contain `name` (a human label) and `sk` (a template string). A template string is literal text interpolated with zero or more parameter placeholders of the form `${ident}` where `ident` matches `[A-Za-z_][A-Za-z0-9_]*`; a literal `$` not followed by `{` is literal text, and an unterminated `${` is malformed.

#### Scenario: Well-formed model doc parses into an object

- **WHEN** the folder contains `dynamo/tables/AppTable/models/Order.md` whose `system.kind` is `dynamo_model`, `name` is `Order`, and `access_patterns` lists `{ index: "table", pk: "USER#${userId}", sk: "ORDER#${orderId}" }`
- **THEN** parsing the context folder yields a parsed object carrying `kind: "dynamo_model"`, `physical_table: "AppTable"` derived from the directory, and the access-pattern list with their `pk`/`sk` templates intact

#### Scenario: Table doc file and models directory coexist

- **WHEN** the folder contains both `dynamo/tables/AppTable.md` (the table doc) and `dynamo/tables/AppTable/models/Order.md` (a model doc)
- **THEN** both parse successfully into distinct objects and the model doc does not shadow or overwrite the table doc

#### Scenario: Multiple access patterns on the same index are preserved

- **WHEN** an `Order` model declares two access patterns both with `index: "GSI1"` — one named `"Orders by status"` with `sk: "STATUS#${status}"` and one named `"Orders by date"` with `sk: "DATE#${createdAt}"`
- **THEN** both access patterns are parsed and retained as distinct entries with their `name` values

#### Scenario: Malformed model doc surfaces a warning

- **WHEN** a file under `dynamo/tables/<table>/models/` has `kind: dynamo_model` but is missing `physical_table` or has an empty `access_patterns` list, or contains a template with an unterminated `${`
- **THEN** the parse adds a load warning identifying the file and does not abort parsing of the rest of the folder

### Requirement: Recursive parsing of model docs

The context parser SHALL walk the `dynamo/tables/<table>/models/` subdirectory for every physical table and parse each `*.md` file there as a `dynamo_model` document, in addition to the existing flat walk of `dynamo/tables/*.md`. Model docs MUST NOT shadow or replace the physical-table doc; both coexist in the parsed context.

#### Scenario: Models parsed alongside the physical-table doc

- **WHEN** the folder contains `dynamo/tables/AppTable.md` (a `dynamo_table` doc) and `dynamo/tables/AppTable/models/Order.md` and `dynamo/tables/AppTable/models/User.md`
- **THEN** the parsed context contains the `dynamo_table` object for `AppTable` and two `dynamo_model` objects (`Order`, `User`) both referencing `physical_table: AppTable`

#### Scenario: Table without a models subdirectory is unaffected

- **WHEN** a table doc `dynamo/tables/Events.md` exists with no `dynamo/tables/Events/models/` directory
- **THEN** parsing produces the `dynamo_table` object for `Events` and no model objects, exactly as before this change

### Requirement: Models exposed to the UI per table

The context system SHALL expose a dedicated command `context_list_models(table)` that returns the `dynamo_model` documents whose derived `physical_table` matches the given table name, each including its `name` and `access_patterns`. The existing `context_list_objects` command MUST NOT be relied upon for this (it omits `access_patterns` and keys entities by `name` alone, which collides across tables). The data-view SHALL call `context_list_models` so the QueryBuilder can offer model-based filtering.

#### Scenario: Listing models for a table returns its entities with access patterns

- **WHEN** the front end invokes `context_list_models("AppTable")` and the folder defines `Order` and `User` models under `dynamo/tables/AppTable/models/`
- **THEN** the response contains both models, each with its `access_patterns`, and contains no model owned by a different table — even if another table has an entity also named `Order`

#### Scenario: Table with no models returns an empty list

- **WHEN** the front end invokes `context_list_models` for a table that has no `dynamo_model` docs
- **THEN** the response is an empty list (not an error)
