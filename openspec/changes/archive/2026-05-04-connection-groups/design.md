## Context

Connections today are persisted in a single SQLite table (`connections`) and rendered as a flat alphabetical list in the sidebar's `ConnectionsSection`. The data model already carries a free-form `kind` discriminator (`"postgres"` today, `"dynamo"` and `"cloudwatch"` in the V2+ roadmap) and a generic `params_json` blob, so the storage layer is already source-agnostic.

What is missing is any organizational layer above the connection. This change adds **groups**: lightweight folders that hold any subset of connections, regardless of their `kind`. Groups are deliberately *not* typed — a single group should be able to hold a Postgres production connection and a DynamoDB production table side by side once V2 lands.

The implementation has to coexist with three sensitive places in the codebase:
- `useActiveConnections` and the schema-tree subtree rendering in the sidebar (`SidebarTree` is shared infra).
- The Cmd+P `TablePalette`, which already groups *tables* by their owning connection — semantically a different "group" concept that we must not collide with.
- The OS keychain integration, which keys secrets by `connection:<id>`. Groups have no secrets and must not touch this surface.

## Goals / Non-Goals

**Goals:**
- Source-agnostic grouping: a group's schema and UI must not assume `kind === "postgres"`.
- Non-destructive operations: deleting a group never destroys connections, only re-parents them.
- Stable migration: existing users see the same visible order on first launch after upgrade.
- Manual ordering with cheap reorders: drag-and-drop a single row updates a single row.
- Atomic moves: changing a connection's group + position is one IPC call, not two.
- Accessibility-honest drag-and-drop: keyboard-operable, ARIA-correct.

**Non-Goals:**
- Nested groups. The data model permits a future `parent_id` column; the UI does not deal with hierarchy in this change.
- Tags / many-to-many membership. A connection has at most one group.
- Per-group color or icon. The design system reserves accent color for state, not decoration.
- Group-aware Cmd+P. The palette stays optimized for speed and ignores groups.
- Multi-select drag for moving several connections at once.
- Sync across devices or import/export of group structure.

## Decisions

### D1: Carpetas (1:N) — not tags, not workspaces

A connection belongs to at most one group. We considered three shapes:

| Shape | Verdict | Why |
|---|---|---|
| Folders 1:N | **Chosen** | Matches the "I want prod separate from staging" mental model. Cheapest data model. Unambiguous sidebar render. |
| Tags M:N | Rejected for v1 | Forces "which group do I render this row under?" ambiguity in the sidebar. Adds a join table. Power that the user has not asked for. |
| Workspaces (excluding) | Rejected | The user wants to see prod and staging *together*, just visually separated. Hiding one mode at a time is the wrong shape. |

The data model leaves room for tags later (a separate `connection_tags` join table can be additive).

### D2: Flat hierarchy in v1, schema permits future nesting

Groups have no `parent_id` column in v1. If nesting is requested later, adding `parent_id BLOB REFERENCES connection_groups(id) ON DELETE CASCADE` is a single migration with no UI rewrite required for users who don't nest.

Rationale: drag-and-drop across two dimensions (between groups *and* between nesting levels) is materially harder than one-dimensional drag, and the only justification for nesting is a use case the user hasn't expressed.

### D3: `sort_order` as `REAL` with fractional indexing

Manual ordering uses a single `REAL` column on each table. To insert between rows with `sort_order = 1.0` and `sort_order = 2.0`, write `1.5`. No renumbering of neighbors per drag.

Rejected alternatives:
- `INTEGER` with full renumbering on every drag — O(n) writes per drag, which costs little here but is the kind of premature shortcut that bites later when sort lists grow.
- Linked list (`prev_id` / `next_id`) — needs a transaction for every reorder, harder to query.

We accept the standard fractional-indexing risks: precision exhaustion after ~50 consecutive insertions between the same two neighbors, addressed by a periodic rebalance routine. We do **not** ship a rebalancer in this change — it's deferred until precision actually becomes a problem (very unlikely on a single-user desktop app with order-of-tens of connections per group).

### D4: `ON DELETE SET NULL` for group → connection FK

Deleting a group never destroys connections. The FK constraint enforces this in the database, not in application code, which means even a misbehaving caller cannot orphan rows. The UI confirms before deleting a non-empty group, but the safety belt is at the schema level.

Rejected: `ON DELETE CASCADE` (destructive) and `ON DELETE RESTRICT` (forces the user to manually empty a group before deleting it, annoying).

### D5: "Sin grupo" / "Ungrouped" as a sentinel render, not a real row

`group_id IS NULL` is the storage representation of ungrouped. The sidebar synthesises a sentinel section for these connections at the bottom of the list. There is no row in `connection_groups` named "Ungrouped" — that would create rename/delete edge cases that need special-casing anyway, and it would force a migration to seed it on every install.

Behavioural consequences:
- Cannot rename, delete, or reorder the Ungrouped section.
- Always sorts last.
- A connection's `sort_order` is still meaningful while ungrouped (drag-and-drop within Ungrouped works).

### D6: Atomic `connections.move` IPC

