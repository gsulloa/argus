## Context

Tabs in the dual-window shell are partitioned into **per-connection tab sets** (`Map<connectionId, ConnectionTabSet>`) inside `TabsProvider` (`packages/app/src/platform/shell/tabs/TabsContext.tsx`). When something calls `tabs.open(input)`, the provider must decide which connection set the new tab belongs to. It does this via:

```ts
const targetKey = extractConnectionId(input) ?? focusedConnectionId;
if (!targetKey) return "";          // silent no-op
```

`extractConnectionId(input)` only inspects `input.payload.connectionId`:

```ts
function extractConnectionId(input: OpenInput): string | null {
  const payload = input.payload as { connectionId?: unknown } | ...;
  if (... typeof payload.connectionId === "string") return payload.connectionId;
  return null;
}
```

The three SQL engines build their `open()` payloads differently:

- **MySQL** (`openMysqlQueryTab.ts`) and **MSSQL** (`openMssqlQueryTab.ts`) put the connection at `payload.connectionId` → `extractConnectionId` resolves it → tab routes correctly.
- **Postgres** (`openQueryTab.ts` / `openSavedQueryInNewTab.ts`) builds a `PostgresQueryPayload` whose connection field is `initialConnectionId` (no `connectionId`) → `extractConnectionId` returns `null`.

So every Postgres `postgres-query` tab falls back to `focusedConnectionId`. From the saved-queries panel that value is `null` (the panel is not opened "under" a focused connection), so `open()` returns `""` and **no tab is created** — exactly the #209 symptom. Double-click, `Open`, and `Open in new tab` all funnel through `openQueryTab` / `openSavedQueryInNewTab`, so all three are dead.

The `postgres-query` payload contract is intentionally `initialConnectionId` (the spec, `postgres-sql-editor` "Query tab kind", explicitly defines the payload as `{ initialConnectionId?, initialConnectionName?, initialSql, savedQueryId? }` and notes the connection is mutable per-tab). We must not rename that field.

## Goals / Non-Goals

**Goals:**
- Opening a Postgres saved query (double-click / `Open` / `Open in new tab`) reliably opens or focuses a `postgres-query` tab with the query's SQL.
- The opened tab lands in the **correct** connection set — the saved query's own connection (`initialConnectionId`) — not whichever connection happens to be focused.
- Behavior is correct even when no connection is currently focused.
- Postgres context/prefab queries (which also route through `openQueryTab`) benefit from the same fix.

**Non-Goals:**
- Renaming the `PostgresQueryPayload.initialConnectionId` field or otherwise changing the `postgres-query` payload contract.
- Touching MySQL/MSSQL open paths (already correct).
- Changing the focused-connection fallback semantics for tabs that legitimately have no owning connection (e.g. ad-hoc `+ Query` with no focused connection still falls back, and may still no-op when truly nothing is focused — out of scope for this bug).

## Decisions

### Decision: Fix routing centrally in `extractConnectionId`, reading `initialConnectionId` as a fallback

`extractConnectionId` will resolve the connection id from `payload.connectionId` **or**, when absent, `payload.initialConnectionId`:

```ts
function extractConnectionId(input: OpenInput): string | null {
  const payload = input.payload as
    | { connectionId?: unknown; initialConnectionId?: unknown }
    | null
    | undefined;
  if (payload && typeof payload === "object") {
    if (typeof payload.connectionId === "string") return payload.connectionId;
    if (typeof payload.initialConnectionId === "string") return payload.initialConnectionId;
  }
  return null;
}
```

**Why here (vs. the Postgres open helpers):** this is the single chokepoint every `open()` call passes through, so one change fixes saved-query open, `Open in new tab`, and context/prefab query open simultaneously, and the tab is routed to the *right* set rather than the focused one. It is purely additive — the existing `connectionId` path is untouched, so MySQL/MSSQL are unaffected.

**Alternatives considered:**
- *Add `connectionId` to `PostgresQueryPayload` alongside `initialConnectionId`* — duplicates state in the payload, two fields meaning almost-the-same thing, and risks them diverging (the tab's *current* connection is mutable per-tab while `initialConnectionId` is the seed). Rejected.
- *Rename `initialConnectionId` → `connectionId`* — breaks the documented `postgres-sql-editor` payload contract and every consumer (`QueryTab`, `useQueryTabState`, the new-query path that reads `initialConnectionId`), for no real gain. Rejected.

### Decision: Keep the `focusedConnectionId` fallback

The fallback stays for tabs whose payload genuinely carries no connection (e.g. an ad-hoc new query). The fix only adds a more specific source ahead of the fallback, so a saved query bound to a real connection now resolves deterministically before the fallback is ever consulted.

## Risks / Trade-offs

- **[A saved query whose `last_connection_id` is null/stale still has no `initialConnectionId`]** → `extractConnectionId` returns `null` and we fall back to `focusedConnectionId`, matching the existing spec scenario "Saved query without a valid last connection opens with selector empty". This is unchanged and acceptable; the common case (query bound to a live connection) is fixed.
- **[Another payload shape might happen to carry an unrelated `initialConnectionId`]** → only the `postgres-query` payload defines that field; the lookup is still type-guarded to a string, so non-string/absent values fall through harmlessly.
- **[Regression surface]** → change is one pure function with no side effects; covered by a unit test on `extractConnectionId`/`open()` routing and the existing saved-query open scenarios.

## Migration Plan

Pure frontend logic fix, no data or schema migration. Ships in the next release; rollback is reverting the single-function edit.
