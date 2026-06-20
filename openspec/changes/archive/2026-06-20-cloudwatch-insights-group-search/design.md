## Context

`InsightsToolbar` (`src/modules/cloudwatch/insights/Toolbar.tsx`) loads up to 50 groups on mount and filters that slice client-side. `cloudwatch_list_log_groups` (`src-tauri/.../cloudwatch/groups.rs`) only accepts `next_token` + `limit`. We need typed search to reach the whole account.

## Key decisions

### 1. Use `DescribeLogGroups.logGroupNamePattern` for server-side search

The AWS SDK `DescribeLogGroups` request supports `log_group_name_pattern` — a **case-sensitive substring** match evaluated server-side across all log groups (cannot be combined with `log_group_name_prefix`). This is exactly the "search all groups" primitive we need, with no client-side accumulation.

```
cloudwatch_list_log_groups(connection_id, next_token?, limit?, name_pattern?)
   name_pattern = Some("checkout") → DescribeLogGroups.logGroupNamePattern("checkout")
   name_pattern = None/empty       → unchanged (first page, current behavior)
```

Decision: add `name_pattern: Option<String>`; trim it and treat empty/whitespace as `None`. Keep `limit` clamped at ≤ 50 as today. Pagination (`next_token`) still works alongside a pattern, so "load more matches" remains possible if we want it, but v1 shows the first page of matches (50) which is sufficient for a search-to-pick flow.

### 2. Debounced search in the dropdown, selection preserved

The dropdown gets a text input at the top. Behavior:

```
type "chk" ──debounce 250ms──▶ listLogGroups(conn, undefined, 50, "chk")
                                       │
                                       ▼
        results = matches across the WHOLE account (≤ 50 shown)
        render: [✓ already-selected groups pinned on top] + [results]
```

- **Debounce** ~250 ms so each keystroke doesn't fire a call; a new keystroke supersedes an in-flight request (track a request id / cancelled flag to avoid out-of-order overwrites).
- **Empty input** → first page (preserves today's "shows something on open" behavior).
- **Selection persistence**: `selectedGroups` is the source of truth (already lifted to the QueryTab). The dropdown renders currently-selected groups even if absent from the active result set, so searching for a second group never visually drops the first. Toggling still respects the ≤ 50 cap.
- Loading + empty ("No log groups match 'X'.") + error states in the dropdown.

### 3. No backend command proliferation

We extend the existing command rather than add a search-specific one — the only difference is one optional request field. `LogGroupsTree` keeps calling without `name_pattern` (unchanged).

## Risks / trade-offs

- **Case-sensitivity**: `logGroupNamePattern` is case-sensitive. Acceptable for v1 and matches AWS console behavior; documented. (A future enhancement could lowercase-normalize or try both cases.)
- **Rapid typing cost**: mitigated by debounce + superseding in-flight requests; these are cheap read calls, not billed Insights queries.
- **First-page-only matches**: if a substring matches > 50 groups, only the first 50 show. A "load more" affordance can be added later via `next_token`; v1 keeps it simple and the user can refine the term.

## Migration

None. Additive optional parameter; existing callers and persisted state are unaffected.
