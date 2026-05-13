## ADDED Requirements

### Requirement: Base column width by data category

The system SHALL compute a base column width as a function of the column's semantic category, used whenever no user override is recorded for that column. The categories and their base widths in pixels MUST be:

| Category  | Base width (px) |
|-----------|-----------------|
| `boolean` | 88              |
| `numeric` | 120             |
| `date`    | 168             |
| `uuid`    | 280             |
| `text`    | 200             |
| `json`    | 240             |
| `binary`  | 140             |
| `other`   | 180             |

Columns flagged as a partition key or sort key indicator MUST add an extra 16px to the base width to accommodate the key badge.

#### Scenario: Numeric column defaults to 120px

- **WHEN** a grid renders a column whose category is `numeric` and no override exists
- **THEN** the column is rendered with `width: 120px`

#### Scenario: Boolean column defaults to 88px

- **WHEN** a grid renders a column whose category is `boolean` and no override exists
- **THEN** the column is rendered with `width: 88px`

#### Scenario: UUID column defaults to 280px

- **WHEN** a grid renders a column whose category is `uuid` and no override exists
- **THEN** the column is rendered with `width: 280px`

#### Scenario: Key column adds badge padding

- **WHEN** a grid renders a column with category `text` that is also a partition-key indicator and no override exists
- **THEN** the column is rendered with `width: 216px` (200 + 16)

#### Scenario: Unknown category falls back to 180px

- **WHEN** a grid renders a column whose category cannot be classified
- **THEN** the column is rendered with `width: 180px`

### Requirement: Postgres data type to category mapping

The system SHALL map Postgres `data_type` strings to a single category via a `categorize(data_type)` helper that returns one of `numeric | boolean | date | text | binary | json | uuid | other`. The mapping MUST treat `text`, `varchar`, `character varying`, `character`, `char`, `citext` as `text`; `bool` / `boolean` as `boolean`; `smallint | int2 | integer | int | int4 | bigint | int8 | numeric | decimal | real | double precision | float4 | float8` as `numeric`; `date | time | timestamp | timestamptz | timestamp with time zone | timestamp without time zone | time with time zone | time without time zone | interval` as `date`; `json | jsonb` as `json`; `bytea` as `binary`; `uuid` as `uuid`; anything else as `other`.

#### Scenario: Integer maps to numeric

- **WHEN** `categorize("integer")` is invoked
- **THEN** it returns `"numeric"`

#### Scenario: Timestamp with time zone maps to date

- **WHEN** `categorize("timestamp with time zone")` is invoked
- **THEN** it returns `"date"`

#### Scenario: JSONB maps to json

- **WHEN** `categorize("jsonb")` is invoked
- **THEN** it returns `"json"`

#### Scenario: Unknown type maps to other

- **WHEN** `categorize("tsvector")` is invoked
- **THEN** it returns `"other"`

### Requirement: DynamoDB attribute tag to category mapping

The system SHALL map DynamoDB AttributeValue tags to a category as follows: `BOOL → boolean`, `N → numeric`, `B → binary`, `S → text`, `NULL → boolean`, complex types `L | M | SS | NS | BS → json`. When a `S` column corresponds to a partition key or sort key whose sampled values match a UUID pattern in at least 80% of inspected rows, it MAY be classified as `uuid` instead of `text`. Mixed-tag columns MUST resolve to the most frequent tag in the loaded sample.

#### Scenario: Number attribute classifies as numeric

- **WHEN** a DynamoDB column's dominant tag in the sample is `N`
- **THEN** its category is `numeric`

#### Scenario: List attribute classifies as json

- **WHEN** a DynamoDB column's dominant tag in the sample is `L`
- **THEN** its category is `json`

#### Scenario: UUID-shaped string PK classifies as uuid

- **WHEN** the partition-key column has tag `S` and ≥80% of sampled values match the UUID v4 regex
- **THEN** its category is `uuid`

### Requirement: Per-column user override storage

The system SHALL maintain, per persisted grid, a `ColumnWidthsRecord` of shape `Record<columnName, number>` containing only user-modified widths. Columns absent from the record MUST fall back to the type-derived base width. The record MUST be loaded and saved through the existing `useSetting<T>(key, defaultValue)` mechanism (memory-cached, debounced 150ms to disk via Tauri).

