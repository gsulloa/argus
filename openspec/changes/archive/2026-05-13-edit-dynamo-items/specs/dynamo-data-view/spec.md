## MODIFIED Requirements

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
