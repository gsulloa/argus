## MODIFIED Requirements

### Requirement: Tabla and JSON view modes

The data view SHALL render results in one of two view modes — `Tabla` or `JSON` — toggleable from the toolbar. The active mode MUST persist per table under the setting key `dynamoView:<connectionId>:<tableName>`. Default mode is `Tabla`. Tabla mode MUST render items in a virtualized TanStack-Table-based grid with inferred columns. The column order MUST be: the partition key first, the sort key second (if the table or selected index has one, taken from `describe.key_schema` of the relevant index), followed by up to ten additional attributes ordered by frequency of appearance in the currently loaded sample (ties broken alphabetically), followed by a fixed final column labeled "More…".

Each non-`More…` column's rendered width MUST be the effective width computed by the `column-width-preferences` capability: the user override if present, otherwise the type-derived base width using the column's inferred AttributeValue category (`BOOL/NULL → boolean`, `N → numeric`, `S → text` or `uuid` if the partition/sort key sample matches the UUID pattern in ≥80% of rows, `B → binary`, complex types `L|M|SS|NS|BS → json`). Partition-key and sort-key columns MUST include the extra 16px badge padding. The `More…` column MUST remain at a fixed 40px width and MUST be flagged `nonResizable` (no handle). The sticky-header and row-container widths MUST equal the sum of all effective column widths plus the 40px `More…` column. Overrides MUST be persisted under `dynamoColumnWidths:<connectionId>:<tableName>` via `useSetting`.

Cells whose AttributeValue tag is one of `L`, `M`, `B`, `SS`, `NS`, `BS` MUST render a fixed summary (`[N items]` / `{K keys}` / `<binary NB>`) instead of inline contents, and clicking such a cell MUST select the row and focus the inspector on that attribute and display a visible "Edit item (JSON)" affordance hint. The "More…" column MUST be clickable per row to open the inspector showing the full item. The column order MUST be stable across page loads: a column once rendered MUST NOT change position; new attributes whose frequency exceeds the current Nth column's frequency MAY append on the right immediately before the "More…" column. Tabla cells whose AttributeValue tag is one of `S`, `N`, `BOOL`, `NULL` AND whose column is NOT a `KeySchema` attribute of the active index MUST become editable on double-click when the connection's `params.read_only` is `false`; the inline-edit affordance MUST follow the contract defined in the `dynamo-data-edit` capability. PK / SK cells of existing rows and all cells on read-only connections MUST refuse double-click. JSON mode MUST render each item as one read-only CodeMirror block with `language-json` and `JSON.stringify(item, null, 2)`. JSON mode MUST be virtualized; CodeMirror instances MUST be mounted lazily on first scroll into view and unmounted with a 5-row look-behind / look-ahead window, except that the inspector-selected item's editor MUST remain mounted while selected.

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

#### Scenario: Tabla columns render at type-derived defaults

- **WHEN** the user opens the Tabla view for the first time on a table with columns `pk (S, partition key, UUID-shaped)`, `sk (N, sort key)`, `payload (M)`, `is_active (BOOL)` and no override record exists
- **THEN** the columns render at widths `[296, 136, 240, 88, 40]` respectively (uuid 280 + 16 key badge; numeric 120 + 16 key badge; json 240; boolean 88; `More…` fixed 40)

#### Scenario: Tabla column resize persists per table

- **WHEN** the user drags the `payload` header handle to set its width to 360px on `connectionA.OrdersTable`
- **THEN** the record `dynamoColumnWidths:A:OrdersTable` is updated to include `{ payload: 360 }` and persisted via `useSetting`
- **AND** the next time the user opens that table, `payload` renders at 360px
- **AND** opening `connectionA.UsersTable` is unaffected

#### Scenario: More… column is not resizable

- **WHEN** the user hovers the right edge of the `More…` header
- **THEN** no resize hit area is exposed and no accent line appears
- **AND** the `More…` column width remains 40px regardless of any other column resizes
