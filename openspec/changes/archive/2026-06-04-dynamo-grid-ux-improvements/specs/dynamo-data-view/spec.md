## ADDED Requirements

### Requirement: Tabla column sort

The data view's Tabla grid SHALL support client-side sorting by clicking a non-`More…` column header. The sort MUST apply only to the items currently loaded into the grid; no sort hint MUST be pushed to AWS, and no re-fetch MUST be triggered by toggling sort.

Clicking a header MUST cycle the column through `asc → desc → none` (none meaning the column is removed from the sort, restoring the natural order of the loaded page). `Shift+Click` MUST add the clicked column to a multi-column sort instead of replacing the active sort: subsequent rows are tie-broken by the columns in the order they were added. `Shift+Click` on a column already in the sort MUST advance only that column's direction through the same `asc → desc → none` cycle, leaving the rest of the multi-column sort untouched. Plain (non-Shift) `Click` on any header MUST always replace the active sort with a single-column sort on that header (cycling on the same column).

The `More…` column MUST NOT be sortable: it MUST NOT respond to clicks, MUST NOT participate in cycling, and MUST NOT render a sort indicator.

The header MUST render a sort indicator (`▲` for `asc`, `▼` for `desc`) when the column is part of the active sort. When two or more columns are sorted, each indicator MUST be accompanied by its 1-based ordinal (`1`, `2`, …) reflecting the column's position in the sort. The indicator MUST NOT render for columns not in the active sort.

Clicks on the column's resize handle MUST NOT change the sort: the handle's pointer events MUST stop propagation so the parent header's `onClick` is not invoked.

The sort state MUST persist per `(connectionId, tableName)` via `useSetting` under the key `dynamoSort:<connectionId>:<tableName>`. The persisted shape MUST be `Array<{ id: string; desc: boolean }>` (TanStack's `SortingState`). The default MUST be `[]` (no sort).

The sort state MUST survive `Load more` and re-runs that append rows: newly loaded items MUST be merged into the existing list and the merged list re-sorted according to the current sort state in place. The sort state MUST NOT be cleared when the user changes the builder, switches between Scan / Query, or changes the index — those gestures replace the loaded items (per the existing Run / Reset contract) and the sort applies to whatever items the next run produces.

Sort comparison MUST be type-aware on the column's DynamoDB AttributeValue tag:
- `N` (numeric) → numeric compare on `parseFloat(value)`; `NaN` sorts as larger than any finite number in `asc` and smaller in `desc`.
- `BOOL` → `false < true`.
- `S` and `B` → lexicographic compare via `String.prototype.localeCompare` with default locale and `{ numeric: true, sensitivity: "base" }`.
- `NULL` → all `NULL` values sort equal to each other.
- Complex types (`L`, `M`, `SS`, `NS`, `BS`) → compared by their displayed summary length (item count / key count / byte count), ascending.
- Missing attribute on a row (`undefined`) → sorts last in `asc` and first in `desc` (i.e. always at the bottom of the visual list).

#### Scenario: Plain click cycles a single column

- **WHEN** the user clicks the `quantity` header on a grid with no active sort
- **THEN** the sort state becomes `[{ id: "quantity", desc: false }]`
- **AND** the rendered rows are ordered by `quantity` ascending
- **AND** the `quantity` header renders a `▲` indicator with no ordinal
- **WHEN** the user clicks the `quantity` header a second time
- **THEN** the sort state becomes `[{ id: "quantity", desc: true }]` and the indicator shows `▼`
- **WHEN** the user clicks the `quantity` header a third time
- **THEN** the sort state becomes `[]` and no indicator renders on `quantity`

#### Scenario: Plain click replaces a previous single-column sort

- **WHEN** the active sort is `[{ id: "quantity", desc: true }]` and the user plain-clicks the `created_at` header
- **THEN** the sort state becomes `[{ id: "created_at", desc: false }]`
- **AND** the `quantity` header no longer renders an indicator

#### Scenario: Shift-click adds a tie-breaker column

- **WHEN** the active sort is `[{ id: "status", desc: false }]` and the user shift-clicks the `quantity` header
- **THEN** the sort state becomes `[{ id: "status", desc: false }, { id: "quantity", desc: false }]`
- **AND** rows with identical `status` are tie-broken by `quantity` ascending
- **AND** the `status` header renders `▲ 1` and the `quantity` header renders `▲ 2`

#### Scenario: Shift-click on an existing column advances only that column

- **WHEN** the active sort is `[{ id: "status", desc: false }, { id: "quantity", desc: false }]` and the user shift-clicks `quantity`
- **THEN** the sort state becomes `[{ id: "status", desc: false }, { id: "quantity", desc: true }]`
- **AND** the `status` entry's direction is unchanged
- **WHEN** the user shift-clicks `quantity` again
- **THEN** the sort state becomes `[{ id: "status", desc: false }]` and `quantity` no longer renders an indicator

#### Scenario: More… column never sorts

- **WHEN** the user clicks the `More…` header
- **THEN** the sort state is unchanged
- **AND** the `More…` header renders no sort indicator regardless of the rest of the active sort

#### Scenario: Resize handle does not trigger sort

- **WHEN** the user clicks (or starts dragging) the resize handle on the `quantity` column header
- **THEN** the sort state is unchanged

#### Scenario: Sort persists per table

- **WHEN** the user sets the sort to `[{ id: "quantity", desc: true }]` on `connectionA.OrdersTable`, closes the tab, and re-opens it
- **THEN** the sort state is restored to `[{ id: "quantity", desc: true }]`
- **AND** opening `connectionA.UsersTable` shows the empty default sort
- **AND** opening the same `OrdersTable` on a different connection (`connectionB`) shows the empty default sort

#### Scenario: Sort survives Load more

- **WHEN** the user has sorted by `quantity desc` over 100 items and clicks `Load more` (or scroll-to-load fires)
- **THEN** the next page is appended to `items` and the merged 200-item list is rendered sorted by `quantity desc` in place
- **AND** the sort state is unchanged

#### Scenario: Numeric column sorts numerically

- **WHEN** the loaded items include `quantity` values `"2"`, `"10"`, `"3"` (all `N`) and the user sorts `quantity` asc
- **THEN** the rendered order is `2`, `3`, `10` (numeric, not lexicographic)

#### Scenario: Missing attribute sorts last in asc and first in desc

- **WHEN** the loaded items include rows where `quantity` is absent and the user sorts `quantity` asc
- **THEN** the rows missing `quantity` appear at the bottom of the list
- **WHEN** the user toggles the same column to desc
- **THEN** the rows missing `quantity` appear at the top of the list

#### Scenario: Complex-type column sorts by summary size

- **WHEN** a column holds `L` values with lengths `[3, 1, 7]` across three rows and the user sorts that column asc
- **THEN** the rendered row order corresponds to lengths `1, 3, 7`
