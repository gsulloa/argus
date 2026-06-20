## ADDED Requirements

### Requirement: Run PartiQL command (single statement)

The Dynamo module SHALL expose a Tauri command `dynamo_run_partiql(connection_id, statement, origin?)` that executes exactly one PartiQL statement against the connection's active client via the DynamoDB SDK `ExecuteStatement` API, requesting `ReturnConsumedCapacity: TOTAL`. The `origin` argument MUST be `"user"` or `"auto"` and defaults to `"user"`. The command MUST classify the statement via the `is_mutating_partiql` helper: if the statement is mutating (`INSERT`/`UPDATE`/`DELETE`) AND the connection has `params.read_only: true`, it MUST return `AppError::Validation { message: "connection is read-only" }` BEFORE calling `ExecuteStatement`.

The response MUST be one of:

- `{ kind: "rows", items: Array<AttributeMap>, count: number, query_ms: number, truncated: boolean, consumed_capacity: Value | null }` — for `SELECT`. `items` MUST use the existing `AttrValue` wire codec (`S`/`N`/`BOOL`/`NULL`/`L`/`M`/`SS`/`NS`/`BS`/`B`), identical to the shape returned by `dynamo_scan` / `dynamo_query`, so downstream rendering and column inference can be reused verbatim. `truncated: true` indicates the row count hit the cap (see "Result row cap and NextToken pagination").
- `{ kind: "succeeded", statement_type: "INSERT" | "UPDATE" | "DELETE", query_ms: number, consumed_capacity: Value | null }` — for mutating statements that return no result set.

On AWS failure the command MUST return `AppError::Aws` whose message contains the DynamoDB error verbatim. The command SHALL emit exactly one `argus:activity-log` event carrying `origin`, the statement, and a success/failure `status`.

#### Scenario: SELECT returns items envelope

- **WHEN** the user invokes `dynamo.runPartiql(id, "SELECT * FROM \"events\" WHERE id = 'e_1'", "user")`
- **THEN** the response is `{ kind: "rows", items: [ { id: { S: "e_1" }, ... } ], count, query_ms, truncated: false, consumed_capacity }`
- **AND** each item uses the same `AttributeValue` wire shape as `dynamo_scan`
- **AND** one activity-log event is emitted with `status: "ok"`

#### Scenario: INSERT returns succeeded envelope on a writable connection

- **WHEN** the user invokes `dynamo.runPartiql(id, "INSERT INTO \"events\" VALUE { 'id': 'e_2' }", "user")` against a connection without `read_only`
- **THEN** the response is `{ kind: "succeeded", statement_type: "INSERT", query_ms, consumed_capacity }`

#### Scenario: Mutation on read-only connection rejected before dispatch

- **WHEN** the user invokes `dynamo.runPartiql(id, "DELETE FROM \"events\" WHERE id = 'e_1'", "user")` and the connection has `params.read_only: true`
- **THEN** the command returns `AppError::Validation { message: "connection is read-only" }`
- **AND** `ExecuteStatement` is NOT called
- **AND** an activity-log event is emitted with `status: "err"`

#### Scenario: AWS error surfaced verbatim

- **WHEN** `ExecuteStatement` fails (e.g. `ValidationException` for an unknown table)
- **THEN** the command returns `AppError::Aws` whose message contains the DynamoDB error message verbatim

### Requirement: Classify mutating PartiQL statements

The Dynamo module SHALL provide an `is_mutating_partiql(statement)` helper that classifies a PartiQL statement by its first significant keyword: `SELECT` is non-mutating; `INSERT`, `UPDATE`, and `DELETE` are mutating. The classifier MUST be case-insensitive and MUST ignore leading whitespace and line comments. Because PartiQL statements always begin with their verb, the classifier MAY only ever over-classify a read as a mutation under no realistic input — it MUST NOT classify a mutation as a read.

#### Scenario: SELECT classified as read

- **WHEN** `is_mutating_partiql("  select * from \"t\"")` is evaluated
- **THEN** it returns `false`

#### Scenario: UPDATE classified as mutating

- **WHEN** `is_mutating_partiql("UPDATE \"t\" SET a = 1 WHERE k = 'x'")` is evaluated
- **THEN** it returns `true`

### Requirement: Result row cap and NextToken pagination

`dynamo_run_partiql` MUST page through `ExecuteStatement` using the opaque `NextToken` cursor, accumulating items until a fixed cap is reached, then stop and set `truncated: true`. The accumulated `ConsumedCapacity` MUST be aggregated across pages and returned as `consumed_capacity` so the editor can display query cost. The cap MUST match the Athena editor's row cap unless a lower DynamoDB-appropriate default is chosen.

#### Scenario: Large result set is capped and flagged

- **WHEN** a SELECT returns more items than the cap across multiple `NextToken` pages
- **THEN** `items` contains exactly the cap and `truncated` is `true`

#### Scenario: Consumed capacity reported

- **WHEN** any PartiQL statement completes successfully
- **THEN** `consumed_capacity` reflects the DynamoDB-reported total consumed capacity for that run, aggregated across pages

### Requirement: Multi-statement run (sequential executions)

The Dynamo module SHALL expose `dynamo_run_partiql_many(connection_id, statements, origin?)` that accepts multiple statements (the editor splits the body on `;`) and runs each as a separate `ExecuteStatement` sequentially, stopping at the first failure (remaining statements marked skipped). The response MUST be a `{ outcomes: Array<{ index, statement, outcome: "ok" | "err" | "skipped", result?, error? }> }` envelope analogous to `athena_run_sql_many`. Each `ExecuteStatement` call is independent and non-atomic; the module MUST NOT present multi-statement runs as transactional. The read-only gate from "Run PartiQL command" MUST apply to each mutating statement in the batch.

