## 1. Schema and migration

- [x] 1.1 Add migration `src-tauri/migrations/0003_groups.sql`: create `connection_groups(id BLOB PRIMARY KEY, name TEXT NOT NULL, sort_order REAL NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`
- [x] 1.2 In the same migration: `ALTER TABLE connections ADD COLUMN group_id BLOB REFERENCES connection_groups(id) ON DELETE SET NULL`
- [x] 1.3 In the same migration: `ALTER TABLE connections ADD COLUMN sort_order REAL NOT NULL DEFAULT 0`
- [x] 1.4 In the same migration: backfill `connections.sort_order` from each row's case-insensitive alphabetical position by `name`
- [x] 1.5 Verify `PRAGMA foreign_keys = ON` is set on every connection (so `ON DELETE SET NULL` actually fires) and add a startup assertion if not already present
- [x] 1.6 Add a Rust integration test that boots a fresh DB, applies migrations, and asserts the new schema (columns exist, FK is `SET NULL`, default `sort_order` is non-zero after backfill)

## 2. Rust: groups module

- [x] 2.1 Create `src-tauri/src/platform/connection_groups.rs` with `ConnectionGroup` struct (`id: Uuid`, `name: String`, `sort_order: f64`, `created_at: i64`, `updated_at: i64`)
- [x] 2.2 Implement DB helpers: `list`, `get`, `create(name)`, `update(id, patch)`, `delete(id)` (rusqlite, matches existing pattern)
- [x] 2.3 Add Tauri commands `connection_groups_list`, `connection_groups_create`, `connection_groups_update`, `connection_groups_delete`
- [x] 2.4 Reject empty/whitespace `name` in create with `AppError::Validation`
- [x] 2.5 In `create`, compute `sort_order = (SELECT COALESCE(MAX(sort_order), 0) FROM connection_groups) + 1.0`
- [x] 2.6 In `delete`, return `AppError::NotFound` if no row matched
- [x] 2.7 Register the new commands in `src-tauri/src/lib.rs` (or wherever the invoke handler is built)
- [x] 2.8 Unit/integration tests: create → list → update → delete; non-empty group delete preserves connections; FK `SET NULL` fires

## 3. Rust: extend connections module

