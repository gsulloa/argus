## Why

Once a query is sent from a SQL editor, there is no way to stop it. On a slow query — or one run by mistake — the user is stuck staring at "Running…" until the statement finishes or the 60s backend timeout fires. TablePlus and every comparable tool offer a stop button. The backend cancel primitives already exist per engine (Postgres `cancel_token`, MySQL `KILL QUERY`, MSSQL `KILL <spid>`, Athena `StopQueryExecution`, CloudWatch `StopQuery`) but on the synchronous engines they only fire on the internal timeout, never on user request. CloudWatch already ships a full user-facing Run/Cancel button; this change brings the rest of the SQL editors to that same bar. (Issue #193.)

## What Changes

- Add a user-facing **Cancel** affordance to every SQL editor that runs cancellable queries: while a run is in flight the Run button becomes a **Stop** action (button + keyboard shortcut). Triggering it aborts the in-flight statement in the backend and returns the editor to idle with a clear "cancelled" outcome — no half-rendered results, no hang.
- **Postgres / MySQL / MSSQL** — expose the existing cancel primitives to the user:
  - Register each in-flight run in a shared **cancel-handle registry** keyed by a frontend-generated run token (passed into the run command), holding the handle needed to abort it (Postgres `CancelToken`; MySQL connection thread id + connect params; MSSQL `@@SPID` + connect params).
  - Add a `cancel_running_query(run_token)` Tauri command that looks up the token and fires the abort (best-effort, idempotent); the in-flight `run` future then resolves as cancelled.
- **Athena** — finish the partially-built path: backend `athena_cancel_query` + `athena:query-started` event already exist; expose `cancel()` from `useAthenaQueryRun` and render the Stop button in the Athena query toolbar.
- **CloudWatch** — already complete; serves as the reference implementation. No behavior change (verify only).
- **Frontend** — extend each `useQueryRun` hook with a `cancel()` method and a `"cancelled"` terminal state, and render a unified Run⇄Stop toolbar control consistent with `DESIGN.md` loading/action styling. Cancelling clears the running spinner and shows a non-error "Query cancelled" summary.
- **Non-goal**: DynamoDB scan/query/PartiQL has no server-side abort API; it is explicitly out of scope (documented as a known limitation).

## Capabilities

### New Capabilities
- `query-cancellation`: The cross-engine mechanism for aborting an in-flight SQL run — the per-engine in-flight cancel-handle registry, the `*_cancel_sql` command contract, the run-token / `*:query-started` correlation event, the cancelled terminal state, and the user-facing Run⇄Stop affordance (button + shortcut) with its DESIGN-consistent presentation.

### Modified Capabilities
- `postgres-sql-editor`: Gains a requirement that a running query can be cancelled from the editor (Stop button + shortcut) and that cancellation aborts the backend statement and returns to idle.
- `mysql-sql-editor`: Same cancel affordance requirement.
- `mssql-sql-editor`: Same cancel affordance requirement.
- `athena-sql-editor`: Gains the user-facing Stop affordance, completing the already-present backend cancel path.

## Impact

- **Backend (Rust, `packages/app/src-tauri/`)**: new cancel-handle registries and `*_cancel_sql` commands + `*:query-started` emits in `modules/postgres/sql.rs`, `modules/mysql/sql.rs` (+ `mysql/cancel.rs`), `modules/mssql/sql.rs` (+ `mssql/cancel.rs`); command registration in `lib.rs`. Athena/CloudWatch backend unchanged.
- **Frontend (React/TS, `packages/app/src/`)**: `useQueryRun` hooks + `api.ts` for postgres/mysql/mssql/athena; Run/Stop control in each `QueryTab`/toolbar; `ResultPanel`/`RunSummary` cancelled-state copy. Mirrors `src/modules/cloudwatch/insights/`.
- **No new dependencies.** Reuses existing drivers' cancel facilities.
- **No persisted-state or wire-format breaking changes**; the new `*:query-started` events and `*_cancel_sql` commands are additive.
