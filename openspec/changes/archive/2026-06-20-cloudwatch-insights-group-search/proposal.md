## Why

The Logs Insights toolbar's log-group multi-select loads **at most 50 log groups** once on mount (`InsightsToolbar` paginates `DescribeLogGroups` until it hits 50, then stops) and the dropdown filters only within that in-memory slice. AWS accounts routinely have hundreds or thousands of log groups, so any group past the first 50 is **unreachable** — the user cannot find or select it by typing. The only escape today is knowing the exact group name and there is no free-text entry that reaches the backend. This makes Insights unusable on real accounts where the group you want isn't in the first arbitrary page.

## What Changes

- **Server-side search in the group selector**: the dropdown gains a text input. As the user types, the toolbar queries the backend with the term and shows matching log groups across the **entire account**, not just a preloaded page. Empty input shows the first page (current behavior). Debounced so each keystroke doesn't spam the API.
- **Backend filter parameter**: `cloudwatch_list_log_groups` gains an optional `name_pattern` argument that maps to `DescribeLogGroups.logGroupNamePattern` (case-sensitive substring match across all groups). When absent, behavior is unchanged. `name_pattern` is mutually exclusive with prefix-style filtering — we use pattern only.
- **Selection survives search**: groups already selected stay selected and visible (as chips/summary) even when they fall outside the current search results, so the user can assemble a selection across multiple searches without losing prior picks. The ≤ 50 selection cap is unchanged.

## Capabilities

### Modified Capabilities
- `cloudwatch-insights-editor`: the log-group selector requirement is extended so the selector searches all account log groups server-side via a typed query, rather than filtering only the preloaded page.
- `cloudwatch-logs-browser`: the `cloudwatch_list_log_groups` command requirement is extended with an optional `name_pattern` filter (`DescribeLogGroups.logGroupNamePattern`) for server-side substring search.

## Impact

- **Backend (`src-tauri/src/modules/cloudwatch/groups.rs`)**: `cloudwatch_list_log_groups` gains `name_pattern: Option<String>`; when present and non-empty it sets `.log_group_name_pattern(..)` on the `DescribeLogGroups` request. No new command.
- **Frontend (`src/modules/cloudwatch/`)**: `api.ts` `listLogGroups` gains a `namePattern` arg; `insights/Toolbar.tsx` adds a debounced search input inside the group dropdown that calls the backend with the term, renders the returned matches, and preserves the current selection across searches. `schema/LogGroupsTree.tsx` is unaffected (it already paginates with "load more").
- **No change** to the connection lifecycle, Insights execution, persistence, or events.
- **External**: one extra `DescribeLogGroups` call per debounced search term (read-only, negligible cost; not billed like Insights queries).

## Non-goals

- Fuzzy/regex/multi-token matching — v1 uses AWS's single case-sensitive substring pattern (`logGroupNamePattern`) as-is.
- Changing the log-group **tree** browser (it already supports incremental "load more").
- Raising the 50-group Insights selection cap (an AWS limit).
