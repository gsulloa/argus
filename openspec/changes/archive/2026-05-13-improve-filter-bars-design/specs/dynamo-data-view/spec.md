## MODIFIED Requirements

### Requirement: Structured query builder

The data view SHALL include a structured query-builder panel that compiles to AWS expressions without exposing the DynamoDB DSL syntax to the user. The builder MUST surface a mode selector (`Scan` default, `Query`), an index dropdown listing the primary index and every GSI / LSI from `describe`, partition- and sort-key pickers for `Query` mode (typed by the selected index's `key_schema` + `attribute_definitions`), and a list of filter rows applied to both modes. Filter row operators MUST include `=`, `<>`, `<`, `<=`, `>`, `>=`, `between`, `contains`, `begins_with`, `attribute_exists`, `attribute_not_exists`, and `attribute_type`. Sort-key operators in `Query` mode MUST be one of `=`, `<`, `<=`, `>`, `>=`, `between`, `begins_with`. Filter rows MUST AND-join into a single `FilterExpression`. Attribute names MUST be passed via `ExpressionAttributeNames` placeholders (`#nN`); attribute values MUST be passed via `ExpressionAttributeValues` placeholders (`:vN`); no user-supplied attribute name or value MUST be inlined into the expression text. Value types MUST be one of `S | N | BOOL | NULL`; key-picker types MUST follow the schema's `attribute_definitions` (`S | N | B`) and reject other types client-side. The panel MUST expose a collapsible "Preview" disclosure showing the compiled `FilterExpression`, `KeyConditionExpression`, names, and values for transparency. Pressing `⌘R` MUST run the current builder state via Scan or Query; pressing `⌘⇧R` MUST reset the builder to defaults (Scan mode, no index, no filters, page size from the persisted setting or 100).

The query-builder panel SHALL conform to every requirement of the `filter-bar-visual-system` capability: it MUST use the shared primitive layer in `src/modules/shared/filter-bar/`, the shared design tokens, the 32/body/32 layout rhythm, the segmented mode toggle primitive (for the Scan/Query selector), the `box-shadow`-based 3px focus halo on every focusable child (index dropdown, key pickers, attribute-name input, operator picker, value input, type badge picker, Preview disclosure, Run, Reset), the violet primary button (Run) with a layout-stable dirty pip when the builder state differs from the last-run state, the keyboard-hint chips (`⌘↵` next to Run, `⌘⇧R` next to Reset), the inline `No filters · + Filter` empty filters-section state, the `var(--surface-2)` hover surface, and the `prefers-reduced-motion: reduce` overrides. The panel MUST NOT reimplement any of the chrome covered by the shared primitives inline. The type badges next to attribute names, the `+ Filter` button, and any AND connector between filter rows MUST be rendered by the shared primitives (`FilterTypeBadge`, `FilterRowAddButton`, `FilterConnector`).

#### Scenario: Mode selector defaults to Scan

- **WHEN** the user opens the data view for the first time on a given table
- **THEN** the query builder is in `Scan` mode with no filters and the primary index selected

#### Scenario: Query mode requires partition key

- **WHEN** the user switches to `Query` mode without setting a partition-key value
- **THEN** the Run button is disabled and a hint reads "Partition key value required"

#### Scenario: Filter compiles to placeholders

- **WHEN** the user adds a filter row `status = "ok"` and another `count >= 5`
- **THEN** the compiled `FilterExpression` is `#n0 = :v0 AND #n1 >= :v1` with `ExpressionAttributeNames: { "#n0": "status", "#n1": "count" }` and `ExpressionAttributeValues: { ":v0": { "S": "ok" }, ":v1": { "N": "5" } }`

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
- **THEN** the builder returns to defaults (Scan mode, no index, no filters, persisted page size)

#### Scenario: Preview reveals compiled expressions

- **WHEN** the user expands the Preview disclosure
- **THEN** the panel shows the current `FilterExpression`, `KeyConditionExpression` (if Query mode), names, and values maps

#### Scenario: Query builder uses the shared primitive layer

- **WHEN** the Dynamo query builder is rendered
- **THEN** its shell, header, Scan/Query segmented toggle, action-row chrome, `+ Filter` button, attribute-name type badges, AND connector strips between filter rows, and keyboard-hint chips are rendered by components imported from `src/modules/shared/filter-bar/`
- **AND** none of those chrome elements are reimplemented inline in `QueryBuilder.tsx`

#### Scenario: Run button shows the violet dirty pip

- **WHEN** the builder's current state differs from the state of the most-recently-executed Scan or Query
- **THEN** the Run button renders a 4px violet pip at its top-right corner with a 2px `var(--accent)` ring
- **AND** the Run button's measured width is identical to its clean-state width

#### Scenario: Empty filters section is a single inline row

- **WHEN** the filters section of the query builder has zero filter rows
- **THEN** the section renders one 24px row reading `No filters · + Filter` with `+ Filter` clickable
- **AND** no separate empty-message row appears above the add button
