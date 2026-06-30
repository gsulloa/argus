## Context

The connections sidebar (`packages/app/src/platform/shell/Sidebar.tsx`) wraps all rows in a **single** dnd-kit `DndContext` with `collisionDetection={closestCenter}` (line ~352). Two distinct sortable types coexist inside it:

- **Group headers** — `GroupHeader` calls `useSortable({ id: 'group-sortable:<id>' })` **and** `useDroppable({ id: 'group-header:<id>' })` on the same node (drag handle carries the sortable listeners).
- **Connection rows** — `ConnectionRow` calls `useSortable({ id: <connection-uuid> })`.

The render order inside the outer `SortableContext` is a flat, interleaved sequence: `[GroupHeader A][rows A…][GroupHeader B][rows B…] … [Ungrouped header][ungrouped rows…]`.

`onDragEnd` branches on the active id prefix: `group-sortable:` → `handleGroupDragEnd`, else → `handleConnectionDragEnd`. `handleGroupDragEnd` guards with `if (!String(over.id).startsWith("group-sortable:")) return;`.

**The defect**: `closestCenter` ranks *every* registered droppable in the context by distance to the active item's center. When a group header is dragged, the nearest droppable is very often a connection row (UUID id) or the group's own `group-header:<id>` droppable — not a sibling `group-sortable:<id>`. The guard then discards that `over`, so `groups.update` is never called and the group visibly snaps back. Worsened because each group node registers *two* droppables (`group-sortable:` + `group-header:`), so even hovering directly over another group header can resolve to its `group-header:` id. This is the user-reported "the row above is focused before I can drag."

## Goals / Non-Goals

**Goals:**
- A group can be reordered by pointer drag regardless of expanded groups, connection rows, or the ungrouped section lying between source and destination.
- Group reordering remains keyboard-operable (KeyboardSensor + `sortableKeyboardCoordinates` already wired) and still emits exactly one `connection_groups.update` IPC call per committed reorder.
- Connection drag / re-parent behavior — including dropping onto a `group-header:<id>` droppable to append into a group — is unchanged.
- Preserve the existing rule: a group drag released over a genuinely non-group target makes no IPC call.

**Non-Goals:**
- No change to IPC commands, SQLite schema, `sort_order` midpoint math, or the 4px `PointerSensor` activation constraint.
- No restructuring of the DOM, no splitting into multiple `DndContext`s, no change to `ConnectionRow`/`GroupHeader` markup.
- Not addressing connection-drag collision quality (out of scope for #208).

## Decisions

### Decision 1: Type-scoped custom collision detection (chosen)

Replace `collisionDetection={closestCenter}` with a custom function that filters the candidate droppable set by the **active drag type**, then delegates to `closestCenter` on the filtered subset:

```ts
function collisionDetection(args) {
  const activeId = String(args.active.id);
  const isGroupDrag = activeId.startsWith("group-sortable:");
  const containers = args.droppableContainers.filter((c) => {
    const id = String(c.id);
    return isGroupDrag
      ? id.startsWith("group-sortable:")              // group drag: only sibling group sortables
      : !id.startsWith("group-sortable:");            // connection drag: keep rows + group-header: droppables
  });
  return closestCenter({ ...args, droppableContainers: containers });
}
```

- For a **group drag**, the only candidates are the other `group-sortable:<id>` headers, so `over` always resolves to a real group and `handleGroupDragEnd`'s guard never discards a legitimate reorder.
- For a **connection drag**, the `group-sortable:<id>` headers are removed so they cannot win over the intended `group-header:<id>` append-droppable or connection-row targets — connection behavior is preserved.

**Why over alternatives:**
- *Splitting into two `DndContext`s* — violates the spec's "single drag context that spans every group section and the ungrouped sentinel section" (required so a connection started in any section can target any other). Rejected.
- *Switching to `pointerWithin`/`rectIntersection` globally* — would change connection-drag feel and still mix both types. Rejected.
- *Loosening the `handleGroupDragEnd` guard to map a connection `over` back to its group* — fragile, ambiguous at group boundaries, and conflicts with the "ignores non-group drop targets" scenario. Rejected.

### Decision 2: Keep the `handleGroupDragEnd` guard

The `if (!over.id.startsWith("group-sortable:")) return;` guard stays. With scoped collision the guard now only fires for the keyboard/edge case where no group candidate is found, preserving the "Group reorder ignores non-group drop targets" scenario.

## Risks / Trade-offs

- **[Keyboard drag of a group still routes through the same collision function]** → The filter is type-based, not pointer-based, so KeyboardSensor coordinate resolution also benefits; existing keyboard scenario remains green. Verify in QA.
- **[A future third sortable type added to the context]** → The prefix-based filter assumes exactly "group vs. not-group." → Mitigation: comment the function noting the two-type assumption; new types must extend the predicate.
- **[`closestCenter` called with an empty candidate set]** (e.g. only one group exists) → returns `[]`, `over` is null, `handleGroupDragEnd` returns early — no-op, matches today's behavior.
