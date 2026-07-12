## Context

The Postgres data-grid filter bar (`packages/app/src/modules/postgres/data/filter-bar/`)
renders a flat list of `FilterRow`s joined by one root combinator
(`FilterTree = { rows: FilterRow[], combinator: "AND" | "OR" }`). State is split
into `draft` (being edited) and `applied` (queried), persisted per
`(connectionId, schema, relation)` via `useTableFilter` → `useSetting`. Rows are
rendered in array order with `key={i}` and all keyboard navigation keys off a
positional `data-filter-row-index` attribute (`FilterBar.tsx`).

Relevant existing facts that shape this design:

- **Order is result-neutral.** `modelToPayload` maps enabled+complete rows into
  `filter_tree.children` in list order and the backend joins them with a single
  `AND`/`OR`. AND/OR are commutative, so reordering never changes returned rows —
  only the SQL-preview text order and the visual row order change.
- **Equality is field-explicit.** `filterRowEquals` compares `op`/`column`/`value`;
  `filterTreeEquals` walks rows positionally via `filterRowEqualsWithEnabled`.
  Neither does a deep/structural object compare, so a new field on `FilterRow`
  that these functions don't read is invisible to dirty-detection and the per-row
  "Applied" badge. `modelToPayload` likewise picks fields explicitly, so a new
  field does not leak onto the wire.
- **dnd-kit is already a dependency.** `@dnd-kit/core`, `@dnd-kit/sortable`,
  `@dnd-kit/utilities` are used by the connection sidebar
  (`src/platform/shell/Sidebar.tsx`, `ConnectionRow.tsx`) with `DndContext` +
  `SortableContext` + `useSortable`. We follow that pattern.

The MySQL and MSSQL filter bars are separate, older single-file components
(`src/modules/{mysql,mssql}/data/FilterBar.tsx`) that do not share the Postgres
filter-bar internals; they are out of scope.

## Goals / Non-Goals

**Goals:**

- Let the user reorder filter rows by drag-and-drop, with a clear drag handle,
  matching `DESIGN.md` (thin borders, accent-soft affordances, no bubbly radii).
- Keyboard-accessible reordering for parity with the bar's keyboard-first design.
- Persist the chosen order using the existing per-table filter storage, with no
  new dependency and no backend/SQL/wire change.
- Keep dirty-detection, the per-row "Applied" badge, per-row Apply, Apply All,
  Unset, insert/remove, and existing keyboard navigation working unchanged.

**Non-Goals:**

- No nesting/sub-groups (the model stays a flat list under one combinator).
- No change to query execution, `filter_tree` wire shape, or backend compilation.
- No reordering in the MySQL/MSSQL/Dynamo filter surfaces.
- No auto-Apply on reorder and no special "reorder doesn't dirty" behavior (see
  Decisions).

## Decisions

### 1. Reorder with `@dnd-kit/sortable`, following the sidebar pattern

Wrap the rows `.map()` in `FilterBar.tsx` with `<DndContext>` +
`<SortableContext items={rowIds} strategy={verticalListSortingStrategy}>`. Make
`ConditionRow` a sortable item via `useSortable({ id: row.id })`, exposing
`setNodeRef`, `transform`, `transition`, `attributes`, `listeners`. On
`onDragEnd({ active, over })`, if `over` exists and differs, compute source/target
indices from `rowIds` and call `onDraftChange(moveRow(draft, from, to))`.

Configure a `PointerSensor` with `activationConstraint: { distance: 5 }` (as in
`ContextQueriesBranch.tsx`) so clicks on the row's inline controls (checkbox,
column/operator pickers, value input, Apply, ±) still work and only a deliberate
drag initiates a reorder. Add a `KeyboardSensor` with
`sortableKeyboardCoordinates` for keyboard reordering.

_Alternatives considered:_ native HTML5 drag-and-drop (dependency-free but clunky
drag image, no touch, no built-in keyboard support, and we'd reimplement what
dnd-kit already gives us — rejected since dnd-kit is already in the bundle and
used elsewhere); `react-beautiful-dnd`/`react-dnd` (not present, larger, rbd is
in maintenance mode — rejected).

### 2. Dedicated drag handle, not whole-row draggable

Render a small grip handle (lucide `GripVertical`, size 11 to match the existing
`Minus`/`Plus` icons) as the first element of `ConditionRow`, carrying the
`useSortable` `listeners`/`attributes`. The rest of the row is not a drag source,
so text selection and control interaction inside the row are unaffected. The
handle gets an `aria-label` ("Reorder filter row") and a `data-filter-control`
value consistent with the row's other controls.

_Alternative:_ whole row draggable with the pointer-distance constraint — rejected
because it makes selecting text inside the value input and clicking pickers
fiddly, and the handle is the clearer affordance.

