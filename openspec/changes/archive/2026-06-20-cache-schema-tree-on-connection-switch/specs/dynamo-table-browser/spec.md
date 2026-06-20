## MODIFIED Requirements

### Requirement: Frontend table cache

The frontend SHALL maintain an in-memory cache per Dynamo connection holding two slots: a `tables` slot (state machine `{ status: "idle" | "loading" | "ready" | "error", names?: string[], nextToken?: string, truncated?: boolean, error?: AppError, fetchedAt?: number }`) and a `describe` slot (a `Map<tableName, { status: "loading" | "ready" | "error", value?: TableDescription, error?: AppError }>`). The cache MUST be created on first mount of the connection's subtree, MUST survive unmount/remount of the subtree (e.g. switching focus between connections in the rail), and MUST be dropped when (a) the user invokes `Tables: Refresh` for the connection, the toolbar refresh button, or the global `Cmd+R` / `Ctrl+R` accelerator while the connection is focused, (b) the connection appears in `dynamo:active-changed` as no longer active, or (c) `dynamo:credentials-refreshed` fires for the connection. The cache MUST NOT be persisted to disk.

When the `tables` slot reaches `status: "ready"`, the cache MUST record a `fetchedAt` timestamp. The entry is **stale** when older than `SCHEMA_CACHE_TTL_MS` (1 hour). When the subtree mounts (e.g. on refocus) with a stale `ready` entry, the rendered list MUST continue to show the cached names while `dynamo.listTables` is re-invoked in the background; on success the cache is replaced, on failure the stale names are retained. A fresh `ready` entry MUST NOT trigger a refetch on remount.

#### Scenario: First mount triggers listTables once

- **WHEN** the user connects a Dynamo connection and its subtree mounts for the first time in the session
- **THEN** `dynamo.listTables(id, {})` is invoked exactly once
- **AND** while the call is in flight the cache's `tables` slot has `status: "loading"`

#### Scenario: Re-mount uses cache, no new listTables call

- **WHEN** the cache for a connection has `tables.status: "ready"` with a non-stale `fetchedAt` and the subtree is unmounted (e.g. user switches focus to another connection) and then re-mounted
- **THEN** `dynamo.listTables` is NOT invoked again
- **AND** the rendered list reflects the cached names

#### Scenario: Stale cache refreshes in the background on remount

- **WHEN** the subtree re-mounts for a connection whose `tables` slot is `ready` but whose `fetchedAt` is older than `SCHEMA_CACHE_TTL_MS`
- **THEN** the cached names are rendered immediately
- **AND** `dynamo.listTables` is re-invoked in the background and the list updates on success

#### Scenario: Cmd+R forces a reload of the focused connection

- **WHEN** the user presses `Cmd+R` / `Ctrl+R` while a Dynamo connection is focused
- **THEN** that connection's cache is dropped and `dynamo.listTables` is re-invoked
- **AND** other connections' caches are untouched

#### Scenario: Disconnect drops the cache

- **WHEN** a connected Dynamo connection is disconnected
- **THEN** every cache entry for that connection id is dropped from memory
- **AND** if the user reconnects, `dynamo.listTables` is invoked again on the next subtree mount

#### Scenario: Credentials refresh drops the cache

- **WHEN** `dynamo:credentials-refreshed` fires for an active connection
- **THEN** the cache for that connection id is dropped
- **AND** if the subtree is currently mounted, `dynamo.listTables` is re-invoked automatically

#### Scenario: Cache is per-connection

- **WHEN** the user has two connected Dynamo connections A and B and refreshes A
- **THEN** A's cache is dropped and re-fetched
- **AND** B's cache is untouched
