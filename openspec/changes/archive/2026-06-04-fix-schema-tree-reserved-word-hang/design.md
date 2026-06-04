## Context

The schema tree under each connected Postgres connection lazily loads per-table indexes and triggers via the Tauri command `postgres_list_table_extras(id, schema, relation)`. The current implementation is documented in `openspec/specs/postgres-schema-browser/spec.md` under *List table extras command* and *Lazy on-expand fetching*.

Today's implementation:

- **Backend** — `src-tauri/src/modules/postgres/schema_commands.rs:387-470`
  - `list_table_extras_inner` runs two parameterised catalog queries (`pg_index`, `pg_trigger`) concurrently with `tokio::join!`, each wrapped in `timeout(PER_QUERY_TIMEOUT, …)` (8s).
  - The whole `list_table_extras_inner` future is also wrapped in `timeout(TOTAL_TIMEOUT, …)` (10s).
  - On overall expiry, the code fires a `pg_cancel_backend` via the cached `cancel_token` and synthesises a `failures` envelope of `57014` entries.
  - Crucially, the **connection-borrow and SSL-mode lookup happen *before* the `timeout` wrapper**:
    ```rust
    let sslmode = pools.sslmode_for(&parsed).await?;       // unbounded
    let client = pools.acquire(&parsed).await?;            // unbounded
    let cancel_token = client.cancel_token();
    let outcome = timeout(TOTAL_TIMEOUT, list_table_extras_inner(&client, …)).await;
    ```
  - Row decoding inside `schema::list_table_indexes` / `list_table_triggers` uses `row.get::<_, T>(idx)` — a panic if a column is `NULL` or of the wrong type.

- **Frontend** — `src/modules/postgres/schema/useSchemaTree.ts:508-561`
  - `runFetchTableExtras` dispatches `tableExtrasLoading`, then awaits `schemaApi.listTableExtras(...)`.
  - On resolve → `tableExtrasLoaded`. On reject → `tableExtrasFailed`. No timeout, no `AbortController`, no fallback transition.
  - If the IPC promise neither resolves nor rejects, the state machine sits on `loading` forever, which is exactly what the reporter sees.

The reported symptom (reserved-word table `order` hangs forever) is consistent with one of:

1. **Unbounded connection acquisition** — if `pools.acquire` blocks for a reason indirectly related to the relation (catalog autovacuum on a reserved-word relation, lock contention, exhausted pool), the command never reaches the timeout-protected section.
2. **Panic in row decode** — if a catalog row contains a NULL where the decoder assumes non-NULL, the panic aborts the task; depending on Tauri's plumbing the IPC channel may close *without* surfacing a typed error, leaving the JS promise pending.
3. **Lost response** — Tauri 2 IPC has known edge cases where a panicking command leaves the JS-side promise unresolved.

In all three cases, the user-visible failure mode is identical: indefinite `(loading…)`. The fix must therefore be defensive at **both** layers — backend can no longer hang, *and* frontend treats indefinite silence as an error.

## Goals / Non-Goals

**Goals:**

- A reserved-word relation (`order`, `select`, `from`, `group`, etc.) MUST never wedge the schema tree. The per-table loading indicator MUST resolve to either a populated extras payload or a typed error within a small, bounded time.
- All panics inside `list_table_extras` MUST be converted to typed `AppError` or `KindFailure` entries before the IPC response is sent.
- Connection-acquisition latency MUST be subject to a timeout shorter than or equal to the existing total timeout.
- The reproduction case (a real Postgres table named `order`) MUST be covered by an automated test that runs in CI.

**Non-Goals:**

- Redesigning the `TableExtrasResult` envelope, JSON keys, or activity-log fields. The IPC contract stays as-is.
- Changing the lazy-load policy or cache structure on the frontend.
- Auto-retry on `postgres_list_table_extras` failures (the existing spec explicitly disallows auto-retry for this command).
- Generalising the fix to MySQL / MSSQL schema browsers, even though they have analogous code paths. Each engine ships its own change if needed.
- Changing the queries themselves — the queries are already parameter-safe; this fix is about timeouts, panic resilience, and frontend safety net.

## Decisions

### 1. Add a frontend hard timeout of 12s on `listTableExtras`

In `useSchemaTree.ts`, wrap the `schemaApi.listTableExtras(...)` call in a `Promise.race` against a 12-second timer. If the timer wins, the state transitions to `tableExtrasFailed` with a synthetic `AppError("Timeout", "Loading table details timed out (12s).")` so the inline `Retry` affordance appears.

**Why 12s.** The backend's existing `TOTAL_TIMEOUT` is 10s for the query work, plus up to ~1s of acquisition slack. 12s gives the backend its full envelope while preventing the spinner from ever sitting past ~12 seconds.

