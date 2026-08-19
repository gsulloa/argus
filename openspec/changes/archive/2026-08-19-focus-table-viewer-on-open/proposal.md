## Why

Opening a table from the schema tree or the ⌘P quick switcher renders the viewer tab but never moves keyboard focus into it, so `document.activeElement` stays on `document.body` (or on the tree node / palette input that was just dismissed). Every viewer-scoped shortcut is gated on focus living inside the tab root, so none of them fire until the user makes a priming click:

- **Postgres** (`TableViewerTab.tsx:539-624`) — the window `keydown` listener bails out at `if (!root.contains(document.activeElement)) return;` (`:546`), killing ⌘F (filter bar), ⌘R (reload), ⌘Z (undo) and ⌘1/2/3/4 (subtabs).
- **MySQL / MSSQL** (`TableViewerTab.tsx:417-421` / `:459-463`) — shortcuts hang off a React `onKeyDown` on the root `div`, which only receives events when focus is inside it: ⌘R and ⌘Z are equally dead. (Neither engine has a ⌘F binding at all — that gap is not in scope here.)
- The grid's own keyboard surface (`DataGrid.tsx:492-496`, `tabIndex={0}` + `onGridKeyDown`: ⌘C copy, ⌘V row paste, ⌘A select-all, Backspace/Delete bulk-delete toggle, Escape clear) is likewise inert.

Only ⌘S survives, because `useSaveShortcut` (`src/platform/shell/useSaveShortcut.ts:40-43`) deliberately treats `null` / `document.body` as "in tab" — a one-off workaround for issue #88 that never generalised.

Reported as in-app feedback (issue #280): *"Que al abrir una tabla se 'seleccione' como si se hiciera click. Así comienza a funcionar de inmediato el ⌘+F al abrirla."* Users expect opening a table to behave as if they had clicked it.

## What Changes

- **Focus the data grid when a table viewer tab becomes active.** When a `*-table-data` tab mounts as the active tab — or becomes the active tab after a tab switch — focus moves to the grid root (the `tabIndex={0}` element that owns ⌘C / ⌘V / ⌘A / Delete / Escape), so both the tab-root shortcuts and the grid shortcuts are live from the first keystroke.
- **Fall back to the tab root** when the grid isn't mounted or focusable (first load, error state, empty relation, Structure/Raw/Docs subtab). The tab root already carries `tabIndex={-1}` in all three engines.
- **Never steal focus.** The auto-focus is a no-op when focus already sits inside this tab, inside another element the user is interacting with (an `<input>`, `<textarea>`, `<select>`, contentEditable, or a CodeMirror surface), or while an overlay owns focus (command palette / table quick switcher). This preserves the ⌘P flow: the palette's `autoFocus` input keeps focus until dismissal, and the grid takes it once the tab is genuinely active.
- **Extract the behaviour into one shared hook** (`useAutoFocusOnActivate`) in `src/platform/shell/`, alongside the existing `useSaveShortcut`, and wire it into the Postgres, MySQL, and MSSQL table viewers.
- **Expose `focus()` on `DataGridHandle`** in the three engines' `DataGrid` components (Postgres and MSSQL viewers already hold a `gridRef` for `scrollToTop()`; MySQL does too), so the hook has a well-defined, testable focus target instead of DOM spelunking. This also lets each grid stop reaching for its own root via `viewportRef.current?.parentElement` (`postgres/data/DataGrid.tsx:444`) / `closest("[tabindex]")` (`mysql|mssql/data/DataGrid.tsx:535`) — the root gets a real ref.

Non-goal: DynamoDB's `DataViewTab` already scopes ⌘F on `active` alone (`DataViewTab.tsx:888-899`), so it is not affected; CloudWatch and Athena have no editable grid. No shortcut semantics change — only *when* focus first lands.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `postgres-data-grid`: the per-table viewer tab acquires keyboard focus (grid root, tab root as fallback) when it becomes the active tab, so ⌘F / ⌘R / ⌘Z / ⌘1-4 and the grid's own key handling work without a priming click — subject to a no-steal guard.
- `mysql-data-grid`: same auto-focus-on-activation requirement for the MySQL table viewer tab (⌘R / ⌘Z / grid keys).
- `mssql-data-grid`: same auto-focus-on-activation requirement for the MSSQL table viewer tab (⌘R / ⌘Z / grid keys).

## Impact

- **Frontend, new** `packages/app/src/platform/shell/useAutoFocusOnActivate.ts` (+ `useAutoFocusOnActivate.test.tsx`): shared hook taking `{ active, rootRef, targetRef }`; focuses on the `false → true` transition of `active` and on first mount when already active, guarded against focus theft.
- **Frontend** `packages/app/src/modules/postgres/data/DataGrid.tsx`, `.../mysql/data/DataGrid.tsx`, `.../mssql/data/DataGrid.tsx`: give the `tabIndex={0}` root a `rootRef`, and add `focus()` to `DataGridHandle` / `useImperativeHandle` (same element the click path already focuses at `postgres:443-445`).
- **Frontend** `packages/app/src/modules/postgres/data/TableViewerTab.tsx`, `.../mysql/data/TableViewerTab.tsx`, `.../mssql/data/TableViewerTab.tsx`: call the hook (all three already declare `gridRef` and `rootRef`).
- **Frontend** the three `DataGrid.module.css` files: `outline: none` on `.root`, so the UA focus ring doesn't appear around the whole grid when the tab is opened via a keyboard path (⌘P) but not via a mouse path.
- No backend, Tauri command, or persisted-state changes. No design-token changes.
- Tests: new `useAutoFocusOnActivate` unit tests (modelled on `useSaveShortcut.test.tsx`); per-engine `TableViewerTab` tests asserting the grid root is focused on activation and that focus is not stolen from an input.
