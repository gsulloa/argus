## Why

Double-clicking a data-grid cell to enter edit mode and then clicking away (or
pressing Enter/Tab) without changing the value leaves the cell highlighted with
the yellow dirty-state background — the same treatment used for cells with real
pending changes. This makes it impossible to tell which cells were genuinely
edited from those that were only focused, defeating the purpose of the dirty
highlight (issue #245, reported via in-app feedback on Postgres).

The root cause is a type-coercion mismatch: the inline editor coerces the raw
input string into a typed `EditValue` on commit (numeric/decimal/bigint columns
— which the backend returns as strings to preserve precision — become JS
`number`s; JSON/JSONB text gets re-canonicalized). The edit buffer's
"drop the edit if it equals the original" guard compares with `JSON.stringify`
equality, so `"42"` (server) vs `42` (coerced) no longer match and the untouched
cell is stored as a dirty entry. The bug is shared across Postgres, MySQL, and
MSSQL because all three re-use the same edit buffer.

## What Changes

- The inline cell editor MUST NOT commit an edit when the editor content was
  never modified from the value it opened with. Entering and leaving edit mode
  (double-click → blur / Enter / Tab) on an unchanged cell becomes a no-op that
  leaves the buffer — and therefore the dirty highlight — untouched.
- The edit buffer's "collapse an edit that equals the original" guard becomes
  type-tolerant so a value round-tripped through the editor's type coercion
  (numeric string ↔ number, canonicalized JSON) still compares equal to the
  server value and is dropped from the buffer. This hardens the revert-to-original
  path against the same class of false positives.
- Applied consistently to the Postgres, MySQL, and MSSQL data grids (they share
  the buffer; each has its own inline editor).

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `postgres-data-grid`: refine the editable-mode dirty-highlight requirement so
  entering edit mode without changing a cell does not create a dirty buffer entry,
  and so the buffer's drop-if-equals-original collapse is robust to the editor's
  numeric/JSON type coercion.
- `mysql-data-grid`: same refinement for the MySQL data grid's editable mode.
- `mssql-data-grid`: same refinement for the MSSQL data grid's editable mode.

## Impact

- Frontend only; no backend, schema, or API changes.
- Inline editors: `packages/app/src/modules/{postgres,mysql,mssql}/data/EditableCell.tsx`.
- Shared edit buffer: `packages/app/src/modules/postgres/data/useEditBuffer.ts`
  (`cellEquals`), re-exported by the MySQL and MSSQL modules.
- Tests: `useEditBuffer.test.ts` and the per-engine `EditableCell` test suites.
- No visual/token changes — the dirty (`--warning`) and active-cell (`--accent`)
  styling stay as-is; only *when* the dirty state is applied changes.
