## Why

Argus today is a single window whose left sidebar mixes two concerns: the list of *all saved connections* and the *schema tree* of every connection the user has activated. With several connections active, all their trees stack up in the same sidebar (issue #146); and ⌘P searches tables across every active connection at once (issue #147). Both are symptoms of one missing idea — **a single connection "in focus."**

TablePlus solves this with two windows: a connections picker, and a workspace that shows exactly one connection at a time with a rail to rotate between the ones that are open. We adopt that model. Once focus is structural rather than incidental, #146 and #147 dissolve by construction: connections (the rail, level 1) and tables (the tree, level 2) live at different levels, so you never see two connections' tables at once, and ⌘P naturally scopes to the connection in focus.

## What Changes

- The app becomes **two windows with fixed roles**: a **Connection Manager** window (the "home"/picker) and a single **Workspace** window.
- The **Manager** owns *all* connection management — the full saved-connection list, groups, drag-drop ordering, the kind picker, create/edit/delete forms, and context-folder linking. It shows each connection's open/closed state. Opening a connection sends it to the Workspace.
- The **Workspace** has a left **connection rail** (level 1) listing only the *currently-open* connections, each an engine icon + environment-color chip. The selected rail item is the **focused connection**. Level 2 (the schema tree) shows only the focused connection's objects. Query tabs are scoped to the focused connection — switching the rail swaps the visible tab set.
- **⌘P** (table quick-switcher) defaults to the focused connection only; a modifier opens it scoped to **all open connections**.
- **Window lifecycle**:
  - Cold start opens the **Manager only**; nothing is auto-connected.
  - Opening the first connection spawns the Workspace; opening an already-open connection just focuses it in the rail (never duplicated).
  - Closing the **Workspace** disconnects **all** open connections and reveals/focuses the Manager. When more than one connection is open, a confirmation prompt (naming the count) appears first; cancelling aborts the close.
  - Closing the **Manager** while a Workspace exists keeps the Workspace; the rail's **"+"** reopens/focuses the Manager.
  - Closing the **last** open connection in the rail closes the Workspace and focuses the Manager.
  - A connection can be closed from **either** window.
- The current single sidebar is **split**: the connection-list section (and its CRUD + kind picker) moves to the Manager; the per-connection schema subtree moves to the Workspace, rendered once for the focused connection.
- Tabs become **connection-scoped** instead of one global flat list.
- The backend is unchanged: both windows invoke the same Tauri commands against the shared Rust registries (pools, SQLite, keychain, context watchers); a connection's pool is reused across windows, never duplicated.

## Capabilities

### New Capabilities

- `dual-window-shell`: the two-window topology — window types and routing, startup, lifecycle rules, the open/focus coordination protocol between Manager and Workspace, the cross-window "open connections" source of truth, and shared-backend reuse.
- `connection-rail`: the Workspace's level-1 rail of open connections — focus selection, engine icon + environment color, close-from-rail, the "+" that reopens the Manager, and the rule that the focused connection drives the schema tree, the visible tab set, and ⌘P scope.

### Modified Capabilities

- `app-shell`: the single-window requirement becomes two window types; the four-region layout and tab system apply to the Workspace; tabs become connection-scoped; base keyboard shortcuts gain ⌘P focused-scope plus a global modifier and are partitioned by window; the connection kind picker and the connection-list section move to the Manager; sidebar subtree hosting moves to the Workspace.
- `table-quick-switcher`: the index scopes to the focused connection by default, with a modifier to search across all open connections.

### Unchanged (UI relocated only — no spec delta)

- `connection-registry`, `connection-groups`: their backend commands and data model are untouched. Only the UI that drives them relocates to the Manager window.

- **Design polish (post-QA):**
  - The **Manager** reads as a deliberate connection *picker* (à la the TablePlus welcome window), not the sidebar transplanted into a full window: a compact picker-appropriate default window size, a scannable connection list with comfortable row widths (name + host/subtitle + environment + engine icon + open/closed state), all within the `DESIGN.md` system (Geist, `--accent` violet, `--surface`/`--elevated`, restrained).
  - The **Workspace** makes the focused connection's **identity legible at a glance** — not only the engine icon. The connection's name (and environment) is shown without requiring hover, so the user can tell *which* Postgres/Dynamo/etc. they're looking at.

## Impact

- **New backend surface** (`src-tauri`):
  - A cross-engine **open-connections registry** + `connections_open_list()` command and a `connections:open-changed` event so both windows agree on what is open. Consolidates today's per-engine `*:active-changed` events.
  - A `workspace_open_connection(id)` command that ensures the connection is open, ensures the Workspace window exists, focuses it, and emits `workspace:focus-connection`.
  - Window creation via `WebviewWindowBuilder` with stable labels (`manager`, `workspace`); `tauri-plugin-window-state` persists each window's geometry by label.
  - `tauri.conf.json`: the static single-window config becomes a `manager` window at startup; the Workspace is created on demand.
- **Frontend routing** (`src/main.tsx`, `src/app/App.tsx`): branch on the window label to mount `ManagerApp` or `WorkspaceApp`, each with its own provider subset.
- **Manager window**: extracts the connection-list UI from `src/platform/shell/Sidebar.tsx` / `ConnectionsSection` / `ConnectionRow.tsx` (header + state + actions, **without** the inline subtree) plus groups (`useConnectionGroups`, `useExpandedGroups`), the kind picker, all form providers, and context-folder linking.
- **Workspace window**: new `ConnectionRail` + a `focusedConnectionId` store; the existing per-engine schema subtrees (`SchemaTree`, `MysqlSchemaTree`, `MssqlSchemaTree`, `DynamoConnectionSubtree`, `AthenaSchemaTree`) re-mount under the focused connection rather than per active row.
- **Tabs refactor** (`src/platform/shell/tabs/TabsContext.tsx`): from one flat `{tabs, activeTabId}` to per-connection tab sets keyed by `connectionId`; the visible set follows `focusedConnectionId`. All `openObjectTab` / `open(...)` call sites get a connection scope.
- **⌘P** (`src/platform/command-palette/useTableIndex.ts`, `TablePalette.tsx`, `App.tsx`): index filtered to the focused connection by default; a global-scope entry via a modifier.
- **Decoupling** `ConnectionRow.tsx:733-798`: the header↔subtree coupling is broken so the header lives in the Manager and the subtree in the Workspace.
- **Cross-window UI sync**: theme and AI-settings changes must propagate to both windows (Tauri events already exist for AI settings; theme needs the same treatment).
- **No data migration**; this is a major UX change shipped as a normal version bump.
