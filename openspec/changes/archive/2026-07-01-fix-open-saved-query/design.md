## Context

Saved queries open through this chain:

1. `SavedQueriesPanel` `onActivate` → `openSavedQuery(tabs, { items: connections }, queryId)`
2. `openSavedQuery` (`modules/saved-queries/openSavedQuery.ts`) resolves the query's connection from `last_connection_id`, then routes to `openQueryTab` / `openMysqlQueryTab` / `openMssqlQueryTab`.
3. Those helpers build a payload (`initialConnectionId` for Postgres, `connectionId` for MySQL/MSSQL) and call `tabs.open()`.
4. `TabsContext.open()` resolves a **target connection key** = `extractConnectionId(payload) ?? focusedConnectionId`. If that is null, it returns `""` — a silent no-op. Otherwise it appends the tab to *that connection's* tab set.

Two structural facts make this fragile:

- **Tabs are scoped per connection.** `TabsContext` keeps a `Map<connectionId, ConnectionTabSet>` and only renders the *focused* connection's set. `open()` does **not** change focus.
- **Focus can only rest on an *open* connection.** `FocusedConnectionProvider` re-derives focus from `useOpenConnections()`; if `setFocused(id)` targets a connection that is not in the open set, the effect immediately reverts focus to the first open connection (or null).

This produces two distinct "nothing happens" failure modes:

- **Mode A — hard no-op:** query has no `last_connection_id` (or an unknown one) *and* no connection is focused → `open()` returns `""`, no tab created, no warning.
- **Mode B — invisible tab:** query is bound to connection B, but connection A (or none) is focused → the tab is appended to B's *hidden* set; focus never switches, so nothing appears on screen.

The stale comment in `openQueryTab.ts` ("tabs are now connection-agnostic") contradicts the actual per-connection model and misleads maintainers.

## Goals / Non-Goals

**Goals:**
- Opening a saved query always produces a visible result: either the query's tab becomes active and visible, or the user gets a clear affordance explaining what to do.
- When the query is bound to a live/open connection, focus switches to it so the tab is visible.
- Eliminate the silent `return ""` no-op as a user-reachable dead end.
- Keep the per-connection tab model intact (no re-architecture).

**Non-Goals:**
- Introducing connection-agnostic ("orphan") tabs that live outside any connection set. That is a larger architectural change; out of scope.
- Changing where saved queries are stored, or the save flow.
- Auto-opening (connecting) a connection that is not currently open. If the associated connection is not in the open set, we treat it as "not live" and fall back (see Decisions).

## Decisions

### Decision 1 — Switch focus as part of opening a saved query

`openSavedQuery` / `openSavedQueryInNew` will accept access to the focused-connection API (`setFocused`) and the open-connections set. When the query's `last_connection_id` resolves to a connection that is currently **open**, the flow calls `setFocused(connId)` **before** `tabs.open()`, so `open()` resolves the target to that connection *and* the tab strip renders that connection's set.

Rationale: This fixes Mode B directly and matches the "the connection is the project" model — opening a query naturally brings its connection to the foreground. Ordering matters: focus first, then open, so the newly created tab is in the now-visible set and becomes active.

*Alternative considered:* have `TabsContext.open()` auto-switch focus to `targetKey`. Rejected as the primary mechanism because `open()` is used widely and a blanket focus-switch on every open could surprise other callers; instead we make `open()` non-silent (Decision 3) and switch focus explicitly in the saved-query flow. (If review prefers centralizing, `open()` switching focus to `targetKey` when it differs is a viable variant — call this out in eng review.)

### Decision 2 — Fall back to the focused connection when the query has no live connection

When `last_connection_id` is null, unknown, or references a connection that is not in the open set, but **a connection is focused**, open the tab against the focused connection with an empty/pre-filled connection selector (current Postgres behavior). This is Mode A's benign path and already partially works — we just make it deterministic.

### Decision 3 — Never let `tabs.open()` silently drop a tab reachable from the saved-query flow

The `open()` early-return (`if (!targetKey) return ""`) stays as a guard, but the saved-query open flow must guarantee a resolvable target or surface an affordance. Concretely: the panel open action inspects the outcome — if no connection can be resolved (no live query connection **and** no focused connection), it shows a clear affordance (e.g., a toast/inline message: "Focus a connection to open this query") instead of calling `open()` and discarding the result.

Rationale: keeps `open()`'s contract simple while removing the user-facing dead end. The decision about *which* affordance (toast vs. connection picker) is a UX detail flagged for design review; the spec only requires that the action is not silently discarded.

### Decision 4 — Fix the stale comment

Update the `openQueryTab.ts` comment to describe the actual per-connection tab model (tabs live in the focused connection's set; opening a saved query switches focus to its connection).

## Risks / Trade-offs

- **[Focus revert race]** `setFocused(id)` for a connection not in the open set is reverted by `FocusedConnectionProvider`'s effect. → Mitigation: only switch focus when the connection is confirmed in `useOpenConnections()`; otherwise use the fallback path (Decision 2).
- **[Ordering bug]** Calling `open()` before `setFocused()` would still deposit the tab correctly (keyed by connId) but the render might briefly show the wrong set. → Mitigation: switch focus first, then open; both are React state updates batched in the same tick.
- **[Wider blast radius if `open()` changes behavior]** If eng review chooses the Decision 1 alternative (open() auto-switches focus), object-tab and quick-switcher flows are affected. → Mitigation: prefer the explicit-in-saved-query-flow approach; only centralize if tests cover the other callers.
- **[MySQL/MSSQL parity]** The same focus logic must apply to `openMysqlQueryTab` / `openMssqlQueryTab`, not just Postgres. → Mitigation: put focus resolution in `openSavedQuery`/`openSavedQueryInNew` (shared entry points) rather than in each engine helper.

## Open Questions

- Affordance for the "no live connection + no focus" case: transient toast vs. inline hint in the panel vs. a connection picker modal? (Design review to decide; spec requires only that it is not a silent no-op.)
- Should the Decision 1 alternative (centralize focus-switch inside `TabsContext.open()`) be preferred for consistency across all tab-open callers? (Eng review.)
