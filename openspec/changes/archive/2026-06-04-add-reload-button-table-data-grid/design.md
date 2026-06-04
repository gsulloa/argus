## Context

The SQL table-viewer tabs (Postgres / MySQL / MSSQL) render a virtualized data grid backed by the `useTableData` hook. The hook owns paging, an applied-filter model, and the in-flight fetch state. It already supports the "refetch current page with current filters/sort/page-size" operation:

- **MySQL** (`src/modules/mysql/data/useTableData.ts:135,226`): exposes `refresh(): void` — bumps an internal token (`applyToken`) and unconditionally refetches even when the filter model is structurally equal.
- **MSSQL** (`src/modules/mssql/data/useTableData.ts:135,225`): same shape, exposes `refresh(): void`.
- **Postgres** (`src/modules/postgres/data/useTableData.ts:355`): exposes `retryFirstPage(): void` — calls `fetchFirstPage()` directly. The caller-facing `applyToken` is set by `TableViewerTab` (the `setApplyToken((t) => t + 1)` calls at the Apply/Apply-row sites) rather than inside the hook.

So MySQL/MSSQL have a symmetric `refresh()` we can wire directly. Postgres needs one extra step: bump the `applyToken` state in the tab and call the existing refetch path. We expose this combined gesture as a `refresh()` callback on the Postgres `TableViewer` (NOT inside `useTableData`, to avoid coupling the hook to the tab-owned `applyToken` state). The proposal said "expose `refresh()` on the Postgres hook", but the cleaner shape — given how `applyToken` is owned by the tab — is to define `refresh` in `TableViewerTab.tsx` as `() => { setApplyToken((t) => t + 1); }` and rely on the existing dep-key effect to refetch. That is the canonical Apply path in Postgres today (see lines 568, 575 of `TableViewerTab.tsx`).

Dynamo's existing pattern lives in `src/modules/dynamo/data-view/DataViewTab.tsx:641-683`: it uses `useShortcuts` with `whenInInput: true` and a manual `focusIsInCodeMirror()` guard. We adopt the same pattern for SQL surfaces.

The SubtabHeader (`src/modules/postgres/structure/SubtabHeader.tsx`) already hosts the Filter toggle button (data subtab only). It is the natural home for the reload control on Postgres. MySQL and MSSQL have their own header layouts (no shared SubtabHeader); they each gain a Reload button in the same visual position.

## Goals / Non-Goals

**Goals:**

- Discoverable, visible refresh control on the data subtab for all three SQL engines.
- Single keyboard shortcut (⌘R / Ctrl+R) that mirrors Dynamo's gesture.
- Disabled / spinning visual state while a first-page fetch is in flight so users don't fire concurrent refetches by mashing the button.
- Reuse the existing refetch path. Zero new Tauri commands.
- Postgres hook gains a `refresh()` method matching MySQL/MSSQL so the three engines have a uniform API surface.

**Non-Goals:**

- No auto-refresh, polling, or pull-to-refresh.
- No "reload every open tab" command.
- No changes to the filter bar, bottom bar, or grid scroll position.
- No new persisted preferences (the button is always shown; the shortcut is always armed when the tab is active).
- No changes to DynamoDB or CloudWatch surfaces.
- No backend changes.

## Decisions

**1. Reload control placement: SubtabHeader (Postgres) / existing tab header bar (MySQL, MSSQL).**

The button sits next to the Filter toggle, visible only on the Data subtab. Rationale: that header row is already a fixed-height bar of tab-scope controls, and the Filter toggle establishes the visual pattern. Putting Reload in the BottomBar was considered but rejected — the BottomBar is densely packed with paging / count / save / dirty-state, and discoverability suffers when a primary action is buried in a row of tertiary metadata. The Dynamo Toolbar pattern (top of the view) is the closer precedent.

**2. Icon: lucide `RotateCw`.**

Dynamo's Run button uses `Play`; Dynamo's Reset uses `RefreshCw`. The SQL data grid's gesture is "re-run the query without changing filters" — closer to a circular reload than a play arrow. `RotateCw` is the canonical reload glyph and disambiguates from "Reset" (used by Dynamo Reset to clear filters). Size: 13px to match the Filter toggle.

**3. Keyboard shortcut: ⌘R / Ctrl+R, `whenInInput: true`, with CodeMirror guard.**