**Alternatives considered:**

- *`AbortController` + cancellable IPC.* Tauri does not expose first-class cancellation for commands. The signal would just be advisory on the JS side. Reject — adds complexity, doesn't solve the problem the user reports (UI-stuck).
- *Polling the state machine and retrying.* Auto-retry is explicitly disallowed for this command in the existing spec.

### 2. Bound connection acquisition on the backend

Wrap `pools.sslmode_for` and `pools.acquire` in a `timeout(ACQUIRE_TIMEOUT, …)` of 3 seconds. On expiry, return `AppError::Postgres { code: Some("57014"), message: "Acquiring connection timed out (3s)" }` and emit an activity-log `err` entry.

**Why 3s.** Acquisition should be milliseconds against a healthy local pool. 3s is generous; anything beyond it means something is wrong and the user is better served by a typed error than an indefinite spinner.

**Alternatives considered:**

- *Same as `TOTAL_TIMEOUT` (10s).* Reject — too coarse; gives the spinner an extra 10s of dead time for a class of failures that is independent of relation contents.
- *Make `pools.acquire` itself enforce a default timeout.* Would touch every Postgres command and risk hidden regressions. Out of scope for issue #56.

### 3. Convert row-decode panics into `KindFailure` entries

Refactor `schema::list_table_indexes` and `schema::list_table_triggers` (in `src-tauri/src/modules/postgres/schema.rs`) so every `row.get::<_, T>(idx)` is replaced with `row.try_get::<_, T>(idx).map_err(|e| AppError::Postgres { code: None, message: format!("decode column {idx}: {e}") })?`. The `try_kind` wrapper already converts an `Err` return into a failure-envelope entry, so this is the smallest change that closes the panic gap.

**Why `try_get` not `catch_unwind`.** `try_get` is the idiomatic, allocation-free approach in `tokio_postgres`. `catch_unwind` would also work but pollutes the call site and forces `UnwindSafe` bounds.

**Alternatives considered:**

- *Audit every `unwrap()`/`expect()` in the Postgres module.* Out of scope. We address only the table-extras path because that's where the reported hang occurs; broader hardening is a follow-up if any other path is implicated.

### 4. Reproduction test: reserved-word table

Add a new integration test (or extend an existing one) under `src-tauri/tests` that:

1. Boots the existing test Postgres container.
2. Executes `CREATE TABLE "order" (id int primary key, ts timestamptz)` and a representative index + trigger.
3. Invokes `postgres_list_table_extras` with `relation = "order"`.
4. Asserts the returned `TableExtrasResult` has `indexes.is_some()`, `triggers.is_some()`, `failures.is_empty()`, and that the call completes in under 5 seconds.

This locks in the actual scenario from issue #56 and prevents regression.

### 5. Structured `tracing` spans around the inner work

Wrap `list_table_extras_inner` in a `tracing::info_span!("list_table_extras", schema = %schema_name, relation = %relation)` and emit `tracing::info!` events for each sub-query's elapsed time. This means the next time anyone files a "hangs forever" bug, the logs can confirm whether either query actually started, finished, or never returned.

## Risks / Trade-offs

- **Risk**: The 12s frontend timeout could fire on a slow but ultimately successful backend (e.g. enormous catalogs over a slow VPN). → **Mitigation**: 12s is comfortably above the backend's hard ceiling of 10s + a small acquire slack; if the backend respects its own timeouts, the frontend safety net never wins the race. If a user's catalog is so large that 10s isn't enough, that's already a backend problem owned by the *List table extras command* requirement — and the frontend correctly surfaces it as a typed retry.
- **Risk**: Bounding `pools.acquire` at 3s could surface as a new error class for users with slow remote databases on first connect. → **Mitigation**: 3s applies only to **borrowing from an already-established pool**, not the initial connect handshake. A healthy pool returns a client in < 5 ms. The error message names the cause.
- **Risk**: Switching from `get` to `try_get` is a refactor across two functions and could introduce a regression. → **Mitigation**: existing tests cover the happy path; the reproduction test covers the reserved-word path. Code review should diff each call site.
- **Trade-off**: We do not generalise the fix to MySQL/MSSQL even though they share the same pattern. Doing so doubles the scope; if those engines turn out to have the same bug, we file a follow-up rather than expanding this change.

## Migration Plan

This change is a pure bug fix — no schema migration, no IPC contract change, no settings migration. Ship with the next regular release. Rollback is `git revert` of the change commit.

## Open Questions

- Do we want to surface the synthesised `Timeout` error message in the UI verbatim, or map it to the existing "Failed to load (Retry)" placeholder used by other failure modes in the schema tree? **Default:** use the existing placeholder for visual consistency; expose the detailed message in a tooltip or in the dev console.
