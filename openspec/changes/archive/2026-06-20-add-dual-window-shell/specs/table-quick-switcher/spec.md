## MODIFIED Requirements

### Requirement: Quick-switcher open and dismiss

The Workspace SHALL provide a dedicated table quick-switcher palette, distinct from the command palette, that opens with the ⌘P hotkey **scoped to the focused connection** and with the ⌥⌘P hotkey **scoped to all open connections**, and dismisses on Escape, click outside the panel, or after activating an entry. While open, the switcher MUST trap focus and return focus to the previously focused element on dismiss. The switcher MUST NOT be open at the same time as the command palette; opening one MUST close the other. The switcher MUST surface its current scope (focused connection vs. all open connections) so the user can tell which set is being searched.

#### Scenario: Opening with ⌘P (focused scope)

- **WHEN** the user presses ⌘P with the Workspace focused
- **THEN** the table quick-switcher appears with a focused search input, scoped to the focused connection
- **AND** the command palette, if it was open, closes

#### Scenario: Opening with ⌥⌘P (all-open scope)

- **WHEN** the user presses ⌥⌘P with the Workspace focused
- **THEN** the table quick-switcher appears scoped to all open connections
- **AND** the panel indicates the all-open scope

#### Scenario: Dismissing with Escape

- **WHEN** the table quick-switcher is open and the user presses Escape
- **THEN** the switcher closes and focus returns to the element that was focused before opening

#### Scenario: Dismissing by clicking outside

- **WHEN** the table quick-switcher is open and the user clicks on the backdrop area
- **THEN** the switcher closes

#### Scenario: Mutual exclusion with command palette

- **WHEN** the command palette is open and the user presses ⌘P
- **THEN** the command palette closes and the table quick-switcher opens

### Requirement: Index of relations across active connections

The switcher SHALL list, as searchable entries, every relation of kind `table`, `view`, or `materialized-view` that is present in the in-memory schema cache for the connections in its **active scope**, excluding any relation whose schema is a Postgres system schema (`information_schema` or any name starting with `pg_`, including the per-session `pg_temp_*` and `pg_toast_temp_*` schemas). When the scope is **focused connection**, the active scope is exactly the focused connection; when the scope is **all open connections**, the active scope is every currently-open connection. Relations from connections outside the active scope MUST NOT appear. When the active scope changes, a connection opens or closes, or the cache receives new relations, the visible list MUST update reactively without requiring the user to close and reopen the switcher.

#### Scenario: Focused scope lists only the focused connection

- **WHEN** connections A and B are open with A focused, A has cached relations `public.users` and `reporting.weekly_kpis`, and B has cached relations
- **AND** the user opens the switcher with ⌘P
- **THEN** only A's relations appear; none of B's relations appear

#### Scenario: All-open scope lists every open connection

- **WHEN** connections A and B are open, each with cached relations
- **AND** the user opens the switcher with ⌥⌘P
- **THEN** relations from both A and B appear

#### Scenario: Excluding connections outside the scope

- **WHEN** a connection that previously contributed entries leaves the active scope (focus changes, or it is closed)
- **AND** the switcher is open
- **THEN** all entries belonging to that connection disappear from the list

#### Scenario: Excluding non-relation objects

- **WHEN** the schema cache contains functions, sequences, indexes, or triggers for the scoped connection(s)
- **AND** the user opens the switcher
- **THEN** none of those objects appear in the list

#### Scenario: Excluding system schemas

- **WHEN** the scoped connection's cache contains relations under `pg_catalog`, `pg_toast`, `information_schema`, or any `pg_temp_*` / `pg_toast_temp_*` schema
- **AND** the user opens the switcher
- **THEN** none of those relations appear in the list

#### Scenario: Reactive updates as cache fills

- **WHEN** the switcher is open with results from one schema visible
- **AND** a background `listRelations` call resolves for another schema within the active scope
- **THEN** the new relations appear in the list without further user interaction