Drag-and-drop changes both `group_id` and `sort_order` in the same gesture. Exposing this as one Tauri command (`connections.move(id, group_id?, sort_order)`) instead of two `connections.update` calls means:
- The frontend doesn't have to model an intermediate "in transit" state.
- A drag that updates two rows (the dragged row and the target row's neighbor) can be wrapped in a SQLite transaction, even though fractional indexing avoids the neighbor write in practice.
- Future Dynamo/CloudWatch UI layers can reuse the same IPC.

`connections.update` keeps existing semantics (no `group_id` argument) so callers that don't care about groups don't grow a footprint.

### D7: Default ordering changes from `name` to `sort_order`

`connections.list` now returns connections ordered by `(group_id IS NOT NULL, group_sort_order, sort_order)` (ungrouped last, then by group order, then by intra-group order). This is a behavioural change to an existing requirement, but invisible on first launch because the migration backfills `sort_order` from the alphabetical position of each existing row.

After the user reorders manually, the order persists across launches.

### D8: `@dnd-kit/core` + `@dnd-kit/sortable` for drag-and-drop

We need accessible, keyboard-operable drag-and-drop with sensors that work inside a Tauri webview. `@dnd-kit` is the lightest mature option (~14 KB gzipped), has first-class keyboard support, and is well-maintained. Native HTML5 drag-and-drop is rejected because its keyboard story is a non-starter and its events fire inconsistently across platforms.

### D9: Expand/collapse persisted in `localStorage`, not SQLite

Per-group expand/collapse state is UI ephemera, not data. `localStorage` keyed by `connection-groups.expanded.<group_id>` is sufficient for a single-user desktop app and avoids polluting the SQLite schema with per-user UI state.

If we later add a multi-machine sync story, this lifts cleanly into a `settings` row.

### D10: Cmd+P `TablePalette` ignores groups

The palette already groups *tables* by their owning connection — that is the disambiguation users actually need ("which `orders` did I want?"). Adding a group-name prefix to every table row would make the palette wider and slower to scan for the common case. If the same table name exists in two connections in two groups (e.g. `orders` in `prod/pg-customer` and in `staging/pg-customer-stg`), the connection name disambiguates today and that's enough.

We may revisit this with a toggle once the user has used groups for a while.

## Risks / Trade-offs

- **Sort-order precision exhaustion** → Mitigation: fractional indexing tolerates ~50 consecutive in-between inserts in IEEE-754 doubles before precision degrades; for a personal-use desktop app this is academic. Can add a rebalance routine later.
- **Drag-and-drop accessibility regressions** → Mitigation: `@dnd-kit` ships keyboard sensors out of the box; we add explicit screen-reader announcements for "moved X to group Y, position N".
- **`ON DELETE SET NULL` race**: a connection currently being edited in the inspector while its group is deleted → Mitigation: `useConnections` re-runs `list` on any group mutation; the inspector binds to the connection by id, not by group, so the row simply migrates to "Ungrouped" mid-edit.
- **`connections.list` ordering change leaks into UI** even when users don't use groups → Mitigation: backfill migration preserves alphabetical order; users who never drag never notice.
- **Cmd+P semantic clash**: the palette's existing per-connection grouping might be confused with the new connection groups by users → Mitigation: keep the palette unchanged; documentation/help text uses "group" only for connection groups, "section" for palette table sections.
- **Drag-and-drop inside the sidebar's shared scroll context** (per `app-shell` spec) — auto-scroll while dragging near edges → Mitigation: `@dnd-kit/sortable` provides `restrictToVerticalAxis` and `autoScroll`, and the existing single-scroll context is the natural target.

## Migration Plan

1. Ship migration `0002_groups.sql`:
   - Create `connection_groups(id, name, sort_order REAL, created_at, updated_at)`.
   - Add `group_id BLOB NULL REFERENCES connection_groups(id) ON DELETE SET NULL` to `connections`.
   - Add `sort_order REAL NOT NULL DEFAULT 0` to `connections`.
   - Backfill `connections.sort_order` so the alphabetical position of each row is its initial sort order.
   - Set `PRAGMA foreign_keys = ON` for the connection (already on per repo convention; verify).
2. Roll out new Tauri commands and frontend wiring under feature flag — actually, no flag: the migration is forward-only and the UI degrades gracefully (no groups means an empty group list, all connections render in "Ungrouped" which renders identically to today's flat list).
3. Rollback strategy: down-migration drops the new columns/table. Because no group state is created automatically, a downgrade after upgrade-without-use is a clean drop. After users have created groups, downgrade is one-way (group structure is lost, connections survive).

## Open Questions

- Does the user want a "Sort alphabetically" affordance on the Ungrouped sentinel section, or only on real groups? (Lean: yes, since once you've dragged Ungrouped rows you may want to reset.)
- Should `connection_groups.name` be unique? Lean: no, the `id` is the identity. Two groups both called "prod" is a UX smell, not a data integrity problem.
- Do we render group `count` always, or only when collapsed? Lean: only when collapsed — when expanded, the rows are visible.
- Where does "create new group" live? Lean: in the same `+` button at the bottom of the connections section that today creates connections — split into a small dropdown ("New connection" / "New group"). Confirms in tasks.
