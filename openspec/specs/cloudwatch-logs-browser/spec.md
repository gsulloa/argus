# cloudwatch-logs-browser Specification

## Purpose
TBD - created by archiving change add-cloudwatch-connection. Update Purpose after archive.
## Requirements
### Requirement: Log-group listing

The CloudWatch module SHALL expose a Tauri command `cloudwatch_list_log_groups(connection_id, next_token?, limit?)` that calls `DescribeLogGroups` against the active client and returns `{ groups: [{ name, arn, stored_bytes?, retention_in_days? }], next_token? }`. Listing MUST be paginated via `next_token`; the frontend tree loads the first page on expand and exposes "load more" while a `next_token` is present.

#### Scenario: First page of log groups

- **WHEN** the user expands a connected CloudWatch connection in the sidebar
- **THEN** `cloudwatch_list_log_groups(id)` returns the first page of `groups` and a `next_token` if more exist

#### Scenario: Paging through log groups

- **WHEN** the user requests more groups with the previously returned `next_token`
- **THEN** the next page of `groups` is returned, and `next_token` is absent on the final page

### Requirement: Log-stream listing (lazy, newest-first)

The CloudWatch module SHALL expose `cloudwatch_list_log_streams(connection_id, group_name, next_token?, limit?)` calling `DescribeLogStreams` with `order_by: LastEventTime` and `descending: true`, returning `{ streams: [{ name, last_event_ts?, first_event_ts?, stored_bytes? }], next_token? }`. Streams MUST load lazily — only when the user expands a specific group — and MUST be ordered newest-first so the most recently active streams appear at the top. The tree MUST NOT eagerly expand streams for all groups.

#### Scenario: Streams load only on group expand

- **WHEN** the user expands a specific log group in the tree
- **THEN** `cloudwatch_list_log_streams(id, group_name)` is invoked for that group and returns its streams newest-first

#### Scenario: Streams are paginated

- **WHEN** a group has more streams than one page
- **THEN** the command returns a `next_token` and the tree exposes "load more" for that group

### Requirement: Raw event tail

The CloudWatch module SHALL expose `cloudwatch_get_log_events(connection_id, group_name, stream_name, forward_token?, backward_token?, start_from_head?, limit?)` calling `GetLogEvents` and returning `{ events: [{ ts, ingestion_ts, message }], next_forward_token, next_backward_token }`. Activating a stream leaf in the tree SHALL open a read-only events viewer for that stream. The viewer MUST default to the most recent events (`start_from_head: false`) and expose "load older" (using `next_backward_token`) and "load newer" (using `next_forward_token`) actions. The viewer is read-only — there is no inline editing of log events.

#### Scenario: Tail opens with the most recent events

- **WHEN** the user activates a log-stream leaf
- **THEN** a read-only events viewer opens showing the most recent page of `{ ts, message }` events for that stream

#### Scenario: Load older events

- **WHEN** the user clicks "load older" in the events viewer
- **THEN** `cloudwatch_get_log_events` is called with the current `backward_token` and prepends the previous page of events

#### Scenario: Load newer events

- **WHEN** the user clicks "load newer" in the events viewer
- **THEN** `cloudwatch_get_log_events` is called with the current `forward_token` and appends any newer events

#### Scenario: Events viewer is read-only

- **WHEN** the events viewer is displayed
- **THEN** no control to edit, insert, or delete a log event is present

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

### Requirement: Log-readable event tail rendering

The raw event tail viewer SHALL render events for readability, consistent with the Insights result panel and `DESIGN.md` (compact density, hairline borders, `--font-mono`, single accent, no decorative gradients or thick borders). The event timestamp SHALL render as a fixed-width, human-readable local datetime with milliseconds, and a long event message SHALL be readable in full — wrapped and selectable, with JSON messages pretty-printed — rather than clipped to a single line. The viewer remains read-only and keeps its "load older / newer" paging.

#### Scenario: Event timestamp is human-readable

- **WHEN** the events viewer shows a stream's events
- **THEN** each event's timestamp renders as a local datetime down to milliseconds in a monospace, fixed-width column

#### Scenario: Long / JSON messages are readable

- **WHEN** an event message is long or is valid JSON
- **THEN** the viewer shows the full message wrapped and selectable, with JSON pretty-printed, without horizontal clipping

#### Scenario: Paging and read-only behavior preserved

