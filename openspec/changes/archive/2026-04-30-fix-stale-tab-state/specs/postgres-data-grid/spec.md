## ADDED Requirements

### Requirement: Per-relation state isolation across tab switches

When the same `TableViewerTab` React instance is rendered with a different `(connectionId, schema, relation)` triple — which happens when the user switches between two open `postgres-table-data` tabs of different relations, since `TabContent` reuses the renderer instance — the bar's `draft`, `applied`, and `orderBy` MUST reflect the *new* triple's persisted state on first paint, NOT the previous triple's state.

The persistence pipeline (`useSetting` and the hooks built on it) MUST detect the key change synchronously during render and re-derive `value` and `isLoaded` from the per-key memory cache (or default) before the render commits. No setter call is required to refresh the value; the change of arguments alone MUST be sufficient.

#### Scenario: Switching between two open table tabs shows the correct filter

- **WHEN** the user has table A and table B open as separate `postgres-table-data` tabs
- **AND** table A has applied filter X persisted, table B has applied filter Y persisted
- **AND** the user switches from tab A to tab B
- **THEN** on the first paint after the switch the filter bar shows filter Y, not filter X

#### Scenario: Switching between two open tabs shows the correct sort

- **WHEN** the user has tab A (orderBy `[created_at desc]`) and tab B (orderBy `[]`) open
- **AND** the user switches from tab A to tab B
- **THEN** the data grid issues SQL with no `ORDER BY` clause for tab B; tab A's sort does not bleed

#### Scenario: Returning to the original tab restores its filter

- **WHEN** the user switches from tab A (filter X) to tab B (filter Y) and back to tab A
- **THEN** the filter bar on tab A shows filter X again

#### Scenario: First paint of the new tab is not stale

- **WHEN** the user switches between two open table tabs
- **THEN** there is no frame in which the filter bar shows the previous tab's filter
- **AND** the data grid does NOT issue a `queryTable` call with the previous tab's `applied` filter against the new tab's relation
