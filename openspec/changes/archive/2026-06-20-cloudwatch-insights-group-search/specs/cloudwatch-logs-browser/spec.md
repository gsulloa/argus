## ADDED Requirements

### Requirement: Log-group server-side name search

The `cloudwatch_list_log_groups` command SHALL accept an optional `name_pattern` argument. When `name_pattern` is present and non-empty (after trimming), the command sets it as `DescribeLogGroups.logGroupNamePattern`, returning only log groups whose name contains that substring (case-sensitive), evaluated server-side across the **entire account** rather than within a preloaded page. When `name_pattern` is absent or empty, the command behaves exactly as before (first page / pagination via `next_token`). The `limit` remains clamped to ≤ 50.

#### Scenario: Search matches groups beyond the first page

- **WHEN** an account has more than 50 log groups and the caller invokes `cloudwatch_list_log_groups(connection_id, name_pattern: "checkout")`
- **THEN** the response contains log groups whose names contain `checkout`, including groups that would not appear in the first unfiltered page

#### Scenario: Empty pattern is unchanged behavior

- **WHEN** the caller invokes `cloudwatch_list_log_groups` with `name_pattern` absent or an empty/whitespace string
- **THEN** the command returns the first page of log groups exactly as before (no `logGroupNamePattern` is sent)

#### Scenario: No matches returns an empty list

- **WHEN** `name_pattern` matches no log group in the account
- **THEN** the command returns an empty `groups` array and no `next_token`, without error