- **WHEN** the user loads older or newer events
- **THEN** paging works as before and no control to edit a log event is present

### Requirement: Log-group tree search

The sidebar log-group tree SHALL provide a text input that searches all of the account's log groups server-side as the user types, reusing the `cloudwatch_list_log_groups` `name_pattern` filter. Typing a term reloads the tree's groups filtered by that term (debounced); an empty term restores the full paginated list. The "load more groups" action SHALL carry the active search term so paging stays within the filtered set. Loading, no-match, and error states SHALL be shown in the tree. Log streams (the second tree level) are not affected.

#### Scenario: Typing filters the tree to matching groups

- **WHEN** an account has many log groups and the user types a substring into the tree's search field
- **THEN** the tree reloads to show only log groups whose name contains that substring, including groups that were not on the initially loaded page

#### Scenario: Clearing the search restores the full list

- **WHEN** the user clears the search field
- **THEN** the tree reloads the first page of all log groups with the "load more groups" affordance, as before

#### Scenario: Load more stays within the filtered set

- **WHEN** a search term is active and more matches exist than one page
- **THEN** activating "load more groups" fetches the next page of matches for the same term

#### Scenario: No matches shows an in-tree message

- **WHEN** the typed term matches no log group
- **THEN** the tree shows a "no log groups match" message and no group rows

#### Scenario: Streams are unaffected

- **WHEN** the user expands a matched log group
- **THEN** its streams load lazily as before, independent of the group search

### Requirement: In-viewer local event filter (⌘F)

The raw event tail viewer SHALL provide a local, in-app text filter opened with ⌘F (⌃F on non-mac) while the events tab is focused. Pressing the shortcut SHALL intercept the browser's native find, open a filter input at the top of the events list, and focus it; `Esc` SHALL close and clear it. The input accepts plain text only (no regex or operators). Matching SHALL be **case-insensitive** and **fuzzy** — a case-insensitive substring match, with an in-order subsequence match as a fallback. The filter applies **client-side to the already-loaded events only** (no refetch); it SHALL show a matched/loaded count and re-apply automatically as "load older / newer" brings in more events. The viewer remains read-only.

#### Scenario: ⌘F opens the local filter

- **WHEN** the events tab is focused and the user presses ⌘F
- **THEN** the browser's native find does not open, an in-app filter input appears at the top of the events list and is focused

#### Scenario: Case-insensitive fuzzy matching

- **WHEN** the user types a query into the filter
- **THEN** only loaded events whose message matches case-insensitively are shown — by substring, or by in-order subsequence as a fallback — and a "N of M" matched/loaded count is shown

#### Scenario: Filter is local and does not refetch

- **WHEN** a filter query is active
- **THEN** no new request is made; only the already-loaded events are filtered, and "load older / newer" remain available and feed the same filter

#### Scenario: Escape clears the filter

- **WHEN** the filter input is open and the user presses `Esc`
- **THEN** the filter bar closes, the query clears, and all loaded events are shown again

#### Scenario: No matches shows a quiet message

- **WHEN** a non-empty query matches none of the loaded events
- **THEN** the list shows a "no events match" message and keeps the "load older / newer" controls available

### Requirement: Highlight filter matches in event messages

While the in-viewer ⌘F filter has a non-empty query, each shown event message SHALL highlight the matched text using the brand accent (`--accent-soft` background per `DESIGN.md`). When the substring filter is active, every case-insensitive occurrence of the query within the message SHALL be highlighted. When the fuzzy fallback is in effect (no substring matched any line), the matched characters SHALL be highlighted in order. Highlighting applies to the displayed message text (including JSON pretty-printed messages) and is removed when the query is cleared or the filter bar is closed.

#### Scenario: Substring occurrences are highlighted

- **WHEN** a filter query is a case-insensitive substring of a shown message
- **THEN** every occurrence of the query within that message is visually highlighted in the accent style

#### Scenario: Fuzzy matches highlight the matched characters

- **WHEN** no message contains the query as a substring and the fuzzy fallback selects lines by subsequence
- **THEN** the in-order matched characters within each shown message are highlighted

#### Scenario: No highlight without an active query

- **WHEN** the filter bar is closed or the query is empty
- **THEN** messages render with no highlight

#### Scenario: Highlight aligns with displayed (JSON) text

- **WHEN** a shown message is JSON and rendered pretty-printed
- **THEN** the highlight marks the matched text within the pretty-printed output, not a different raw form

