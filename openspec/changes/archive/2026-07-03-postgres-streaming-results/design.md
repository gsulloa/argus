## Context

Today a single-statement Postgres run flows through `postgres_run_sql` → `run_one` (`packages/app/src-tauri/src/modules/postgres/sql.rs`). For a SELECT-shape statement `run_one` calls `client.query(&stmt, &[])`, which **materializes the entire result set** in memory before any conversion, then truncates to `RESULT_ROW_CAP` (10,000), converts each row via `cell_to_json`, and returns a single `RunSqlResult::Rows` value. That value is serialized as one JSON IPC response; the frontend (`useQueryRun` → `api.runSql` → `invoke`) awaits the whole thing and only then hands `rows` to `ResultPanel` → `AdhocResultGrid` (already virtualized via `@tanstack/react-virtual`).

The result: for `SELECT * FROM client.order` the user waits for the *entire* fetch + transfer before seeing anything. The grid is already virtualized and cheap to grow, and cancellation infrastructure already exists (`query_cancel.rs` `RunningQueryRegistry` + `client.cancel_token()` registered under a frontend `run_token`). The missing piece is progressive delivery from backend to frontend.

Constraints:
- Keep the existing `postgres_run_sql` / `postgres_run_sql_many` commands intact (used by `origin: "auto"` callers, multi-statement runs, and as a safe fallback).
- Reuse existing helpers: statement classification (`is_mutating_sql`), read-only enforcement, `cell_to_json` / `columns_from_row_meta`, the pool registry, and the cancel registry.
- Respect the 10,000-row cap and the existing `Value` envelope for binary/truncated (>1MB) cells.

## Goals / Non-Goals

**Goals:**
- Stream single-statement SELECT-shape results to the frontend in batches so the first rows render almost immediately.
- Render columns as soon as known; append rows progressively; show a live `Loading… N rows` count.
- Preserve the 10,000-row cap, truncation marker, DML `affected` outcomes, error envelope (incl. mid-stream errors), and cancellation — with cancel now keeping already-delivered rows.
- No new crates; no persisted-data or config changes.

**Non-Goals:**
- Streaming for multi-statement runs (`postgres_run_sql_many`) — stays all-at-once.
- Server-side windowing / infinite scroll beyond the 10k cap (no fetch-on-scroll pagination).
- Changing the non-streaming `postgres_run_sql` behavior or the table-browser path (`postgres_query_table`).
- Streaming for other engines (MySQL/MSSQL/etc.) — Postgres only in this change.

## Decisions

### D1: Transport — `tauri::ipc::Channel<T>` (not Tauri global events)

Use a per-run `tauri::ipc::Channel<StreamEvent>` passed as a command argument. The frontend creates a `Channel`, sets `channel.onmessage`, and passes it into `invoke("postgres_run_sql_stream", { …, onEvent: channel })`. The Rust command receives `on_event: tauri::ipc::Channel<StreamEvent>` and calls `on_event.send(evt)?` per batch.

*Why over global `app.emit`:* Channels are point-to-point and scoped to the single invocation — no need to multiplex/route events by tab or run id, no listener-leak cleanup, ordered delivery, and they serialize with serde like any payload. Global events would require tagging every event with the `run_token` and filtering on the frontend, and risk cross-tab bleed.

The `invoke` promise itself resolves to `()` (or a small ack) — the *data* travels over the channel, and the **terminal event** on the channel (`done` / `affected` / `error`) is the authoritative signal of completion. The command should still return `Ok(())` after the stream is exhausted so the promise settles.

### D2: Backend fetch — `query_raw` / `RowStream` (not `client.query`)

Replace `client.query(&stmt, &[])` with `client.query_raw(&stmt, params)` from `tokio_postgres`, which returns a `RowStream: Stream<Item = Result<Row, Error>>` that yields rows incrementally as they arrive off the socket rather than materializing the whole `Vec<Row>`.

Implementation notes:
- Empty params need an explicitly-typed empty iterator to satisfy inference, e.g. `client.query_raw(&stmt, std::iter::empty::<&(dyn tokio_postgres::types::ToSql + Sync)>())`.
- Pin the stream (`futures_util::pin_mut!`) and drive it with `while let Some(row) = stream.try_next().await?`.
- Column metadata comes from the prepared statement (`stmt.columns()` → `columns_from_row_meta`) and is emitted **before** iterating, so the grid can render immediately.
- Per-row conversion reuses `cell_to_json` unchanged (it takes `&tokio_postgres::Row`).

*Why:* minimal change, reuses all existing conversion, and `RowStream` is the idiomatic incremental primitive. We are not adding a server-side cursor/portal (`query_portal` with `max_rows`) — `query_raw` already yields incrementally to the client, and the 10k cap bounds memory. A portal would add transaction management for marginal benefit; noted as a future option.

### D3: Batching policy — size OR time, whichever first

Accumulate converted rows into a buffer and flush a `batch` event when **either** the buffer reaches `BATCH_ROWS` (proposed 500) **or** `BATCH_INTERVAL` (proposed ~50–60ms) has elapsed since the last flush. Always flush the remaining buffer before the terminal event.

*Why:* Pure size-based batching stalls the UI on slow/trickling queries (few rows but each slow); pure time-based batching spams tiny events on fast queries. The hybrid gives snappy first-paint and bounded event count. Constants live next to `RESULT_ROW_CAP` and are tunable. Emitting one row at a time (no batching) would flood the IPC boundary with per-row serialization overhead for a 10k result.

### D4: Cap & truncation

