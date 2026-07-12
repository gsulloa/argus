## 1. Model: client-only stable row id

- [x] 1.1 Add a client-only `id: string` field to `FilterRow` in `src/modules/postgres/data/types.ts`; document it as client-only (never on the wire), like `enabled`.
- [x] 1.2 Replace the shared `EMPTY_FILTER_ROW` constant with a `makeEmptyRow()` factory that mints a fresh id via `crypto.randomUUID()`; update `EMPTY_FILTER_ROW`/`EMPTY_FILTER_TREE`/`EMPTY_FILTER_MODEL` usages so every created/reset row gets a unique id.
- [x] 1.3 Confirm `modelToPayload`, `filterRowEquals`, `filterRowEqualsWithEnabled`, and `filterTreeEquals` remain unchanged (they read fields explicitly, so `id` stays off the wire and out of dirty/Applied comparisons); add assertions to their tests proving `id` is ignored.

## 2. Persistence: backfill ids on load

- [x] 2.1 In `src/modules/postgres/data/filter-bar/migrateLegacyFilterModel.ts`, assign a fresh id to any loaded row lacking one; leave `column`/`op`/`value`/`enabled` untouched.
- [x] 2.2 Ensure `normalizePersistedFilter` in `useTableFilter.ts` routes both `draft` and `applied` through the id-backfilling normalization so persisted-before-ids records upgrade cleanly.
- [x] 2.3 Extend `migrateLegacyFilterModel.test.ts` (and `useTableFilter.test.tsx` if needed) with cases: legacy rows without ids get ids; rows with ids keep them; round-trip stays coherent.

## 3. Mutation: moveRow

- [x] 3.1 Add pure `moveRow(tree, from, to)` to `src/modules/postgres/data/filter-bar/treeMutations.ts` (slice + splice, `combinator` unchanged, no-op/out-of-range guards return input).
- [x] 3.2 Add `moveRow` unit tests to `treeMutations.test.ts`: basic move up/down, move-to-ends, `from === to` no-op, out-of-range guard, preserves `combinator` and untouched rows.

## 4. UI: sortable rows (dnd-kit)

- [x] 4.1 In `ConditionRow.tsx`, adopt `useSortable({ id: row.id })`; wire `setNodeRef`, `transform`/`transition` styles (`@dnd-kit/utilities` `CSS.Transform`), `attributes`, and `listeners` onto a new leading drag handle.
- [x] 4.2 Render the drag handle as a lucide `GripVertical` (size 11 to match `Minus`/`Plus`) with `aria-label="Reorder filter row"` and a `data-filter-control` value; ensure it is keyboard-focusable.
- [x] 4.3 In `FilterBar.tsx`, wrap the rows `.map()` in `<DndContext>` + `<SortableContext items={rowIds} strategy={verticalListSortingStrategy}>`; build `rowIds` from `row.id`; switch the row render `key` from index to `row.id` (keep `data-filter-row-index={i}` for existing keyboard nav).
- [x] 4.4 Configure sensors: `PointerSensor` with `activationConstraint: { distance: 5 }` and `KeyboardSensor` with `sortableKeyboardCoordinates`, mirroring the sidebar/context-tree usage.
- [x] 4.5 Implement `onDragEnd({ active, over })`: if `over` and `active.id !== over.id`, resolve `from`/`to` from `rowIds` and call `onDraftChange(moveRow(draft, from, to))`.

## 5. Styling (DESIGN.md)

- [x] 5.1 Add drag-handle + dragging styles to `FilterBar.module.css` (thin borders, `--accent-soft` affordance, existing radii; subtle grab/grabbing cursor and lift on drag). No decorative gradients or bubbly radii.
- [ ] 5.2 Verify against `design/preview.html` / running app that the handle reads correctly in both light and dark and does not shift the row layout when idle.

## 6. Tests & verification

- [x] 6.1 Add an interaction test in `FilterBar.test.tsx` (mock `@dnd-kit` per the `Sidebar.dnd.test.tsx` pattern) that a simulated drag reorders `draft` via `onDraftChange` and does not touch `applied`.
- [x] 6.2 Add a test asserting clicking an inline control (value input / checkbox / picker / ±) does not start a drag (activation-distance behavior).
- [x] 6.3 Add a test asserting a reordered draft, once applied, produces a `filter_tree` with the same predicates+combinator (only order differs) and no `id` on the wire.
- [ ] 6.4 Run the app: reorder rows by drag, reorder by keyboard, confirm dirty pip appears, Apply, and confirm results are unchanged and order persists after reopening the tab.
- [x] 6.5 Run lint/typecheck and the filter-bar test suite; confirm all green.
