## Why

In the Postgres data-grid filter bar, plain `Enter` currently runs **Apply All**, which commits only the rows whose `enabled` checkbox is on. When a user types a brand-new filter into a row whose checkbox is still off (e.g. `email Contains e2e+`) and presses `Enter`, that row is silently ignored and the grid keeps showing the previously-applied filter (e.g. `id = 255`). This contradicts the user's mental model — borrowed from TablePlus — where pressing `Enter` on a row applies *that* row immediately. The feedback (issue #198) is that filters can't be built one at a time without fiddling with checkboxes.

## What Changes

- **Plain `Enter`** inside the filter bar now **applies only the focused row** — it commits exactly that single row to `applied` (replacing the active filter), regardless of the row's `enabled` checkbox. This mirrors the existing per-row `Apply` button (`onApplyOnlyRow`).
- **`Shift+Enter`** now runs **Apply All** (commit all `enabled` + complete rows using the current `draft.combinator`) — taking over the role plain `Enter` had.
- `⌘↵` (Apply All AND) and `⇧⌘↵` (Apply All OR) are **unchanged**.
- The `In` / `NotIn` chip-input exception is **preserved**: while focus is in a chip input with non-empty draft text, `Enter` commits the chip instead of applying.
- The `enabled` checkbox keeps its current **pure-gate** semantics: `Enter` does NOT toggle it; it only governs which rows participate in Apply All (Shift+Enter / ⌘↵ / ⇧⌘↵).
- The filter-bar footer **shortcut hint strip** and the per-row Apply button **tooltip** are updated to document the new `Enter` / `Shift+Enter` shortcuts.

Non-goals: MySQL and MSSQL have their own separate `FilterBar` components and are out of scope for this change (potential follow-up). No backend or wire-contract changes.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `postgres-data-grid`: the filter-bar keyboard contract changes — plain `Enter` applies only the focused row (replacing the active filter) instead of running Apply All; `Shift+Enter` now performs Apply All using the current combinator; `⌘↵` / `⇧⌘↵` are unchanged; the chip-input Enter exception and the `enabled`-checkbox gate semantics are preserved; the footer hint strip documents the new shortcuts.

## Impact

- `packages/app/src/modules/postgres/data/filter-bar/FilterBar.tsx` — keydown handler (`onKeyDown`): rewrite the plain-`Enter` branch to resolve the focused row index and call `onApplyOnlyRow(index)`; add a `Shift+Enter` (no-meta) branch that calls `handleApplyAll()`; preserve the chip-input guard for both.
- `packages/app/src/modules/postgres/data/filter-bar/FilterBar.tsx` (footer JSX) — update the shortcut hint strip to include `Apply row: ↵` and `Apply All: ⇧↵`.
- `packages/app/src/modules/shared/filter-bar/RowApplyButton.tsx` — tooltip copy may reference the `Enter` shortcut (optional polish).
- `packages/app/src/modules/postgres/data/filter-bar/FilterBar.test.tsx` — update/add keyboard tests: plain `Enter` → `onApplyOnlyRow(focusedIndex)`; `Shift+Enter` → `onApplyAll`; chip-input `Enter` still suppressed.
- No changes to `TableViewerTab` handlers (`onApplyFilters`, `onApplyOnlyRow` already implement the required semantics), `types.ts`, `treeMutations.ts`, or any Rust/IPC code.
