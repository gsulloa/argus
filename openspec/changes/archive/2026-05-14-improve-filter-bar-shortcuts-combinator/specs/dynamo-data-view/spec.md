## MODIFIED Requirements

### Requirement: Structured query builder

The data view SHALL include a structured query-builder panel that compiles to AWS expressions without exposing the DynamoDB DSL syntax to the user. The builder MUST surface a mode selector (`Scan` default, `Query`), an index dropdown listing the primary index and every GSI / LSI from `describe`, partition- and sort-key pickers for `Query` mode (typed by the selected index's `key_schema` + `attribute_definitions`), and a list of filter rows applied to both modes. Filter row operators MUST include `=`, `<>`, `<`, `<=`, `>`, `>=`, `between`, `contains`, `begins_with`, `attribute_exists`, `attribute_not_exists`, and `attribute_type`. Sort-key operators in `Query` mode MUST be one of `=`, `<`, `<=`, `>`, `>=`, `between`, `begins_with`.

Filter rows MUST be joined into a single `FilterExpression` using a builder-level root combinator (`filterCombinator: "AND" | "OR"`, defaulting to `"AND"` when absent). The builder MUST expose a segmented `AND | OR` toggle adjacent to the `+ Filter` add button that switches the combinator between the two values. The toggle MUST be hidden when `filters.length === 0`. Toggling the combinator MUST mark the builder dirty (the Run button's dirty pip MUST appear) and MUST NOT auto-run.

Attribute names MUST be passed via `ExpressionAttributeNames` placeholders (`#nN`); attribute values MUST be passed via `ExpressionAttributeValues` placeholders (`:vN`); no user-supplied attribute name or value MUST be inlined into the expression text. Value types MUST be one of `S | N | BOOL | NULL`; key-picker types MUST follow the schema's `attribute_definitions` (`S | N | B`) and reject other types client-side. The panel MUST expose a collapsible "Preview" disclosure showing the compiled `FilterExpression`, `KeyConditionExpression`, names, and values for transparency. Pressing `⌘R` MUST run the current builder state via Scan or Query; pressing `⌘⇧R` MUST reset the builder to defaults (Scan mode, no index, no filters, `filterCombinator: "AND"`, page size from the persisted setting or 100).

Each filter row MUST render a per-row Apply affordance (a small `▶` icon-button at the row's right edge, `aria-label="Apply only this filter"`, tooltip `"Apply only this filter (replaces active filter)"`). Activating it MUST compile and run a transient `BuilderState` whose `filters` array contains exactly that one row (with `filterCombinator` preserved but semantically inert with a single row), leaving `mode`, `indexName`, and `query` unchanged. The host tab MUST track this transient state as the new "last-run" so the dirty pip reflects divergence from the user's full draft. The per-row Apply MUST NOT mutate the user-visible `BuilderState.filters` array.

While the Dynamo data-view tab is focused and active AND keyboard focus is not inside a CodeMirror editor, pressing `⌘F` (macOS) / `Ctrl+F` (other) MUST bring keyboard focus into the query-builder body. The handler MUST resolve the focus target in this order: (a) if the builder is in `Query` mode and the partition-key value is empty, focus the partition-key value input; (b) otherwise if `filters.length > 0`, focus the first filter row's attribute input; (c) otherwise focus the `+ Filter` add button in the empty state. The handler MUST call `preventDefault()` and MUST NOT fire on other tabs or when focus is inside a CodeMirror surface.

#### Scenario: Mode selector defaults to Scan

- **WHEN** the user opens the data view for the first time on a given table
- **THEN** the query builder is in `Scan` mode with no filters and the primary index selected

#### Scenario: Query mode requires partition key

- **WHEN** the user switches to `Query` mode without setting a partition-key value
- **THEN** the Run button is disabled and a hint reads "Partition key value required"

#### Scenario: Filter compiles to placeholders

- **WHEN** the user adds a filter row `status = "ok"` and another `count >= 5` with `filterCombinator: "AND"` (default)
- **THEN** the compiled `FilterExpression` is `#n0 = :v0 AND #n1 >= :v1` with `ExpressionAttributeNames: { "#n0": "status", "#n1": "count" }` and `ExpressionAttributeValues: { ":v0": { "S": "ok" }, ":v1": { "N": "5" } }`

#### Scenario: Filter combinator OR joins with OR

- **WHEN** the user adds the same two filter rows but toggles `filterCombinator` to `"OR"`
- **THEN** the compiled `FilterExpression` is `#n0 = :v0 OR #n1 >= :v1` with identical names/values maps

#### Scenario: Sort key between compiles correctly

- **WHEN** the user picks `Query` mode with partition key `pk = "user-1"` and sort key `sk between "2025-01-01" and "2025-12-31"`
- **THEN** the compiled `KeyConditionExpression` is `#k0 = :k0 AND #k1 BETWEEN :k1a AND :k1b`

#### Scenario: Unary filter compiles without value

- **WHEN** the user adds a filter row `archived attribute_not_exists`
- **THEN** the compiled `FilterExpression` is `attribute_not_exists(#n0)` with `ExpressionAttributeNames: { "#n0": "archived" }` and no entry in `ExpressionAttributeValues`

#### Scenario: Key picker rejects wrong type

- **WHEN** the user selects an index whose partition key has `attribute_type: "N"` and types a non-numeric value
- **THEN** the Run button is disabled and the picker shows an inline validation error

#### Scenario: ⌘R runs the current builder state

- **WHEN** the user presses ⌘R with focus inside the data view tab
- **THEN** the builder compiles its state and dispatches either `dynamo.scan` or `dynamo.query` based on the mode

#### Scenario: ⌘⇧R resets the builder

- **WHEN** the user presses ⌘⇧R with focus inside the data view tab
- **THEN** the builder returns to defaults (Scan mode, no index, no filters, `filterCombinator: "AND"`, persisted page size)

#### Scenario: Preview reveals compiled expressions

- **WHEN** the user expands the Preview disclosure
- **THEN** the panel shows the current `FilterExpression`, `KeyConditionExpression` (if Query mode), names, and values maps

#### Scenario: Per-row Apply runs just one filter

- **WHEN** the user has three filter rows in the builder and clicks the per-row Apply button on the second row (`status = "ok"`)
- **THEN** a Scan (or Query, per current mode) is dispatched whose compiled `FilterExpression` is `#n0 = :v0` (only the one row)
- **AND** the user-visible `BuilderState.filters` array is unchanged (still has three rows)
- **AND** the Run button's dirty pip reflects that the last-run state diverges from the current draft

#### Scenario: Per-row Apply preserves mode and key conditions

- **WHEN** the user is in `Query` mode with a partition-key value set and three filter rows, and clicks per-row Apply on the second row
- **THEN** the dispatched request is a `Query` (not a `Scan`)
- **AND** the `KeyConditionExpression` is unchanged
- **AND** the `FilterExpression` contains only the one row's predicate

#### Scenario: AND/OR toggle is hidden with zero filters

- **WHEN** `filters.length === 0`
- **THEN** the `AND | OR` toggle is NOT rendered in the builder body

#### Scenario: Toggling filter combinator marks builder dirty

- **WHEN** the user has run the builder with `filterCombinator: "AND"` and toggles to `"OR"`
- **THEN** the Run button's dirty pip becomes visible
- **AND** no Scan/Query is dispatched until the user presses Run (or ⌘R)

#### Scenario: Cmd+F focuses the partition-key input in Query mode when empty

- **WHEN** the builder is in `Query` mode with an empty partition-key value and the user presses `⌘F` from elsewhere in the tab
- **THEN** keyboard focus moves to the partition-key value input

#### Scenario: Cmd+F focuses the first filter row when filters exist

- **WHEN** the builder is in `Scan` mode with two filter rows and the user presses `⌘F` from elsewhere in the tab
- **THEN** keyboard focus moves to the first filter row's attribute input

#### Scenario: Cmd+F focuses the add button on empty filters

- **WHEN** the builder is in `Scan` mode with zero filters and the user presses `⌘F`
- **THEN** keyboard focus moves to the `+ Filter` add button in the empty state

#### Scenario: Cmd+F is scoped to the active data-view tab

- **WHEN** the user has two Dynamo data-view tabs open, the active tab is Tab A, and Tab B is mounted but not active
- **AND** the user presses `⌘F`
- **THEN** only Tab A's builder receives focus; Tab B's builder is unaffected
