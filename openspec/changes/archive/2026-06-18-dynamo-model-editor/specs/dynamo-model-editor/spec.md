## ADDED Requirements

### Requirement: Model editor entry point in the data-view

The Dynamo data-view SHALL offer an entry point to create and edit `dynamo_model` docs from the QueryBuilder "By model" entity selector — a "New model" affordance and, for a selected entity, an "Edit" affordance. Selecting "Edit" SHALL open the editor seeded from the selected model's `name`, access patterns, and existing Markdown body. The editor is presented over the data-view (panel or dialog), not as a separate top-level view.

#### Scenario: Creating a model from the selector

- **WHEN** the user opens the "By model" selector for an STD table and chooses "New model"
- **THEN** an empty editor opens for that table, and on save the new entity appears in the selector and is immediately available for "By model" filtering

#### Scenario: Editing seeds from the existing doc

- **WHEN** the user chooses "Edit" on the selected entity `Order`
- **THEN** the editor opens pre-filled with `Order`'s name, its access patterns, and its current Markdown body

### Requirement: Editor form for entity and access patterns

The editor SHALL let the user set the entity `name`, add/remove/reorder access patterns, and edit a Markdown body. Each access pattern row SHALL provide an `index` selector populated from the open table's `TableDescription` (`"table"` plus each GSI/LSI), `pk`/`sk` template inputs, and an optional pattern `name`. The editor SHALL show a compiled-key preview per access pattern equivalent to the QueryBuilder's preview.

#### Scenario: Index choices come from the live table

- **WHEN** the editor is open for a table whose `TableDescription` defines `GSI1` and `LSI1`
- **THEN** each access pattern's index selector offers `table`, `GSI1`, and `LSI1` and no others

#### Scenario: Compiled-key preview reflects the templates

- **WHEN** the user enters `pk: "USER#${userId}"` and `sk: "ORDER#${orderId}"` on an access pattern
- **THEN** the editor shows a compiled-key preview for that pattern derived the same way the QueryBuilder compiles "By model" inputs

### Requirement: Validation gate before save

The editor SHALL validate a draft via the front-end `modelCompiler` against the open table's `TableDescription` before saving. When the `TableDescription` is available, validation covers index existence, resolved PK/SK attribute existence, key typing (numeric keys typed `N`; `begins_with` degrade only on string keys), and template grammar; any failure blocks the save and is shown inline on the offending access pattern. When the `TableDescription` is unavailable, only template grammar is validated and the editor surfaces a warning that schema checks were skipped; the save MAY proceed.

#### Scenario: Invalid draft blocks save

- **WHEN** an access pattern references an index not present in the `TableDescription`, or a numeric sort key is given a partial (prefix) template
- **THEN** Save is disabled and an inline error names the offending access pattern

#### Scenario: Offline editing validates grammar only

- **WHEN** the table's `TableDescription` is unavailable and all templates are well-formed
- **THEN** Save is allowed and the editor shows a "schema checks skipped — table not reachable" warning

### Requirement: Save and delete reconcile with the folder watcher

Saving SHALL write through `context_save_model` and deleting through `context_delete_model` (behind a confirmation). The editor SHALL apply an optimistic update and reconcile with the context folder watcher's refetch so a just-saved entity does not momentarily disappear and reappear. When the connection has no linked context folder, the editor SHALL guide the user to link or create one rather than failing silently.

#### Scenario: Saved model does not flash out

- **WHEN** the user saves a new model and the folder watcher subsequently refetches the table's models
- **THEN** the saved model remains visible throughout, without a disappear/reappear flash

#### Scenario: No linked folder guides to linking

- **WHEN** the user attempts to create a model on a connection with no linked context folder
- **THEN** the editor prompts to link or create a context folder before allowing the save
