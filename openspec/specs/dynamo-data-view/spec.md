# dynamo-data-view Specification

## Purpose
TBD - created by archiving change view-dynamo-items. Update Purpose after archive.
## Requirements
### Requirement: Scan command

The Dynamo module SHALL expose a Tauri command `dynamo.scan(connectionId, tableName, options, origin?)` that issues an AWS `Scan` against the given table (or one of its indexes) and returns one page of items together with the pagination cursor and counts. The `options` payload MUST accept snake_case fields `{ index_name?: string, limit: u32, exclusive_start_key?: AttributeMap, filter_expression?: string, expression_attribute_names?: Map<string, string>, expression_attribute_values?: Map<string, AttributeValue>, projection_expression?: string, consistent_read: bool, select?: "ALL_ATTRIBUTES" | "ALL_PROJECTED_ATTRIBUTES" | "SPECIFIC_ATTRIBUTES" | "COUNT", page: u32 }`. The command MUST look up the active client in `DynamoClientRegistry` and MUST return `AppError::NotFound` if no client is registered for `connectionId`. The command MUST validate that `limit` is in the range `1..=1000` before any AWS call, returning `AppError::Validation` otherwise. The command MUST forward the user's expression strings verbatim to AWS without parsing or rewriting them. The response payload MUST be `{ items: Array<AttributeMap>, last_evaluated_key?: AttributeMap, scanned_count: u32, count: u32, consumed_capacity?: ConsumedCapacity }`. The optional `origin` argument MUST be `"user"` or `"auto"` and defaults to `"auto"`. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "scan_table"`, `connection_id: <id>`, `origin: <origin>`, `sql: null`, `params: { table_name, index_name?, has_filter, limit, consistent_read, select?, page }`, `metric: { kind: "items", value: <count> }` on success (`null` on failure), `status` matching the result, and `duration_ms` covering the entire command.

#### Scenario: Default scan returns a page

- **WHEN** the user invokes `dynamo.scan(id, "events", { limit: 100, consistent_read: false, page: 1 })` for an active connection with a table holding 250 items
- **THEN** the response contains `items` of length 100, `count: 100`, `scanned_count: 100`, and a non-null `last_evaluated_key`
- **AND** AWS `Scan` was invoked exactly once internally

#### Scenario: Scan with filter expression

- **WHEN** the user invokes `dynamo.scan(id, "events", { limit: 100, consistent_read: false, page: 1, filter_expression: "#status = :s", expression_attribute_names: { "#status": "status" }, expression_attribute_values: { ":s": { "S": "ok" } } })`
- **THEN** the issued AWS request carries the filter expression and the names/values maps verbatim
- **AND** the response items only contain rows whose `status` is `"ok"`

#### Scenario: Scan against a GSI

- **WHEN** the user invokes `dynamo.scan(id, "events", { index_name: "byCustomer", limit: 100, consistent_read: false, page: 1 })`
- **THEN** the issued AWS request carries `IndexName: "byCustomer"`
- **AND** items reflect the projection of that GSI

#### Scenario: Resume from exclusive_start_key

- **WHEN** the user invokes `dynamo.scan(id, "events", { limit: 100, consistent_read: false, page: 2, exclusive_start_key: <previous response's last_evaluated_key> })`
- **THEN** the next page of items is returned starting after that key

#### Scenario: Invalid limit rejected

- **WHEN** the user invokes `dynamo.scan(id, "events", { limit: 0, consistent_read: false, page: 1 })` or `limit: 1001`
- **THEN** the command returns `AppError::Validation` and no AWS call is made

#### Scenario: No active client

- **WHEN** the user invokes `dynamo.scan(id, "events", { limit: 100, consistent_read: false, page: 1 })` for a `connectionId` with no registered client
- **THEN** the command returns `AppError::NotFound` and no AWS call is made

#### Scenario: Read-only connection allows scan

- **WHEN** the user invokes `dynamo.scan` on a connection whose active-client envelope has `read_only: true`
- **THEN** the command succeeds (`require_writable` is NOT called)

#### Scenario: Expired access-keys session token triggers re-prompt

- **WHEN** `dynamo.scan` fails with `ExpiredToken` on a connection in access-keys mode with a session token
- **THEN** the command returns `AppError::Aws` with the matching code
- **AND** the Dynamo module marks `params.needs_credentials = true` and evicts the client per the existing credential-expiration contract

