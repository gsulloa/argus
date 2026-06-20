## Why

The dual-window shell (#152) split the UI into a Connection Manager and a Workspace. The new Workspace sidebar represents the focused connection with `ConnectionIdentityHeader` + `ConnectionSubtree`, but the header only shows identity (name/engine/env) — it does **not** render the per-engine contextual actions (New SQL query, Refresh schemas, visible-schemas picker, Refresh tables) that previously lived in the connection row's `rowPrimary`/`rowToolbar` slots. As a result, in the Workspace there is no in-sidebar way to open a new query, refresh the schema, or pick visible schemas for Postgres, MySQL, MSSQL, Athena, or DynamoDB — a regression from the pre-#152 experience.

## What Changes

- Add a per-engine **contextual actions slot** to `ConnectionIdentityHeader` (Workspace sidebar), right-aligned within the header.
- Introduce a `ConnectionHeaderActions` dispatcher (parallel to the existing `ConnectionSubtree`) that switches on `connection.kind` and renders each engine's existing primary + toolbar action components, reused unchanged:
  - **PostgreSQL** — `SchemaPrimaryActions` (New SQL query) + `SchemaToolbar` (Refresh + `VisibleSchemasPicker`)
  - **MySQL** — `MysqlSchemaPrimaryActions` (New SQL query) + `MysqlSchemaToolbar` (Refresh + `VisibleSchemasPicker`)
  - **MSSQL** — `MssqlSchemaPrimaryActions` (New SQL query) + `MssqlSchemaToolbar` (Refresh + `VisibleSchemasPicker`)
  - **Athena** — `AthenaSchemaPrimaryActions` (New SQL query) + `AthenaSchemaToolbar` (Refresh)
  - **DynamoDB** — `DynamoRefreshButton` (Refresh tables)
- Extract `DynamoRefreshButton` from its inline definition in `ConnectionRow.tsx` into the dynamo module so it can be shared by both the header dispatcher and the existing connection row (single source of truth).
- Add an `.identityActions` slot class to `WorkspaceShell.module.css` that handles spacing for multiple actions, consistent with `DESIGN.md` (icon sizes, hover states, accent).
- **Scope note (CloudWatch):** the issue lists a `CloudwatchInsightsPrimaryAction` "already in the header," but no CloudWatch frontend module, schema tree, or header action exists in the codebase today (the `cloudwatch` kind is a connection type only). CloudWatch is therefore out of scope; the dispatcher's default case renders no actions, leaving room for it later.
- **Scope note (no live duplication):** the new Workspace sidebar does not use `ConnectionRow` — its workspace-mode toolbar (`ConnectionRow.tsx` ~502–620) is reached only by the legacy single-window `app/App.tsx` `Sidebar`. The single-source-of-truth requirement is satisfied without modifying that legacy path; the only shared code is the extracted `DynamoRefreshButton`.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `dual-window-shell`: the Workspace identity header gains a new requirement to expose the focused connection's per-engine contextual actions (open query, refresh schema, visible-schemas picker, refresh tables), matching engine capabilities.

## Impact

- **Code:**
  - `packages/app/src/platform/shell/WorkspaceShell.tsx` (`ConnectionIdentityHeader`) — render the actions slot.
  - New `packages/app/src/platform/shell/ConnectionHeaderActions.tsx` — per-engine dispatcher.
  - `packages/app/src/platform/shell/WorkspaceShell.module.css` — `.identityActions` slot styles.
  - `packages/app/src/platform/shell/ConnectionRow.tsx` + dynamo module — extract/export `DynamoRefreshButton`.
- **APIs / backend:** none — purely frontend; reuses existing tab-open, refresh, and schema-tree hooks.
- **Dependencies:** none.
- **Tests:** new tests for the header dispatcher (per-engine action presence + default empty case); existing `ConnectionRow`/`WorkspaceShell` tests must remain green.
