## MODIFIED Requirements

### Requirement: By-model filtering mode in the QueryBuilder

When the open Dynamo table has one or more `dynamo_model` documents, the QueryBuilder SHALL offer a builder-mode toggle with values "By model" and "Raw (PK/SK)". When the table has no model documents, the toggle MUST be hidden and the builder MUST behave exactly as the raw PK/SK builder does today. In "By model" mode the QueryBuilder SHALL present, in order: an Entity selector (the table's models), an Access pattern selector for the chosen entity, and one input per distinct `${param}` derived from the chosen access pattern's `pk` and `sk` templates. The access-pattern option label SHALL be the access pattern's `name` when present, otherwise a label derived from its index and templates. Each parameter input SHALL display a required marker (`*`) on its label when the parameter appears in the access pattern's `pk` template, or when it appears in the access pattern's `sk` template and that access pattern defines an `sk`. The required marker is presentation only and MUST NOT change the parameter values, the compiled query, or builder validity. Selecting "By model" MUST NOT remove or alter the raw builder, which remains available via the toggle.

#### Scenario: Toggle appears only for STD tables

- **WHEN** the user opens a table that has `dynamo_model` docs
- **THEN** the QueryBuilder shows the "By model" / "Raw (PK/SK)" toggle
- **WHEN** the user opens a table with no model docs
- **THEN** the toggle is hidden and only the existing raw PK/SK builder is shown

#### Scenario: Entity and access-pattern selection drives parameter inputs

- **WHEN** in "By model" mode the user selects entity `Order` and access pattern `{ index: "table", pk: "USER#${userId}", sk: "ORDER#${orderId}" }`
- **THEN** the builder renders inputs for `userId` and `orderId` and a preview of the compiled key condition

#### Scenario: Required markers flag PK and SK parameters

- **WHEN** in "By model" mode the user selects access pattern `{ index: "table", pk: "USER#${userId}", sk: "ORDER#${orderId}" }`
- **THEN** the `userId` input (a `pk` parameter) and the `orderId` input (an `sk` parameter on a pattern that has an `sk`) each show a `*` required marker on their label
- **AND** the marker does not alter the params, the compiled query, or whether the query is valid

#### Scenario: No SK template means no SK required markers

- **WHEN** the selected access pattern has only a `pk` template (no `sk`), e.g. `{ index: "table", pk: "USER#${userId}" }`
- **THEN** the `userId` input shows a `*` marker and no SK-only parameter is marked

#### Scenario: Raw mode is unchanged

- **WHEN** the user selects "Raw (PK/SK)" on an STD table, or opens a non-STD table
- **THEN** the index selector, partition-key input, sort-key clause, and filter rows behave identically to the current raw builder

### Requirement: Model parameter compilation to key conditions

The data-view SHALL compile a chosen access pattern plus its parameter values into a `BuilderState.query` that the existing Query/Scan compiler consumes, such that "By model" mode and "Raw (PK/SK)" mode produce equivalent requests for equivalent key values. Compilation MUST resolve the partition-key and sort-key **attribute names** from the selected index's key schema in the `TableDescription`, and MUST set each emitted value's **type** (`S`/`N`) from that key attribute's type in `TableDescription.attribute_definitions` (so the existing compiler's key-type validation passes without modification). Compilation MUST derive the key **values** from the access pattern's templates.

When no explicit sort-key operator is supplied (the default), compilation MUST use these rules: a template whose parameters are all filled compiles to an equality condition on the fully substituted string; a sort-key template with a trailing run of empty parameters compiles to `begins_with` on the literal prefix up to the first empty parameter; a trailing-empty sort-key template with no literal prefix compiles to a partition-only Query (the sort-key condition is dropped, not `begins_with("")`); an access pattern with no `sk` compiles to a partition-only Query; a template with an empty parameter occurring before a filled parameter is invalid; an unresolved partition key is invalid. The `begins_with` degrade applies only to `S`-typed sort keys; a partially-filled template on a non-`S` key is invalid.

When an explicit sort-key operator is supplied — one of `=`, `<`, `<=`, `>`, `>=`, `between`, `begins_with` — and the access pattern has an `sk` template on an index with a sort key, compilation MUST instead build the sort-key condition from that operator: for a single-value operator the sort-key value is the fully substituted `sk` template (typed from the SK attribute), emitted as `{ name, op, value }`; for `between` the lower bound is the `sk` template substituted with the primary parameters and the upper bound is the `sk` template substituted with the supplied upper-bound parameters, emitted as `{ name, op: "between", value: { min, max } }`. `begins_with` under an explicit operator remains valid only on an `S`-typed sort key. An empty required sort-key parameter under an explicit operator is invalid and MUST name the offending parameter. The partition-key rules are unchanged by the explicit sort-key operator.

On any invalid input the compiler MUST report an error naming the offending parameter or key and MUST NOT issue a request. For any equivalent key values, the request issued in "By model" mode MUST be identical to the request produced by entering the same index, partition-key value, and sort-key clause directly in raw mode.

#### Scenario: Fully filled template compiles to equality

- **WHEN** access pattern `{ index: "table", pk: "USER#${userId}", sk: "ORDER#${orderId}" }` is compiled with `userId = "123"` and `orderId = "456"` and no explicit sort-key operator
- **THEN** the resulting request issues a Query whose key condition equals partition key `"USER#123"` AND sort key `= "ORDER#456"`, using the table index's PK/SK attribute names

#### Scenario: Empty trailing sort-key parameter compiles to begins_with

- **WHEN** the same access pattern is compiled with `userId = "123"` and `orderId` left empty and no explicit sort-key operator
- **THEN** the resulting request issues a Query with partition key `"USER#123"` AND `begins_with(sk, "ORDER#")`

#### Scenario: Explicit comparison operator builds a range sort-key condition

- **WHEN** access pattern `{ index: "table", pk: "USER#${userId}", sk: "ORDER#${orderId}" }` is compiled with `userId = "123"`, `orderId = "456"`, and explicit sort-key operator `>=`
- **THEN** the resulting request issues a Query with partition key `"USER#123"` AND sort key `>= "ORDER#456"`, identical to entering `pk = "USER#123"` and a `>=` sort-key clause with value `"ORDER#456"` in raw mode

#### Scenario: Explicit between operator builds a min/max sort-key condition

- **WHEN** access pattern `{ index: "table", pk: "USER#${userId}", sk: "DATE#${day}" }` is compiled with `userId = "123"`, primary `day = "2025-01-01"`, upper-bound `day = "2025-12-31"`, and explicit sort-key operator `between`
- **THEN** the resulting request issues a Query with partition key `"USER#123"` AND sort key `between "DATE#2025-01-01" and "DATE#2025-12-31"`

#### Scenario: Explicit begins_with on a non-string sort key is rejected

- **WHEN** an access pattern whose `sk` attribute is typed `N` is compiled with explicit sort-key operator `begins_with`
- **THEN** compilation returns an error and no request is issued

#### Scenario: Gap before a filled parameter is rejected

- **WHEN** a sort-key template `"A#${x}#B#${y}"` is compiled with `x` empty and `y = "5"` and no explicit sort-key operator
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
