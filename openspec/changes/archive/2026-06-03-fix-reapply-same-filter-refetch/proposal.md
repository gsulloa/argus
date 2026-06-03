## Why

Re-applying a structurally-identical filter value in a table viewer does not refetch data. Users who clear a filter input and then re-enter the same value (a natural "refresh" gesture) keep seeing stale rows — including missing rows that were created externally between the two Apply presses. The bug, surfaced as issue #54, affects Postgres, MySQL, and MSSQL data grids and erodes trust in what the grid shows.

## What Changes

- **Postgres data grid**: Pressing **Apply All**, per-row **Apply**, or **⌘↵** in the filter bar must trigger a fresh fetch even when the resulting `applied` filter model is structurally equal to the previous one. Achieved by giving `useTableData` an `applyToken` (or equivalent) input that participates in the dependency key, advanced on every Apply commit.
- **MySQL data grid**: `useTableData.refresh()` (already wired to FilterBar `onApply`) must unconditionally reset the buffer and refetch even when `filterModel` is structurally unchanged. Currently `refresh()` already dispatches `reset` then calls `fetchFirstPage`, but the `depsKey` guard in the auto-fetch effect may swallow the subsequent state if the effect re-runs. Verify and harden so a `refresh()` call always produces a network round-trip.
- **MSSQL data grid**: Same as MySQL.
- Behaviour change is invisible when filters are structurally different (already refetched today) — only the "same filter, applied again" path is affected.
- Not a breaking change: no API/spec scenarios are removed; existing scenarios remain valid.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities

- `postgres-data-grid`: Filter Apply requirements gain a scenario asserting refetch on re-applying a structurally-identical filter model.
- `mysql-data-grid`: Same scenario added for MySQL FilterBar `onApply`.
- `mssql-data-grid`: Same scenario added for MSSQL FilterBar `onApply`.

## Impact

- **Frontend code**:
  - `src/modules/postgres/data/useTableData.ts` — accept/propagate an Apply token (or expose `refresh()`) and include it in `depsKey`.
  - `src/modules/postgres/data/TableViewerTab.tsx` — bump the token in `onApplyFilters` and `onApplyOnlyRow` (around line 560).
  - `src/modules/mysql/data/useTableData.ts` — ensure `refresh()` always fetches even when `depsKey` is unchanged.
  - `src/modules/mysql/data/TableViewerTab.tsx` — confirm `onApply={tableData.refresh}` still triggers a refetch after the hook hardening.
  - `src/modules/mssql/data/useTableData.ts` and `src/modules/mssql/data/TableViewerTab.tsx` — mirror MySQL fix.
- **Backend**: No changes. Verified there is no result cache in `src-tauri/src/modules/postgres/data.rs` or the API layer.
- **Tests**: Add unit/integration coverage for "re-apply same filter triggers fetch" across the three engines.
- **No DB migrations, no schema changes, no IPC contract changes.**
- **User-visible**: Filter Apply becomes a reliable refresh gesture across all SQL engines; closes #54.
