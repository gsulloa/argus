## Context

Three facts about the current implementation combine into the bug reported in issue #280.

1. **Nothing focuses the tab on activation.** Tab state is a React context (`src/platform/shell/tabs/TabsContext.tsx`), not a store: `open()` (`:135-183`) appends the tab and sets `activeTabId`, and never touches DOM focus. `TabContent` (`:89-105`) keeps every *ever-activated* tab mounted, hides the inactive ones with a CSS class, and passes `active={connectionId === focusedConnectionId && tab.id === activeTabId}`. Activation is therefore a prop flip on an already-mounted component — any fix must key off the `false → true` transition of `active` **and** first mount, not mount alone. After clicking a schema-tree node (`SchemaTree.tsx:738`), `document.activeElement` is the tree (`SidebarTree.tsx:876`, `tabIndex={0}`), outside the tab. After the ⌘P quick switcher (`TablePalette.tsx:105-132` calls `hide()` then `open()`), it falls back to `document.body` — `PaletteShell.tsx:74` uses `autoFocus` on its input but nothing restores focus on dismiss.

2. **Postgres shortcuts are gated on focus-within.** `TableViewerTab.tsx:539-624` installs a *window* `keydown` listener but bails immediately:
   ```ts
   const root = rootRef.current;
   if (!root) return;
   if (!root.contains(document.activeElement)) return;
   ```
   With focus on `document.body`, `root.contains(document.body)` is `false`, so ⌘F (`:598`), ⌘R (`:588`), ⌘Z (`:577`) and ⌘1-4 (`:549`) are all dead. The one shortcut that *does* work is ⌘S, because `useSaveShortcut` (`src/platform/shell/useSaveShortcut.ts:39-44`) deliberately treats `null` / `document.body` as "in tab" — a targeted workaround for issue #88 that never generalised.

3. **MySQL and MSSQL are worse.** Their shortcuts hang off a React `onKeyDown` on the root div (`mysql/data/TableViewerTab.tsx:417-421`, `mssql/data/TableViewerTab.tsx:459-463`). React's synthetic events require the event to actually reach that subtree, so ⌘R / ⌘Z are unreachable until focus is inside — the `useSaveShortcut` escape hatch doesn't apply. (Neither engine binds ⌘F at all, and neither passes a ref to its `FilterBar`; adding ⌘F parity is a separate change.)

The natural focus target already exists: `DataGrid`'s root carries `tabIndex={0}` and `onKeyDown={onGridKeyDown}` (`postgres/data/DataGrid.tsx:491-496`), and the grid *already* focuses it after a click-drag ("Focus the grid root so Escape / ⌘C work immediately after click", `DataGrid.tsx:443-445`). The tab root carries `tabIndex={-1}` in all three engines (`:705`, `:419`, `:461`). So the fix is to reproduce, on activation, the focus state a click already produces.

What `onGridKeyDown` actually binds (`postgres/data/DataGrid.tsx:288-380`): ⌘C single-cell and row-range copy, ⌘V row-range paste, ⌘A select-all, Backspace/Delete bulk-delete toggle, Escape clear. There is **no** arrow-key cell navigation — worth knowing so the change isn't oversold as "keyboard navigation now works".

DynamoDB's `DataViewTab` is out of scope: its ⌘F listener is gated on `active` alone (`DataViewTab.tsx:888-899`) and already works. Athena and CloudWatch have no editable grid.

## Goals / Non-Goals

**Goals:**
- Opening or switching to a table viewer tab lands keyboard focus inside it, so ⌘F / ⌘R / ⌘Z / ⌘1-4 and the grid's own key handling work from the first keystroke.
- One shared, unit-tested hook covering Postgres, MySQL and MSSQL — not three copies.
- Never steal focus from a place the user is typing, and never break the palette / quick-switcher focus trap.
- No change to what any shortcut *does*; only to when focus first arrives.

