## 1. Frontend — searchable log-group tree

- [x] 1.1 `src/modules/cloudwatch/schema/LogGroupsTree.tsx`: add a `searchTerm` state and a debounced (~250 ms) effect that reloads groups from the first page when it changes; thread the term into `loadGroups` so it calls `cloudwatchApi.listLogGroups(connectionId, nextToken, undefined, searchTerm.trim() || undefined)`; cancel/supersede in-flight loads
- [x] 1.2 Add a compact search input above the `SidebarTree` (DESIGN.md tokens: input `6px 10px`, hairline border, `--radius-md`); placeholder e.g. "Search log groups…"
- [x] 1.3 "Load more groups…" carries the active term — read the term from a ref (or include in deps) so the load-more handler isn't stale; keep the existing next-token paging
- [x] 1.4 In-tree states: loading placeholder while searching, `No log groups match "<term>".` on empty matches, and the existing error node + retry re-running the current term

## 2. Verification

- [x] 2.1 `pnpm typecheck` + lint pass; apply the `/frontend-design` lens (no gradients/thick borders/bubbly radii/multiple accents)
- [x] 2.2 Manual smoke against an account with > 50 log groups: type a substring and confirm a group beyond the first page appears; expand a matched group and confirm its streams still load; "load more" stays within the filtered set; clear the field and confirm the full list returns
