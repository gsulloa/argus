## Why

The sidebar lists every connection in a flat alphabetical roster. As soon as a user keeps connections for several environments and several data sources (Postgres now, DynamoDB and CloudWatch later) that flat list stops scaling — there is no way to separate `prod` from `staging` from `local`, and no way to keep related sources together (e.g. a Postgres and a DynamoDB that both belong to the same product). Folder-style grouping, source-agnostic, gives users a place to organize before the multi-source roadmap lands.

## What Changes

- Introduce **connection groups** as a flat, source-agnostic container. A group is just a labelled folder; it has no `kind`, so a single group can hold a Postgres connection today and a DynamoDB connection in the future.
- Each connection belongs to at most one group (1:N). Connections without a group render as a sentinel "Ungrouped" section at the bottom of the sidebar.
- Connections gain a manual `sort_order` so the user can drag-and-drop to reorder rows inside a group. Groups themselves are also manually ordered. **BREAKING (behavioural):** the default `connections.list` ordering changes from `name` to `sort_order`; on first launch after migration, existing connections get a `sort_order` derived from their alphabetical position so the visible order is unchanged.
- New Tauri commands for group CRUD (`connection_groups.list/create/update/delete`) and a single atomic `connections.move` command that updates `group_id` and `sort_order` together (used by drag-and-drop).
- Deleting a non-empty group moves its members to "Ungrouped" via `ON DELETE SET NULL` — never destroys connections.
- Sidebar gains collapsible group rows with chevron, member count when collapsed, and a `⋯` overflow menu (rename, sort alphabetically, delete). Drag-and-drop moves connections between groups and reorders within a group; a separate handle reorders groups themselves. Expand/collapse state is persisted in `localStorage` keyed by `group_id`.
- The command palette (Cmd+P table switcher) deliberately ignores groups — speed over visual hierarchy.

## Capabilities

### New Capabilities

- `connection-groups`: data model, CRUD commands, ordering primitives, and sidebar rendering for source-agnostic folder-style groups of connections.

### Modified Capabilities

- `connection-registry`: connection envelope gains an optional `group_id`; `connections.list` ordering changes from `name` to `sort_order`; `connections.create` and `connections.update` accept `group_id`; introduces a new `connections.move` command for atomic group/order changes.

## Impact

- **Schema:** new migration `0002_groups.sql` adds the `connection_groups` table and adds `group_id` (FK, `ON DELETE SET NULL`) and `sort_order` (REAL) columns to `connections`.
- **Rust (`src-tauri/src/platform/connections.rs` + new `connection_groups.rs`):** new struct, new commands, updated list/create/update queries.
- **TypeScript (`src/platform/connection-registry/`):** new `useConnectionGroups` context, extended `Connection` type with `group_id`, new API wrappers, new `move` mutation.
- **UI (`src/platform/shell/Sidebar.tsx`):** `ConnectionsSection` rewritten to render groups → connections, with drag-and-drop and expand/collapse. Net new dependency: a small drag-and-drop library (proposing `@dnd-kit/core` + `@dnd-kit/sortable`, ~14 KB, accessibility-friendly).
- **Command palette:** unchanged behavior, but `useActiveConnections` and the Cmd+P palette must keep working when a connection's `group_id` changes mid-session.
- **No keychain changes.** Secrets remain at `service=argus`, `account=connection:<id>`. Groups have no secrets.
- **No breaking IPC for existing callers** beyond the ordering change in `connections.list`.