**Non-Goals:**
- Not changing selection state. Opening a table must not set an active cell or select row 0 — a click does that, but it would arm ⌘C / ⌘V / Delete against a row the user never chose. The issue explicitly asks for a *non-destructive* landing spot.
- Not touching Dynamo, Athena, CloudWatch, the SQL editor, or the Structure/Raw/Docs viewers.
- Not generalising `useSaveShortcut`'s body/null escape hatch to the other shortcuts (see Decisions).
- No focus-restoration on tab *close* or on palette dismissal (separate concern; the quick-switcher spec claims it, the implementation doesn't — out of scope here).

## Decisions

**Decision: Fix it by focusing, not by loosening the focus guards.**
An alternative is to relax each handler's guard the way `useSaveShortcut` does — treat `null` / `document.body` as "focus is in the active tab". Rejected on three counts: (a) it doesn't help MySQL/MSSQL at all, since their React `onKeyDown` never receives the event regardless of how the handler is written; (b) it leaves the *grid's* own bindings (arrows, ⌘C, ⌘A, Escape) broken, so the tab would be half-alive; (c) with two windows and multiple connection sets, "focus is nowhere" is a genuinely ambiguous state to route keystrokes from. Actually moving focus makes the DOM tell the truth and fixes every consumer at once. This also matches the user's own framing: *"como si se hiciera click"*.

**Decision: New shared hook `useAutoFocusOnActivate` in `src/platform/shell/`.**
Signature mirrors the neighbouring `useSaveShortcut` so the three viewers read consistently:
```ts
useAutoFocusOnActivate({
  active,                       // boolean — the tab's `active` prop
  rootRef,                      // RefObject<HTMLElement | null> — tab root, tabIndex={-1}
  targetRef,                    // RefObject<{ focus(): void } | null> — the grid handle
});
```
Behaviour: track the previous `active` with a ref; run only on the `false → true` edge *and* on first mount when `active` is already true (the common "open a table" path mounts with `active === true`). Schedule the focus in a `requestAnimationFrame` so the grid root exists post-paint, and cancel the frame on cleanup so a fast tab-switch can't land a stale focus. Re-check the guards *inside* the RAF callback, not before scheduling — the DOM can change in that gap.

- Alternative: an `autoFocus`-style prop on `DataGrid`. Rejected — it wouldn't cover the fallback-to-tab-root case (loading, error, non-Data subtab), and `DataGrid` unmounts/remounts on subtab switches, which would re-fire focus at the wrong times.
- Alternative: put the focus call in `TabContent` generically for all tab kinds. Rejected — the SQL editor, AI panel and CloudWatch tabs each have their own idea of a correct landing spot; a blanket rule would fight them. Opt-in per viewer.

**Decision: Focus target = grid root, falling back to the tab root — driven by *observed* focus, not by a null check.**
Resolve at focus time: call `targetRef.current?.focus()`, then check `rootRef.current?.contains(document.activeElement)` and call `rootRef.current?.focus()` if focus did not actually land.

The naive version — `if (targetRef.current) grid.focus(); else root.focus();` — is wrong, and implementation proved it. The three viewers hide the grid three different ways:

| Engine | Non-Data subtab | First load / error |
|---|---|---|
| Postgres | **mounted**, `display: none` via `.dataSubtab[data-active="false"]` (`TableViewerTab.module.css:21-23`) | grid unmounted only while `isFirstLoad` (`idle`/`loading-first`/`loading-first-retrying`); the `error` status still renders the grid |
| MSSQL | **mounted**, inline `display: activeSubtab === "data" ? "contents" : "none"` (`TableViewerTab.tsx:507`) | genuinely unmounted (`:821-823`, gated on `!isLoading && !error`) |
| MySQL | genuinely unmounted (`TableViewerTab.tsx:657`) | genuinely unmounted |

So for Postgres and MSSQL on a Structure/Raw/Docs subtab, `gridRef.current` is non-null while the grid sits inside a `display: none` subtree — and `HTMLElement.focus()` on a non-rendered element is a **silent no-op**. The null-check version would take the grid branch, move nothing, and leave focus on `document.body`: issue #280, reproduced on exactly the path the fallback was meant to cover. Verifying the outcome collapses unmounted, hidden and detached into one correct code path, and needs no per-engine knowledge.

Note this is invisible to jsdom, which performs no layout and happily focuses a `display: none` element — so the unit test for it must simulate the no-op with a stub target whose `focus()` does nothing, rather than by actually hiding a node.

The tab root's `tabIndex={-1}` makes it programmatically focusable but not tab-reachable, which is exactly right. Focusing the grid root — rather than the tab root — is what makes ⌘C / ⌘A / arrows work too, since those live on `onGridKeyDown`; the tab-root shortcuts still fire either way because the grid root is a descendant of `rootRef` and the window listener's `root.contains(...)` check passes.

**Decision: Expose `focus()` on `DataGridHandle` rather than reaching into the DOM.**
`DataGridHandle` already exists in all three engines with `scrollToTop()` (`postgres/data/DataGrid.tsx:100-103`, imperative handle at `:211-228`), and each viewer already holds a `gridRef` (`postgres:538`, `mysql:196`, `mssql:241`). Add `focus(): void` to the interface and to `useImperativeHandle`, focusing the same `tabIndex={0}` root element the click path focuses. Implement it as a no-op when the ref is null so a call during teardown is harmless. This keeps the hook engine-agnostic and gives tests a seam. Alternative — `rootRef.current.querySelector('[tabindex="0"]')` — rejected as brittle (the filter bar and inspector contain focusable elements too).

Note the grid roots have **no ref today**: Postgres reaches its own root via `viewportRef.current?.parentElement` (`DataGrid.tsx:444`) and MySQL/MSSQL via `e.currentTarget.closest("[tabindex]")` (`:535` in both). Add a real `rootRef` on the root div in all three and route both the existing click-focus and the new `focus()` through it — that removes two DOM-traversal hacks as a side effect and keeps the two focus paths provably identical.

**Decision: The no-steal guard lives in the hook, checked against `document.activeElement`.**
Skip the focus when, at RAF time:
- `rootRef.current?.contains(document.activeElement)` — focus is already in this tab (covers the user having clicked during the frame, and covers re-activation while the inspector is focused).
- The active element is a text-entry surface *anywhere*: `tagName` in `INPUT` / `TEXTAREA` / `SELECT`, `isContentEditable`, or `closest(".cm-editor")`. This predicate is currently reimplemented in at least nine places — `useShortcuts.ts:30-36` and `useCommandHotkeys.ts:19-24` (private `isTypingTarget` copies, neither checking `.cm-editor`), plus ad-hoc `.cm-editor` checks in `useSaveShortcut.ts:37`, `postgres/data/TableViewerTab.tsx:555-561, 589, 600`, `mysql/…:395`, `mssql/…:437`, `dynamo/DataViewTab.tsx:893`, `FilterBar.tsx:243`, `EventsTab.tsx:103`. Export one `isTextEntryTarget(el)` helper from `src/platform/shell/` and use it in the new hook. Do **not** retrofit the nine existing call sites in this change — the guards differ subtly (some deliberately omit `.cm-editor`) and swapping them all in wholesale would put unrelated shortcut regressions in a focus fix. Leave a follow-up note instead.
- An overlay owns focus. The palette/quick-switcher input is an `<input>`, so the text-entry check already covers it — but assert it explicitly with a test rather than relying on that coincidence, because the quick switcher is the highest-traffic path into this bug.

Deactivation is not handled: `active` going `true → false` does nothing. Blurring on deactivate would leave focus nowhere and reintroduce the original problem for whatever tab comes next.

**Decision: Suppress the UA focus ring on the grid root.**
Chromium applies `:focus-visible` when the last input modality was the keyboard — so opening a table via ⌘P (keyboard) would draw a default outline around the entire grid container, while opening it by clicking the tree would not. That inconsistency is worse than no ring, and a box around the whole grid is not a `DESIGN.md`-sanctioned affordance. Add `outline: none` to `DataGrid.module.css` `.root` (all three engines). The grid's real selection feedback is the accent cell ring already defined at `DataGrid.module.css:222`; a deliberate container-focus treatment is a separate design question, not something to smuggle in here.

**Decision: Do not set selection state.**
A real click sets an active cell (`DataGrid.tsx:437-441`). The auto-focus deliberately does not. `activeCell` and `selection` arm ⌘C, ⌘V, ⌘A, and Backspace/Delete bulk-delete; auto-selecting row 0 on open would point destructive shortcuts at a row the user never chose. The issue itself asks for a non-destructive landing spot. Consequence: ⌘A is a no-op immediately after opening (it requires an existing selection — see the `grid-select-all` spec), which is correct and unchanged.

## Risks / Trade-offs

- **[⌘R now fires two handlers instead of one]** → `WorkspaceShell.tsx:400-411` registers ⌘R = "refresh the focused connection tree" through `useShortcuts`, which guards only on `isTypingTarget` and always calls `preventDefault()`. The table viewer's own ⌘R (`TableViewerTab.tsx:588`) is an independent window listener. Once focus is in the grid, both fire: the tree refreshes *and* the table reloads. This is **not a new regression** — it is exactly what happens today the moment the user clicks into the grid, so the change only makes the existing overlap reachable sooner. Out of scope to fix; called out for QA so it isn't misfiled as caused by this change.
- **[Focus is stolen from a surface the guard doesn't know about]** → the guard is a denylist of text-entry tags plus a focus-within check, so an exotic focusable (a custom listbox, a drag handle) outside the tab could lose focus on a background activation. Mitigated because activation is almost always a direct user gesture targeting this tab, and because the `false → true` edge means it fires at most once per activation. Covered by tests for the input / CodeMirror / palette cases.
- **[Double-focus fight when two windows or two connection sets are involved]** → `active` is already computed as `connectionId === focusedConnectionId && tab.id === activeTabId`, so at most one tab per window is active. The edge-triggered hook plus the focus-within guard means a losing tab's RAF callback sees focus already inside the winner and no-ops.
- **[RAF never fires under test]** → jsdom does implement `requestAnimationFrame`, but tests should still `await` a frame (or use fake timers) before asserting; the hook's unit tests will establish the pattern for the three viewer tests. Two existing test hazards to respect: the MySQL/MSSQL `TableViewerTab` tests mock `DataGrid`/`FilterBar`/`Inspector` and **must return stable object references or the suite infinite-loops and exhausts the heap** (see the header comment in `mysql/data/__tests__/TableViewerTab.test.tsx:10-16`), and any test that renders a real `DataGrid` under jsdom must mock `@tanstack/react-virtual` so rows actually render (pattern at `DataGrid.copy.test.tsx:29-46`).
- **[Screen-reader users hear the grid announced on every tab switch]** → this is the intended behaviour of activating a tab panel and matches what a click already produces; it does not add a live region or an announcement of its own.
- **[Focus lands on the grid while rows are still loading, then the grid remounts]** → the fallback puts focus on the tab root during first load; when rows arrive the grid mounts but the hook does **not** re-fire (activation edge already consumed), so focus stays on the tab root and the root-level shortcuts keep working. Accepted: re-focusing on data arrival would risk yanking focus away from a user who moved on. Noted as an open question below.

## Migration Plan

Frontend-only; no data, schema, or persisted-state migration. Ships behind no flag. Rollback is removing the three `useAutoFocusOnActivate` call sites (the hook, the `DataGridHandle.focus()` additions and the `outline: none` rule are inert on their own).

## Open Questions

- Should the fallback-to-tab-root case upgrade to the grid root once rows finish loading? Current design says no (see Risks). If QA finds that the common "open a big table, wait, press ⌘C" flow feels broken, the follow-up is to re-run the focus once when the grid handle first becomes non-null *and* focus is still on the tab root.
- Should Dynamo's `DataViewTab` adopt the same hook for consistency even though its ⌘F already works? Left out of v1 to keep the diff proportional; worth revisiting if we later tighten its listener to a focus-within guard like Postgres's.
- **Subtab switching probably drops focus back to `document.body` (Postgres, MSSQL).** Per the HTML spec, when the focused element stops being rendered the browser resets focus to the body. Postgres hides the Data subtab with `display: none` (`TableViewerTab.module.css:21-23`) and MSSQL with an inline `display: none` — so pressing ⌘2 while focus is on the grid root should hide the grid, blank the focus, and make the follow-up ⌘1 fail the `root.contains(document.activeElement)` guard, stranding the user on Structure until they click. This is **pre-existing** (identical after any priming click) but this change makes it reachable on the default path, since focus now starts on the grid root. Not verified in a real browser — jsdom performs no layout, so no test here can confirm or refute it; QA step 5.4 should check it explicitly. If confirmed, the cheapest fix is to relax the tab-root listener's guard to accept `null` / `document.body` as "in tab", exactly as `useSaveShortcut.ts:40-43` already does for ⌘S — small, well-precedented, and it repairs every shortcut after any focus loss rather than just this path. Deliberately **not** done here: it changes shortcut scoping semantics and belongs in its own change.
- Two adjacent gaps surfaced while scoping this and are deliberately **not** fixed here: (a) MySQL and MSSQL have no ⌘F binding and pass no ref to their `FilterBar`, so they have no filter-bar focus path at all; (b) `postgres-data-grid` spec line 890 requires that hiding the filter bar with ⌘F move focus "to a sensible fallback (the data grid root, or the tab root)", and `TableViewerTab.tsx:613-615` doesn't do that — it just hides the bar, leaving focus on a detached node. Both deserve their own change; (b) becomes easy once `DataGridHandle.focus()` exists.
