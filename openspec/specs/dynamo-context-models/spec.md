# dynamo-context-models Specification

## Purpose

The `dynamo-context-models` capability defines how the context-folder system recognizes, parses, and exposes `dynamo_model` documents — structured Single-Table Design entity definitions stored alongside DynamoDB table docs — so the data-view QueryBuilder can offer model-based filtering driven by access-pattern templates.
## Requirements
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

### Requirement: Models exposed to the UI per table

The context system SHALL expose a dedicated command `context_list_models(table)` that returns the `dynamo_model` documents whose derived `physical_table` matches the given table name, each including its `name` and `access_patterns`. Matching SHALL compare a model's derived `physical_table` against the **normalized** form of the incoming live table name, where normalization applies the connection's table-name normalization rule (see `dynamo-table-name-normalization`); when no rule is configured the normalized form equals the raw name, preserving exact-match behavior. The existing `context_list_objects` command MUST NOT be relied upon for this (it omits `access_patterns` and keys entities by `name` alone, which collides across tables). The data-view SHALL call `context_list_models` so the QueryBuilder can offer model-based filtering.

Model **writes** SHALL use the same normalized name as reads: `context_save_model` and `context_delete_model` receive the live (physical) table name and MUST fold it through the connection's normalization rule before deriving the on-disk path `dynamo/tables/<logical>/models/<slug>.md`. This keeps the editor and AI-extraction write path consistent with the read path, so models authored against a CDK-named live table land under the logical folder rather than a per-deploy suffixed one. When no rule is configured the logical name equals the live name, preserving prior behavior.

#### Scenario: Models authored against a CDK-named live table land under the logical folder

- **WHEN** the connection's rule strips a suffix `-[0-9a-f]+$`, and the editor (or AI extraction) saves a model `Slot` for the live table `InventoryTable-0a12ed4ec6bf`
- **THEN** the model file is written at `dynamo/tables/InventoryTable/models/Slot.md` (the logical folder), and `context_list_models("InventoryTable-0a12ed4ec6bf")` returns it

#### Scenario: Listing models for a table returns its entities with access patterns

- **WHEN** the front end invokes `context_list_models("AppTable")` and the folder defines `Order` and `User` models under `dynamo/tables/AppTable/models/`
- **THEN** the response contains both models, each with its `access_patterns`, and contains no model owned by a different table — even if another table has an entity also named `Order`

#### Scenario: Table with no models returns an empty list

- **WHEN** the front end invokes `context_list_models` for a table that has no `dynamo_model` docs
- **THEN** the response is an empty list (not an error)

#### Scenario: CDK-named live table matches logical model docs

- **WHEN** the connection's rule strips `prefix: "MyApp-prod-"` and `suffix_pattern: "-[A-Z0-9]+$"`, the folder defines models under `dynamo/tables/EventsTable/models/`, and the front end invokes `context_list_models("MyApp-prod-EventsTable-3M4N5O6P7Q8R")`
- **THEN** the response contains the `EventsTable` models, matched via the normalized name `EventsTable`

#### Scenario: Same logical models reused across environments

- **WHEN** a `dev` connection (rule prefix `MyApp-dev-`) and a `prod` connection (rule prefix `MyApp-prod-`) are both linked to the same context folder, and each lists models for its own live `EventsTable` name
- **THEN** both resolve to the same `dynamo/tables/EventsTable/models/` docs without duplicating files

#### Scenario: Unconfigured connection still matches exactly

- **WHEN** a connection has no normalization rule and the front end invokes `context_list_models("AppTable")`
- **THEN** matching is exact equality against `physical_table`, identical to before this change

### Requirement: Writing a model doc

The context system SHALL expose a command `context_save_model(connection_id, table, draft)` that serialises a model draft into a `dynamo_model` document and writes it to `dynamo/tables/<table>/models/<Model>.md` within the connection's linked context folder. The draft carries `name`, a non-empty `access_patterns` list (each `{ name?, index, pk, sk? }`), and an optional Markdown body. The owning `physical_table` SHALL be derived from the `table` argument and MUST NOT be accepted from the draft or written into frontmatter. The on-disk filename SHALL be derived from `name` via a slug over `[A-Za-z0-9_-]`. The write SHALL be atomic and, when the target file already exists, MUST preserve its `human:` block and Markdown body byte-for-byte, replacing only the `system:` block. The command SHALL return an error when the connection has no linked context folder.

#### Scenario: Saving a new model writes a parseable doc

- **WHEN** the user invokes `context_save_model("AppTable", { name: "Order", access_patterns: [{ index: "table", pk: "USER#${userId}", sk: "ORDER#${orderId}" }] })` on a connection with a linked folder
- **THEN** a file `dynamo/tables/AppTable/models/Order.md` is created whose `system.kind` is `dynamo_model`, `system.name` is `Order`, and whose `access_patterns` round-trip through the parser with `physical_table` derived as `AppTable`
- **AND** the frontmatter contains no authored `physical_table` field

#### Scenario: Editing an existing model preserves the human block and body

- **WHEN** `dynamo/tables/AppTable/models/Order.md` already exists with a hand-edited `human:` block and a Markdown body, and the user saves an edited draft for `Order` that changes an access pattern
- **THEN** the file's `human:` block and Markdown body are preserved byte-for-byte
- **AND** only the `system:` block reflects the edited access patterns

#### Scenario: physical_table is never taken from the caller

- **WHEN** a save is invoked for table `AppTable`
- **THEN** the written doc's owning table is `AppTable` regardless of any `physical_table` value present in the draft, and the field is absent from the written frontmatter

#### Scenario: Slug collision is rejected

- **WHEN** a save would write to a filename that already belongs to a different entity in the same table's `models/` directory
- **THEN** the command returns an error naming the conflicting filename and writes nothing

#### Scenario: Save without a linked folder errors

- **WHEN** `context_save_model` is invoked on a connection that has no linked context folder
- **THEN** the command returns a validation error identifying the missing folder and writes nothing

### Requirement: Deleting a model doc

The context system SHALL expose a command `context_delete_model(connection_id, table, model_name)` that removes the `dynamo_model` document at `dynamo/tables/<table>/models/<Model>.md`. The command MUST be safe to call when the file is already absent (it reports success/no-op rather than failing) and MUST NOT touch the physical-table doc or any other model.

#### Scenario: Deleting a model removes only its file

- **WHEN** the user invokes `context_delete_model("AppTable", "Order")` and the folder contains `dynamo/tables/AppTable.md`, `.../models/Order.md`, and `.../models/User.md`
- **THEN** `Order.md` is removed and both `AppTable.md` and `User.md` remain untouched

#### Scenario: Deleting an absent model is a no-op

- **WHEN** `context_delete_model` is invoked for a model whose file does not exist
- **THEN** the command reports success without error and changes nothing on disk

