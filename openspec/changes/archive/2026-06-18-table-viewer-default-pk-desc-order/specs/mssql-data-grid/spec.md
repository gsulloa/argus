## MODIFIED Requirements

### Requirement: Per-table ordering controls

The data grid SHALL support changing the active order via column header clicks. Clicking a column header MUST cycle that column's sort through `ASC → DESC → unsorted`. Holding `Shift` while clicking a column header MUST extend the existing `order_by` array by appending (or toggling) that column — preserving multi-column sort. The new `order_by` array MUST be persisted per `(connectionId, schema, relation)` under `msTableOrder:<connectionId>:<schema>:<relation>` (a JSON array of `{ column, direction: "ASC" | "DESC" }`).

When no order has been selected for the relation, the initial `order_by` MUST default to the relation's primary key in descending direction — every primary-key column `DESC`, in primary-key definition order. When the relation has no primary key (a heap or a view), the order MUST default to the empty array, which the backend resolves via its primary-key-ascending / `SELECT NULL` fallback per the query-table requirement. Because the primary key is loaded asynchronously, the viewer MUST seed the initial order from the resolved primary key and MUST NOT issue a first-page fetch with an empty order followed by a second fetch carrying the primary-key default; the relation MUST open with a single first-page fetch carrying the correct order. A user order change MUST take precedence over the default for the life of the tab and MUST NOT be overwritten when the primary key resolves.

The header MUST show a visible sort badge (e.g. `↑` / `↓`) on every column currently participating in the sort, with the badge order or index reflecting the column's position in the array.

The setting MUST be scoped per connection — two connections inspecting the same `<schema>.<relation>` MUST NOT share sort state.

#### Scenario: Default order is primary key descending

- **WHEN** the user opens `sales.orders` (primary key `id`) for the first time and no order has been selected
- **THEN** the issued SQL contains `ORDER BY [id] DESC`
- **AND** the viewer issues exactly one first-page fetch (no preceding fetch with an empty order)

#### Scenario: Composite primary key defaults to all columns descending

- **WHEN** the user opens a table whose primary key is `(tenant_id, created_at)` for the first time
- **THEN** the issued SQL contains `ORDER BY [tenant_id] DESC, [created_at] DESC`

#### Scenario: Heap or view defaults to the backend fallback

- **WHEN** the user opens a heap table (no primary key) or a view for the first time
- **THEN** the frontend sends no user `order_by` and the issued SQL uses the backend primary-key-ascending / `SELECT NULL` fallback

#### Scenario: Single-column sort cycle

- **WHEN** the user clicks the `created_at` header on a relation with no active sort
- **THEN** the next click triggers ASC; clicking again triggers DESC; clicking again removes the sort
- **AND** each transition triggers a buffer reset and a fresh first page

#### Scenario: Shift-click extends the sort

- **WHEN** the user has `order_by = [{ column: "country", direction: "ASC" }]` and Shift-clicks the `created_at` header
- **THEN** `order_by` becomes `[{ column: "country", direction: "ASC" }, { column: "created_at", direction: "ASC" }]`
- **AND** the issued SQL contains `ORDER BY [country] ASC, [created_at] ASC`

#### Scenario: User order is not overwritten by the primary-key default

- **WHEN** the user changes the order on `sales.orders` and then the primary key resolves (or the tab re-renders)
- **THEN** the user's `order_by` remains in effect and the primary-key default is not re-applied

#### Scenario: Sort persists across tab switches and restarts

- **WHEN** the user sets `order_by: [{ column: "created_at", direction: "DESC" }]` on `sales.orders` and switches tabs
- **AND** the user returns (or quits Argus and relaunches and reopens the table)
- **THEN** the same `order_by` is restored and the issued SQL contains `ORDER BY [created_at] DESC`

#### Scenario: Sort is per connection

- **WHEN** the user has `created_at DESC` on `connectionA.sales.orders` and opens `connectionB.sales.orders` (primary key `id`) for the first time
- **THEN** `connectionB.sales.orders` issues SQL ordered by its own default `ORDER BY [id] DESC`, not by `created_at` from connection A
