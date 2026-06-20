## Why

The sidebar log-group browser (`LogGroupsTree`) lists log groups one page at a time with a "Load more groups…" node. On accounts with hundreds or thousands of log groups, finding a specific group means paging blindly — there is no way to type and jump to it. The Logs Insights toolbar already solved this with a server-side search (`cloudwatch_list_log_groups` + `name_pattern`); the tree should offer the same affordance so browsing and querying feel consistent.

## What Changes

- **Search input atop the log-group tree**: add a text field above the tree. As the user types, the tree reloads its groups server-side filtered by the term (debounced), matching across the **whole account**, not just the loaded page — identical mechanism to the Insights toolbar search.
- **Empty term restores the full paginated list** (current behavior). Loading / no-match / error states are shown in-tree. "Load more groups…" continues to work, carrying the active search term so paging stays within the filtered set. Streams (the second tree level) are unaffected.

## Capabilities

### Modified Capabilities
- `cloudwatch-logs-browser`: the log-group tree requirement is extended so the tree provides a typed, server-side search over all account log groups (reusing the existing `cloudwatch_list_log_groups` `name_pattern` filter), with paging scoped to the active term.

## Impact

- **Frontend only** (`src/modules/cloudwatch/schema/LogGroupsTree.tsx`): add a debounced search input; thread the term through `loadGroups` as `name_pattern` (the `cloudwatchApi.listLogGroups(connectionId, nextToken, limit?, namePattern?)` arg already exists); pass the term to "load more". Add in-tree loading/empty/error messaging for the searched state.
- **No backend change** — `cloudwatch_list_log_groups` already accepts `name_pattern` (shipped in `cloudwatch-insights-group-search`).
- **No change** to streams, the event tail, Insights, persistence, or events.

## Non-goals

- Fuzzy/regex matching — uses AWS's case-sensitive `logGroupNamePattern` substring search, same as the Insights toolbar.
- Searching/filtering log **streams** (the second tree level) — out of scope.
- Any backend or command changes.
