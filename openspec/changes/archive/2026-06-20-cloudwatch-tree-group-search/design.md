## Context

`LogGroupsTree` (`src/modules/cloudwatch/schema/LogGroupsTree.tsx`) loads groups via `loadGroups(nextToken?)` → `cloudwatchApi.listLogGroups(connectionId, nextToken)` and renders a "Load more groups…" node when `groupsNextToken` is set. The backend command and the api wrapper already accept an optional `name_pattern` / `namePattern` (case-sensitive substring, server-side, whole account) from the `cloudwatch-insights-group-search` change. So this is a thin frontend addition mirroring the Insights toolbar search.

## Key decisions

### 1. Reuse the existing server-side search; thread a term through `loadGroups`

Add `searchTerm` state. `loadGroups` gains the term and passes it as the 4th arg:

```
loadGroups(nextToken?) → listLogGroups(connectionId, nextToken, undefined, searchTerm.trim() || undefined)
```

- **Debounce** the term (~250 ms) before reloading from the first page, mirroring `InsightsToolbar`. A new keystroke supersedes the previous load (cancelled flag), so results never arrive out of order.
- **Empty term** → behaves exactly as today (first page + "load more").
- **"Load more groups…"** must pass the current term too, so paging stays within the filtered set. Read the term from a ref inside the load-more handler (or include it in the dependency set) to avoid stale captures.

### 2. Input placement and states (DESIGN.md)

The search field sits in a compact header row above the `SidebarTree`, styled with existing tokens (input `6px 10px`, hairline border, `--radius-md`, `--font-mono` optional). While a search is loading, show the existing in-tree "Loading…" placeholder; on no matches show `No log groups match "<term>".`; errors reuse the existing tree error node with retry. The retry path re-runs the current term.

### 3. Keep streams untouched

Only the top level (groups) is searched. Expanding a matched group still lazily loads its streams as today. Clearing the term collapses back to the full list; already-expanded group state is reset along with the reload (same as today's reload semantics).

## Risks / trade-offs

- **Case-sensitivity**: inherited from `logGroupNamePattern`; consistent with the Insights toolbar and documented there.
- **Reset on search**: typing reloads from page 1 and resets expanded groups — acceptable and expected for a search box; matches the Insights behavior of "search drives the list".

## Migration

None. Frontend-only; backend, persistence, and events unchanged.
