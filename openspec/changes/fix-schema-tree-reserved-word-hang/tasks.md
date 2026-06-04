## 1. Reproduce locally

- [ ] 1.1 Spin up the existing test Postgres container; create a table `CREATE TABLE "order" (id int primary key, ts timestamptz)`; add one index (`CREATE INDEX ON "order" (ts)`) and one BEFORE-INSERT trigger.
- [ ] 1.2 In the dev build, expand the `order` node in the schema tree and confirm the `(loading…)` hang reported in issue #56.
- [ ] 1.3 Capture the Tauri / Rust logs during the hang; note whether `list_table_extras_inner` ever logs entry/exit and whether `tracing::warn!` fires.

## 2. Backend: bound connection acquisition

- [x] 2.1 In `src-tauri/src/modules/postgres/schema_commands.rs`, add a module-level `const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(3);` adjacent to the existing `PER_QUERY_TIMEOUT` / `TOTAL_TIMEOUT`.
- [x] 2.2 Wrap the `pools.sslmode_for(&parsed)` and `pools.acquire(&parsed)` awaits inside `postgres_list_table_extras` in `tokio::time::timeout(ACQUIRE_TIMEOUT, …)`. On `Err(Elapsed)`, return `AppError::Postgres { code: Some("57014".into()), message: "Acquiring connection timed out (3s)".into() }`.
- [x] 2.3 Ensure the activity-log builder records this as an `err` outcome with `error.code = "57014"`.

## 3. Backend: panic-proof row decoding

- [x] 3.1 In `src-tauri/src/modules/postgres/schema.rs`, audit `list_table_indexes` and `list_table_triggers` for every `row.get::<_, T>(idx)` call.
- [x] 3.2 Replace each with `row.try_get::<_, T>(idx).map_err(|e| AppError::Postgres { code: None, message: format!("decode {col_label} (col {idx}): {e}") })?`.
- [x] 3.3 Verify no `unwrap()` / `expect()` remains in either function's row-iteration loop.

## 4. Backend: tracing spans

- [x] 4.1 Wrap the body of `list_table_extras_inner` in a `tracing::info_span!("list_table_extras", schema = %schema_name, relation = %relation).entered()` (or equivalent on the async path).
- [x] 4.2 Emit `tracing::info!("indexes query took {:?}", elapsed)` and the same for triggers, after each sub-query future resolves.

## 5. Backend: reproduction test

- [x] 5.1 Add a test (in `src-tauri/tests` or wherever the existing Postgres integration tests live) named `list_table_extras_reserved_word_table_completes`.
- [x] 5.2 The test SHALL create a Postgres relation named `order` with one index and one trigger, invoke `postgres_list_table_extras(id, schema, "order")`, and assert:
  - `result.indexes.is_some() && result.indexes.as_ref().unwrap().len() == 1`
  - `result.triggers.is_some() && result.triggers.as_ref().unwrap().len() == 1`
  - `result.failures.is_empty()`
  - the call completes in `< 5s` (use `tokio::time::Instant`).
- [ ] 5.3 Run the broader Postgres test suite to confirm no regression in existing extras-loading paths.

## 6. Frontend: hard safety timeout

- [x] 6.1 In `src/modules/postgres/schema/useSchemaTree.ts`, introduce a `TABLE_EXTRAS_SAFETY_TIMEOUT_MS = 12_000` constant near the top of the module.
- [x] 6.2 Refactor `runFetchTableExtras` so the `await schemaApi.listTableExtras(...)` is raced against a timer that resolves with a sentinel value after `TABLE_EXTRAS_SAFETY_TIMEOUT_MS`. On timeout, dispatch `tableExtrasFailed` with a synthetic `new AppError("Timeout", "Loading table details timed out (12s).")` and mark the in-flight call as "safety-tripped" so its later resolve/reject becomes a no-op.
- [x] 6.3 Ensure the safety-tripped flag is keyed by `(schema, relation)` so concurrent expansions of different tables do not interfere.
- [ ] 6.4 Verify (manually or via the test harness if present) that the loading flag is always cleared within 12s in pathological cases.

## 7. Frontend: failed-state UI sanity check

- [ ] 7.1 Confirm the existing `tableExtrasFailed` rendering already shows a `Retry` affordance (per the `postgres-schema-browser` spec). Re-test the path manually: simulate a safety timeout by mocking `schemaApi.listTableExtras` to never resolve; confirm Retry button appears and re-invokes the command.
- [ ] 7.2 If the error message is not user-friendly, map `AppError("Timeout", …)` to the existing failure placeholder string and expose the detailed message in the tooltip (per design.md Open Questions resolution).

## 8. Ship

- [ ] 8.1 Update the in-app CHANGELOG entry (if one exists in this repo) with a short user-facing line: "Fixed: schema tree no longer hangs when a table name is a SQL reserved word."
- [ ] 8.2 Self-review the diff, confirm no IPC contract change, no activity-log shape change.
- [ ] 8.3 Open a PR titled `fix: schema tree hangs on reserved-word table names (#56)`, link issue #56 in the description, and tag the relevant reviewer.
- [ ] 8.4 Archive this OpenSpec change (`/opsx:archive` once merged) so the modified requirements land in `openspec/specs/postgres-schema-browser/spec.md`.
