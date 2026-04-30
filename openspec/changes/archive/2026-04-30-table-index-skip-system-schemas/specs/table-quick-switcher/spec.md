## MODIFIED Requirements

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
