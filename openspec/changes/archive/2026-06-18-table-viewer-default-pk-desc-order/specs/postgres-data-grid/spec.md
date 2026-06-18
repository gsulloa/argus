## MODIFIED Requirements

### Requirement: Per-table sort persistence

The frontend SHALL persist the table viewer's `orderBy` per `(connectionId, schema, relation)` tuple under the settings key `pgTableOrder:<connectionId>:<schema>:<relation>` (a JSON array of `{ column, direction }`). The persisted state MUST distinguish "no order has ever been selected for this relation" (the setting key is absent) from "the user has explicitly chosen an empty order" (the key is present with value `[]`).

When the setting key is absent (no user selection yet):
- if the relation has a primary key, the effective `orderBy` MUST default to every primary-key column in `desc` direction, in primary-key definition order;
- if the relation has no primary key (including views and other PK-less relations), the effective `orderBy` MUST default to the empty array (the relation's natural row order).

A persisted value MUST be used verbatim and MUST NOT be overwritten by the primary-key default — this includes a persisted explicit empty array `[]`, which MUST continue to issue SQL with no `ORDER BY` clause. Because the default is derived from the asynchronously-loaded primary key, when nothing is persisted the first-page fetch MUST NOT be issued with an empty order and then immediately re-fetched with the primary-key default; the viewer MUST defer the first-page fetch until the primary key has resolved so the relation opens with a single fetch carrying the correct order. When a persisted value exists, the first-page fetch MUST NOT wait on the primary key.

The persisted sort MUST survive the same lifecycle events as the persisted filter (tab switches, tab close/reopen, app restarts). The persisted sort MUST be cleared only by the same explicit user gestures that change it: clicking a column header to cycle sort, or removing a sort via the existing sort UX. There is no separate "reset sort" affordance — the user's existing column-header gesture is the manual control.

The setting MUST be scoped per connection — two connections inspecting the same `<schema>.<relation>` MUST NOT share sort state.

#### Scenario: Default sort is primary key descending

- **WHEN** the user opens a table tab for `public.users` (primary key `id`) for the first time and no setting is stored
- **THEN** the issued SQL contains `ORDER BY "id" DESC`
- **AND** the viewer issues exactly one first-page fetch (no preceding fetch with an empty order)

#### Scenario: Composite primary key defaults to all columns descending

- **WHEN** the user opens a table whose primary key is `(tenant_id, created_at)` for the first time with no setting stored
- **THEN** the issued SQL contains `ORDER BY "tenant_id" DESC, "created_at" DESC`

#### Scenario: Relation without a primary key defaults to no order

- **WHEN** the user opens a view, or a table with no primary key, for the first time with no setting stored
- **THEN** the issued SQL contains no `ORDER BY` clause

#### Scenario: Explicit empty order is respected over the default

- **WHEN** the relation has a primary key `id` and the persisted setting for the relation is an explicit empty array `[]`
- **THEN** the issued SQL contains no `ORDER BY` clause (the default is not applied)

#### Scenario: Sort persists across tab switches and restarts

- **WHEN** the user sets `order_by: [{ column: "created_at", direction: "desc" }]` on `public.users` and switches tabs
- **AND** the user returns (or quits Argus and relaunches and reopens the table)
- **THEN** the same `order_by` is restored and the issued SQL contains `ORDER BY "created_at" DESC`

#### Scenario: Sort is per connection

- **WHEN** the user has `created_at desc` persisted on `connectionA.public.users` and opens `connectionB.public.users` (primary key `id`) for the first time with nothing persisted
- **THEN** `connectionB.public.users` issues SQL ordered by its own default `ORDER BY "id" DESC`, not by `created_at` from connection A
