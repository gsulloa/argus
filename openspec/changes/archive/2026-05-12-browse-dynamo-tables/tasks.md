## 1. Backend module scaffolding

- [x] 1.1 Create `src-tauri/src/modules/dynamo/tables/` with `mod.rs`, `commands.rs`, `list.rs`, `describe.rs`, `types.rs`
- [x] 1.2 In `types.rs` define `TableDescription`, `GsiInfo`, `LsiInfo`, `StreamSpecificationInfo` with snake_case `serde` derives matching the `dynamo-table-browser` spec exactly
- [x] 1.3 Register the new `tables` submodule in `src-tauri/src/modules/dynamo/mod.rs`
- [x] 1.4 Confirm no edits required in `src-tauri/src/modules/postgres/**` (sanity check before touching anything else)

## 2. `dynamo.listTables` command

- [x] 2.1 In `list.rs`, implement the internal pager: loop `ListTables` with `Limit=100`, follow `LastEvaluatedTableName`, stop when AWS returns no token or the configured cap is reached
- [x] 2.2 Implement `cap` resolution: per-call `cap` arg → setting `dynamoTablesCap:<connectionId>` → default 1000
- [x] 2.3 Implement `paginationToken` resume by passing it as `ExclusiveStartTableName` on the first internal request
- [x] 2.4 Return `{ tables, nextToken, truncated }` shape; ensure `nextToken` is omitted (not `null`) when `truncated: false`
- [x] 2.5 In `commands.rs`, wire the `dynamo.listTables` Tauri command: look up the client in `DynamoClientRegistry`, return `AppError::NotFound` when absent
- [x] 2.6 Map `ExpiredToken*` errors through the existing credential-expiration helper from the `dynamo-connection` module so `needs_credentials` and client eviction happen the same way as on other commands
- [x] 2.7 Emit exactly one `argus:activity-log` event with `kind: "list_tables"`, `origin` from the caller, `metric: { kind: "items", value: tables.len() }` on ok / `null` on err, `duration_ms` covering the full pagination
- [x] 2.8 Register `dynamo.listTables` in `src-tauri/src/lib.rs`'s `invoke_handler!`

## 3. `dynamo.describeTable` command

- [x] 3.1 In `describe.rs`, implement the single `DescribeTable` call against the registered client
- [x] 3.2 Map the AWS response into the `TableDescription` envelope; collapse `StreamSpecification` to `None` when `StreamEnabled` is `false` or the field is absent
- [x] 3.3 Surface `ResourceNotFoundException` as `AppError::Aws { code: "ResourceNotFoundException", ... }`
- [x] 3.4 In `commands.rs`, wire `dynamo.describeTable`: registry lookup, NotFound when absent, credential-expiration mapping as in 2.6
- [x] 3.5 Emit one `argus:activity-log` event with `kind: "describe_table"`, `metric: { kind: "items", value: 1 }` on ok
- [x] 3.6 Register `dynamo.describeTable` in `src-tauri/src/lib.rs`'s `invoke_handler!`

## 4. Frontend module scaffolding

- [x] 4.1 Create `src/modules/dynamo/tables/` with subfolders `commands/`, `cache/`, `sidebar/`, `palette/`, `tab/`, plus a `types.ts`, `errors.ts`, and `index.ts`
- [x] 4.2 In `types.ts` declare TypeScript mirrors of `TableDescription`, `GsiInfo`, `LsiInfo`, `StreamSpecificationInfo` matching the backend snake_case wire format
- [x] 4.3 In `commands/index.ts` add typed `invoke` wrappers for `dynamo.listTables` and `dynamo.describeTable`
- [x] 4.4 Confirm no edits required in `src/modules/postgres/**`

## 5. Frontend cache provider

