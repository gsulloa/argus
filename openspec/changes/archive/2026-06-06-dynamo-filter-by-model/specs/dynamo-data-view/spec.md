## ADDED Requirements

### Requirement: By-model filtering mode in the QueryBuilder

When the open Dynamo table has one or more `dynamo_model` documents, the QueryBuilder SHALL offer a builder-mode toggle with values "By model" and "Raw (PK/SK)". When the table has no model documents, the toggle MUST be hidden and the builder MUST behave exactly as the raw PK/SK builder does today. In "By model" mode the QueryBuilder SHALL present, in order: an Entity selector (the table's models), an Access pattern selector for the chosen entity, and one input per distinct `${param}` derived from the chosen access pattern's `pk` and `sk` templates. The access-pattern option label SHALL be the access pattern's `name` when present, otherwise a label derived from its index and templates. Selecting "By model" MUST NOT remove or alter the raw builder, which remains available via the toggle.

#### Scenario: Toggle appears only for STD tables

- **WHEN** the user opens a table that has `dynamo_model` docs
- **THEN** the QueryBuilder shows the "By model" / "Raw (PK/SK)" toggle
- **WHEN** the user opens a table with no model docs
- **THEN** the toggle is hidden and only the existing raw PK/SK builder is shown

#### Scenario: Entity and access-pattern selection drives parameter inputs

- **WHEN** in "By model" mode the user selects entity `Order` and access pattern `{ index: "table", pk: "USER#${userId}", sk: "ORDER#${orderId}" }`
- **THEN** the builder renders inputs for `userId` and `orderId` and a preview of the compiled key condition

#### Scenario: Raw mode is unchanged

- **WHEN** the user selects "Raw (PK/SK)" on an STD table, or opens a non-STD table
- **THEN** the index selector, partition-key input, sort-key clause, and filter rows behave identically to the current raw builder

### Requirement: Model parameter compilation to key conditions

The data-view SHALL compile a chosen access pattern plus its parameter values into a `BuilderState.query` that the existing Query/Scan compiler consumes, such that "By model" mode and "Raw (PK/SK)" mode produce equivalent requests for equivalent key values. Compilation MUST resolve the partition-key and sort-key **attribute names** from the selected index's key schema in the `TableDescription`, and MUST set each emitted value's **type** (`S`/`N`) from that key attribute's type in `TableDescription.attribute_definitions` (so the existing compiler's key-type validation passes without modification). Compilation MUST derive the key **values** from the access pattern's templates using these rules: a template whose parameters are all filled compiles to an equality condition on the fully substituted string; a sort-key template with a trailing run of empty parameters compiles to `begins_with` on the literal prefix up to the first empty parameter; a trailing-empty sort-key template with no literal prefix compiles to a partition-only Query (the sort-key condition is dropped, not `begins_with("")`); an access pattern with no `sk` compiles to a partition-only Query; a template with an empty parameter occurring before a filled parameter is invalid; an unresolved partition key is invalid. The `begins_with` degrade applies only to `S`-typed sort keys; a partially-filled template on a non-`S` key is invalid. On any invalid input the compiler MUST report an error naming the offending parameter or key and MUST NOT issue a request.

#### Scenario: Fully filled template compiles to equality

- **WHEN** access pattern `{ index: "table", pk: "USER#${userId}", sk: "ORDER#${orderId}" }` is compiled with `userId = "123"` and `orderId = "456"`
- **THEN** the resulting request issues a Query whose key condition equals partition key `"USER#123"` AND sort key `= "ORDER#456"`, using the table index's PK/SK attribute names

#### Scenario: Empty trailing sort-key parameter compiles to begins_with

- **WHEN** the same access pattern is compiled with `userId = "123"` and `orderId` left empty
- **THEN** the resulting request issues a Query with partition key `"USER#123"` AND `begins_with(sk, "ORDER#")`

#### Scenario: Gap before a filled parameter is rejected

- **WHEN** a sort-key template `"A#${x}#B#${y}"` is compiled with `x` empty and `y = "5"`
- **THEN** compilation returns an error naming `x` as the offending parameter and no request is issued

#### Scenario: Unresolved partition key is rejected

- **WHEN** a partition-key template `"USER#${userId}"` is compiled with `userId` empty
- **THEN** compilation returns an error and no request is issued

#### Scenario: Compiled request matches raw mode

- **WHEN** an access pattern targeting `GSI1` compiles partition key `"ORDER#456"` and `begins_with(GSI1SK, "STATUS#")`
- **THEN** the issued request is identical to one produced by entering the same index, partition-key value, and `begins_with` sort-key clause directly in raw mode

#### Scenario: Numeric sort key emits an N-typed value

- **WHEN** an access pattern targets an index whose sort key attribute is typed `N` and the sort-key template `"${version}"` is compiled with `version = "7"`
- **THEN** the emitted sort-key value is `{ type: "N", value: "7" }` and the existing key-type validation passes (no `S`/`N` mismatch error)

#### Scenario: begins_with rejected on a non-string key

- **WHEN** the same numeric-keyed access pattern is compiled with `version` left empty (which would otherwise degrade to `begins_with`)
- **THEN** compilation returns an error indicating the sort key is not a string and no request is issued

#### Scenario: Access pattern with no sort key compiles to a partition-only Query

- **WHEN** an access pattern declares only `pk: "USER#${userId}"` (no `sk`) and is compiled with `userId = "123"`
- **THEN** the issued Query has partition key `"USER#123"` and no sort-key condition (a partition-only query)

#### Scenario: Bare empty sort-key template drops the condition

- **WHEN** an access pattern declares `sk: "${cursor}"` and is compiled with `cursor` left empty
- **THEN** the sort-key condition is dropped (partition-only Query), not compiled to `begins_with(sk, "")`

### Requirement: Model-mode selection is the persisted source of truth

In "By model" mode the QueryBuilder SHALL persist the user's `modelSelection` (chosen entity, access pattern, and parameter values) as the source of truth and SHALL always derive the compiled `query` from it; the raw `query` MUST NOT be hand-edited while in model mode. Switching to "Raw (PK/SK)" seeds the raw builder from the last compiled `query`; switching back to "By model" re-derives from the persisted `modelSelection` without losing the parameters. If the open table's model docs change such that the table is no longer STD, the builder SHALL fall back to raw mode using the last compiled `query` and hide the toggle.

#### Scenario: Parameters survive a round-trip through raw mode

- **WHEN** the user fills `userId = "123"` in model mode, switches to raw mode, then switches back to model mode
- **THEN** the entity, access pattern, and `userId = "123"` are still selected and the compiled query is unchanged

#### Scenario: Models disappearing falls back to raw

- **WHEN** a tab is open in "By model" mode and the table's model docs are removed on disk (the table is no longer STD)
- **THEN** the builder switches to raw mode preserving the last compiled `query`, and the "By model" toggle is hidden
