## Why

Expanding a Postgres table whose name is a SQL reserved word (e.g. `order`) in the schema tree hangs forever on `(loading…)`. An earlier build crashed the app on the same action. Issue [#56](https://github.com/argus-app/argus/issues/56) shows the symptom: neither the success nor the failure path of `postgres_list_table_extras` ever resolves on the frontend, so the spinner is stuck and the user has no way to recover short of refreshing the schema or restarting the app. The schema tree is the primary navigation surface for the Postgres module — every blocker here is high-impact.

## What Changes

- Add a **frontend hard safety timeout** on every `postgres_list_table_extras` invocation. If the IPC promise has not resolved within a small constant over the backend's own 10s total timeout (≈ 12s), the frontend MUST transition the per-table state out of `loading` and into a typed error with a manual retry, so the spinner cannot persist indefinitely.
- **Audit and harden the Rust handler path** for `postgres_list_table_extras`:
  - Ensure every `tokio::join!` branch propagates as `Ok(Err(...))` or appears in `failures`, never as a dropped panic.
  - Wrap row-decode `.get::<_, T>()` chains so a malformed catalog row surfaces as `KindFailure { kind, code: None, message }` rather than panicking the command task.
  - Confirm that the connection-borrow and per-query timeouts apply *before* any catalog query runs, so an unhealthy pool cannot hang the command.
- **Add a reproduction-grade automated test** that calls `postgres_list_table_extras` against a real database containing a table literally named `order`, asserting that the command returns within the total timeout and never panics.
- **Add structured `tracing` spans** around `list_table_extras_inner` carrying `schema`, `relation`, and the elapsed time of each sub-query, so the next hang (if any) is diagnosable from logs without a rebuild.

No user-visible UI changes beyond: a node that gets stuck for ≥ 12s now flips to "Failed to load (Retry)" instead of staying on "(loading…)".

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `postgres-schema-browser`: tighten `List table extras command` and `Lazy on-expand fetching of structure and table extras` to require (a) frontend safety timeout that always clears the loading flag, (b) backend panic-resilience so any sub-query failure surfaces through `failures` rather than a hung task.

## Impact

- **Rust**: `src-tauri/src/modules/postgres/schema_commands.rs` (`list_table_extras` / `list_table_extras_inner`), `src-tauri/src/modules/postgres/schema.rs` (row-decode paths in `list_table_indexes` and `list_table_triggers`).
- **Frontend**: `src/modules/postgres/schema/useSchemaTree.ts` (`loadTableExtras` state machine — add hard timeout and typed error transition).
- **Tests**: new integration test in `src-tauri/tests` covering reserved-word relations; light unit coverage of the JS hook's timeout path if a harness exists.
- **No dependency changes**. No IPC contract change — the envelope shape stays identical; behavior just becomes deterministic on the frontend.
- **No migration**. Activity-log shape unchanged.
