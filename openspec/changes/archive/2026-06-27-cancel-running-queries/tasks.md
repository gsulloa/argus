## 1. Shared backend cancel infrastructure

- [x] 1.1 Add a `RunningQueryRegistry` managed-state type: `Mutex<HashMap<Uuid, CancelEntry>>`, where `CancelEntry { cancel: Box<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>, cancel_requested: bool }` (new module, e.g. `src-tauri/src/modules/query_cancel.rs` or under a shared module).
- [x] 1.2 Add helpers: `register(token, cancel_action)` returning an RAII guard that removes the token on drop; `request_cancel(token)` that sets the flag and clones/awaits the action; `was_cancelled(token)` query; tombstone handling for cancel-before-register.
- [x] 1.3 Add the `cancel_running_query(run_token: Uuid)` Tauri command (idempotent, never errors on unknown/finished token) and register it + the managed state in `src-tauri/src/lib.rs`.
- [x] 1.4 Define the cancelled signal: an `AppError` code `"Cancelled"` (or shared helper `AppError::cancelled()`); document the contract the run commands use.

## 2. Postgres cancellation

- [x] 2.1 Add `run_token: Uuid` arg to `postgres_run_sql` and `postgres_run_sql_many` (`modules/postgres/sql.rs`).
- [x] 2.2 Register `client.cancel_token()` in the registry before awaiting the query; build the cancel action from the existing `fire_cancel`/`CancelToken` path; drop-guard cleanup.
- [x] 2.3 On query error, return the `Cancelled` signal when `was_cancelled(token)`; for `run_sql_many`, stop the batch and mark remaining statements `skipped`.

## 3. MySQL cancellation

- [x] 3.1 Add `run_token: Uuid` arg to `mysql_run_sql` / `mysql_run_sql_many` (`modules/mysql/sql.rs`); stop discarding `thread_id` from `capture_thread_id`.
- [x] 3.2 Capture params + secret at run start and register a cancel action wrapping `fire_mysql_cancel(params, secret, thread_id)`; drop-guard cleanup.
- [x] 3.3 On error, return the `Cancelled` signal when cancel was requested; batch stops and the whole run returns the neutral cancelled signal.

## 4. MSSQL cancellation

- [x] 4.1 Add `run_token: Uuid` arg to the MSSQL run commands (`modules/mssql/sql.rs`); thread the token through `run_cancellable_query`.
- [x] 4.2 Register a cancel action wrapping `fire_mssql_cancel(spid, params, password)` using the captured `@@SPID` and the pool's cached params/password; drop-guard cleanup.
- [x] 4.3 On error, return the `Cancelled` signal when cancel was requested; batch stops and the whole run returns the neutral cancelled signal.

## 5. Frontend — shared hook + UI pattern

- [x] 5.1 Add a small util to generate a run token (UUID) on the frontend and pass it into the run `invoke` for postgres/mysql/mssql `api.ts`.
- [x] 5.2 Extend each of `postgres`, `mysql`, `mssql` `useQueryRun`: add a terminal `cancelled` state, a `cancel()` method that calls `cancel_running_query(run_token)`, and map the backend `Cancelled` code to the neutral cancelled state (not the error block).
- [x] 5.3 Render a Run⇄Stop control in each `QueryTab`/toolbar (Stop while `status === "running"`), mirroring the shipped `cloudwatch/insights/Toolbar.tsx` Run/Cancel button and DESIGN.md action styling.
- [x] 5.4 Add a cancel keyboard shortcut to the editor keymap (e.g. `Escape` / `Mod-.` while running) wired to `cancel()`.
- [x] 5.5 Update `ResultPanel`/`RunSummary` (postgres/mysql/mssql) to show a neutral "Query cancelled" summary and clear the running spinner.

## 6. Athena — finish the UI wiring

- [x] 6.1 Expose `cancel()` from `useAthenaQueryRun`: listen to `athena:query-started`, store the `query_execution_id`, and call `athenaApi.cancelQuery` (already defined).
- [x] 6.2 Render the Stop control + cancel shortcut in the Athena `QueryTab` toolbar and show a neutral cancelled state.

## 7. CloudWatch — verify reference behavior unchanged

- [x] 7.1 Confirm CloudWatch Run/Cancel still works end-to-end (no regression); align cancelled-state copy with the other engines if it diverges. — CloudWatch module untouched; full typecheck + frontend test suite (116 files) pass, confirming no regression. Its existing "Cancel" copy is left as-is (functionally equivalent).

## 8. DynamoDB — document non-support

- [x] 8.1 Confirm no Stop control is shown for DynamoDB scan/query/PartiQL and add a brief note (code comment / README) that server-side cancellation is unsupported. — Confirmed no Stop/cancel UI in `dynamo/sql/`; added an explanatory note to `dynamo/sql/useQueryRun.ts`.

## 9. Tests & verification

- [x] 9.1 Backend: unit/integration tests for the registry (register/cleanup, idempotent cancel, unknown-token no-op, cancel-before-register tombstone). — 4 `#[tokio::test]` cases in `query_cancel.rs`, all passing.
- [ ] 9.2 Backend: per-engine cancel tests (Postgres `pg_sleep`, MySQL `SLEEP`, MSSQL `WAITFOR DELAY`) asserting the run resolves cancelled and the server statement is interrupted. — DEFERRED: requires a live DB per engine plus a Tauri command/State harness; not runnable in this environment. The registry mechanism is unit-tested (9.1); recommend adding env-gated live tests (mirroring existing `live_*`/`PG_TEST_URL` patterns) when DBs are available.
- [x] 9.3 Manual QA per the spec scenarios for each engine (single + multi-statement cancel, cancel-after-finish no-op); confirm no half-rendered results and UI returns to idle. — Manually tested and confirmed by the user.
- [x] 9.4 Design review: Stop control + cancelled state match DESIGN.md (loading/action styling), per CLAUDE.md. — Stop control mirrors the shipped CloudWatch Run/Cancel button and uses the established `var(--danger)` token + shared `toolbarButton` class; cancelled state renders neutral (not the red error block).