### 3. Client-only stable row `id` on `FilterRow`

`useSortable` needs stable, unique ids across renders and reloads; index-based ids
break dnd-kit tracking mid-drag. Add `id: string` to `FilterRow` as a **client-only**
field:

- Minted when a row is created — `EMPTY_FILTER_ROW` is replaced by a factory
  (`makeEmptyRow()`) so each new/inserted row gets a fresh id via
  `crypto.randomUUID()`; `addRow`/`removeRow`'s "reset to one empty row" path uses
  the factory.
- Backfilled on load — `migrateLegacyFilterModel` / persisted-filter normalization
  assigns ids to any row lacking one, so existing persisted filters keep working.
- Invisible to the wire and to comparisons — `modelToPayload`, `filterRowEquals`,
  `filterRowEqualsWithEnabled`, and `filterTreeEquals` already read fields
  explicitly and are left untouched, so `id` never ships on the wire and never
  affects dirty state or the Applied badge. This is verified by keeping those
  functions unchanged and asserting it in tests.

`data-filter-row-index` and the index-based keyboard navigation are kept as-is
(positional), independent of the new id. Row render `key` switches from the array
index to `row.id`.

_Alternative:_ keep the model id-free and maintain a component-local
id↔row mapping in a ref, reconciling on every rows change — rejected as more
fragile (must re-sync on external load/unset/insert/remove and permute on
reorder) than persisting a stable id, given equality/wire functions already
ignore unknown fields.

### 4. Reorder is a plain draft edit (marks dirty; Apply syncs order)

Reordering calls `onDraftChange` and therefore marks the bar dirty vs `applied`,
exactly like every other bar edit. This keeps the "all edits touch draft only"
invariant intact. Because `draft` is persisted, the chosen order survives reloads
even if the user never applies. Applying commits the order into `applied` through
the normal path; since results are order-independent the re-fetch returns the same
rows (acceptable and consistent with how Apply already behaves).

_Alternative:_ special-case reorder to mutate `draft` and `applied` together so no
dirty pip appears and no re-fetch happens — rejected because it would require
order-insensitive re-fetch de-duplication deep in the viewer and would break the
single, simple "draft vs applied" mental model for a marginal gain.

### 5. `moveRow` pure mutation

Add to `treeMutations.ts`, mirroring the existing pure-function style:

```ts
export function moveRow(tree: FilterTree, from: number, to: number): FilterTree {
  if (from === to) return tree;
  const rows = tree.rows.slice();
  const [moved] = rows.splice(from, 1);
  if (!moved) return tree;
  rows.splice(to, 0, moved);
  return { ...tree, rows };
}
```

Out-of-range/no-op guards return the input unchanged. Unit-tested alongside the
existing `addRow`/`removeRow` tests. (dnd-kit's `arrayMove` could be used inside
`onDragEnd`, but a local pure helper keeps mutation logic testable and colocated
with the others.)

## Risks / Trade-offs

- **Drag conflicts with inline control interaction** → Mitigation: dedicated drag
  handle + `PointerSensor` `activationConstraint.distance: 5`; controls live
  outside the handle. Covered by an interaction test.
- **Stable-id migration corrupts persisted filters** → Mitigation: id is additive
  and client-only; normalization only backfills a missing `id` and never alters
  `column`/`op`/`value`/`enabled`; existing migration tests extended to assert
  round-trip stability and id backfill.
- **Reorder unexpectedly changes results** → Not possible for the flat root
  combinator (commutative); asserted by keeping `modelToPayload` unchanged and by
  a test showing reordered rows produce an equal (order-only-different) wire
  payload with identical semantics. If per-row RAW expressions were ever combined
  under mixed operators this could matter — but the model has a single root
  combinator, so it does not.
- **Dirty pip after a "cosmetic" reorder may surprise users** → Accepted for
  consistency (Decision 4); the order still persists via `draft` without Apply.
- **Keyboard reorder discoverability** → Mitigation: handle is focusable with an
  `aria-label`; optionally note the capability in the footer hints (kept minimal
  to avoid clutter).

## Migration Plan

Frontend-only, no data migration and no rollback coordination needed. The
persisted per-table filter record gains an optional client-only `id` that is
backfilled on read; older app versions that don't understand `id` simply ignore
the unknown field (the normalizer already tolerates unknown/legacy shapes), so
the change is forward- and backward-compatible on disk. Rollback is a code revert.

## Open Questions

- Should the footer shortcut-hint strip advertise keyboard reordering, or keep the
  handle-only affordance to avoid crowding the hint row? Leaning: no new hint;
  revisit if QA finds it undiscoverable.
