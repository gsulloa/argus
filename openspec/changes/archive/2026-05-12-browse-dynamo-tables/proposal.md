## Why

Change #9 (`add-dynamo-connection`) shipped the ability to register and open a real DynamoDB client, but the sidebar today shows a Dynamo connection row with nothing under it — connecting succeeds, and then the user is staring at an inert dot. To make Dynamo connections actually navigable (and to unlock #11 `view-dynamo-items`), Argus needs to list the tables in the account/region and surface the table metadata that matters before clicking in: key schema, secondary indexes, billing mode, stream state, item count.

This change adds that browse layer. It is the Dynamo analogue of `browse-postgres-schema`, but with the simpler shape DynamoDB actually has: no schemas, a flat list of tables, and per-table metadata that is one `DescribeTable` away.

## What Changes

- New `src/modules/dynamo/tables/` and `src-tauri/src/modules/dynamo/tables/` (folder layout consistent with the existing Dynamo module). **No code under `src/modules/postgres/` or `src-tauri/src/modules/postgres/` is touched.**
- New Tauri commands:
  - `dynamo.listTables(connectionId, { paginationToken?, cap? }) -> { tables: string[], nextToken?: string, truncated: boolean }` — paginates the AWS API's 100/page limit up to a configurable cap (default 1000), returning whether the result was truncated.
  - `dynamo.describeTable(connectionId, tableName) -> TableDescription` — typed envelope with `keySchema`, `attributeDefinitions`, `globalSecondaryIndexes`, `localSecondaryIndexes`, `itemCount`, `tableSizeBytes`, `billingMode` (`"PROVISIONED" | "PAY_PER_REQUEST"`), `streamSpecification` (or null), `tableStatus`, `creationDateTime`.
- A flat sidebar subtree rendered under each **active** Dynamo connection row (mirroring how the Postgres schema tree appears only when connected). The subtree is one level deep: connection → tables. There is no schema level — DynamoDB does not have one.
- Per-table indicators on each leaf node:
  - `on-demand` or `provisioned` badge from `billingMode`.
  - `streams` icon-badge when `streamSpecification.streamEnabled` is true.
  - `GSI×N` badge when `globalSecondaryIndexes.length > 0`.
- Local search box at the top of each connection's table subtree filtering by case-insensitive substring against the table name. Search MUST NOT call the API.
- Per-connection in-memory cache of `listTables` results and per-table `describeTable` results. Cache invalidates:
  - On user-triggered refresh (a refresh icon in the connection-row toolbar and a `Tables: Refresh` palette command).
  - On `dynamo:active-changed` reporting the connection as no longer active (mirrors the Postgres cache behavior on disconnect).
  - On `dynamo:credentials-refreshed` for the given id (the new client may see different tables).
- Clicking a table node opens or focuses a center-area tab of kind `dynamo-table-placeholder` with payload `{ connectionId, tableName, describe }` — the real viewer ships with change #11; this placeholder is the seam.
- Palette commands `Tables: Refresh` (drops the focused connection's table cache and re-fetches) and `Tables: <query>` filter as part of the `⌘K` palette so the user can jump to a table from anywhere. When no Dynamo connection is focused, the palette transitions to a chooser.
- Right-click context menu on a table node: `Open` (same as click), `Copy table name`, `Copy ARN` (uses `describeTable`'s `tableArn`). No DDL: create/drop/alter belong to a future `dynamo-create-table` crossroads.

## Capabilities

### New Capabilities

- `dynamo-table-browser`: `listTables` + `describeTable` commands with pagination cap, per-connection table tree under the sidebar Dynamo connection row, indicators (billing/streams/GSI), local search, in-memory cache and invalidation rules, click-to-placeholder tab, refresh affordances, palette `Tables: …` commands.

### Modified Capabilities

- `app-shell`: The `Sidebar sections may host hierarchical subtrees` requirement is extended so the existing `SidebarTree` primitive supports a **flat (single-level)** tree under a connection row, in addition to the multi-level Postgres tree it already supports. No new primitive is added; the existing one already handles arbitrary depth — what changes is the documented contract that 1-level depth (used by Dynamo) is a supported shape and shares the sidebar's single scroll context exactly like the Postgres subtree does.

> Note: `dynamo-connection` is **not** modified. Its existing requirements (`Connect command and client registry`, `Active connections enumeration and event`, etc.) already give us everything the table browser needs (active client lookup, `dynamo:active-changed` event, `dynamo:credentials-refreshed` event, `needs_credentials` flag). The new commands live in the new `dynamo-table-browser` capability and reuse the registry via the same internal helper pattern Postgres uses for `pool.rs`.

## Impact

- **Code**:
  - New: `src/modules/dynamo/tables/` (sidebar subtree component, table-node renderer, search box, cache hook, types, errors, palette command registration), `src-tauri/src/modules/dynamo/tables/` (`mod.rs`, `commands.rs`, `list.rs`, `describe.rs`, `types.rs`).
  - Modified: `src/platform/shell/ConnectionRow.tsx` only to host the Dynamo subtree under the row when the connection is active (analogous to how it hosts the Postgres schema tree today), and `src-tauri/src/lib.rs` to register the two new commands in `invoke_handler!`. No other Postgres files are touched.
- **APIs**: 2 new Tauri commands under `dynamo.*`. No existing command signatures change.
- **Dependencies**: none new. `aws-sdk-dynamodb` (already pinned in #9) covers both endpoints. `SidebarTree` already exists in `app-shell`.
- **Storage**: no new SQLite tables, no new keychain entries. Only an in-memory cache. Two new `settings` keys: `dynamoTablesSearch:<connectionId>` (last-typed search; convenience, optional to persist) and `dynamoTablesCap:<connectionId>` (per-connection override of the default 1000 cap, advanced).
- **Activity log**: each `listTables` and `describeTable` call emits exactly one `argus:activity-log` event with `kind: "list_tables" | "describe_table"`, `connection_id`, `origin: "auto"`, `metric: { kind: "items", value: <count> }` (count = tables for list, `1` for describe), and `status` matching the result. Origin is `"user"` when the call was triggered by an explicit refresh or palette command.
- **Out of scope** (per ROADMAP §10): editing the table structure (DDL), deleting tables, CloudWatch metrics, scan/query of items (change #11), edit of items (change #12), PartiQL (change #13). The right-click menu intentionally does not include `New PartiQL Query` because the editor lands in #13.
