## 1. Plumbing — share a scroll element via context

- [x] 1.1 Create `SidebarScrollContext` in `src/platform/shell/Sidebar.tsx` (or a sibling file) exposing a `React.RefObject<HTMLDivElement | null>` for the sidebar's scroll element.
- [x] 1.2 In `Sidebar.tsx`, create a `scrollRef` with `useRef<HTMLDivElement | null>(null)` and provide it via the new context around the sidebar contents.

## 2. Sidebar — add the single scroll wrapper

- [x] 2.1 In `Sidebar.tsx`, wrap everything below `<header className={styles.brand}>` in a new `<div ref={scrollRef} className={styles.scroll}>…</div>` containing `<ConnectionsSection />` (and any future sections).
- [x] 2.2 In `Sidebar.module.css`, add `.scroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }`.
- [x] 2.3 Verify `Sidebar.module.css` `.root` still has `display: flex; flex-direction: column; height: 100%` (no change needed) so `.scroll` can claim the leftover height.

## 3. SidebarTree — accept an external scroll element

- [x] 3.1 In `src/platform/shell/SidebarTree.tsx`, add an optional prop `scrollElementRef?: React.RefObject<HTMLElement | null>` to `SidebarTreeProps`.
- [x] 3.2 In the component, derive the virtualizer's `getScrollElement` from `scrollElementRef.current ?? scrollerRef.current`, so external refs win when provided and the internal ref is the fallback.
- [x] 3.3 In `src/platform/shell/SidebarTree.module.css`, drop `overflow: auto` and `max-height: 100%` from `.scroller` (keep `position: relative` for absolutely-positioned virtualized rows).
- [x] 3.4 Confirm there are no other CSS rules (e.g. on `.tree`) that introduce a competing scroll context.

## 4. SchemaTree — wire the external scroll element

- [x] 4.1 In `src/modules/postgres/schema/SchemaTree.tsx`, consume `SidebarScrollContext` and pass its ref into `<SidebarTree scrollElementRef={…} />`.
- [x] 4.2 In `src/modules/postgres/schema/SchemaTree.module.css`, change `.body` from `flex: 1; min-height: 0; overflow: auto; padding: 4px 0;` to just `padding: 4px 0;` (let the body grow to its natural content height).

## 5. Manual verification (golden path + regressions) — REQUIRES USER

These require launching `pnpm tauri:dev` against a live Postgres connection; deferred to the user.

- [ ] 5.1 Run the dev server (`pnpm tauri dev` or `pnpm dev` per `package.json`) and reproduce the original bug: connect to a Postgres DB with many tables, expand a schema, confirm the sidebar now scrolls vertically and reveals all tables.
- [ ] 5.2 With multiple connections active, expand schemas under each — confirm one shared scrollbar moves through both trees in document order; no nested scrollbars appear.
- [ ] 5.3 Resize the sidebar via its drag handle — confirm trees still ellipsize labels and the new scroll wrapper still works at min and max widths.
- [ ] 5.4 Confirm the brand header stays fixed at the top while scrolling.
- [ ] 5.5 Test keyboard navigation in `SidebarTree`: ↑/↓/←/→/Home/End/Enter/type-ahead all still work; the focused row stays visible (relying on default browser focus behavior or `scrollIntoView` if needed — note any regression as a follow-up).
- [ ] 5.6 If a schema with >500 visible nodes is available, expand it and confirm virtualization still works (DOM has only the visible window of `treeitem` rows; scrolling reveals more).

## 6. Code health

- [x] 6.1 Run `pnpm typecheck` (or the project's tsc invocation) — no new type errors. *(Clean.)*
- [x] 6.2 Run `pnpm lint` — no new lint errors. *(0 errors, 19 pre-existing `react-refresh/only-export-components` warnings unrelated to this change.)*
- [x] 6.3 Run any existing tests (`pnpm test` if present) — no regressions. *(No `test` script in package.json; nothing to run.)*

## 7. Documentation hygiene

- [x] 7.1 Confirm no doc comments in `Sidebar.tsx`, `SidebarTree.tsx`, or `SchemaTree.tsx` reference per-tree independent scroll. If so, update them or delete them per repo conventions (no purely descriptive comments). *(Searched — no stale references.)*
- [x] 7.2 Re-render `design/preview.html` (if it exercises the sidebar) to confirm the static design preview still matches the live shell — only if relevant; skip otherwise. *(Skipped: preview.html is a static design-token preview, not a live sidebar render.)*
