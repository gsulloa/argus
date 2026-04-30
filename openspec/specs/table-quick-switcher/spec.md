# table-quick-switcher Specification

## Purpose
TBD - created by archiving change table-quick-switcher. Update Purpose after archive.
## Requirements
### Requirement: Quick-switcher open and dismiss

The application SHALL provide a dedicated table quick-switcher palette, distinct from the command palette, that opens with the ⌘P hotkey and dismisses on Escape, click outside the panel, or after activating an entry. While open, the switcher MUST trap focus and return focus to the previously focused element on dismiss. The switcher MUST NOT be open at the same time as the command palette; opening one MUST close the other.

#### Scenario: Opening with ⌘P

- **WHEN** the user presses ⌘P with the application focused
- **THEN** the table quick-switcher appears with a focused search input
- **AND** the command palette, if it was open, closes

#### Scenario: Dismissing with Escape

- **WHEN** the table quick-switcher is open and the user presses Escape
- **THEN** the switcher closes and focus returns to the element that was focused before opening

#### Scenario: Dismissing by clicking outside

- **WHEN** the table quick-switcher is open and the user clicks on the backdrop area
- **THEN** the switcher closes

#### Scenario: Mutual exclusion with command palette

- **WHEN** the command palette is open and the user presses ⌘P
- **THEN** the command palette closes and the table quick-switcher opens

### Requirement: Visual parity with command palette

The table quick-switcher SHALL render with the same overlay scaffold, surface, border, radius, shadow, typography, and selection styling as the command palette so the two affordances feel like siblings of one design system.

#### Scenario: Matching surface tokens

- **WHEN** the user opens the table quick-switcher
- **THEN** the panel uses the same `--surface`, `--border`, radius, shadow, and centered placement as the command palette

#### Scenario: Matching keyboard navigation

- **WHEN** the user presses ↑ / ↓ inside the switcher
- **THEN** the highlighted row moves between entries with the same visual treatment used by the command palette's selected item

### Requirement: Index of relations across active connections

The switcher SHALL list, as searchable entries, every relation of kind `table`, `view`, or `materialized-view` that is present in the in-memory schema cache for any currently active Postgres connection, **excluding any relation whose schema is a Postgres system schema** (`information_schema` or any name starting with `pg_`, including the per-session `pg_temp_*` and `pg_toast_temp_*` schemas). Relations from connections that are not currently active MUST NOT appear. When a connection becomes active or inactive, or when the cache receives new relations, the visible list MUST update reactively without requiring the user to close and reopen the switcher.

#### Scenario: Listing relations from one active connection

- **WHEN** an active connection has cached relations `public.users` (table) and `reporting.weekly_kpis` (view)
- **AND** the user opens the switcher
- **THEN** both entries appear in the list

#### Scenario: Excluding inactive connections

- **WHEN** a connection that previously contributed entries becomes inactive (disconnected)
- **AND** the switcher is open
- **THEN** all entries belonging to that connection disappear from the list

#### Scenario: Excluding non-relation objects

- **WHEN** the schema cache contains functions, sequences, indexes, or triggers
- **AND** the user opens the switcher
- **THEN** none of those objects appear in the list

#### Scenario: Excluding system schemas

- **WHEN** the schema cache contains relations under `pg_catalog`, `pg_toast`, `information_schema`, or any `pg_temp_*` / `pg_toast_temp_*` schema
- **AND** the user opens the switcher
- **THEN** none of those relations appear in the list

#### Scenario: Reactive updates as cache fills

- **WHEN** the switcher is open with results from one schema visible
- **AND** a background `listRelations` call resolves for another schema
- **THEN** the new relations appear in the list without further user interaction

### Requirement: Eager relation loading on first open

The first time the switcher mounts in a session, it SHALL trigger `listRelations` for every (active connection, schema) pair where the schema is known to the cache, **the schema is not a Postgres system schema** (`information_schema` or any name starting with `pg_`, including the per-session `pg_temp_*` and `pg_toast_temp_*` schemas), and the schema's relations are not yet loaded. Calls MUST be deduplicated against in-flight requests so the same (connection, schema) is not fetched more than once concurrently. The switcher MUST NOT block on these calls — partial results render immediately and stream in as fetches resolve. The switcher MUST NOT trigger eager loading of column data; column fetches remain governed by their existing lazy/bulk pathway.

#### Scenario: Schemas known but relations not loaded

- **WHEN** an active connection has cached schemas `public` and `auth` but no cached relations for either
- **AND** the user opens the switcher for the first time in the session
- **THEN** the switcher fires `listRelations` for `(connection, public)` and `(connection, auth)` in parallel

#### Scenario: System schemas are not eager-loaded

- **WHEN** an active connection has cached schemas including `public`, `pg_catalog`, `pg_toast`, `information_schema`, and many `pg_temp_*` entries
- **AND** the user opens the switcher for the first time in the session
- **THEN** the switcher fires `listRelations` only for `(connection, public)` and not for any `pg_*` or `information_schema` schema

#### Scenario: Avoiding duplicate fan-out

- **WHEN** an eager `listRelations` for `(connection, public)` is already in flight
- **AND** the switcher mounts and would otherwise request the same pair
- **THEN** no second request is issued

#### Scenario: Schemas not yet loaded

- **WHEN** an active connection has not had its schema list loaded (the user has never browsed it)
- **AND** the user opens the switcher
- **THEN** that connection contributes no entries and the switcher does not call `listSchemas` on its behalf

### Requirement: Fuzzy search across schema, name, and connection

When the user types in the search input, the visible entries SHALL be filtered by case-insensitive fuzzy match against `schema`, relation `name`, the combined `schema.name` form, and the connection display name. Results MUST be ordered by match quality (better matches first).

