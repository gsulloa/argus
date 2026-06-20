## 1. Render the engine type label

- [x] 1.1 Import `engineLabel` from `@/platform/shell/ConnectionRail` into `ConnectionSelector.tsx`
- [x] 1.2 Render `<span className={styles.itemType}>{engineLabel(conn.kind)}</span>` after the connection name inside each dropdown `DropdownMenu.Item`
- [x] 1.3 Leave the collapsed trigger button unchanged (name + status dot only)

## 2. Style the label per the design system

- [x] 2.1 Add `.itemType` to `ConnectionSelector.module.css`: `flex-shrink: 0`, `font-size: 10px`, `color: var(--text-subtle)`, no accent color
- [x] 2.2 Confirm `.itemName` keeps `flex: 1` + ellipsis so the name truncates before the type label

## 3. Verify

- [x] 3.1 `npx tsc --noEmit` passes (no type/import errors, no circular dependency)
- [x] 3.2 `npx eslint` passes on the edited file
- [ ] 3.3 Manually confirm in the running app that each dropdown item shows its engine type label and the name truncates correctly under a narrow dropdown