#### Scenario: Successful scan emits activity-log

- **WHEN** `dynamo.scan` returns 100 items
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "scan_table"`, `status: "ok"`, `metric: { kind: "items", value: 100 }`, `connection_id: <id>`, `params.page: 1`

#### Scenario: AWS ValidationException surfaced verbatim

- **WHEN** the user invokes `dynamo.scan` with a malformed `filter_expression` that AWS rejects
- **THEN** the command returns `AppError::Aws` with code `"ValidationException"` and the AWS message verbatim
- **AND** the activity-log event has `status: "err"`

### Requirement: Query command

The Dynamo module SHALL expose a Tauri command `dynamo.query(connectionId, tableName, options, origin?)` that issues an AWS `Query` against the given table (or one of its indexes) and returns one page of items. The `options` payload extends the Scan shape with required `key_condition_expression: string` and adds optional `scan_index_forward: bool` (defaulting to `true`). The command MUST validate that `key_condition_expression` is non-empty before any AWS call, returning `AppError::Validation` otherwise. All other validation rules and AWS-error handling MUST match the Scan command. The response payload mirrors the Scan response. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "query_table"`, `connection_id: <id>`, `origin: <origin>`, `sql: null`, `params: { table_name, index_name?, has_filter, has_key_condition: true, limit, consistent_read, select?, page, scan_index_forward }`, `metric: { kind: "items", value: <count> }` on success (`null` on failure), `status` matching the result, and `duration_ms`.

#### Scenario: Query on primary partition key

- **WHEN** the user invokes `dynamo.query(id, "events", { key_condition_expression: "#pk = :pk", expression_attribute_names: { "#pk": "pk" }, expression_attribute_values: { ":pk": { "S": "user-1" } }, limit: 100, consistent_read: false, scan_index_forward: true, page: 1 })`
- **THEN** the response contains items whose partition key is `"user-1"`

#### Scenario: Query with reverse sort

- **WHEN** the user invokes `dynamo.query` with `scan_index_forward: false`
- **THEN** the issued AWS request carries `ScanIndexForward: false`
- **AND** the response items are ordered descending by sort key

#### Scenario: Query against a GSI

- **WHEN** the user invokes `dynamo.query` with `index_name: "byCustomer"` and a key condition referencing the GSI's partition key
- **THEN** the issued AWS request carries `IndexName: "byCustomer"`

#### Scenario: Missing key condition rejected

- **WHEN** the user invokes `dynamo.query` with `key_condition_expression: ""` or the field omitted
- **THEN** the command returns `AppError::Validation` and no AWS call is made

#### Scenario: Query also funnels expired-token through the contract

- **WHEN** `dynamo.query` fails with `ExpiredToken` on an access-keys connection with a session token
- **THEN** the command returns `AppError::Aws` with the matching code AND the Dynamo module marks `params.needs_credentials = true`

#### Scenario: Query emits activity-log

- **WHEN** `dynamo.query` returns 42 items
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "query_table"`, `status: "ok"`, `metric: { kind: "items", value: 42 }`, `params.has_key_condition: true`

### Requirement: Count items command

The Dynamo module SHALL expose a Tauri command `dynamo.countItems(connectionId, tableName, options, origin?)` that aggregates the count of items matching a Scan or Query without returning items. The `options` payload MUST accept `{ mode: "scan" | "query", index_name?: string, filter_expression?: string, expression_attribute_names?: Map<string, string>, expression_attribute_values?: Map<string, AttributeValue>, key_condition_expression?: string, scan_index_forward?: bool, consistent_read: bool }`. When `mode === "query"`, `key_condition_expression` MUST be present (rejected with `AppError::Validation` otherwise). The command MUST internally page through AWS with `Select: "COUNT"` and `Limit: 1000` per page, following `LastEvaluatedKey` until exhausted, aggregating `Count` and `ScannedCount` into `total_count` and `total_scanned_count`. The response payload MUST be `{ total_count: u64, total_scanned_count: u64, page_count: u32, consumed_capacity?: ConsumedCapacity }`. The command MUST funnel AWS errors through the credential-expiration contract identically to Scan/Query. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "count_table"`, `connection_id: <id>`, `origin: <origin>`, `sql: null`, `params: { table_name, index_name?, mode, has_filter, has_key_condition, consistent_read }`, `metric: { kind: "items", value: <total_count> }` on success (`null` on failure), `status` matching the result, and `duration_ms` covering the entire paginated walk.

