## MODIFIED Requirements

### Requirement: Per-tab structure cache

The frontend SHALL cache the response of `postgres_table_structure` on the `TableViewerTab` instance for the lifetime of the tab AND for the lifetime of a single `(connectionId, schema, relation)` triple. The cache MUST be populated on first successful response and replaced atomically on every subsequent successful Refresh. The cache MUST NOT be shared across tabs — two `postgres-table-data` tabs of the same `(connectionId, schema, relation)` MUST each have their own independent cache.

The cache MUST be keyed on `(connectionId, schema, relation)`. When the same `useTableStructureCache` invocation is rerun with a different triple — which happens when the user switches between two open `postgres-table-data` tabs, since `TabContent` reuses the same `TableViewerTab` component instance across tabs — the hook MUST detect the change synchronously during render, reset its state to `{ status: "idle", response: null, error: null }`, and clear the in-flight promise reference. The next render MUST NOT show the previous triple's `response` or `error`, and a follow-up `ensureLoaded` MUST dispatch a fresh `postgres_table_structure` call against the new triple, not return the previous triple's stale promise.

A `postgres_table_structure` response that started before a triple change MUST NOT update the cache after the triple change. The hook MUST track an internal generation counter that increments on every triple change, capture it at the start of each dispatch, and discard the response if the generation has advanced when the response resolves.

When a fetch is in flight and a second activation of Structure or Raw occurs against the *same* triple, no second fetch MUST be dispatched; both subtabs MUST share the in-flight promise.

#### Scenario: Two tabs of the same relation have independent caches

- **WHEN** the user has tab A and tab B open on `public.users` (two separate `postgres-table-data` tabs)
- **AND** the user clicks Refresh on tab A
- **THEN** tab A's cache is replaced
- **AND** tab B's cache is unchanged

#### Scenario: Concurrent Structure + Raw activation deduplicates the fetch

- **WHEN** the user clicks Structure (which triggers a fetch) and immediately clicks Raw before the fetch resolves
- **THEN** only one `postgres_table_structure` call is dispatched
- **AND** both subtabs render from the same response when it resolves

#### Scenario: Switching to a different table tab clears stale Structure / Raw

- **WHEN** the user has loaded the Structure subtab on tab A (`public.orders`) — its cache is `ready` with `response_A`
- **AND** the user switches to tab B (`public.customers`) and clicks the Structure subtab
- **THEN** the Structure subtab on tab B does NOT render `response_A`
- **AND** a fresh `postgres_table_structure` call is dispatched for `public.customers`
- **AND** the loading state is shown until the response for `public.customers` resolves

#### Scenario: Switching tabs while a fetch is in flight does not poison the new tab's cache

- **WHEN** the user clicks Structure on tab A (`public.orders`), a `postgres_table_structure` call starts but has not resolved
- **AND** the user switches to tab B (`public.customers`) and clicks Structure before tab A's fetch resolves
- **THEN** tab A's pending response, when it eventually resolves, MUST NOT be written into the cache
- **AND** a fresh fetch is dispatched for `public.customers`
- **AND** tab B's cache only ever holds `response_B`

#### Scenario: Returning to the original tab does not refetch when its triple is unchanged

- **WHEN** the user switches from tab A to tab B and then back to tab A
- **AND** the cache for tab A's triple is still `ready` with the previously loaded response
- **THEN** no new `postgres_table_structure` call is dispatched for tab A
- **AND** the Structure / Raw subtabs render the previously loaded response immediately