Matches Dynamo exactly (`DataViewTab.tsx:646-658`). The browser's default ⌘R / Ctrl+R reloads the page; in Tauri this typically forces a window reload — we MUST `preventDefault()` to suppress it. The shortcut fires regardless of focus location *except* CodeMirror surfaces (where ⌘R is sometimes bound to editor actions and where the user is mid-typing). Inputs are intentionally NOT excluded — Dynamo's `whenInInput: true` is the project convention for Run shortcuts.

The Postgres tab already has a window-level `keydown` listener for ⌘S/⌘1-4/⌘Z/⌘F (`TableViewerTab.tsx:469-552`). We add ⌘R into that same handler rather than introducing a second listener, so the gating logic (`active` + root-contains-focus check) stays uniform. MySQL and MSSQL tabs use `useShortcuts` (already imported in MSSQL; needs verification for MySQL — if absent we fall back to a `keydown` listener matching Postgres).

**4. Disabled state: while first-page fetch is in flight.**

Specifically: `status === "loading-first"` or `status === "loading-first-retrying"`. The button stays enabled during `loading-next` (paging in more rows) so users can interrupt a paginated load with a fresh refetch — this matches what `refresh()` does today (it resets the buffer and refetches page 1, abandoning any in-flight next-page request via the deps-key cancellation that `useTableData` already implements).

Visual: when disabled, the icon spins (`animation: spin 1s linear infinite`). Otherwise the icon is static.

**5. Postgres `refresh()` shape: tab-level callback that bumps `applyToken`.**

The proposal originally suggested "expose `refresh()` on the hook". On re-reading the code, the hook does not own `applyToken` — that lives in `TableViewerTab.tsx:144`. Putting `refresh()` on the hook would require either (a) moving `applyToken` into the hook (a larger refactor that touches the Apply/Apply-row gesture wiring) or (b) calling `retryFirstPage()` from the hook, which short-circuits the deps-key invalidation and could race with an in-flight Apply. The clean shape is: define a tab-local `onReload` callback that does `setApplyToken((t) => t + 1)` — this is identical to the existing Apply path. The reload spec then references *behavior*, not the hook's API shape. The three tabs converge in user-visible behavior even though Postgres's internal wiring is slightly different.

> **Trade-off:** the proposal said "expose `refresh()` on the hook". We are diverging because the bigger goal — uniform API across engines — is already met at the tab/spec level. Updating the hook is a larger, riskier refactor that adds no user value. The proposal's Impact list should be read with this delta in mind.

**6. No "loading rows from refresh" indicator beyond the spinning icon.**

The grid already shows its standard loading-first overlay (`<Loader2 /> Loading table…`) when the first-page fetch is in flight. The spinning button is redundant with that overlay but provides feedback when the overlay is visually occluded (e.g. user scrolled, or focus is in the header). No need for a separate toast or banner.

## Risks / Trade-offs

- **⌘R conflicts with browser/Tauri page reload** → Mitigation: all three handlers call `e.preventDefault()` unconditionally when the gating conditions match. Tested empirically before shipping (manual: open table, press ⌘R, verify no window reload).
- **User fires ⌘R while focus is in a CodeMirror surface (e.g., raw SQL editor opened in a side panel)** → Mitigation: explicit `focused?.closest(".cm-editor")` guard, same as Dynamo and the existing ⌘F handler in Postgres.
- **Race: user clicks Reload while a row save is in flight** → The save flow already calls `data.retryFirstPage()` on success (`TableViewerTab.tsx:417`). An out-of-band Reload triggered mid-save would bump `applyToken`, the deps-key would change, and the next-page request (if any) gets cancelled by the existing `paramsKeyRef` check. The pending save's own `retryFirstPage` arrives second and refetches again. Net effect: one extra refetch on success. Acceptable.
- **Refresh during dirty edits** → The grid's edit buffer survives a refetch (`useEditBuffer` is independent of `useTableData`'s state). Inserts stay on top; pending updates/deletes still show their dirty markers. This is the same behavior as today's Apply gesture, so no new risk.
- **MySQL test coverage** → MySQL/MSSQL already have `__tests__/useTableData.refresh.test.ts` proving `refresh()` always refetches. We do NOT need to add hook-level tests for Postgres because we are not changing the hook's API; the existing Apply tests already cover `applyToken`-triggered refetches.

## Migration Plan

- Single PR, frontend only. No data migration, no schema changes, no IPC contract changes.
- Rollback: revert the PR. No persisted state to clean up.
- No feature flag — the surface is small, the change is purely additive, and the affordance is the explicit user-requested fix.

## Open Questions

(none)