#### Scenario: Count over an unfiltered scan

- **WHEN** the user invokes `dynamo.countItems(id, "events", { mode: "scan", consistent_read: false })` for a table of 2500 items
- **THEN** the response is `{ total_count: 2500, total_scanned_count: 2500, page_count: 3 }`
- **AND** AWS `Scan` was invoked 3 times internally with `Select: "COUNT"`

#### Scenario: Count with filter scans more than it counts

- **WHEN** the user invokes `dynamo.countItems(id, "events", { mode: "scan", consistent_read: false, filter_expression: "#s = :ok", expression_attribute_names: { "#s": "status" }, expression_attribute_values: { ":ok": { "S": "ok" } } })` for a table where 1200 of 5000 items match
- **THEN** the response has `total_count: 1200` and `total_scanned_count: 5000`

#### Scenario: Count over a query

- **WHEN** the user invokes `dynamo.countItems` with `mode: "query"`, a valid `key_condition_expression`, and an index
- **THEN** the command aggregates pages from `Query` (not `Scan`) and the response counts reflect only the queried partition

#### Scenario: Query mode without key condition rejected

- **WHEN** the user invokes `dynamo.countItems` with `mode: "query"` and no `key_condition_expression`
- **THEN** the command returns `AppError::Validation` and no AWS call is made

#### Scenario: Count emits activity-log

