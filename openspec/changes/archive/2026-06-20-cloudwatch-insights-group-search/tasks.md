## 1. Backend — server-side name pattern

- [x] 1.1 `cloudwatch/groups.rs`: add `name_pattern: Option<String>` to `cloudwatch_list_log_groups`; trim it, and when non-empty set `.log_group_name_pattern(pattern)` on the `DescribeLogGroups` request. Leave `next_token`/`limit` (clamped ≤ 50) behavior unchanged; do not combine pattern with any prefix
- [x] 1.2 Backend test: a unit/shape test asserting the request builder sets the pattern when provided and omits it when `None`/empty (mirror the existing groups.rs test style)

## 2. Frontend — api wrapper

- [x] 2.1 `src/modules/cloudwatch/api.ts`: extend `listLogGroups(connectionId, nextToken?, limit?, namePattern?)` to pass `namePattern: namePattern ?? null` to `cloudwatch_list_log_groups`

## 3. Frontend — searchable group selector

- [x] 3.1 `src/modules/cloudwatch/insights/Toolbar.tsx`: add a text input at the top of the group dropdown; on change, debounce (~250 ms) and call `cloudwatchApi.listLogGroups(connectionId, undefined, 50, term)`; track a request id / cancelled flag so a newer query supersedes an in-flight one
- [x] 3.2 Empty term → fetch the first page (preserve current on-open behavior); show loading, empty ("No log groups match …"), and error states in the dropdown
- [x] 3.3 Preserve selection across searches: render currently-selected groups (pinned/marked) even when they are not in the active result set; keep the ≤ 50 cap in `toggleGroup`
- [x] 3.4 Remove (or relax) the mount-time "load up to 50 then stop" accumulation so the initial list is just the first page; the search input is now the path to everything else

## 4. Verification

- [x] 4.1 `cargo test cloudwatch` (backend) and `pnpm typecheck` + lint (frontend) pass
- [x] 4.2 Manual smoke against an account with > 50 log groups: open Insights, type a substring of a group beyond the first page, confirm it appears and is selectable; select a second group via a different search and confirm the first stays selected; clear the search and confirm the first page returns