- [x] 3.1 Add `group_id: Option<Uuid>` and `sort_order: f64` to the `Connection` struct in `src-tauri/src/platform/connections.rs`
- [x] 3.2 Update the `SELECT` in `connections_list` to project the new columns and order by `(group_id IS NULL, group_sort_order, sort_order)` (LEFT JOIN to `connection_groups` to get the group's sort order; ungrouped last)
- [x] 3.3 Update `connections_create` to accept optional `group_id`, validate that the group exists when supplied (return `NotFound`), and assign a new `sort_order = MAX(sort_order WHERE same group_id) + 1.0`
- [x] 3.4 Confirm `connections_update` does **not** mutate `group_id` or `sort_order` (kind already immutable; mirror that pattern)
- [x] 3.5 Add Tauri command `connections_move` that accepts `{ id, group_id: Option<Uuid>, sort_order: f64 }`, updates both columns and `updated_at` in a single statement, returns the updated connection, and returns `NotFound` for unknown `id` or unknown `group_id`
- [x] 3.6 Register `connections_move` in the invoke handler
- [x] 3.7 Integration tests: list ordering across groups + ungrouped; create-with-group; create-with-unknown-group fails; move within group; move between groups; move to ungrouped (`group_id: null`); move preserves keychain entry

## 4. Frontend: types and API wrappers

- [x] 4.1 Extend the `Connection` TypeScript type in `src/platform/connection-registry/types.ts` with `group_id: string | null` and `sort_order: number`
- [x] 4.2 Add `ConnectionGroup` type alongside existing types in `types.ts`
- [x] 4.3 Add API wrappers in `src/platform/connection-registry/api.ts`: `connectionGroupsApi.{list,create,update,delete}`, `connectionsApi.move`
- [x] 4.4 Confirm existing `create`/`update` wrappers accept (or are extended to accept) the new optional `group_id` parameter on create

## 5. Frontend: state / context

- [x] 5.1 Add `useConnectionGroups` context in `src/platform/connection-registry/useConnectionGroups.tsx` mirroring the shape of `useConnections` (`{ items, loading, error, refresh, create, update, remove }`)
- [x] 5.2 Mount `ConnectionGroupsProvider` next to `ConnectionsProvider` at the app root
- [x] 5.3 Extend `useConnections` with a `move(id, group_id, sort_order)` mutation that calls `connectionsMove` and refetches both stores
- [x] 5.4 Add a small helper `computeMidpointSortOrder(prev?: number, next?: number): number` for fractional-index inserts (used by drag-and-drop drop handlers)
- [x] 5.5 Add a tiny `useExpandedGroups` hook backed by `localStorage` keyed `connection-groups.expanded.<group_id>`

## 6. Frontend: drag-and-drop dependency

- [x] 6.1 Add `@dnd-kit/core` and `@dnd-kit/sortable` to `package.json`
- [x] 6.2 Run `pnpm install` and verify the lockfile

## 7. Frontend: sidebar render

- [x] 7.1 Refactor `ConnectionsSection` in `src/platform/shell/Sidebar.tsx` to read both `useConnections` and `useConnectionGroups`
- [x] 7.2 Render groups in `connection_groups.list` order; under each group render its member connections in `sort_order`; render an "Ungrouped" sentinel section last only if any connection has `group_id === null`
- [x] 7.3 Add chevron + member count when collapsed; persist expand/collapse via `useExpandedGroups`
- [x] 7.4 Wire `@dnd-kit` `DndContext` + `SortableContext` for connections (one context per group, including the ungrouped sentinel) and a separate `SortableContext` for the group list
- [x] 7.5 On drop: compute the new `sort_order` via `computeMidpointSortOrder` and call `connections.move` (for connection drops) or `connection_groups.update` (for group drops)
- [x] 7.6 Add per-row drag handles that appear on hover; rows remain keyboard-navigable (KeyboardSensor + sortableKeyboardCoordinates)
- [x] 7.7 Add a screen-reader live region that announces "Moved <connection-name> to <group-name>, position <n>" after each drop
- [x] 7.8 Replace the existing `+` "New connection" button with a small dropdown: `New connection` / `New group`. Wire `New group` to a Dialog rename-on-create flow
- [x] 7.9 Add per-group `⋯` overflow menu: Rename, Sort alphabetically, Delete
- [x] 7.10 Implement Sort alphabetically: read members, sort case-insensitive by name, rewrite their `sort_order` via batched `connections.move` calls
- [x] 7.11 Implement Delete: confirm if non-empty; call `connection_groups.delete`; refetch
- [x] 7.12 Existing per-connection context menu (Edit, Duplicate, Delete, "New SQL Query") still works; "Move to group ▸" submenu added with existing groups + Ungrouped target

## 8. Compatibility verification

- [x] 8.1 Cmd+P `TablePalette`: audit confirms it filters by `activeIds.map(a => a.id)` and doesn't depend on group_id or alphabetical order
- [x] 8.2 Schema browser subtree: audit confirms `SchemaTree` renders per-connection, isolated from sidebar grouping; `.groupBody` has no stacking/scroll concern
- [x] 8.3 Active-connection violet stripe: dot is on `ConnectionRow`, not on `GroupHeader`; preserved
- [ ] 8.4 Manual smoke test: create 3 groups, drag connections between them, restart the app, verify order persists *(deferred — covered by `fix-cross-group-dnd` section 8 after the cross-section DnD fix lands)*

## 9. Tests and docs

- [x] 9.1 Vitest: tests for `computeMidpointSortOrder` (empty, single neighbor, both neighbors, precision-degraded tail) — 5 tests
- [x] 9.1b Vitest: tests for `useExpandedGroups` (defaults, localStorage roundtrip, toggle, setExpanded, independence) — 5 tests
- [ ] 9.2 Vitest: render `ConnectionsSection` with a fixture covering grouped + ungrouped, collapsed + expanded; assert correct DOM structure and ARIA attributes *(deferred — requires mocking many providers; better verified via the existing manual smoke test loop in the dev shell)*
- [ ] 9.3 Vitest: drag-and-drop interaction test (using `@dnd-kit`'s test utilities) for "move between groups" and "reorder within group" *(deferred — `@dnd-kit` pointer-event simulation is brittle in jsdom; deferred to integration / Playwright. Logic is covered by `sortOrder.test.ts` plus Rust integration tests for `connections_move`.)*
- [x] 9.4 No `DESIGN.md` update required — no new visual conventions: group header uses existing typography tokens, count pill uses existing `--surface-2` + radius-full pattern, drag handle is a standard hairline icon
- [ ] 9.5 Update the connection-registry purpose/spec text once the change is archived (per archive note in existing spec) *(archive-time task — done by `/opsx:archive`)*
