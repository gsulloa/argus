## Why

`⌘S` / `Ctrl+S` does not save pending edits consistently across engines (issue #88). DynamoDB has no `⌘S` handler at all, and the three SQL engines diverge in how they detect the shortcut: Postgres uses a `window` listener gated on a focus check, while MySQL and MSSQL use an `onKeyDown` handler on the root `div`. The `onKeyDown` approach silently fails to save whenever focus has left the grid (e.g. nothing focused, or focus parked in a toolbar/inspector control), which reads as data loss to the user.

## What Changes

- Unify the `⌘S` detection across Postgres, MySQL, and MSSQL so the shortcut saves the dirty buffer whenever the data tab is **active**, regardless of where focus sits inside the tab (including when no element is focused) — without hijacking `⌘S` from other tabs/panels.
- Switch MySQL and MSSQL from the root-`div` `onKeyDown` handler to the same `window`-level, active-gated listener pattern Postgres uses, with a focus rule that does not block the save when focus is absent or outside the grid but still within the tab.
- Define and implement `⌘S` for DynamoDB: because Dynamo saves each cell immediately (no batch buffer), `⌘S` MUST commit the currently-open inline cell editor when one is active; the inspector JSON editor's existing `⌘S` → Save behavior is preserved; when no editor is open, `⌘S` is a no-op.
- Keep all existing no-op-when-clean, read-only-disabled, and error-banner behaviors intact.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `postgres-data-edit`: Clarify the Direct save flow so `⌘S` fires whenever the table tab is active and focus is anywhere within the tab or absent (not only when a grid descendant holds focus).
- `mysql-data-edit`: Replace the root-`div` `onKeyDown` `⌘S` detection with the active-gated `window` listener so focus position no longer blocks saving.
- `mssql-data-edit`: Same `⌘S` detection change as MySQL.
- `dynamo-data-edit`: Add a `⌘S` behavior that commits the active inline cell editor (and preserves the inspector editor's `⌘S` → Save), making save behavior uniform with the SQL engines given Dynamo's immediate-save model.

## Impact

- Frontend only; no Rust command or API changes.
- `src/modules/postgres/data/TableViewerTab.tsx` (~L473–563): focus-rule adjustment.
- `src/modules/mysql/data/TableViewerTab.tsx` (~L318–365): move `⌘S` off `onKeyDown` to a `window` listener.
- `src/modules/mssql/data/TableViewerTab.tsx` (~L356–407): same as MySQL.
- `src/modules/dynamo/data-view/DataViewTab.tsx` (~L813–866): add `⌘S` handler alongside the existing `⌘F` / `⌘R` shortcuts.
- Optional shared helper/hook to centralize the `window`-level `⌘S` detection used by the SQL viewers.
- No persisted state, schema, or keychain changes.