#### Scenario: Two statements run sequentially

- **WHEN** the user runs two statements in one batch against a writable connection
- **THEN** each is executed as its own `ExecuteStatement` in order and both outcomes are returned

#### Scenario: Failure stops the batch

- **WHEN** the first of three statements fails
- **THEN** its outcome is `err` and the remaining two are marked `skipped` (not executed)

#### Scenario: Read-only gate applies per statement

- **WHEN** a batch contains a `SELECT` followed by a `DELETE` on a `read_only` connection
- **THEN** the `SELECT` runs and the `DELETE` outcome is an error with message `connection is read-only`

### Requirement: PartiQL editor tab

The Dynamo module SHALL provide a free-form PartiQL editor as a center-area tab of a new kind (e.g. `dynamo-query`), modeled on the Athena query-only editor: a CodeMirror surface with `Mod-Enter` (run current/selected statement), `Mod-Shift-Enter` (run all), syntax highlighting, and a results region. The tab MUST be registered with `TabRegistry.register` via a side-effect (value) import in `src/modules/dynamo/index.ts` — NOT an `export type` — so registration actually runs at module load. The guided `data-view` `QueryBuilder` MUST remain the default per-table experience; the PartiQL editor is the advanced mode and is not bound to a single table.

#### Scenario: Tab kind is registered at module load

- **WHEN** the dynamo module barrel is imported
- **THEN** `TabRegistry.register` has been called for the PartiQL tab kind (via a value/side-effect import, not `export type`)

#### Scenario: Run executes the current statement

- **WHEN** the user types a PartiQL statement and presses `Mod-Enter`
- **THEN** `dynamo_run_partiql` is invoked and the results region renders the outcome

#### Scenario: Run all executes every statement

- **WHEN** the editor body contains two statements separated by `;` and the user presses `Mod-Shift-Enter`
- **THEN** `dynamo_run_partiql_many` is invoked and a per-statement outcome list is rendered

### Requirement: Nested-item result rendering

The PartiQL editor's result panel SHALL render `SELECT` results using DynamoDB-native item rendering — reusing the `data-view` inferred-columns grid, `AttributeValue` cell rendering, and the JSON inspector for a selected item — rather than a flat tabular table, so heterogeneous and nested items (`M`, `L`, `SS`, binary) are not lost. For `succeeded` outcomes the panel SHALL render a status summary (statement type + consumed capacity) with no grid.

#### Scenario: Heterogeneous items render with inferred columns

- **WHEN** a SELECT returns items where one has a `tags` string-set and another has a nested `meta` map
- **THEN** columns are inferred across the returned items and nested values are rendered without flattening loss

#### Scenario: Inspector shows the selected item as JSON

- **WHEN** the user selects a result row
- **THEN** the JSON inspector shows that item's full `AttributeValue` structure

#### Scenario: Mutating outcome shows a status summary

- **WHEN** a run returns `{ kind: "succeeded", statement_type: "UPDATE", consumed_capacity }`
- **THEN** the panel shows the statement type and consumed capacity and renders no result grid

### Requirement: PartiQL completion sources

The PartiQL editor SHALL offer autocomplete scoped to what DynamoDB exposes: PartiQL keywords, table names and index names for the connection, and the partition/sort key attribute names from each table's cached `DescribeTable`, plus attribute names declared in the connection's linked context-folder documentation. The editor MUST NOT attempt to complete arbitrary item attributes by sampling table data.

#### Scenario: Table names completed

- **WHEN** the user types `FROM ` and triggers completion
- **THEN** the connection's cached table names are offered

#### Scenario: Key attributes completed

- **WHEN** the user references a table whose `DescribeTable` is cached
- **THEN** that table's partition and sort key attribute names are offered as completions

#### Scenario: No data sampling for completion

- **WHEN** completion is triggered for a table with no key beyond PK/SK and no context docs
- **THEN** only keys, keywords, table/index names are offered and NO `ExecuteStatement`/`Scan` is issued to discover attributes

### Requirement: Result export

The PartiQL editor SHALL offer export of the current `SELECT` result set to CSV, JSONL, and XLSX, reusing the existing export utilities and save flow used by the Athena/MySQL editors.

#### Scenario: Export to CSV

- **WHEN** the user exports a PartiQL result set as CSV
- **THEN** a CSV file is written via the existing `saveExport` flow with the inferred columns and item values

### Requirement: Launch points for the PartiQL editor

The PartiQL editor SHALL be openable from a command-palette entry (group `"Dynamo"`) when a Dynamo connection is focused, and the existing Dynamo context-query runner SHALL open the editor pre-filled with the substituted query body (replacing the prior clipboard fallback in `openDynamoQuery`). Opening the editor from a specific table context (see the `dynamo-table-browser` and `dynamo-connection` capabilities) SHALL pre-fill the body with `SELECT * FROM "<tableName>"`.

#### Scenario: Command palette opens the editor

- **WHEN** a Dynamo connection is focused and the user runs the palette command to open a new PartiQL query
- **THEN** a PartiQL editor tab opens for that connection

#### Scenario: Context query opens the editor instead of the clipboard

- **WHEN** the user runs a Dynamo context query
- **THEN** the substituted query body opens in a PartiQL editor tab (the clipboard fallback is no longer used)

#### Scenario: Opening from a table pre-fills a SELECT

- **WHEN** the editor is opened from a table named `events`
- **THEN** the editor body is pre-filled with `SELECT * FROM "events"`