- **WHEN** `dynamo.countItems` returns `total_count: 2500`
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "count_table"`, `status: "ok"`, `metric: { kind: "items", value: 2500 }`

### Requirement: Data view tab kind

The Dynamo module SHALL register a center-area tab kind `dynamo-data-view` whose payload is `{ connectionId: UUID, connectionName: string, tableName: string, describe: TableDescription | null }`. The stable id format for instances of this kind MUST be `dynamotbl:<connectionId>:<tableName>`. When opened with `describe: null`, the tab MUST invoke `dynamo.describeTable(connectionId, tableName)` once on mount and render its metadata sub-view as soon as the call returns. When opened with a non-null `describe`, the tab MUST render immediately without re-invoking describe. The tab body MUST contain three top-level sections: a top toolbar (mode toggle, run/reset, consistent-read toggle, reverse-order toggle, count button, page-size control, load-more button, plus an Insert `+` button and a Read-only badge), the query-builder panel, and the results panel, plus a resizable inspector dock on the right. The Insert `+` button MUST be visible only when the connection's `params.read_only` is `false`. The Read-only badge MUST be visible only when the connection's `params.read_only` is `true`. The tab MUST register two keyboard shortcuts active while focus is inside the tab: `⌘N` opens the Insert modal (no-op when the connection is read-only) and `⌫` opens the multi-row Delete confirmation modal when one or more rows are selected and no inline editor is active (no-op when the connection is read-only or no rows are selected). The tab MUST expose a `Metadata` sub-view (reachable from the toolbar) that displays the same describe information the retired placeholder showed: key schema, attribute definitions, GSIs/LSIs, billing mode, stream state, item count, ARN, plus a "Refresh metadata" button that re-fires `dynamo.describeTable` for the table.

#### Scenario: Activation opens the data view tab

- **WHEN** the user activates a table leaf in the sidebar subtree (Enter, single click, or double click)
- **THEN** a tab with id `dynamotbl:<connectionId>:<tableName>` and kind `dynamo-data-view` opens or is focused
- **AND** the payload includes the cached `describe` if available

#### Scenario: Data view opens with no cached describe

- **WHEN** the tab opens with `describe: null`
- **THEN** the tab renders the toolbar and panels with a loading indicator on the metadata sub-view
- **AND** `dynamo.describeTable(connectionId, tableName)` is invoked exactly once

#### Scenario: Metadata sub-view exposes refresh

- **WHEN** the user opens the data view's Metadata sub-view and clicks "Refresh metadata"
- **THEN** `dynamo.describeTable(connectionId, tableName)` is invoked once and the sub-view updates with the new result

#### Scenario: Same leaf activates the existing data view tab

- **WHEN** the user activates the same table leaf a second time
- **THEN** the existing `dynamo-data-view` tab is focused and no new tab is opened

#### Scenario: Insert button visibility tracks read-only flag

- **WHEN** the data view tab is open for a connection with `params.read_only: false`
- **THEN** the `+` Insert button is rendered in the toolbar
- **WHEN** the same tab's connection has `params.read_only: true`
- **THEN** the `+` Insert button is NOT rendered

#### Scenario: Read-only badge visibility tracks read-only flag

- **WHEN** the data view tab is open for a connection with `params.read_only: true`
- **THEN** a "Read-only" badge is rendered in the toolbar
- **WHEN** the same tab's connection has `params.read_only: false`
- **THEN** the "Read-only" badge is NOT rendered

#### Scenario: ⌘N opens the Insert modal

- **WHEN** the user presses `⌘N` with focus inside the data view tab on a writable connection
- **THEN** the Insert modal opens

#### Scenario: ⌫ opens the Delete confirmation modal

- **WHEN** the user has at least one Tabla row selected, no inline editor is active, the connection is writable, and the user presses `⌫`
- **THEN** the multi-row Delete confirmation modal opens

#### Scenario: ⌘N is a no-op on read-only

- **WHEN** the user presses `⌘N` on a connection with `params.read_only: true`
- **THEN** no modal opens

### Requirement: Tabla and JSON view modes

The data view SHALL render results in one of two view modes — `Tabla` or `JSON` — toggleable from the toolbar. The active mode MUST persist per table under the setting key `dynamoView:<connectionId>:<tableName>`. Default mode is `Tabla`. Tabla mode MUST render items in a virtualized TanStack-Table-based grid with inferred columns. The column order MUST be: the partition key first, the sort key second (if the table or selected index has one, taken from `describe.key_schema` of the relevant index), followed by up to ten additional attributes ordered by frequency of appearance in the currently loaded sample (ties broken alphabetically), followed by a fixed final column labeled "More…". Cells whose AttributeValue tag is one of `L`, `M`, `B`, `SS`, `NS`, `BS` MUST render a fixed summary (`[N items]` / `{K keys}` / `<binary NB>`) instead of inline contents, and clicking such a cell MUST select the row and focus the inspector on that attribute and display a visible "Edit item (JSON)" affordance hint. The "More…" column MUST be clickable per row to open the inspector showing the full item. The column order MUST be stable across page loads: a column once rendered MUST NOT change position; new attributes whose frequency exceeds the current Nth column's frequency MAY append on the right immediately before the "More…" column. Tabla cells whose AttributeValue tag is one of `S`, `N`, `BOOL`, `NULL` AND whose column is NOT a `KeySchema` attribute of the active index MUST become editable on double-click when the connection's `params.read_only` is `false`; the inline-edit affordance MUST follow the contract defined in the `dynamo-data-edit` capability. PK / SK cells of existing rows and all cells on read-only connections MUST refuse double-click. JSON mode MUST render each item as one read-only CodeMirror block with `language-json` and `JSON.stringify(item, null, 2)`. JSON mode MUST be virtualized; CodeMirror instances MUST be mounted lazily on first scroll into view and unmounted with a 5-row look-behind / look-ahead window, except that the inspector-selected item's editor MUST remain mounted while selected.

#### Scenario: Toggle persists per table

- **WHEN** the user opens the data view for table A, switches to JSON mode, closes the tab, then re-opens it
- **THEN** the tab opens in JSON mode

#### Scenario: Toggle is per table, not global

- **WHEN** the user has table A in JSON mode and opens table B for the first time
- **THEN** table B opens in Tabla mode (default)

#### Scenario: Tabla column order

- **WHEN** the Tabla view renders 100 items in a table with `key_schema: [{ pk, HASH }, { sk, RANGE }]` and frequent attributes `created_at` (100×), `status` (90×), `user_id` (40×)
- **THEN** the columns appear in the order `pk`, `sk`, `created_at`, `status`, `user_id`, …, `More…`

#### Scenario: Complex-type cell renders as summary and routes to inspector

- **WHEN** a Tabla cell holds the AttributeValue `{ "L": [1, 2, 3] }` and the user double-clicks it
- **THEN** the cell renders `[3 items]`, double-click does NOT open an inline editor, the row is selected, the inspector receives focus on that attribute, AND a visible "Edit item (JSON)" affordance hint is displayed

#### Scenario: Column order is stable across pages

- **WHEN** the user loads page 1 with columns `[pk, sk, status, created_at]` and then loads page 2 in which `category` becomes the most frequent non-key attribute
- **THEN** the existing four columns keep their positions, and `category` appends on the right before "More…"

#### Scenario: JSON mode mounts editors lazily

- **WHEN** JSON mode shows 100 items with a viewport that fits 10 visible blocks
- **THEN** at most ~20 CodeMirror instances are mounted at any time (visible + 5-row look-behind/ahead)

#### Scenario: Selected item editor stays mounted

- **WHEN** the user selects an item in JSON mode and scrolls it out of view
- **THEN** that item's CodeMirror remains mounted as long as it is selected

#### Scenario: Primitive non-key cells become editable on writable connections

- **WHEN** the user double-clicks an `S`, `N`, `BOOL`, or `NULL` cell in a non-PK / non-SK column on a connection with `params.read_only: false`
- **THEN** an inline editor opens per the `dynamo-data-edit` capability's contract

#### Scenario: Key cells never become editable

- **WHEN** the user double-clicks a cell in the partition-key or sort-key column of the active index
- **THEN** no inline editor opens regardless of connection writability

#### Scenario: Read-only connection disables Tabla edit

- **WHEN** the user double-clicks any cell on a connection with `params.read_only: true`
- **THEN** no inline editor opens

### Requirement: Inspector panel

The data view SHALL include a resizable inspector dock on the right that displays the currently selected item as a tree. Each node MUST render `attributeName : <typeBadge> : value` where `typeBadge` is one of `S | N | B | BOOL | NULL | L | M | SS | NS | BS`. Partition-key and sort-key rows MUST receive a subtle accent (consistent with `DESIGN.md`). Nested `L` and `M` values MUST be expandable. Set types (`SS`, `NS`, `BS`) MUST render their elements. The dock MUST expose an "Edit item" button at the top of the inspector that, when activated, swaps the read-only tree for a full-item JSON editor per the `dynamo-data-edit` capability's "Inspector JSON editor" requirement. The "Edit item" button MUST NOT be rendered when the connection's `params.read_only` is `true`. The dock width MUST persist per tab via an existing inspector-width persistence pattern. Pressing `Escape` while the data view tab is focused MUST clear the current row selection and empty the inspector, except when the inspector's JSON editor is open and has an unsaved draft — in that case Escape MUST trigger the editor's Cancel flow (which itself may surface the unsaved-draft guard).

#### Scenario: Selection populates the inspector

- **WHEN** the user clicks a row in Tabla mode (or a block in JSON mode)
- **THEN** the inspector displays the full item as a tree with type badges for every attribute

#### Scenario: Nested map expansion

- **WHEN** the selected item has an attribute `meta: { "M": { country: { "S": "CL" }, age: { "N": "33" } } }`
- **THEN** the inspector shows `meta : M` as an expandable node
- **AND** expanding it reveals `country : S : "CL"` and `age : N : 33`

#### Scenario: Sets render in the tree

- **WHEN** the selected item has an attribute `tags: { "SS": ["a", "b", "c"] }`
- **THEN** the inspector's tree shows `tags : SS : ["a", "b", "c"]` (the tree itself remains read-only; mutation flows through the Edit item JSON editor)

#### Scenario: Edit item button visible on writable connections

- **WHEN** the inspector renders on a connection with `params.read_only: false`
- **THEN** an "Edit item" button is rendered at the top of the inspector

#### Scenario: Edit item button hidden on read-only

- **WHEN** the inspector renders on a connection with `params.read_only: true`
- **THEN** the "Edit item" button is NOT rendered

#### Scenario: Escape clears selection when no editor is open

- **WHEN** a row is selected, the inspector's JSON editor is NOT open, and the user presses Escape with focus inside the data view tab
- **THEN** the row selection clears and the inspector empties

#### Scenario: Escape routes to editor Cancel when editor is open

- **WHEN** the inspector's JSON editor is open and the user presses Escape with focus inside the data view tab
- **THEN** the editor's Cancel flow is triggered (which may itself surface the unsaved-draft guard) and the row selection is NOT cleared

#### Scenario: Inspector width persists per tab

- **WHEN** the user drags the inspector dock handle to widen it for table A and then re-opens table A in a new session
- **THEN** the inspector dock opens at the same width

### Requirement: Structured query builder

The data view SHALL include a structured query-builder panel that compiles to AWS expressions without exposing the DynamoDB DSL syntax to the user. The builder MUST surface a mode selector (`Scan` default, `Query`), an index dropdown listing the primary index and every GSI / LSI from `describe`, partition- and sort-key pickers for `Query` mode (typed by the selected index's `key_schema` + `attribute_definitions`), and a list of filter rows applied to both modes. Filter row operators MUST include `=`, `<>`, `<`, `<=`, `>`, `>=`, `between`, `contains`, `begins_with`, `attribute_exists`, `attribute_not_exists`, and `attribute_type`. Sort-key operators in `Query` mode MUST be one of `=`, `<`, `<=`, `>`, `>=`, `between`, `begins_with`. Filter rows MUST AND-join into a single `FilterExpression`. Attribute names MUST be passed via `ExpressionAttributeNames` placeholders (`#nN`); attribute values MUST be passed via `ExpressionAttributeValues` placeholders (`:vN`); no user-supplied attribute name or value MUST be inlined into the expression text. Value types MUST be one of `S | N | BOOL | NULL`; key-picker types MUST follow the schema's `attribute_definitions` (`S | N | B`) and reject other types client-side. The panel MUST expose a collapsible "Preview" disclosure showing the compiled `FilterExpression`, `KeyConditionExpression`, names, and values for transparency. Pressing `⌘R` MUST run the current builder state via Scan or Query; pressing `⌘⇧R` MUST reset the builder to defaults (Scan mode, no index, no filters, page size from the persisted setting or 100).

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

