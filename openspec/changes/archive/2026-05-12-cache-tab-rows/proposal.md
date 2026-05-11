## Why

Switching away from a table viewer tab and back triggers a full refetch of rows from Postgres, losing the user's scroll position, selected row, and edit buffer. For tables with thousands of rows or slow connections, this turns tab-switching into a multi-second wait and disrupts the inspect-and-compare workflow Argus is built around.

The root cause is that `TabContent` only mounts the active tab; inactive tabs unmount entirely, taking `useTableData`'s in-memory rows, selection, and edit buffer with them. There is no caching layer for row data (only schema/columns are cached globally).

## What Changes

- Each table viewer tab SHALL retain its fetched rows, pagination cursor, selected row index, scroll position, and unsaved edit buffer when the user switches to another tab and back, with no refetch.
- A tab SHALL only refetch when one of its query inputs changes (applied filter, order-by, page size, or an explicit user-triggered refresh).
- The retention mechanism is implementation-defined (see `design.md`) but MUST survive any number of intermediate tab switches and MUST be released when the tab is closed.
- SQL query tabs SHALL similarly retain their last result set across tab switches.
- A reopened tab (closed then re-opened to the same relation) is treated as a fresh tab — no cross-tab cache sharing in v1.
- No new user-facing UI; behavior change only.

## Capabilities

### New Capabilities
*(none)*

### Modified Capabilities
- `postgres-data-grid`: add a "tab state retention" requirement covering rows, selection, scroll, and edit buffer across tab switches; clarify that refetch is triggered only by query-input changes or explicit user action, not by tab activation.
- `postgres-sql-editor`: add a parallel retention requirement for the last query result and editor buffer across tab switches.
- `app-shell`: clarify that tab activation does not unmount inactive tab content for tab kinds that opt into state retention.

## Impact

- **Affected code**:
  - `src/platform/shell/tabs/TabContent.tsx` — render strategy for inactive tabs (mount-all + visibility toggle, or external cache).
  - `src/platform/shell/tabs/TabsContext.tsx` — close handler must release retained state.
  - `src/modules/postgres/data/TableViewerTab.tsx` and `useTableData.ts` — must not re-issue the initial fetch on remount when cached state exists.
  - `src/modules/postgres/sql/QueryTab.tsx` and `useQueryRun.ts` — must retain last result.
- **Memory**: holding row buffers for all open tabs increases memory roughly linearly with `open_tabs × page_size × row_bytes`. Page sizes are bounded; the data grid is virtualized so only the visible rows are in the DOM regardless.
- **No new dependencies**. No new IPC commands. No schema changes. No settings persistence changes (filters/sort already persist).
- **Activity log**: fewer `query_table` events emitted (only on real input changes or explicit refresh), which matches user intent.