Persistence keys:
- Postgres table viewer: `pgColumnWidths:<connectionId>:<schema>:<relation>`
- DynamoDB data view: `dynamoColumnWidths:<connectionId>:<tableName>`

Grids whose schema is not stable (e.g. ad-hoc SQL result grids) MUST NOT persist to disk; their record MUST live in component state for the lifetime of the surrounding tab.

#### Scenario: Default record is empty

- **WHEN** a user opens a Postgres table viewer for the first time and no setting is stored
- **THEN** `useSetting` resolves to `{}` and every column uses its type-derived base width

#### Scenario: Override persists across sessions

- **WHEN** the user sets the `created_at` column to 250px in `connectionA.public.users`
- **THEN** the next time the user opens that table in a future app session, `created_at` renders at 250px

#### Scenario: Persistence is scoped per connection

- **WHEN** the user has `pgColumnWidths:A:public:users = { id: 90 }` and opens `connectionB.public.users`
- **THEN** `connectionB.public.users` reads `pgColumnWidths:B:public:users` independently and `id` uses the default for its category, not 90

#### Scenario: Ad-hoc grid does not persist to disk

- **WHEN** the user resizes a column in the SQL editor's result grid and closes the tab, then opens a new query tab and runs a query that returns the same column shape
- **THEN** the new tab does NOT inherit the previous tab's width adjustment

### Requirement: Resize handle interaction

Every grid header cell whose column is resizable SHALL expose a draggable hit area along its right edge that is 6px wide (3px inside the cell, 3px outside). The hit area MUST:

- Set `cursor: col-resize` on hover and during drag.
- Render a visible 1px vertical accent line on hover and during drag, using the `--accent` token at 50% opacity with `transition: opacity var(--duration-instant)`. The handle MUST NOT be visible in the idle state.
- Use HTML pointer events with `setPointerCapture` so move events route only to the captured target. The grid MUST listen to `pointermove`, `pointerup`, and `pointercancel` to update and finalize the width.
- During an active drag, the document body MUST receive `user-select: none` and `cursor: col-resize` so cross-cell drag does not flicker the cursor; both MUST be cleared on pointer up/cancel.
- Clamp the resulting width to `[56, 800]` pixels before applying.
- On `dblclick` over the hit area, remove the column's entry from the record (reset to type-derived base width).

Columns flagged as `nonResizable` MUST NOT render a hit area (e.g. DynamoDB's `More…` column).

#### Scenario: Hover reveals handle

- **WHEN** the pointer enters the right-edge hit area of a resizable column header
- **THEN** a 1px vertical line appears at 50% accent opacity within `--duration-instant`

#### Scenario: Drag updates width live

- **WHEN** the user presses pointer down on the handle of a 180px column and moves the pointer 40px to the right before releasing
- **THEN** the column's rendered width transitions to 220px during the drag (live feedback)
- **AND** on pointer up, the override `{ <column>: 220 }` is committed to the record and scheduled for persistence

#### Scenario: Width clamps at the minimum

- **WHEN** the user drags the handle so the computed width would be 30px
- **THEN** the column width is set to 56px instead

#### Scenario: Width clamps at the maximum

- **WHEN** the user drags the handle so the computed width would be 1200px
- **THEN** the column width is set to 800px instead

#### Scenario: Double-click resets to type default

- **WHEN** the user has set `status` to 300px and then double-clicks the handle on the `status` header
- **THEN** the override for `status` is removed from the record
- **AND** `status` re-renders at its type-derived base width

#### Scenario: Non-resizable column shows no handle

- **WHEN** the DynamoDB Tabla view renders the `More…` column
- **THEN** no resize hit area is rendered on its right edge
- **AND** hovering its right edge does not reveal an accent line

### Requirement: Grid total width tracks effective column widths

Each grid SHALL compute its sticky-header and row-container width as the sum of the effective width of every visible column (user override if present, otherwise the type-derived base width). The grid MUST NOT hard-code a `columns.length * <constant>` total.

#### Scenario: Total width matches column widths after a resize

- **WHEN** a grid has four columns at widths `[120, 200, 180, 88]`
- **THEN** the sticky header and the row container width are 588px
- **AND** after the user resizes the first column to 160px, both become 628px on the next render