### Requirement: Pagination via LastEvaluatedKey

The data view SHALL paginate results by following `last_evaluated_key` returned from Scan / Query. Loading more MUST append items to the existing result list without re-fetching previous pages. The toolbar MUST contain a "Load more" button that is enabled exactly when `last_evaluated_key != null` for the current result set. Scroll-to-load MUST automatically trigger "Load more" when the last rendered row enters the viewport, except after a failed load (which disables scroll-to-load until the user manually retries). The bottom bar MUST display `<N> items loaded` where `N` is the current count. The page size MUST be controllable from the toolbar in the range `[1, 1000]` and MUST persist per table under the setting key `dynamoLimit:<connectionId>:<tableName>` with a default of 100. Changing the page size MUST NOT clear the current result list, but the next page or a Re-run MUST use the new size.

#### Scenario: First page loads on Run

- **WHEN** the user clicks Run on a fresh builder state
- **THEN** the data view fetches exactly one page with the current page size and renders the items

#### Scenario: Load more appends a page

- **WHEN** the first page returned a non-null `last_evaluated_key` and the user clicks "Load more"
- **THEN** a second page is fetched with that key as `exclusive_start_key` and its items are appended

#### Scenario: Scroll-to-load triggers automatically

- **WHEN** the last rendered row in the results panel enters the viewport and `last_evaluated_key != null`
- **THEN** "Load more" is fired automatically once

