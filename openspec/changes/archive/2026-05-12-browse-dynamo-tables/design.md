## Context

Change #9 (`add-dynamo-connection`) shipped a working Dynamo client registry: `dynamo.connect(id)` builds an `aws-sdk-dynamodb` client and stores it in a `DynamoClientRegistry` keyed by connection id, with a read-only snapshot, `dynamo:active-changed` and `dynamo:credentials-refreshed` events, and a `needs_credentials` re-prompt flow. There is no UI under a connected Dynamo row yet — clicking a Dynamo connection lights it up green and that is it. This change fills that gap: a flat tree of tables with per-table metadata indicators, lazy describe, local search, and a single hook into the existing palette.

**Current state worth knowing**:

- `openspec/specs/dynamo-connection/spec.md` defines `dynamo.connect` to return `{ accountId, identityArn, region, readOnly }` and to register a client in `DynamoClientRegistry`. The registry is the single source of truth for whether a Dynamo command can run, and the new `listTables` / `describeTable` commands lookup their client via the same registry.
- `openspec/specs/app-shell/spec.md` defines `SidebarTree` (Requirement: Sidebar tree primitive) and the rule that embedded trees share the sidebar's single vertical scroll context (Requirement: Sidebar sections may host hierarchical subtrees). The Postgres tree is multi-level (schema → groups → relations → indexes/triggers). The Dynamo tree is one level (connection → tables) — but it is structurally the same primitive use, just with a tree of depth 1.
- `openspec/specs/postgres-schema-browser/spec.md` is the closest analogue: per-connection in-memory cache, refresh affordances, click-to-tab. We mirror its shape where it makes sense and diverge where the data model differs.
- `aws-sdk-dynamodb` is already pinned in `src-tauri/Cargo.toml` (shipped with #9). No new SDK or crate is needed.
- `ConnectionRow.tsx` already knows how to host a per-row subtree (Postgres uses it today). Adding a Dynamo subtree under a Dynamo row is a kind-dispatched branch in the same place, not a new shell-level concept.

**Constraints**:

- **Hard isolation from Postgres**: this change MUST NOT edit `src/modules/postgres/**` or `src-tauri/src/modules/postgres/**`. If a primitive is needed, it lives in `src/platform/**` (typically `SidebarTree` is already there).
- DynamoDB's `ListTables` API caps at 100 names per response and uses `ExclusiveStartTableName` for pagination. We must page until done or until our soft cap. The cap exists so a misconfigured account with 10k tables doesn't freeze the UI thread.
- `DescribeTable` is 1 RPC per table. We never proactively describe all tables (would be `N` RPCs on connect). Describe is lazy: it fires when a table node first becomes visible to the renderer (in practice: when the user opens its row's tooltip, or always for the first viewport since the indicators need it). See D3 for the exact trigger.
- Read-only flag does **not** block read commands. `listTables` and `describeTable` are read-only by construction; `require_writable` is irrelevant here.
- DESIGN.md rules apply to any new UI surface (badges, icons, search input, refresh affordance).

## Goals / Non-Goals

**Goals:**

- After a Dynamo connection connects, the user sees a flat, navigable list of tables under that connection row in the sidebar within one second on a typical account (≤ 200 tables, single page).
- Per-table badges communicate the three highest-signal facts without a click: billing mode (`on-demand` vs `provisioned`), streams (yes/no), and presence of secondary indexes.
- The user can filter the loaded list locally as they type, without any API call.
- The cache survives accidental sidebar churn (collapse/expand, blur/focus, app backgrounding) and is dropped exactly when it must be: explicit refresh, disconnect, or credentials refresh.
- Click on a table opens a placeholder tab that is the seam for #11 (`view-dynamo-items`). The tab payload already carries the describe result so #11 doesn't have to re-fetch.
- Postgres module is byte-for-byte unchanged.

**Non-Goals:**

- DDL (`CreateTable`, `DeleteTable`, `UpdateTable`) — deferred to `dynamo-create-table` crossroads.
- Scanning, querying, or showing items — that is change #11.
- CloudWatch metrics — `dynamo-table-metrics` crossroads.
- Saving the filter text as a persistent setting beyond the per-connection convenience key. Filter is ephemeral by design.
- Auto-describe-everything on connect (would be a thundering herd on accounts with hundreds of tables). Describe is per-table and on-demand.

## Decisions

### D1 — `listTables` paginates internally with a configurable cap

The Tauri command `dynamo.listTables(connectionId, { paginationToken?, cap? })` issues `ListTables` calls with `Limit=100` (the AWS hard maximum), concatenating `TableNames` and following `LastEvaluatedTableName` until either (a) AWS reports no `LastEvaluatedTableName` or (b) the accumulated count reaches the cap (default 1000; configurable per call and overridable per connection via setting `dynamoTablesCap:<connectionId>`). The result is `{ tables: string[], nextToken?: string, truncated: boolean }`. `truncated: true` plus a `nextToken` means the user hit the cap — the frontend renders an inline "Showing first 1000 of more — load more" affordance that re-invokes with `paginationToken` to fetch the next chunk.

**Alternatives considered**:

- Return the AWS-shaped pagination raw (`Limit=100`, single page per call) and let the frontend page. Rejected: the frontend would need to issue N IPC calls for every account refresh, and the per-call IPC overhead dominates 100-name pages. Server-side concatenation keeps the IPC chatter to ≤ ceil(N / 1000).
- No cap, page until done. Rejected: pathological accounts (auto-generated tables per tenant) can have tens of thousands of tables; rendering them all in the sidebar is hostile, and there is no UX win in offering all of them at once when the search filter only operates on what is loaded.

### D2 — `describeTable` is a separate single-table command, cached per-table in the frontend

`dynamo.describeTable(connectionId, tableName) -> TableDescription` returns the typed envelope listed in the proposal. The frontend caches results in a `Map<tableName, TableDescription>` per connection. The render pipeline for the table tree:

1. On first visibility of a connection's tree, fire `listTables` for that connection.
2. For each name returned, render a placeholder node with the name and a thin "loading metadata" badge slot.
3. Fire `describeTable` for every visible name in the rendered subtree in chunks of 8 in parallel (saturate the SDK's default connection pool without hammering it). Off-viewport names defer until they enter the viewport via the `SidebarTree` virtualizer.
4. As describes complete, the corresponding nodes upgrade from placeholder to full (badges and metadata appear).

**Alternatives considered**:

- A bulk `dynamo.describeTables(names[])` command that the backend parallelizes. Considered, but it complicates partial-failure UX (one bad table fails the whole batch in naive implementations, or every result needs a per-name status envelope). One RPC per table with a small parallelism cap is simpler and the failure mode is naturally per-row.
- Inline metadata in `listTables`. Rejected: AWS does not return rich metadata from `ListTables`. We'd be lying about cost.
- Pre-describe everything on first load. Rejected: see Non-Goal above.

### D3 — Subtree under each active Dynamo row, mounted only while active

The tree is rendered inline as a child of the connection row when, and only when, the connection is in the active client registry (`useActiveConnections()` reports it). On disconnect the subtree unmounts; its in-memory cache is dropped at the same instant via the existing `dynamo:active-changed` event handler. This mirrors the Postgres behavior in `postgres-schema-browser`'s "Tree appears on connect, disappears on disconnect" scenario.

**Why mount/unmount on connect/disconnect**: keeping the tree mounted when disconnected forces us to either retain stale data (confusing) or render an empty/error placeholder (wasted space in the sidebar). The connection row itself collapses to a flat row when inactive — the user has nothing to interact with at that level anyway.

### D4 — Cache lives in a React context, keyed by connection id

`useDynamoTableCache(connectionId)` returns `{ tables, describe, refresh, status }`:

- `tables: { state: "loading" | "ready" | "error", names?: string[], nextToken?: string, truncated?: boolean, error?: AppError }`
- `describe: Map<tableName, { state, value?, error? }>`
- `refresh()` clears both and re-fires `listTables`.
- `status: "idle" | "loading" | "ready"` is a derived view for the row toolbar.

The cache provider lives in `src/modules/dynamo/tables/CacheProvider.tsx` and listens for:

- `dynamo:active-changed` → drop cache entries for connections no longer active.
- `dynamo:credentials-refreshed { id }` → drop that connection's cache and re-fire `listTables` if its tree is currently mounted.

**Alternatives considered**:

- TanStack Query. Rejected: we don't have it in the project, adding a dep for one feature is overkill, and our invalidation model is event-driven (Tauri events) rather than query-key-based.
- Zustand global store. Rejected: scope is per-connection-id and lifetime is tied to render of the subtree; React context with a `Map` and a small reducer is the simpler primitive.

### D5 — Badges: `on-demand` / `provisioned`, `streams`, `GSI×N`

Three indicators per table node, rendered to the right of the name:

- Billing mode: text badge `on-demand` or `provisioned`. Derived from `billingMode`. Visual weight is muted (per DESIGN.md, no accent color reserved for selection).
- Streams: a small lightning icon when `streamSpecification.streamEnabled` is `true`. Tooltip on hover: `Streams enabled · <viewType>` (e.g. `NEW_AND_OLD_IMAGES`).
- GSIs: text badge `GSI×N` (e.g. `GSI×3`) when `globalSecondaryIndexes.length > 0`. No badge when zero. LSIs are intentionally not surfaced as a badge (they're rare and read-only at table creation time; if the user cares, they'll be visible in #11's inspector).

While the describe is loading, the badge area shows a thin placeholder shimmer of fixed width so the layout doesn't shift when metadata lands.

**Alternative considered**: badges for `tableStatus`. `ACTIVE` is the overwhelmingly common case and rendering a badge for it is noise. We only badge non-`ACTIVE` states (`CREATING`, `UPDATING`, `DELETING`, `INACCESSIBLE_ENCRYPTION_CREDENTIALS`) and the badge is the literal status string in a warning tone. This keeps the steady state quiet.

### D6 — Local search filters loaded names; nothing else

A search input at the top of the connection's subtree. Behavior:

- Case-insensitive substring match against the table name.
- Filters which leaf nodes render. There are no group nodes in a Dynamo tree so there is nothing to auto-expand.
- The matched substring is visually highlighted in the rendered name.
- Esc clears the input.
- The input never triggers a `listTables` call — search is purely local.
- The current text is held in component state and optionally mirrored to `dynamoTablesSearch:<connectionId>` (a "remember last filter" convenience, not a hard requirement). Loss on app restart is acceptable.

**Alternative considered**: a global "search across all connections" palette mode. We already have `Tables: <query>` in the palette (D8) which does this with a slightly different surface. The per-connection search box stays local and fast.

### D7 — Click opens or focuses `dynamo-table-placeholder` tab; payload includes describe

Activating a leaf node (click, double-click, Enter) opens or focuses a tab of `kind: "dynamo-table-placeholder"` with payload `{ connectionId, connectionName, tableName, describe }` and stable id `dynamotbl:<connectionId>:<tableName>`. The tab body is intentionally a placeholder for V2.1 — it shows the table's KeySchema, AttributeDefinitions, GSIs/LSIs, billing mode, stream state, and item count in a static read-only layout. Change #11 (`view-dynamo-items`) replaces the renderer; the payload contract carries forward so #11 doesn't reload.

**Why pass describe in the payload**: the cache is in the sidebar's React tree; the tab tree is elsewhere. Passing the describe at activation time avoids a re-fetch when the tab opens. If the describe is stale (rare; metadata changes are rare in steady state), the placeholder's "Refresh" button re-fires `describeTable` for that one table.

### D8 — Palette: `Tables: Refresh` + one dynamic command per cached table

Two flavors of palette entry register against the existing `command-palette` registry — no platform-level palette changes:

- A static `Tables: Refresh` command — drops the focused connection's cache and re-fires `listTables`. When no Dynamo connection is focused, the command opens a chooser (palette stays open via `keepOpen: true` and lists currently connected Dynamo connections). This mirrors `Schema: Refresh` for Postgres.
- A **dynamic command per cached table**: every table name in every connected Dynamo connection's populated cache gets its own `Command` registered into the palette, with `id: "argus.dynamo.openTable:<connectionId>:<tableName>"`, `group: "Tables"`, `label: "<connectionName> · <tableName>"`, `keywords: [connectionName, tableName, "dynamo"]`, and `run` opening or focusing the placeholder tab. The palette's existing cmdk-driven fuzzy keyword search filters them as the user types — no typed-prefix mechanism, no platform changes, exact same UX as if we had a `Tables: <query>` mode but cheaper. Commands are registered on cache `status: "ready"` (or growth via load-more) and unregistered on cache drop.

**Why not a typed-prefix mode**: the platform palette today is a flat keyword-fuzzy list (`src/platform/command-palette/Palette.tsx`). Adding a stateful prefix-mode would be a platform feature with broader implications for every future module. Registering one Command per cached table reuses the existing search and stays inside the Dynamo module — strictly smaller blast radius, same product result.

**Alternative considered**: extending the existing table quick-switcher (`⌘P`) to also list Dynamo tables. Considered, but quick-switcher in V1 is Postgres-specific and touching it would require modifying the Postgres-owned palette wiring. Registering Dynamo tables as palette commands keeps the Dynamo entry in the Dynamo module and respects the no-Postgres-edits rule. We can unify in a follow-up if it pays off.

### D9 — Right-click context menu on a table node

The menu has three items: `Open` (same as click), `Copy table name`, `Copy ARN`. `Copy ARN` uses the cached describe's `tableArn`. If the describe hasn't loaded yet, `Copy ARN` is disabled with tooltip `Loading metadata…`. No `New PartiQL Query` — that lives in #13. No `Refresh` per-table — refresh is per-connection (the cost of re-listing 1k names is small; the cost of re-rendering N partially-loaded describes is the more annoying case, which the per-connection refresh handles cleanly).

### D10 — Activity log entries

Each `listTables` and `describeTable` call emits exactly one `argus:activity-log` event:

- `kind: "list_tables"` or `"describe_table"`.
- `connection_id: <id>`.
- `origin: "user"` when triggered by `Tables: Refresh` palette command, the row's refresh icon, or user-initiated reconnection; `"auto"` when fired as part of the initial subtree mount or background describe pipeline.
- `metric: { kind: "items", value: <names.length for list, 1 for describe> }` on success, `null` on failure.
- `status: "ok" | "err"`.
- `duration_ms` covering the whole command (including internal pagination for `listTables`).

This is the same contract Postgres uses for `list_schemas` and `list_relations`.

## Risks / Trade-offs

[Risk] Accounts with thousands of tables overload the sidebar.
→ Mitigation: hard cap at 1000 by default with explicit "load more" affordance, and `SidebarTree` virtualizer kicks in above 500 visible nodes (already in the platform). Search filters down to a working set fast.

[Risk] Describe pipeline saturates the SDK connection pool when a connection's tree first mounts on a large account.
→ Mitigation: parallelism cap of 8 in-flight describes at once, no global describe storm — only what's in the rendered viewport plus a small look-ahead.

[Risk] Cache invalidation on `dynamo:active-changed` is too coarse — disconnecting one connection drops the cache for that one, but a brief flicker happens if the user reconnects fast.
→ Mitigation: acceptable. Reconnect is rare and the re-list is fast. Adding TTL would just hide bugs.

[Risk] Per-table describe leaks the table's existence to activity logs even when nothing is rendered (background pipeline).
→ Mitigation: describe only fires for names that are in the viewport at the time the dispatcher runs. Off-viewport names never describe until they scroll into view. Activity log entries are local — privacy boundary is the local sqlite file.

[Risk] AWS throttles `DescribeTable` at very high parallelism (it has a 100 TPS per-region soft limit by default).
→ Mitigation: parallelism cap of 8 keeps us well below throttle even with rapid viewport churn. On throttle (`ThrottlingException`), we surface the error inline on the affected nodes with a `Retry` affordance and don't auto-retry — the user's machine triggered the throttle by scrolling fast, and silent retries would compound it.

[Risk] `truncated: true` UX feels broken when the cap is misconfigured low.
→ Mitigation: the "Showing first N — load more" affordance makes it explicit, and the per-connection cap setting (`dynamoTablesCap:<connectionId>`) is an escape hatch advanced users can bump.

[Risk] The `dynamo-table-placeholder` tab kind becomes load-bearing if #11 slips, because users will start using it as a real view.
→ Mitigation: keep the placeholder intentionally read-only and visually placeholder-like (per DESIGN.md, no fake-functional buttons that don't work). When #11 lands, the tab kind upgrades in place; payload contract is preserved.

## Migration Plan

- No data migration. No schema migration. No new dependencies. No new keychain entries.
- Backwards compatibility: existing Dynamo connections (created via #9) gain a working subtree on next connect with zero user action. Existing Postgres connections see no change.
- Rollback: revert the change. No persistent state was introduced beyond two optional `settings` keys that are safe to leave behind.

## Open Questions

1. Do we want `Copy ARN` to be enabled before describe completes, by reconstructing the ARN locally from `accountId`, `region`, and `tableName` (the ARN format is mechanical: `arn:aws:dynamodb:<region>:<accountId>:table/<tableName>`)? Reconstruction would always work but slightly couples the frontend to the ARN format. Decision proposed: yes, reconstruct locally — it's not user-facing API and the format is stable.
2. Should `Tables: <query>` palette mode auto-trigger `listTables` for connected-but-not-yet-cached connections? Decision proposed: no — palette is a fast-path; cold-start should go through the sidebar where the user sees the loading state.
3. For tables with `tableStatus !== "ACTIVE"`, do we disable click-to-open? Decision proposed: no — the user can still inspect metadata in the placeholder tab. The status badge is enough of a signal.
