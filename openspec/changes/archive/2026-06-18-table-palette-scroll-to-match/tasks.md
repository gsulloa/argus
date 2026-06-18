## 1. Plumb a list ref through PaletteShell

- [x] 1.1 Add an optional `listRef?: Ref<HTMLDivElement>` prop to `PaletteShellProps` in `PaletteShell.tsx`
- [x] 1.2 Forward `listRef` to `<Cmdk.List ref={listRef} className={styles.list}>`; verify ⌘K command palette (no ref passed) is unaffected

## 2. Reset list scroll on query change in TablePalette

- [x] 2.1 Create a `useRef<HTMLDivElement>(null)` in `TablePalette` and pass it as `listRef` to `PaletteShell`
- [x] 2.2 Add a `useLayoutEffect` keyed on `search` (gated on `open`) that sets `listRef.current.scrollTop = 0` so the freshly ranked top result is visible
- [x] 2.3 Confirm the active row (cmdk's first/best-ranked item) is in view and that Enter still opens the highlighted entry

## 3. Verify preserved behavior

- [x] 3.1 Empty search: `Recent` group renders and is not hidden/reordered by the scroll reset
- [x] 3.2 ↑/↓ keyboard navigation still scrolls the highlighted row into view via cmdk's native behavior
- [x] 3.3 Switching from a scrolled-down query to a new query brings the new best match into the viewport (no stale scroll offset)

## 4. Manual QA

- [x] 4.1 With a long table list, scroll down, type a new query, and confirm the best match is visible without manual scrolling
- [x] 4.2 Repeat across Postgres, MySQL, and MSSQL active connections to confirm engine-agnostic behavior
