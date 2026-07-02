## ADDED Requirements

### Requirement: Folder create/delete refreshes the parsed context synchronously

`context_create_query_folder` and `context_delete_query_folder` MUST, after the filesystem operation succeeds, refresh the connection's cached parsed context (reparse the `<engine>/queries/` tree and update the registry cache) and emit a `context://changed` event whose `kinds` include `"query"` — synchronously, before the command returns. This guarantees that a subsequent `context_list_queries` for the same connection immediately reflects the created or removed folder, **including empty folders** that do not otherwise trigger the filesystem watcher.

#### Scenario: Created empty folder is immediately listable

- **WHEN** a connection invokes `context_create_query_folder({ connection_id, path: "reports" })` and then immediately calls `context_list_queries({ connection_id })`
- **THEN** the `folders` array of the result includes `"reports"` without waiting for a filesystem-watcher flush

#### Scenario: Deleted folder disappears immediately

- **WHEN** a connection invokes `context_delete_query_folder` on an existing empty folder and then immediately calls `context_list_queries`
- **THEN** the removed folder is absent from the `folders` array

#### Scenario: Subscribers are notified

- **WHEN** `context_create_query_folder` or `context_delete_query_folder` succeeds
- **THEN** a `context://changed` event with `kinds` including `"query"` is emitted for the affected folder path