#### Scenario: Matching by relation name

- **WHEN** entries include `public.users` and `auth.sessions` and the user types `usr`
- **THEN** `public.users` ranks at or near the top of the filtered list

#### Scenario: Matching by schema-qualified name

- **WHEN** entries include `auth.users` and `public.users` and the user types `auth.us`
- **THEN** `auth.users` is visible and ranks higher than `public.users`

#### Scenario: Matching by connection name

- **WHEN** entries from connections `supabase-prod` and `supabase-staging` are listed and the user types `staging`
- **THEN** only entries from the `supabase-staging` connection remain visible

### Requirement: Entry display

Each entry SHALL display a single-character kind glyph (`T` for table, `V` for view, `M` for materialized view), the relation in `schema.name` form as the primary label, and the connection display name as a secondary label. The connection name MUST always be shown, regardless of whether multiple connections are active.

#### Scenario: Rendering a table entry

- **WHEN** the switcher renders the table `public.orders` from connection `supabase-prod`
- **THEN** the row shows `T`, then `public.orders`, then `supabase-prod`

#### Scenario: Rendering a view entry

- **WHEN** the switcher renders the view `reporting.weekly_kpis` from connection `stripe-staging`
- **THEN** the row shows `V`, then `reporting.weekly_kpis`, then `stripe-staging`

#### Scenario: Rendering a materialized view entry

- **WHEN** the switcher renders the materialized view `public.daily_metrics` from connection `supabase-prod`
- **THEN** the row shows `M`, then `public.daily_metrics`, then `supabase-prod`

#### Scenario: Connection always visible with single connection

- **WHEN** only one connection is active and contributing entries
- **THEN** rows still display the connection name as a secondary label

### Requirement: Recently opened relations

The switcher SHALL maintain a list of recently opened relations, populated only by selections made through the switcher itself, capped at 10 entries, persisted across application restarts in `localStorage`. Recents MUST appear in their own group at the top of the list when the search input is empty. Recent entries whose source connection is not currently active MUST be hidden from the rendered list (without being removed from storage). Selecting a relation that is already in the recents list MUST move it to the top rather than create a duplicate.

#### Scenario: Recording a recent on selection

- **WHEN** the user opens the switcher and activates `public.users` from `supabase-prod`
- **AND** the user reopens the switcher
- **THEN** `public.users` from `supabase-prod` appears at the top of a "Recent" group

#### Scenario: Sidebar clicks do not affect recents

- **WHEN** the user opens a relation by clicking it in the sidebar tree (not via the switcher)
- **AND** the user opens the switcher
- **THEN** that relation does not appear in the "Recent" group

#### Scenario: Capping at 10

- **WHEN** the recents list contains 10 entries and the user selects an 11th relation via the switcher
- **THEN** the oldest recent is dropped and the new selection takes the top slot

#### Scenario: Deduplication

- **WHEN** the recents list contains `public.users` from `supabase-prod` and the user selects the same relation again
- **THEN** the recents list still contains exactly one entry for `public.users` from `supabase-prod`, now at the top

#### Scenario: Persistence across restarts

- **WHEN** the user has selected `public.orders` and `auth.users` via the switcher
- **AND** the application is closed and reopened
- **THEN** both entries are present in the "Recent" group on the next switcher open

#### Scenario: Hiding recents from inactive connections

- **WHEN** the recents list contains an entry from a connection that is currently disconnected
- **AND** the user opens the switcher
- **THEN** that entry is not displayed (and is not removed from underlying storage)

#### Scenario: Hiding the Recent group while searching

- **WHEN** the user types any non-empty query into the switcher search input
- **THEN** the "Recent" group is hidden and entries are shown ungrouped (or under a single "Tables" group) sorted by match quality

### Requirement: Activation opens via the existing tab routing

Activating an entry (Enter on a highlighted row, or click) SHALL invoke the same `openObjectTab` flow used by the sidebar tree, with a payload reflecting the entry's connection, schema, name, and relation kind. The switcher MUST close before the tab routing runs. There MUST NOT be a modifier-key affordance for "open in a new tab"; activation always reuses the existing dedup behavior of the tab system.

#### Scenario: Opening a table

- **WHEN** the user activates the entry `public.users` from `supabase-prod`
- **THEN** the switcher closes
- **AND** `openObjectTab` is invoked with a payload whose `connectionId` matches `supabase-prod`, `schema` is `public`, `name` is `users`, and `kind` is `table`

#### Scenario: Refocusing an already-open tab

- **WHEN** a tab for `public.users` from `supabase-prod` is already open
- **AND** the user activates the same entry from the switcher
- **THEN** the existing tab is refocused (no new tab is created)

#### Scenario: No new-tab modifier

- **WHEN** the user holds ⌘ and presses Enter on a highlighted entry
- **THEN** the same single `openObjectTab` call occurs (no parallel tab is created)

### Requirement: Empty states

The switcher SHALL render distinct empty-state messages for three conditions: no active connections, no relations indexed yet despite active connections, and a non-empty search with no matching entries.

#### Scenario: No active connections

- **WHEN** the user opens the switcher with zero active connections
- **THEN** the panel shows a message indicating no active connections and hints that opening a connection enables table search

#### Scenario: Active connections but nothing indexed yet

- **WHEN** at least one connection is active but no relations are cached and eager loading is still in flight
- **THEN** the panel shows a "Loading tables…" indicator distinct from the no-connections state

#### Scenario: No matches for the current query

- **WHEN** the switcher has indexed entries and the user types a query that matches none of them
- **THEN** the panel shows a "No matching tables" message distinct from the other empty states