#### Scenario: Failed load disables scroll-to-load

- **WHEN** a "Load more" call fails (e.g., ValidationException, throttling)
- **THEN** scroll-to-load stops auto-firing until the user manually clicks "Load more" again

#### Scenario: Bottom bar shows loaded count

- **WHEN** the data view has 250 items loaded across three pages
- **THEN** the bottom bar reads `250 items loaded`

#### Scenario: Page size persists per table

- **WHEN** the user sets page size to 200 for table A, closes the tab, and re-opens it
- **THEN** the page-size control reads 200 and a new Run uses `limit: 200`

#### Scenario: Page size bounded

- **WHEN** the user attempts to set page size to 0 or 1001
- **THEN** the control clamps to the nearest valid value (1 or 1000) and shows a hint

### Requirement: Count affordance

The data view SHALL include a "Count" button in its toolbar that invokes `dynamo.countItems` with the current builder state (mode, index, filter, key condition if Query, consistent_read). The button MUST NEVER fire automatically. While a count is in flight, the button MUST show a spinner and be disabled to prevent duplicate invocations. The result MUST be displayed inline in the bottom bar as `Count: <total_count> (scanned <total_scanned_count>)`. The displayed count MUST remain visible until the builder state (mode, index, filter, key condition) changes, at which point it MUST be cleared so a stale count never accompanies new builder state.

#### Scenario: Count never fires automatically

