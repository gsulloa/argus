## Context

The dual-window shell (#152) replaced the single-window sidebar with two roles. In the **Workspace** window, `WorkspaceSidebar` (`WorkspaceShell.tsx`) renders the focused connection as:

```
ConnectionRail            // left icon rail of open connections
treeColumn
  ├─ ConnectionIdentityHeader   // name / engine label / env dot — NO actions today
  └─ ConnectionSubtree          // per-engine schema tree dispatcher (switch on kind)
```

`ConnectionRow.tsx` — which still carries per-engine action slots (`.rowPrimary`/`.rowToolbar`, ~lines 502–620) — is **only** used by `ManagerShell` (`mode="manager"`, no toolbar) and the legacy single-window `app/App.tsx` `Sidebar` (`mode="workspace"`). It is **not** rendered in the new Workspace window. So the actions were not "duplicated elsewhere" in the Workspace — they were simply never ported to `ConnectionIdentityHeader`.

`ConnectionSubtree.tsx` already establishes the exact pattern we need: a small component that reads the connection from `useConnections()`, branches on `connection.kind` against the per-engine `*_KIND` constants, and renders reused per-engine components. The action components also already exist and are exported from each module:

| Engine | Primary | Toolbar | Export |
|---|---|---|---|
| Postgres | `SchemaPrimaryActions` | `SchemaToolbar` (incl. `VisibleSchemasPicker`) | `@/modules/postgres` |
| MySQL | `MysqlSchemaPrimaryActions` | `MysqlSchemaToolbar` (incl. `VisibleSchemasPicker`) | `@/modules/mysql` |
| MSSQL | `MssqlSchemaPrimaryActions` | `MssqlSchemaToolbar` (incl. `VisibleSchemasPicker`) | `@/modules/mssql` |
| Athena | `AthenaSchemaPrimaryActions` | `AthenaSchemaToolbar` (refresh only) | `@/modules/athena` |
| Dynamo | — | `DynamoRefreshButton` | **inline in `ConnectionRow.tsx`** (not yet exported) |

Each action component takes `{ connectionId: string }` and self-sources everything it needs (tabs, schema tree, visible-schemas hooks). This makes them drop-in for the header.

## Goals / Non-Goals

**Goals:**
- Expose each engine's contextual actions in the Workspace `ConnectionIdentityHeader`, reusing existing action components unchanged.
- Single source of truth for the dispatch logic and for `DynamoRefreshButton`.
- Match `DESIGN.md` for icon sizing, spacing, hover, and accent in the new header slot.

**Non-Goals:**
- No CloudWatch actions — there is no CloudWatch frontend module/schema tree/action in the codebase; the dispatcher's default case is intentionally empty.
- No change to the Manager window or to the legacy `app/App.tsx` `Sidebar` workspace-mode toolbar (it is a separate, still-functioning code path; touching it risks unrelated test churn).
- No backend changes; no new hooks. Reuse the action components as-is.

## Decisions

### Decision 1: New `ConnectionHeaderActions` dispatcher, parallel to `ConnectionSubtree`

Create `packages/app/src/platform/shell/ConnectionHeaderActions.tsx`:

```tsx
export function ConnectionHeaderActions({ connectionId }: { connectionId: string }) {
  const { items } = useConnections();
  const connection = items.find((c) => c.id === connectionId);
  if (!connection) return null;
  switch (connection.kind) {
    case POSTGRES_KIND:
      return <><SchemaPrimaryActions connectionId={connectionId} /><SchemaToolbar connectionId={connectionId} /></>;
    case MYSQL_KIND:
      return <><MysqlSchemaPrimaryActions connectionId={connectionId} /><MysqlSchemaToolbar connectionId={connectionId} /></>;
    case MSSQL_KIND:
      return <><MssqlSchemaPrimaryActions connectionId={connectionId} /><MssqlSchemaToolbar connectionId={connectionId} /></>;
    case ATHENA_KIND:
      return <><AthenaSchemaPrimaryActions connectionId={connectionId} /><AthenaSchemaToolbar connectionId={connectionId} /></>;
    case DYNAMO_KIND:
      return <DynamoRefreshButton connectionId={connectionId} />;
    default:
      return null; // cloudwatch and any future engine without header actions
  }
}
```

`ConnectionIdentityHeader` renders it inside a new `.identityActions` slot:

```tsx
<span className={styles.identityActions}>
  <ConnectionHeaderActions connectionId={connectionId} />
</span>
```

**Why a dedicated component over inlining the switch in `ConnectionIdentityHeader`?** Keeps `ConnectionIdentityHeader` focused on identity, mirrors the established `ConnectionSubtree` pattern (familiarity, testability in isolation), and gives a single mount point that other header consumers could reuse.

**Alternative considered — a per-engine UI registry** (`kind → { Primary, Toolbar }`). Rejected for this change: the codebase deliberately uses explicit `switch`/conditional dispatch everywhere (`refreshFocusedConnection.ts`, `ConnectionSubtree.tsx`, `ConnectionRow.tsx`). Introducing a registry would be a larger, cross-cutting refactor inconsistent with the surrounding code and out of scope for a regression fix.

### Decision 2: Extract `DynamoRefreshButton` into the dynamo module

`DynamoRefreshButton` is currently defined inline in `ConnectionRow.tsx` (~lines 979–999) and uses `useDynamoTableCache(connectionId)`. Move it to the dynamo module (e.g. `modules/dynamo/tables/DynamoRefreshButton.tsx`, re-exported from `@/modules/dynamo/tables` alongside `DynamoConnectionSubtree`), then import it in both `ConnectionRow.tsx` and `ConnectionHeaderActions.tsx`.

**Why:** avoids duplicating the button (which would violate the issue's single-source-of-truth criterion) and keeps engine-specific UI inside its module, matching how every other engine's actions live in their module.

### Decision 3: MySQL uses the exported `MysqlSchemaPrimaryActions`, not the inline "+ Query" button

`ConnectionRow.tsx` renders MySQL's primary action as an inline `+ Query` button rather than the exported `MysqlSchemaPrimaryActions`. The header will use the **exported component** for parity with Postgres/MSSQL/Athena (Terminal-icon "New SQL query"), giving a consistent header treatment across SQL engines. The legacy row's inline button is left untouched (out of scope).

### Decision 4: `.identityActions` styling

Add to `WorkspaceShell.module.css`:
- `.identityActions { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; margin-left: auto; }` — right-aligns the cluster after the flex-`1` `.identityBody`, matching the `.rowPrimary`/`.rowToolbar` gap conventions.
- The reused action components already carry `toolbarBtn` styling; the header is `8px 10px` tall with the same `--text-muted`/accent tokens, so no per-button restyle is expected. Verify hover states and icon sizes against `DESIGN.md`; the header is always-visible (unlike the row's hover-revealed `.rowToolbar`), which is appropriate for a single focused connection.

## Risks / Trade-offs

- **[Reused components assume a tree-host context]** The toolbar components rely on schema-tree/visible-schemas hooks; in the Workspace they sit above `ConnectionSubtree`, which mounts the same tree — providers are app-level, so context is available. → Verify in the running app that Refresh and the visible-schemas picker drive the `ConnectionSubtree` tree (they target by `connectionId`, so they should). Covered by a manual `/run` check in tasks.
- **[Visual cramping with many actions]** Postgres/MySQL/MSSQL show primary + refresh + picker in a narrow sidebar header. → `.identityActions` uses `flex-shrink: 0` and `margin-left: auto`; `.identityBody` already truncates the name with ellipsis, so the name yields space to the actions. Validate at a narrow sidebar width.
- **[Legacy row path divergence]** Leaving `ConnectionRow`'s workspace-mode toolbar in place means two code locations render engine actions (legacy row vs. header). → Acceptable: they are never both visible in the new dual-window experience, and the only genuinely shared widget (`DynamoRefreshButton`) is deduplicated. A later cleanup can remove the legacy workspace path when `app/App.tsx`'s single-window shell is retired.
- **[Issue premise mismatch — CloudWatch]** The issue assumes CloudWatch is already wired in the header; it is not present at all. → Documented as out of scope; default case renders nothing. No user-facing regression since CloudWatch never had these actions in this codebase.

## Migration Plan

Pure additive frontend change; no data migration. Rollback = revert the commit. No feature flag needed.