- [x] 5.1 In `cache/CacheProvider.tsx` implement a React context exposing `{ tables, describe, refresh, status }` per connection id (state machine per the `Frontend table cache` requirement)
- [x] 5.2 On first hook subscription for a connection id, fire `dynamo.listTables(id, {})` with activity-log `origin: "auto"`; flip `tables.status` `idle → loading → ready | error`
- [x] 5.3 Implement `refresh(id)`: drop cache and re-fire `listTables` with `origin: "user"`
- [x] 5.4 Subscribe to `dynamo:active-changed` events; on a connection becoming inactive, drop its cache entries
- [x] 5.5 Subscribe to `dynamo:credentials-refreshed` events; on `{ id }`, drop that id's cache and re-fire `listTables` only if the subtree for it is currently mounted
- [x] 5.6 Implement the describe dispatcher: queue of pending table names with parallelism cap 8, fed by viewport visibility (driven by the `SidebarTree` virtualizer's visible-range callback)
- [x] 5.7 Implement per-table retry: a single API `retryDescribe(connectionId, tableName)` that re-queues one name regardless of the dispatcher state

## 6. Sidebar subtree under each active Dynamo connection

- [x] 6.1 In `sidebar/DynamoConnectionSubtree.tsx` render the subtree only when the connection is in `useActiveConnections()` and report its `tableName` rows to `SidebarTree`
- [x] 6.2 Configure `SidebarTree` with depth 1 (no group nodes); ensure the tree shares the sidebar scroll context (consumes the shared scroll element from `app-shell`)
- [x] 6.3 Implement the leaf node renderer with name + indicator slot (fixed-width placeholder until describe arrives)
- [x] 6.4 Implement the three badges (`on-demand`/`provisioned`, streams icon with tooltip, `GSI×N`) per the spec
- [x] 6.5 Implement the non-`ACTIVE` status badge in the warning tone
- [x] 6.6 Wire the virtualizer visible-range callback to the cache provider's describe dispatcher
- [x] 6.7 In `src/platform/shell/ConnectionRow.tsx`, dispatch by `kind`: render `DynamoConnectionSubtree` for active rows whose `kind === "dynamodb"`. Do NOT modify the Postgres path beyond placing the new branch alongside it
- [x] 6.8 Render a refresh icon button in the connection row's toolbar slot only when the Dynamo connection is active; activation calls `refresh(id)` with `origin: "user"`

## 7. Search filter

- [x] 7.1 In `sidebar/TableSearchInput.tsx` implement a controlled input above the leaf list; case-insensitive substring filter against the cached names
- [x] 7.2 Highlight matching substring in each visible leaf's rendered name
- [x] 7.3 Render the `7 of 50` match-count indicator inline in the input
- [x] 7.4 Render the "No tables match" inline hint when the filter excludes every name
- [x] 7.5 Esc clears the input when focused
- [x] 7.6 Mirror the current input text to setting `dynamoTablesSearch:<connectionId>` (best-effort; never blocks render) and restore it on mount

## 8. Truncated load-more affordance

- [x] 8.1 When `tables.truncated === true`, render a non-leaf "Showing first N of more — Load more" row at the bottom of the leaf list
- [x] 8.2 Wire activation to call `dynamo.listTables(id, { paginationToken: nextToken, cap })` and append the result to the cache (updating `nextToken`/`truncated`)
- [x] 8.3 Verify the load-more row remains visible after a follow-up that itself returns `truncated: true`

## 9. Placeholder tab kind

- [x] 9.1 In `tab/registerKind.ts` register the `dynamo-table-placeholder` tab kind with the platform tab registry, payload `{ connectionId, connectionName, tableName, describe: TableDescription | null }` and stable id `dynamotbl:<connectionId>:<tableName>`
- [x] 9.2 In `tab/PlaceholderTab.tsx` render a read-only inspection view (key schema, attribute definitions, GSIs/LSIs, billing mode, stream state, item count, ARN)
- [x] 9.3 When the tab opens with `describe: null`, the renderer MUST invoke `dynamo.describeTable(id, tableName)` itself and render on arrival
- [x] 9.4 Add a "Refresh metadata" button that re-fires `dynamo.describeTable` for the single table
- [x] 9.5 Wire leaf-node activation in `DynamoConnectionSubtree` to open or focus this tab kind (single click, double click, Enter all equivalent)

## 10. Right-click context menu on leaves

- [x] 10.1 Implement the menu with three items: `Open`, `Copy table name`, `Copy ARN`
- [x] 10.2 `Copy ARN` prefers the cached `describe.tableArn`; when missing, reconstructs locally as `arn:aws:dynamodb:<region>:<accountId>:table/<tableName>` using the active client envelope's `region` and `accountId`
- [x] 10.3 Use the existing context-menu primitive from the sidebar so spacing and keyboard handling match Postgres rows

## 11. Palette commands

- [ ] 11.1 Register `Tables: Refresh` in the `command-palette` registry with `group: "Tables"` and `keepOpen: true`; when no Dynamo connection is focused, present an inline chooser listing currently connected Dynamo connections (selection runs the refresh) — **implemented with toast fallback, not inline chooser; see report**
- [x] 11.2 In `palette/dynamicCommands.ts`, register one `Command` per cached table when a cache enters `status: "ready"` and when load-more appends new names; ids follow `argus.dynamo.openTable:<connectionId>:<tableName>`, label `<connectionName> · <tableName>`, `group: "Tables"`, `keywords: [connectionName, tableName, "dynamo"]`
- [x] 11.3 Unregister those dynamic commands when the cache is dropped (disconnect, refresh, credentials refresh) so they disappear from the palette in lockstep
- [x] 11.4 Activation of a dynamic command opens or focuses the placeholder tab via the same handler the sidebar leaf uses

## 12. app-shell delta — flat subtree shape

- [x] 12.1 Verify the existing `SidebarTree` primitive already supports depth 1 with no behavior changes required; if anything in the primitive treats depth 1 as a special case, generalize to remove that special case
- [x] 12.2 Confirm `ARIA tree`/`treeitem` semantics still hold when every node is a leaf
- [x] 12.3 Confirm the shared sidebar scroll context behaves identically for flat subtrees as for multi-level ones
- [ ] 12.4 Update `openspec/specs/app-shell/spec.md` requirement "Sidebar sections may host hierarchical subtrees" via the delta in this change at archive time

## 13. Tests

- [x] 13.1 Backend: add unit test for the `listTables` pager covering single-page, multi-page-under-cap, cap-reached-with-token, and resume-from-token cases (mocked AWS client)
- [x] 13.2 Backend: add unit test for `describeTable` envelope mapping for an `ACTIVE` on-demand table with streams + 1 GSI
- [x] 13.3 Backend: add unit test verifying `ResourceNotFoundException` round-trips as `AppError::Aws` with the correct code
- [x] 13.4 Backend: add unit test verifying both commands return `AppError::NotFound` when the client is not registered, with no AWS call attempted
- [x] 13.5 Frontend: add integration test for the cache provider's drop-on-disconnect behavior using a fake `dynamo:active-changed` emission
- [x] 13.6 Frontend: add integration test for the cache provider's drop-on-credentials-refresh behavior
- [x] 13.7 Frontend: add component test for the search filter (substring highlight, match count, Esc clears)
- [x] 13.8 Frontend: add component test for the truncated load-more affordance (initial render, append on activation, persists when follow-up is also truncated)
- [x] 13.9 Frontend: add component test for the describe pipeline parallelism cap (at most 8 in-flight per connection)

## 14. Activity log + telemetry verification

- [x] 14.1 Verify exactly one `argus:activity-log` event per `listTables` and `describeTable` call by exercising both success and failure paths in dev
- [x] 14.2 Confirm the `origin` field is `"user"` for refresh-icon and palette-triggered calls and `"auto"` for initial mount and viewport-driven describes

## 15. Manual QA

- [x] 15.1 Connect to a real DynamoDB account with ≤ 20 tables; verify subtree appears, badges populate, click opens placeholder tab
- [x] 15.2 Connect to a DynamoDB account with > 1000 tables (or temporarily lower `dynamoTablesCap` to force truncation); verify the load-more affordance behaves correctly and that subsequent pages append
- [x] 15.3 Verify the search filter highlights matches and clears on Esc
- [x] 15.4 Verify the refresh icon drops the cache (badges flash to placeholder, then re-populate)
- [x] 15.5 Verify the right-click menu's `Copy ARN` works both before and after describe completes for the same leaf
- [x] 15.6 Verify expired session-token mid-browse triggers the existing re-prompt flow without losing the subtree state (subtree shows the cached names until reconnect; on `credentials-refreshed` it re-lists)
- [x] 15.7 Verify a Postgres connection in the same window is visually and behaviorally unchanged

## 16. Docs

- [x] 16.1 Update `openspec/ROADMAP-DYNAMO.md` to mark change #10 as ✅ once the change is archived (handled by `/opsx:archive` flow, but call it out in the proposal-to-apply handoff)
