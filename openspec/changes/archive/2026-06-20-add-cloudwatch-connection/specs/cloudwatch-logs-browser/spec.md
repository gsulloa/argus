## ADDED Requirements

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
