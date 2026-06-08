## MODIFIED Requirements

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