- **WHEN** the user opens the data view, runs a scan, and loads more pages
- **THEN** no `dynamo.countItems` call is made

#### Scenario: Count fires only on button click

- **WHEN** the user clicks the Count button
- **THEN** exactly one `dynamo.countItems` call is made with the current builder state

#### Scenario: Count button disabled while in flight

- **WHEN** a count call is in flight and the user clicks the Count button again
- **THEN** no second `dynamo.countItems` call is dispatched

#### Scenario: Result rendered in the bottom bar

- **WHEN** `dynamo.countItems` returns `{ total_count: 12345, total_scanned_count: 50000 }`
- **THEN** the bottom bar reads `Count: 12,345 (scanned 50,000)`

#### Scenario: Stale count cleared on builder change

- **WHEN** a count result is visible and the user changes an index, a filter row, or the mode
- **THEN** the count line is cleared from the bottom bar

### Requirement: Origin tagging for activity-log

The data view SHALL pass `origin: "user"` to `dynamo.scan`, `dynamo.query`, and `dynamo.countItems` for all calls initiated by direct user gestures (Run, ⌘R, Load more, scroll-to-load, Count button, Reset followed by Run, page-size change followed by Run). The data view MAY pass `origin: "auto"` for the initial sample loaded automatically on the first open of a data view tab when the connection's default behavior is to pre-populate items; if no auto-load is performed, this concern does not apply.

#### Scenario: Run button is user-origin

- **WHEN** the user clicks Run
- **THEN** the dispatched command carries `origin: "user"` and the activity-log event reflects that

#### Scenario: Scroll-to-load is user-origin

- **WHEN** scroll-to-load fires a "Load more" automatically
- **THEN** the dispatched command carries `origin: "user"` (scrolling is a user action)

#### Scenario: Count button is user-origin

- **WHEN** the user clicks Count
- **THEN** the dispatched `dynamo.countItems` carries `origin: "user"`

### Requirement: Credential-expiration handling in the data view

When `dynamo:credentials-refreshed` fires for the data view's connection id while a request was in flight or queued, the data view SHALL re-fire the most recent request automatically using the same builder state and pagination cursor. Open data view tabs MUST NOT be closed by the credential-expiration flow. While the connection is in `needs_credentials` state, the data view's toolbar MUST disable Run, Load more, Count, and the index/mode controls, and display an inline notice "Connection waiting for credentials".

#### Scenario: Credentials refresh resumes the last request

- **WHEN** the user has run a scan and an `ExpiredToken` arrives on the next "Load more", followed by the user re-entering credentials and `dynamo:credentials-refreshed` firing for the connection
- **THEN** the data view automatically re-fires the failed "Load more" with the same builder state and `exclusive_start_key`

#### Scenario: Tab survives credential expiration

- **WHEN** a Dynamo connection enters `needs_credentials` while a data view tab is open for one of its tables
- **THEN** the tab remains open

#### Scenario: Controls disabled while waiting

- **WHEN** the data view's connection is in `needs_credentials` state
- **THEN** Run, Load more, Count, and the index/mode controls are disabled and an inline notice reads "Connection waiting for credentials"

### Requirement: Disconnect closes the data view tab

When the data view's connection is disconnected (either by user action via `dynamo.disconnect` or by `connections.delete`), the tab SHALL be closed. The close MUST be silent (no extra confirmation dialog beyond the existing disconnect-confirmation flow defined in `dynamo-connection`).

#### Scenario: Disconnect closes the data view

- **WHEN** the user disconnects a Dynamo connection while a data view tab for one of its tables is open
- **THEN** the data view tab is closed

#### Scenario: Delete closes the data view

- **WHEN** the user deletes a Dynamo connection while a data view tab for one of its tables is open
- **THEN** the data view tab is closed

### Requirement: Shared selection and palette behavior

The palette command `argus.dynamo.openTable:<connectionId>:<tableName>` registered by `dynamo-table-browser` (one per cached table per active connection) SHALL open or focus the data view tab — not the retired placeholder. Activating an entry MUST be equivalent to clicking the leaf in the sidebar subtree (same tab id, same payload behavior).

#### Scenario: Palette opens the data view

- **WHEN** the user runs the palette entry `prod-dynamo · events`
- **THEN** the `dynamo-data-view` tab with id `dynamotbl:<prod-dynamo-id>:events` opens or is focused
