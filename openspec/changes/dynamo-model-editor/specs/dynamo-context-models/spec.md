## ADDED Requirements

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