Count emitted rows; once the count reaches `RESULT_ROW_CAP` (10,000), stop pulling from the stream (drop it), flush any buffered rows, and send `{ event: "done", row_count: 10000, truncated: true, query_ms }`. `truncated_columns` (per-cell >1MB truncation) is tracked across the whole run and can ride the `done` event (or each batch) — carry it on `done` to keep batch events lean and match how the frontend surfaces the existing `truncated_columns`.

### D5: Terminal events & error handling

Exactly one terminal event ends every stream:
- `done { row_count, truncated, query_ms, truncated_columns }` — SELECT-shape success.
- `affected { command_tag, affected_rows, query_ms }` — DML/DDL (no columns/batch events; `stmt.columns().is_empty()` branch, same as today via `client.execute`).
- `error { message, code?, position? }` — any failure, **including mid-stream** (`try_next()` yields `Err`). The error carries the same SQLSTATE/position/verbatim-server-message detail as the existing non-streaming error envelope (see `postgres-sql-editor` "Postgres server message surfaces verbatim").

Read-only rejection for a mutating statement happens **before** streaming begins; it can surface either as an `error` terminal event or as an `Err` from the `invoke` (frontend must handle both — simplest is to emit it as the `error` terminal event so one code path handles all failures).

### D6: Cancellation semantics — keep partial rows

Register `client.cancel_token()` under the frontend `run_token` in the existing `RunningQueryRegistry` exactly as `postgres_run_sql` does. On `cancel_running_query(run_token)` the token fires (Postgres cancel-request) and the stream errors/ends. The command detects the cancel flag and resolves to the **neutral cancelled state** — it does **not** send an `error` event. Rows already delivered via prior `batch` events stay in the grid.

*Why change the current "no partial rows on cancel" rule for streaming:* in a streaming model the delivered rows are real rows the user chose to inspect; discarding them defeats the "eyeball early rows then stop" workflow that #193 + this change enable. The frontend distinguishes "cancelled" (keep rows, idle status) from "error" (error block).

### D7: Frontend state — accumulate batches in `RunState`

Extend `useQueryRun`'s `RunState` with a streaming-aware shape: on `columns` set the columns and switch the panel to a rows view with an empty/growing array; on each `batch`, append to an accumulator (use a ref + throttled React state commit, or `flushSync`-free batched `setState`, to avoid a render per batch under fast streams); on the terminal event, finalize (`truncated`, `query_ms`, clear the `Loading…` indicator). `api.ts` gains `runSqlStream(connectionId, sql, origin, runToken, onEvent)` wrapping `invoke` with a `Channel`.

*Rendering perf:* the grid is already virtualized, so a growing `rows` array is cheap to render. The concern is re-render frequency, not row count — coalesce batch-driven state updates (e.g. commit on animation frame / at most every ~60ms) so a burst of `batch` events doesn't cause a render storm. This mirrors the D3 backend interval on the client side.

### D8: Sorting interaction

`sql-result-sorting` sorts loaded rows client-side (`sortResultRows` in `ResultPanel`). During an in-flight stream the set is still growing; sorting a partial set then appending unsorted rows is confusing. Decision: **disable the sort affordance while a stream is in flight** (or apply sort only to the finalized set) and (re)apply sort once the terminal event lands. Simpler and predictable; revisit if users want live-sorted streaming.

## Risks / Trade-offs

- **Render storms from frequent batches** → D3 (backend size/time batching) + D7 (frontend coalesced commits). Grid virtualization already bounds DOM cost.
- **`query_raw` empty-params type inference is fiddly in Rust** → use the explicitly-typed empty iterator; add a focused test that a no-param SELECT streams.
- **Mid-stream error after rows already shown** → explicit `error` terminal event (D5); frontend shows the error block while optionally retaining/greying delivered rows (spec keeps it simple: error block replaces the loading state).
- **Cancellation race (cancel fires as the last batch is in flight)** → treat any post-cancel outcome as cancelled; the terminal resolution is driven by the cancel flag, not by whether the stream ended cleanly. Idempotent registry cleanup as today.
- **Behavior divergence: cancel keeps rows for streaming but not for `postgres_run_sql`/`_many`** → intentional (D6); documented in the spec so the two paths are clearly different, not a bug.
- **Backpressure**: `query_raw` yields to the client incrementally but does not throttle the server via a portal, so a huge result still streams fast into the 10k cap; peak client memory is bounded by the cap. Acceptable; portal-based windowing is a future option.

## Migration Plan

Purely additive — no data migration.
1. Add the `StreamEvent` enum + `postgres_run_sql_stream` command in `sql.rs`; register it in the Tauri command list.
2. Add `runSqlStream` to `api.ts`; extend `useQueryRun` `RunState` + wire the `Channel` and coalesced accumulation.
3. Update `ResultPanel` for progressive rows, `Loading… N rows` indicator, and cancel-keeps-rows handling; adjust `sql-result-sorting` gating (D8).
4. Route **user-driven single-statement runs** through the streaming command; keep `postgres_run_sql` for `origin: "auto"` and as fallback.

Rollback: revert the frontend to call `runSql` (non-streaming) — backend command can remain unused. Low blast radius since the old command is untouched.

## Open Questions

- `BATCH_ROWS` / `BATCH_INTERVAL` exact values — start at 500 rows / 50ms and tune against a real large table.
- Should the `error` terminal event retain the partial rows greyed-out, or clear them and show only the error block? (Design leans: clear to error block, matching current error UX; revisit if users complain.)
- Do we want a portal/`max_rows` server-side window later to reduce server memory for very wide rows? Deferred.
