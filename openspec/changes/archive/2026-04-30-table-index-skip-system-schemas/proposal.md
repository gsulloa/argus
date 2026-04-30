## Why

The new ⌘P table quick-switcher eager-loads `listRelations` for every cached schema on first open. Postgres exposes a `pg_temp_N` schema per backend session — on a busy database that's hundreds of schemas, all empty from the user's perspective. Firing one `listRelations` per schema saturates the connection pool, every query stalls 40–45 s waiting for a connection, and the database appears to collapse while delivering exactly nothing useful.

## What Changes

- The table-index eager loader and the rendered table list MUST skip system schemas (`information_schema` and any schema name starting with `pg_`).
- Reuse the existing `isSystemSchema()` helper in `globalSchemaCache.ts` — no new heuristic.
- No backend, no Tauri command, no cache shape changes. Pure UI filter at the index layer.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `table-quick-switcher`: the eager loader and the rendered list MUST exclude system schemas, so a connection with hundreds of `pg_temp_*` schemas does not produce hundreds of empty `listRelations` calls.

## Impact

- **Affected code**:
  - `src/platform/command-palette/useTableIndex.ts` — filter system schemas in both the `flatten()` traversal and the eager-load loop.
- **No backend changes**.
- **No storage / persistence changes**.
- **Dependency on `table-quick-switcher`**: this change modifies a capability introduced by the sibling `table-quick-switcher` change. It must land alongside or after it.
