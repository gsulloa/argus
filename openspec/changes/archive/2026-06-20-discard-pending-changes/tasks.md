## 1. Shared dialog copy

- [x] 1.1 Extend `modules/postgres/data/DiscardChangesDialog.tsx` so the dialog can render a refresh-context message ("Discard N changes and refresh?") in addition to the existing close copy, driven by a prop (e.g. `action: "close" | "refresh" | "discard"`); keep DESIGN.md tokens (`--danger` for the destructive confirm, neutral for Cancel).
- [x] 1.2 Confirm the DynamoDB `edit/DiscardChangesDialog.tsx` already accepts a `context` string suitable for "refresh the table"; if not, add it.

## 2. Postgres refresh guard + visible discard

- [x] 2.1 In `modules/postgres/data/TableViewerTab.tsx`, wrap the `⌘R` / hard-refresh / reload-button trigger: when `buffer.hasDirty`, open the discard dialog (refresh action) instead of reloading.
- [x] 2.2 On dialog Confirm → `buffer.clear()` then run the existing reload; on Cancel → close dialog, no reload. Clean buffer → reload immediately (no dialog).
- [x] 2.3 Add a toolbar pending-edit count + **Discard** button visible only when `buffer.hasDirty`, showing `dirtyCounts` total; clicking opens the discard dialog (discard action) → Confirm runs `buffer.clear()` (no reload), Cancel leaves buffer intact.

## 3. MySQL refresh guard + visible discard

- [x] 3.1 In `modules/mysql/data/TableViewerTab.tsx`, apply the same refresh guard as Postgres (2.1–2.2), reusing the shared dialog.
- [x] 3.2 Ensure the existing MySQL toolbar pending count gains a **Discard** button with the same confirm-then-`clear()` behavior (3.x mirrors 2.3).

## 4. MSSQL refresh guard + visible discard

- [x] 4.1 In `modules/mssql/data/TableViewerTab.tsx`, apply the same refresh guard as Postgres (2.1–2.2), reusing the shared dialog.
- [x] 4.2 Ensure the existing MSSQL toolbar pending count gains a **Discard** button with the same confirm-then-`clear()` behavior.

## 5. DynamoDB refresh guard

- [x] 5.1 In `modules/dynamo/data-view/DataViewTab.tsx`, gate both the soft (`⌘R`) and hard (`⌘⇧R`) refresh entry points (and the reload button) on `hasUnsavedDraft`: when true, show the existing discard dialog with a "refresh" context before refreshing.
- [x] 5.2 Confirm → reset draft state then refresh; Cancel → no refresh, draft intact. Clean state → refresh immediately. Ensure the `dynamo:credentials-refreshed` / `needs_credentials` background path still preserves drafts silently (no regression).

## 6. Tests

- [x] 6.1 Postgres: add `__tests__/TableViewerTab.test.tsx` coverage — refresh with dirty buffer shows dialog; Cancel keeps buffer + no reload; Confirm clears + reloads; clean buffer reloads with no dialog; Discard button visibility + clear behavior.
- [x] 6.2 MySQL: extend `__tests__/TableViewerTab.test.tsx` with the same four refresh scenarios + Discard button behavior.
- [x] 6.3 MSSQL: extend `__tests__/TableViewerTab.test.tsx` with the same four refresh scenarios + Discard button behavior.
- [x] 6.4 DynamoDB: extend `data-view/edit/useUnsavedDraft.test.tsx` / `DataViewTab` tests — soft + hard refresh with draft prompt confirmation; Confirm refreshes; Cancel aborts; clean refresh no dialog; credential-refresh still silent.

## 7. Verification & specs sync

- [x] 7.1 Run `pnpm -C packages/app tsc --noEmit`, `pnpm -C packages/app lint`, and the changed test suites green.
- [x] 7.2 Manually verify against `design/preview.html` / running app that the dialog and Discard button match DESIGN.md (accent/danger tokens, no decorative styling).
- [x] 7.3 After implementation, run `/opsx:archive` to sync the four `*-data-edit` delta specs into `openspec/specs/` and archive the change.
