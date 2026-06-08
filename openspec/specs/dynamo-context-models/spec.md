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
