## ADDED Requirements

### Requirement: Table viewer tab state survives tab switches without refetch

A `postgres-table-data` tab SHALL retain its full in-memory state across any sequence of tab activations and deactivations within the same app session. The retained state MUST include:

- The fetched row buffer (every page loaded so far) and pagination cursor.
- The columns metadata returned by the most recent successful `postgres_query_table`.
- The selected row index (if any) and the inspector panel state.
- The unsaved edit buffer (pending row edits not yet applied).
- The active sub-tab (Data / Structure / Raw) and the data-grid scroll position.
- The filter "draft" state in the filter bar (text not yet applied) and any local UI state (column widths, inspector width).

Switching away from the tab and back MUST NOT dispatch any `postgres_query_table` or `postgres_count_table` invocation. The activity log MUST NOT show new `query_table` or `count_table` events as a result of tab activation alone.

A refetch of the first page MAY only be triggered by:
- A change to one of the query inputs that already resets the data buffer per the existing reset rules — applied filter, order-by, or page size.
- An explicit user-initiated refresh affordance (if/when one exists).
- The very first time the tab is rendered after being opened (the initial load).

Closing the tab MUST discard all retained state for that tab. Reopening the same `(connectionId, schema, relation)` afterward MUST behave as a fresh first-time open (fresh fetch, no carry-over from the previously closed tab).

#### Scenario: Returning to a table tab shows the same rows with no new fetch

- **WHEN** the user opens `public.users`, scrolls partway down the data grid, selects row 17, switches to another tab, then switches back to `public.users`
- **THEN** the data grid shows exactly the same rows as before
- **AND** the scroll position is preserved
- **AND** row 17 is still the selected row
- **AND** no new `postgres_query_table` event appears in the activity log between deactivation and reactivation

#### Scenario: Unsaved edits survive a tab switch

- **WHEN** the user edits a cell in `public.users` without applying, switches to another tab, then switches back
- **THEN** the edited cell still shows the pending value with its "dirty" indicator
- **AND** the global edit-buffer indicator still reflects the unsaved change

#### Scenario: Applying a filter still refetches

- **WHEN** the user is on a returned-to table tab and applies a new filter
- **THEN** a fresh `postgres_query_table` is dispatched per the existing reset rules
- **AND** the row buffer is replaced with the new result

#### Scenario: Many tabs open, switching cycles without IPC

- **WHEN** five different table tabs are open and the user cycles ⌃Tab through all of them
- **THEN** zero `postgres_query_table` or `postgres_count_table` events are emitted during the cycle
- **AND** each tab shows its previously loaded rows on activation

#### Scenario: Closing and reopening a table tab refetches

- **WHEN** the user closes the `public.users` tab and then reopens `public.users` from the schema browser
- **THEN** a fresh `postgres_query_table` is dispatched (first-time-open behavior)
- **AND** the previously-loaded rows from the closed tab are NOT used

#### Scenario: Hidden table tab does not respond to keyboard shortcuts

- **WHEN** two table tabs A and B are open, B is active, and the user presses `Cmd+2` to activate the Structure subtab
- **THEN** only tab B's Structure subtab activates
- **AND** tab A's Structure subtab is unchanged
