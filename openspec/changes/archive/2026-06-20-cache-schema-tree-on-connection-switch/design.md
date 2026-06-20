## Context

In the dual-window shell the Workspace sidebar renders `ConnectionSubtree` only for the **focused** connection (`WorkspaceSidebar` → `ConnectionSubtree connectionId={focusedConnectionId}`). Switching focus in the rail unmounts the previous tree and mounts the new one.

The caching landscape differs by engine:

- **Postgres / MySQL / MSSQL** — each `SchemaTree` mount creates a fresh `useSchemaTree(connectionId)` instance. The reducer starts at `schemasState: "idle"` and its mount effect fires `listSchemas` (then eager `listRelations` for visible schemas). A process-wide `globalSchemaCache` already stores `schemas`, `relationsBySchema`, and bulk columns per connection — but the reducer is **never seeded from it on mount**, so refocusing always refetches.
- **DynamoDB** — `useDynamoTableCache` is a provider mounted above the subtree, so its cache **already survives** unmount/remount (the spec has a "Re-mount uses cache, no new listTables call" scenario). It lacks only TTL-based staleness and the global accelerator.
- **Athena** — `AthenaSchemaTree` keeps relations/columns in local `useState` plus an `athenaSchemaCache`; refocus loses the local state and re-expands trigger refetch.

Existing refresh affordances: per-engine `Schema: Refresh` palette command + a hover refresh button in each tree toolbar; Athena dispatches an `athena:schema-refresh` window event. There is **no** `Cmd+R` accelerator (`useShortcuts` registers `⌘K/⌘P/⌘W/⌘\\/⌘,` etc.).

## Goals / Non-Goals

**Goals:**
- Refocusing an already-loaded connection renders its schema/table tree **instantly with no IPC refetch**, for all five engines.
- Cached entries carry a timestamp; after a ~1h TTL the next refocus serves the stale tree immediately and refreshes in the background.
- A global `Cmd+R` / `Ctrl+R` accelerator in the Workspace forces a reload of the focused connection's tree, mirroring the existing per-tree refresh button.
- Caches stay in memory only (no disk persistence), consistent with current behavior.

**Non-Goals:**
- Keeping every open connection's subtree permanently mounted (rejected approach — see Decisions).
- Changing any backend/IPC command or its SQL.
- TTL-refreshing lazily-loaded slots that the user never re-expands (`structure`, per-table `tableExtras`); these keep their existing first-need-then-cache behavior.
- Persisting schema data across app restarts.
- A user-configurable TTL setting (the 1h window is a constant in v1).

## Decisions

### D1 — Seed local state from the global cache on mount (SQL engines), not keep-all-mounted

For Postgres/MySQL/MSSQL, `useSchemaTree`'s mount effect SHALL consult `globalSchemaCache` before issuing `listSchemas`. If a fresh entry exists, the reducer initializes directly to `schemasState: "loaded"` (and seeds already-cached `relations` slots to `loaded`) with **no IPC call**. If the entry is missing or stale, behavior falls back to the current fetch path (stale entries serve cached data first — see D3).

*Alternative considered — Approach #1 (keep all open subtrees mounted, toggle visibility like `TabContent`).* Rejected as the primary mechanism: it grows DOM and live reducer/effect state unbounded with the number of open connections, duplicates the `TabContent` complexity in the sidebar, and still wouldn't give us TTL or forced-reload semantics. Seeding reuses the cache that already exists and is O(1) per refocus.

### D2 — Per-entry `fetchedAt` timestamp lives in the global cache

Each per-connection cache (Postgres/MySQL/MSSQL `globalSchemaCache`, `athenaSchemaCache`, `useDynamoTableCache`) records a `fetchedAt` epoch-ms when `recordSchemas` / table-list / relations write succeeds. A shared helper `isStale(fetchedAt, ttlMs)` and a constant `SCHEMA_CACHE_TTL_MS = 60 * 60 * 1000` govern staleness. The timestamp is keyed at the connection's schemas/table-list level (the eager fetch that fires on mount); relations entries inherit freshness from the schemas-level timestamp to keep the model simple.

*Alternative considered — a single global "last refresh" clock.* Rejected: connections are loaded at different times; per-connection timestamps are required for correct per-connection freshness.

### D3 — Stale = serve-then-refresh, never blank

On refocus of a connection whose entry is older than the TTL, the tree SHALL render the cached (stale) data immediately and trigger a **background** refresh (`listSchemas` → eager relations for visible schemas). Success replaces the cache and re-renders; failure keeps the stale data and surfaces the error non-destructively (existing error slot semantics). This avoids a loading flash on every hour-old reconnect.

### D4 — `Cmd+R` routes through a single "refresh focused connection" dispatcher

A new accelerator registered in `WorkspaceShell`'s `useShortcuts` bindings (`{ key: "r", mod: true, whenInInput: false }`) calls a shell-level `refreshFocusedConnection()` that resolves the focused connection's engine and triggers the **same** invalidate-and-reload path as that engine's existing refresh button (drop the connection's cache entry → bump generation / dispatch the engine's refresh event → refetch). The handler MUST `preventDefault` so the Tauri webview's native reload does not fire. This keeps one source of truth per engine for "refresh" and avoids duplicating invalidation logic.

*Alternative considered — bind `Cmd+R` directly inside each tree component.* Rejected: only the focused tree is mounted, but centralizing in the shell keeps the binding independent of which engine is focused and avoids five separate listeners competing.

### D5 — Forced reload bypasses the cache; focus-switch never does

Forced reload (button or `Cmd+R`) and disconnect/credentials-refresh continue to **drop** the cache entry (existing behavior). The only new bypass-free path is the focus-switch remount, which now seeds from cache instead of refetching. The existing invalidation triggers (`Schema: Refresh`, `*:active-changed`, Dynamo `credentials-refreshed`) are unchanged.

## Risks / Trade-offs

- **[Stale data shown for up to ~1h]** → A user could act on schema that changed in the last hour. Mitigation: background refresh on first refocus past TTL, plus always-available `Cmd+R` / refresh button for immediate reload. Schema DDL changes mid-session are rare in normal workflows.
- **[`Cmd+R` collides with webview reload in dev]** → In the dev server `Cmd+R` reloads the page. Mitigation: `preventDefault` in the handler; verify in the packaged app where devtools reload is disabled. Document that the binding is Workspace-scoped.
- **[Background refresh races a manual refresh or a disconnect]** → Mitigation: reuse the existing generation counter / inflight guards in `useSchemaTree` (and the Dynamo inflight set) so a stale-triggered background fetch that resolves after an invalidation is discarded.
- **[Memory growth across a long session]** → `globalSchemaCache` accumulates entries for every connection opened. Mitigation: entries are already dropped on disconnect; bounded by concurrently-open connections, which is small. No new eviction needed.
- **[Per-engine drift]** → Five engines with slightly different cache shapes risk inconsistent behavior. Mitigation: share the `SCHEMA_CACHE_TTL_MS` constant and `isStale` helper; cover seed-on-refocus + TTL + forced-reload with a scenario per engine spec.
