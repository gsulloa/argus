## Why

Users on the SQL table data grid (Postgres / MySQL / MSSQL) have no visible way to re-run the current query and pick up freshly written data — feedback from the field: *"No sé cómo hacer reload de la misma consulta"*. The Dynamo data view already exposes a **Run** button and **⌘R** shortcut for the same gesture; SQL editors expose **Run** (**⌘↩**) for their query. The three SQL table-viewer tabs are the only data-display surfaces in the app without an explicit refresh affordance, even though `useTableData` already exposes a `refresh()` method (MySQL/MSSQL) that unconditionally refetches the current page. Postgres has the same internal capability via `retryFirstPage()` but does not expose a `refresh()` name. Without a discoverable control, users either close and reopen the tab or twiddle a filter to force a refetch — both are painful and discoverable only by accident.

## What Changes

- **Add a Reload control to the table data grid for Postgres, MySQL, and MSSQL.** The control is a small icon button (lucide `RotateCw` / `RefreshCw`) placed in the SubtabHeader (next to the Filter toggle, Data subtab only). It is disabled while a first-page fetch is in flight and shows a spinning state during the refetch.
- **Add a ⌘R / Ctrl+R keyboard shortcut** on the active SQL table-viewer tab that triggers the same refetch. The shortcut MUST fire even when focus is inside form inputs (mirroring Dynamo's `whenInInput: true`), MUST be ignored when focus is inside a CodeMirror surface, and MUST preempt the browser's default reload action via `preventDefault()`.
- **Expose `refresh()` on the Postgres `useTableData` hook** so the three engines share a uniform API. Internally `refresh()` is an alias for the existing first-page refetch path (no change to the underlying request).
- **No new backend commands.** No new Tauri commands, no new payload shape, no new persisted state. The refetch reuses the same `queryTable` request the grid already issues.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `postgres-data-grid`: add a "User can refresh the current table query" requirement covering both the toolbar button and the ⌘R shortcut; document that `useTableData` exposes `refresh()`.
- `mysql-data-grid`: add a "User can refresh the current table query" requirement covering both the toolbar button and the ⌘R shortcut. (`refresh()` is already exposed.)
- `mssql-data-grid`: add a "User can refresh the current table query" requirement covering both the toolbar button and the ⌘R shortcut. (`refresh()` is already exposed.)

## Impact

**Affected code (frontend only):**

- `src/modules/postgres/data/useTableData.ts` — expose `refresh()` (alias of the existing first-page refetch path).
- `src/modules/postgres/data/TableViewerTab.tsx` — wire reload button into SubtabHeader, register ⌘R shortcut on the active tab.
- `src/modules/mysql/data/TableViewerTab.tsx` — wire reload button into the tab header, register ⌘R shortcut.
- `src/modules/mssql/data/TableViewerTab.tsx` — same as MySQL.
- `src/modules/postgres/structure/SubtabHeader.tsx` — accept an optional `onReload` / `reloadDisabled` / `reloading` prop (only the Postgres header takes this; MySQL/MSSQL place the button alongside their existing controls).
- `src/modules/postgres/structure/SubtabHeader.module.css` — minor style for the new icon button (matches the existing Filter toggle).

**Out of scope:**

- Auto-refresh / polling. This change is a one-shot user-initiated refresh.
- DynamoDB and CloudWatch surfaces (Dynamo already has Run+⌘R; CloudWatch is out of scope for this change).
- A "refresh all open tabs" command — not requested.
- Visual changes to the BottomBar or FilterBar layout.

**No data, network, or build impact** beyond the new icon button and one extra keyboard listener per active tab.
