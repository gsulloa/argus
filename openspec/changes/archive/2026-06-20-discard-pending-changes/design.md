## Context

Issue #148 asks for a clear way to discard pending (uncommitted) edits, with: pending changes shown visibly, the ability to discard before refresh/context-switch, and confirmation before losing unsaved work — mirroring TablePlus, which confirms before discarding edits on refresh.

The codebase already has most of the pieces:

- **SQL engines (Postgres / MySQL / MSSQL)** share `useEditBuffer` (`modules/postgres/data/useEditBuffer.ts`, re-exported by mysql/mssql). It exposes `hasDirty`, `dirtyCounts { updates, inserts, deletes }`, `clear()`, and `undo()`. A `DiscardChangesDialog` (`modules/postgres/data/DiscardChangesDialog.tsx`) already exists and is wired into the **tab-close** path via `useCloseConfirm`. Dirty state is surfaced to the disconnect flow via `useDirtySummary`. MySQL/MSSQL already show a pending count in the toolbar; Postgres shows an Apply button.
- **DynamoDB** uses `useUnsavedDraft` (3 booleans) + its own `edit/DiscardChangesDialog.tsx` with a `context` prop ("close the tab" / "switch tabs"), wired into close/switch/row-change guards in `DataViewTab.tsx`.

The single consistent gap: the **refresh/reload action drops pending edits silently**. In all three SQL `TableViewerTab.tsx` files the `⌘R` handler (and reload button) calls reload/`refresh()` directly with no `hasDirty` check; DynamoDB's `⌘R` / `⌘⇧R` likewise refresh without consulting `useUnsavedDraft`. There is also no always-visible explicit "Discard" button on the SQL grids (discarding currently requires closing the tab or pressing ⌘Z repeatedly).

## Goals / Non-Goals

**Goals:**
- Refresh/reload (⌘R, hard-refresh ⌘⇧R, reload button) MUST prompt for confirmation when there are pending edits, on all four engines.
- Cancel preserves the buffer and aborts the refresh; Confirm discards the buffer and proceeds with the refresh. Clean buffer → refresh with no dialog (unchanged).
- An always-visible, consistent **Discard** affordance with a pending-edit count in the SQL data-grid toolbars.
- Reuse the existing dialogs and buffer APIs — no new backend work, no edit-buffer model changes.

**Non-Goals:**
- No changes to the apply/commit flow, Tauri commands, or `applyTableEdits`.
- No new undo semantics beyond the existing `⌘Z` stack.
- No persistence of pending edits across refresh (confirm = discard, as TablePlus does); a "save then refresh" combined action is out of scope.
- CloudWatch / Athena (no inline-edit data grid) are unaffected.

## Decisions

### Decision 1: Reuse the existing DiscardChangesDialog with a `context` label, not a new component
The DynamoDB dialog already accepts a `context` string ("refresh the table"). For SQL engines, the Postgres `DiscardChangesDialog` takes a `count`; we extend its copy to convey the action ("Discard N changes and refresh?"). We keep a single dialog per module rather than introducing a shared primitive in this change — consolidating SQL + Dynamo dialogs is a worthwhile follow-up but would widen the blast radius here.
- *Alternative considered:* build one cross-engine confirm primitive now. Rejected: larger diff, touches DESIGN-governed styling across modules; not required to close #148.

### Decision 2: Gate the refresh action behind a pending-state check at the handler level
Wrap each engine's existing refresh trigger (⌘R keyboard handler, hard-refresh, and the reload button `onClick`) so that when `hasDirty` (SQL) / `hasUnsavedDraft` (Dynamo) is true, it opens the confirm dialog instead of refreshing. Confirm runs `clear()` (SQL) / draft-reset (Dynamo) then the original refresh. This mirrors the existing `useCloseConfirm` pattern (intercept → dialog → proceed/cancel), keeping behavior uniform with tab-close.
- *Alternative considered:* route refresh through `useCloseConfirm`-style registry. Rejected: refresh is in-tab and synchronous; a local dialog-state + handler is simpler and matches how close-confirm already calls into the buffer.

### Decision 3: SQL toolbar gains a Discard button next to the pending count
Render a Discard button whenever `hasDirty`, showing `dirtyCounts` totals (e.g. "3 pending"). Clicking it opens the same confirm dialog; Confirm runs `buffer.clear()` (no refresh needed — discard returns the grid to server values already held). This satisfies "mostrar cambios pendientes de forma visible" + "permitir descartarlos" without forcing a tab close. Styling follows `DESIGN.md`: neutral/ghost button for Discard, `--danger` for the destructive confirm action in the dialog.

### Decision 4: Extend the DynamoDB "Unsaved-draft guard" requirement rather than add a parallel one
The refresh case is conceptually identical to the close/switch cases already enumerated in that requirement, so we add refresh (⌘R / ⌘⇧R) to the same requirement and add a scenario. The credential-refresh "preserve silently" carve-out is unchanged and must still hold (a background credential refresh is not a user refresh action).

## Risks / Trade-offs

- **Risk: a confirm-on-refresh becomes annoying for power users who refresh constantly.** → The dialog only appears when the buffer is dirty; clean refresh is untouched. ⌘Z undo and the explicit Discard button give fast escape hatches.
- **Risk: divergence between the three SQL `TableViewerTab.tsx` implementations.** → Keep the guard logic identical (same dialog copy, same handler shape) across the three; cover with parallel tests in each module's `__tests__/TableViewerTab.test.tsx`.
- **Risk: DynamoDB hard-refresh (⌘⇧R) path differs from soft refresh.** → Guard both the soft (⌘R) and hard (⌘⇧R) refresh entry points; add a scenario asserting the hard-refresh also prompts.
- **Trade-off: confirm = discard (no "save and refresh").** → Matches TablePlus and issue intent; keeps the dialog binary. A combined save+refresh can be a later enhancement.

## Migration Plan

Pure additive frontend behavior; no data migration, no backend changes. Ships behind no flag. Rollback = revert the frontend diff. No persisted state is affected.

## Open Questions

- Should the SQL pending-count/Discard control live in the existing toolbar row or share space with the Apply button? (Lean: same row, Discard adjacent to Apply, only visible when dirty.) Resolve during implementation against `DESIGN.md` / `design/preview.html`.
