## 1. Backend — streaming command

- [x] 1.1 In `packages/app/src-tauri/src/modules/postgres/sql.rs`, define a serde-tagged `StreamEvent` enum with variants `Columns { columns: Vec<DataColumn> }`, `Batch { rows: Vec<Vec<JsonValue>> }`, `Done { row_count: u64, truncated: bool, query_ms: u64, truncated_columns: Vec<String> }`, `Affected { command_tag, affected_rows, query_ms }`, and `Error { message: String, code: Option<String>, position: Option<i32> }`. Use `#[serde(tag = "event", rename_all = "snake_case")]` so it serializes as `{ event: "batch", rows: [...] }`.
- [x] 1.2 Add `BATCH_ROWS` (500) and `BATCH_INTERVAL` (~50ms) consts next to `RESULT_ROW_CAP`.
- [x] 1.3 Add `async fn run_one_stream(client, sql, is_read_only, cap, on_event, cancel_flag) -> AppResult<()>` mirroring `run_one`: read-only check first; `prepare`; if `stmt.columns().is_empty()` run `client.execute` and send one `Affected` event; else send `Columns`, then iterate `client.query_raw(&stmt, std::iter::empty::<&(dyn ToSql + Sync)>())` via `try_next()`, converting each row with `cell_to_json`, buffering, and flushing a `Batch` on size-or-interval; stop at `cap`; flush remainder; send `Done`.
- [x] 1.4 Handle mid-stream / prepare errors by mapping to a `StreamEvent::Error` (reuse the existing error-envelope mapping for SQLSTATE/position/verbatim message) instead of returning `Err`, so one code path settles the stream.
- [x] 1.5 Add the Tauri command `postgres_run_sql_stream(app, pools, registry, id, sql, origin, run_token, on_event: tauri::ipc::Channel<StreamEvent>)`: acquire the pool client (no new connection), register `client.cancel_token()` in `RunningQueryRegistry` under `run_token` (same as `postgres_run_sql`), call `run_one_stream`, and return `Ok(())` after the terminal event. Emit the activity-log metric on completion as the existing path does.
- [x] 1.6 Cancellation: on cancel, stop pulling from the stream and resolve to the neutral cancelled state — do NOT emit an `Error` event (detect via the cancel flag / registry). Ensure registry cleanup is idempotent on all exit paths.
- [x] 1.7 Register `postgres_run_sql_stream` in the Tauri `invoke_handler` command list (same module that registers `postgres_run_sql`).
- [x] 1.8 `cargo build` / `cargo clippy` clean; resolve the `query_raw` empty-params type inference.

## 2. Frontend — API + run state

- [x] 2.1 In `packages/app/src/modules/postgres/sql/api.ts`, add the `StreamEvent` TS type (discriminated on `event`) and `runSqlStream(connectionId, sql, origin, runToken, onEvent)` that creates a `Channel<StreamEvent>` from `@tauri-apps/api/core`, sets `channel.onmessage = onEvent`, and calls `invoke("postgres_run_sql_stream", { id, sql, origin, runToken, onEvent: channel })`.
- [x] 2.2 In `useQueryRun.ts`, extend `RunState` to carry streaming state (columns, growing rows, `loadedCount`, `streaming: boolean`, plus terminal `truncated` / `query_ms` / `truncated_columns`).
- [x] 2.3 Route user-driven single-statement runs through `runSqlStream`; keep `origin: "auto"` and multi-statement on the existing non-streaming calls.
- [x] 2.4 On `columns` set columns + switch to rows view; on `batch` append rows to a ref and commit to React state on a coalesced cadence (~animation frame / ≤60ms) to avoid a render per batch; on `done`/`affected`/`error` finalize and clear the loading indicator.
- [x] 2.5 Cancellation: reuse the existing `run_token` + `cancelQuery`; on cancel keep already-appended rows, clear `Loading…`, and set the neutral cancelled state (distinct from error).

## 3. Frontend — result panel UI

- [x] 3.1 In `ResultPanel.tsx`, render the `AdhocResultGrid` as soon as columns exist and feed it the growing rows array; render the `Loading… <n> rows` progress indicator above the grid while `streaming` is true and clear it on terminal.
- [x] 3.2 Update the bottom status indicator to reflect the streamed `row_count` on completion (and truncation), keeping the live elapsed-time behavior while running.
- [x] 3.3 Keep the truncation banner driven by the terminal `truncated` flag.
- [x] 3.4 Gate `sql-result-sorting`: disable/deactivate the sort affordance while a stream is in flight and (re)apply sort on the finalized set.

## 4. Verification

- [ ] 4.1 Manual (requires live Postgres + running app): run `SELECT * FROM <large table>` and confirm the grid paints first rows before completion, the `Loading… N rows` count ticks up, and it stops/marks truncated at 10,000.
- [ ] 4.2 Manual (requires live Postgres + running app): cancel mid-stream and confirm already-delivered rows remain, the indicator clears, and no error block shows.
- [ ] 4.3 Manual (requires live Postgres + running app): DML statement shows the `affected` summary; a failing statement shows the error block (including a statement that errors after some rows).
- [x] 4.4 Backend test: `stream_event_serializes_with_event_tag` guards the `StreamEvent` wire contract (event tag + snake_case fields) the frontend depends on. (A live-DB streaming test is not feasible as a unit test — the repo's sql.rs tests are DB-free; the contract test is the runnable equivalent. Row-streaming/cap behavior is covered by manual QA 4.1.)
- [x] 4.5 Ran Rust `cargo test --lib` (194 pass incl. new test) + frontend `pnpm typecheck` (clean) + `vitest run src/modules/postgres/sql/` (20 pass) + eslint (no new errors). No regressions in the non-streaming `postgres_run_sql` path.
