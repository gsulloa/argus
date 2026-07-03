## Why

When a Postgres query returns many rows (e.g. `SELECT * FROM client.order`), Argus fully materializes the entire result set in the Rust backend (`client.query()`), serializes it as one large JSON IPC response, and only then renders the grid. The user stares at a spinner until the *whole* set is fetched and transferred, even though the first rows are available almost immediately. TablePlus and other tools show the first rows the instant they arrive; Argus should too. This makes large reads feel instant and pairs naturally with query cancellation (#193) — the user can eyeball early rows and stop a long load mid-way.

## What Changes

- Add **incremental (streaming) result delivery** for single-statement Postgres SELECT-like runs: the backend fetches rows from the server as a stream and pushes them to the frontend in batches over a Tauri IPC `Channel`, rather than returning one materialized `RunSqlResult`.
- The result grid **populates progressively** — columns render as soon as they are known, and rows append batch-by-batch as they arrive. A live count (e.g. `Loading… 3,412 rows`) shows progress.
- Streaming **respects the existing 10,000-row cap**: the backend stops pulling from the server once the cap is reached and marks the result `truncated`.
- Streaming **integrates with query cancellation**: cancelling mid-stream stops fetching, keeps the rows already delivered on screen, and resolves the run to a neutral cancelled state.
- Preserve existing semantics for `affected` (DML) outcomes and errors: these resolve as a single terminal event with no partial rows.
- Multi-statement runs (`postgres_run_sql_many`) are **out of scope** for streaming in this change and keep their current all-at-once behavior.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `postgres-sql-editor`: the single-statement run path gains a streaming contract (row batches delivered incrementally over an IPC channel), the result panel renders rows progressively with a live loading count, and the row-cap and cancellation behaviors are restated in streaming terms.

## Impact

- **Backend (Rust):** `packages/app/src-tauri/src/modules/postgres/sql.rs` — new streaming run path using `tokio_postgres` `query_raw` (`RowStream`) instead of `client.query()`; new `tauri::ipc::Channel` event enum (columns / row-batch / terminal). Interacts with `query_cancel.rs` (RunningQueryRegistry) and `pool.rs` (connection acquisition). Registered in the Tauri command list.
- **Frontend (React/TS):** `packages/app/src/modules/postgres/sql/api.ts` (channel-based invoke), `useQueryRun.ts` (accumulate batches into `RunState`), `ResultPanel.tsx` (progressive/loading UI), and consumption by `AdhocResultGrid.tsx` (already virtualized — just receives a growing rows array).
- **Interaction with sorting:** client-side sort (`sql-result-sorting`) applies to the accumulated set; sorting during an in-flight stream must be handled gracefully (defer/re-sort on completion).
- **No new dependencies** — `tokio-postgres` streaming and `tauri::ipc::Channel` are already available.
- **No breaking changes** to persisted data or connection config.
