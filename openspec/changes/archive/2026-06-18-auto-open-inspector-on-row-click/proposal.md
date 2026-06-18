## Why

When the MySQL or MS SQL Server table viewer has its inspector panel toggled off, clicking a row selects the cell but leaves the user with no way to see the full row detail until they manually re-open the inspector. The expected flow is that clicking a row to inspect it should surface the inspector automatically. Postgres and DynamoDB already keep their inspector docked and follow the selection, so they do not exhibit the problem.

## What Changes

- When the user selects a row in the **MySQL** data grid while the inspector panel is hidden, the inspector MUST automatically become visible and show that row.
- When the user selects a row in the **MS SQL Server** data grid while the inspector panel is hidden, the inspector MUST automatically become visible and show that row.
- The auto-reveal MUST fire only on row/cell selection gestures (plain click and shift-click range extension). It MUST NOT fire on header sort clicks, column resize, scroll, or toolbar actions.
- The auto-reveal MUST NOT interrupt inline editing or alter the selection range — it only flips the panel's visibility.
- The manual `Inspector` toggle button keeps working: the user can still hide the inspector; the next row click re-opens it.
- **No change to Postgres** (its inspector is permanently docked, never hideable) and **no change to DynamoDB** (its inspector dock is always present and the spec already requires selection to focus it). This is the explicit scoping decision called for by the issue.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `mysql-data-grid`: the "Inspector panel" requirement gains an auto-reveal-on-row-selection behavior and documents the hide/show toggle it depends on.
- `mssql-data-grid`: the "Inspector panel" requirement gains the same auto-reveal-on-row-selection behavior and toggle documentation.

## Impact

- Frontend only; no backend / Tauri command changes.
- `packages/app/src/modules/mysql/data/TableViewerTab.tsx` — wire the existing `onCellSelect` callback to set `inspectorVisible(true)`.
- `packages/app/src/modules/mssql/data/TableViewerTab.tsx` — same wiring.
- The grid components (`mysql/data/DataGrid.tsx`, `mssql/data/DataGrid.tsx`) already invoke `onCellSelect` on cell clicks and on edit-start, and do **not** invoke it on header sort / resize / toolbar; no grid changes are required.
- No persistence change: auto-reveal flips in-memory `inspectorVisible` only; it does not persist a new default.
