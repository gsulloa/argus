## ADDED Requirements

### Requirement: Per-table filter persistence

The frontend SHALL persist the filter bar's `draft` and `applied` `FilterModel` per `(connectionId, schema, relation)` tuple under the settings key `pgTableFilter:<connectionId>:<schema>:<relation>`. The persisted record MUST contain both halves of the bar's state (`{ draft, applied }`) as a single coherent JSON object, so a partial-write (one half stale, the other fresh) is impossible.

The persisted filter MUST survive: switching to a different tab and back, closing the table tab and reopening it, switching to a different connection and back, and restarting the app. The persisted filter MUST NOT be cleared by any of those events.

The persisted filter MUST be cleared *only* when the user explicitly invokes one of:
- the filter bar's `Reset` button,
- the bottom bar's `Clear filters` chip / affordance.

When the persisted filter references a column that no longer exists (schema drift), the system MUST surface the resulting `AppError::Postgres` through the same UI paths as today (inline near the Raw editor when in Raw mode; the existing first-load error banner when in Structured mode). The system MUST NOT auto-prune predicates or silently drop the persisted filter on schema drift.

The setting MUST be scoped per connection — two connections inspecting the same `<schema>.<relation>` MUST NOT share filter state.

#### Scenario: Default filter is empty

- **WHEN** the user opens a table tab for the first time and no setting is stored
- **THEN** the filter bar shows the empty filter model (no rows, no raw body) and `applied` is empty
- **AND** the first `postgres.queryTable` invocation has neither `filter_tree` nor `raw_where`

#### Scenario: Filter persists across tab switches

- **WHEN** the user has applied a Structured filter on `public.users` and clicks a different tab
- **AND** the user clicks back to the `public.users` tab
- **THEN** both the filter bar `draft` and the `applied` filter are restored exactly as they were
- **AND** the data grid reflects the restored `applied` filter (no spurious empty-filter fetch is visible)

#### Scenario: Filter persists across tab close + reopen

- **WHEN** the user has applied a filter on `public.users`, closes that tab, and reopens `public.users` from the schema browser
- **THEN** the filter bar shows the previously applied filter as both `draft` and `applied`

#### Scenario: Filter persists across app restart

- **WHEN** the user has applied a filter on `public.users` and quits Argus
- **AND** the user re-launches Argus and opens `public.users`
- **THEN** the filter bar shows the previously applied filter as both `draft` and `applied`

#### Scenario: Mid-edit draft persists on tab switch

- **WHEN** the user has typed a partial value into a filter row but has NOT pressed Apply, and switches tabs
- **AND** the user returns to the table's tab
- **THEN** the unapplied draft is preserved exactly (including the dirty indicator showing draft ≠ applied)

#### Scenario: Reset clears the persisted filter

- **WHEN** the user has applied filters and clicks `Reset` in the filter bar
- **THEN** both `draft` and `applied` become empty
- **AND** the next time the user reopens that table the filter is still empty (the persisted record was cleared)

#### Scenario: BottomBar Clear filters clears the persisted filter

- **WHEN** the user has applied filters and clicks the bottom bar's `Clear filters` chip
- **THEN** both `draft` and `applied` become empty and the persisted record is cleared

#### Scenario: Filter is per connection

- **WHEN** the user has applied a filter for `connectionA.public.users` and opens `connectionB.public.users`
- **THEN** `connectionB.public.users` shows the empty filter model, not `connectionA`'s filter

#### Scenario: Schema drift surfaces a Postgres error and does not auto-clear

- **WHEN** the persisted filter references a column that no longer exists in the relation
- **AND** the user opens that table
- **THEN** the data grid surfaces an `AppError::Postgres` (e.g. `42703 undefined_column`) through the existing error UX
- **AND** the persisted filter is unchanged (the user can choose to `Reset` or to fix the predicate)

### Requirement: Per-table sort persistence

The frontend SHALL persist the table viewer's `orderBy` per `(connectionId, schema, relation)` tuple under the settings key `pgTableOrder:<connectionId>:<schema>:<relation>` (a JSON array of `{ column, direction }`). When unset, the order MUST default to the empty array (the relation's natural row order).

The persisted sort MUST survive the same lifecycle events as the persisted filter (tab switches, tab close/reopen, app restarts). The persisted sort MUST be cleared only by the same explicit user gestures that change it: clicking a column header to cycle sort, or removing a sort via the existing sort UX. There is no separate "reset sort" affordance — the user's existing column-header gesture is the manual control.

The setting MUST be scoped per connection — two connections inspecting the same `<schema>.<relation>` MUST NOT share sort state.

#### Scenario: Default sort is empty

- **WHEN** the user opens a table tab for the first time and no setting is stored
- **THEN** the issued SQL contains no `ORDER BY` clause

#### Scenario: Sort persists across tab switches and restarts

- **WHEN** the user sets `order_by: [{ column: "created_at", direction: "desc" }]` on `public.users` and switches tabs
- **AND** the user returns (or quits Argus and relaunches and reopens the table)
- **THEN** the same `order_by` is restored and the issued SQL contains `ORDER BY "created_at" DESC`

#### Scenario: Sort is per connection

- **WHEN** the user has `created_at desc` on `connectionA.public.users` and opens `connectionB.public.users`
- **THEN** `connectionB.public.users` issues SQL with no `ORDER BY` clause
