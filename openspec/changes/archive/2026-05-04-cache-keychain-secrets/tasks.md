## 1. Cache layer in `secrets.rs`

- [x] 1.1 Add `mod cache` inside `src-tauri/src/platform/secrets.rs` with a `OnceLock<Mutex<HashMap<Uuid, Option<String>>>>` and helper functions `peek(id) -> Option<Option<String>>`, `insert(id, value)`, `remove(id)`, and `clear()`.
- [x] 1.2 Refactor `pub fn get` to read-through the cache: hit returns immediately, miss reads `backend::get`, inserts into cache, returns.
- [x] 1.3 Refactor `pub fn set` to write-through: call `backend::set` first, then `cache::insert(id, Some(secret.to_string()))`.
- [x] 1.4 Refactor `pub fn delete` to evict-on-delete: call `backend::delete` first, then `cache::remove(id)`.
- [x] 1.5 Add `pub fn refresh(id) -> AppResult<Option<String>>` that calls `cache::remove(id)` then `get(id)` (which will repopulate from backend).
- [x] 1.6 Remove `secrets::_clear_for_tests()` from `connections::tests::fresh()` — the call would race with concurrent cache tests and is unnecessary because every connections test uses a fresh `Uuid`.

## 2. Test backend instrumentation

- [x] 2.1 Add a per-id call-count `OnceLock<Mutex<HashMap<Uuid, usize>>>` to `cfg(test) mod backend` and increment the counter for the looked-up id inside `backend::get` before any other work. Per-id (not global) so cache tests don't race against `connections.rs` tests on a shared counter.
- [x] 2.2 Expose `pub fn _get_call_count_for_tests(&Uuid) -> usize` from the test backend so cache tests can assert "no backend call on warm hit" via before/after deltas without ever touching another test's count.

## 3. Cache unit tests

- [x] 3.1 Add `#[cfg(test)] mod cache_tests` to `secrets.rs` — each test generates its own `Uuid::new_v4()` so no shared-state setup is required.
- [x] 3.2 Test: cold miss reads backend, inserts into cache, returns value.
- [x] 3.3 Test: warm hit returns cached value without incrementing the backend call counter.
- [x] 3.4 Test: cold miss for unknown id stores `None` in cache, second call does not invoke backend (negative caching).
- [x] 3.5 Test: `set` writes backend AND populates cache (subsequent `get` returns the new value with no extra backend call).
- [x] 3.6 Test: `delete` removes backend entry AND evicts cache (subsequent `get` re-reads backend, finds nothing, caches `None`).
- [x] 3.7 Test: `refresh` evicts the cache and re-reads the backend even when the cache previously held a different value for that id.
- [x] 3.8 _(removed — would test a global `_clear_for_tests` that we no longer expose; the per-id design makes the meta-test unnecessary.)_

## 4. Tauri command for refresh

- [x] 4.1 Add `connections::refresh_secret(conn, id) -> AppResult<Option<String>>` in `src-tauri/src/platform/connections.rs` that mirrors `get_secret`'s existence check and calls `secrets::refresh(&id)`.
- [x] 4.2 Add `connections_refresh_secret` `#[tauri::command]` wrapper accepting `(state: State<'_, DbState>, id: String)` and validating the UUID.
- [x] 4.3 Add a unit test in `connections::tests` that creates a connection with a secret, mutates the backend directly via `secrets::_backend_set_for_tests` (a new test-only helper that bypasses the cache wrapper) to simulate an external edit, calls `refresh_secret`, and asserts the new value is returned.
- [x] 4.4 Add a unit test that `refresh_secret` for an unknown id returns `AppError::NotFound`.
- [x] 4.5 Register `connections_refresh_secret` in the `tauri::generate_handler!` invocation in `src-tauri/src/lib.rs`.
- [x] 4.6 Add the command to the `pub use` re-export list at the top of `src-tauri/src/lib.rs` if other commands follow that pattern.

## 5. Frontend IPC binding

- [x] 5.1 Add `refreshSecret: (id: string) => call<string | null>("connections_refresh_secret", { id })` to the `connectionsApi` object in `src/platform/connection-registry/api.ts`.

## 6. ConnectionForm refresh button

- [x] 6.1 In `src/modules/postgres/ConnectionForm.tsx`, add a small button beside the password input, visible only when `initial?.id` is defined (editing an existing connection — there is no cached secret to refresh for a brand-new id).
- [x] 6.2 Label the button "Re-read from Keychain" and use an inline-SVG refresh icon (Lucide-shaped, 1.5px stroke, 14px) matching the existing inline-SVG convention in `src/modules/postgres/icon.tsx`. Verified against `DESIGN.md` (dark-first, restrained, single-accent).
- [x] 6.3 On click, call `connectionsApi.refreshSecret(initial.id)` with a loading state on the button while in flight; on success, replace the form's `password` field value with the result; on error, surface the error inline below the input using the existing `.error` className.
- [x] 6.4 Disable the button while loading; re-enable when the request settles. Icon spins via a CSS keyframe animation while loading.
- [x] 6.5 Manual smoke test: open a connection edit form, click the button, confirm the keychain prompt fires once (or never if "Always Allow" is set), and confirm the password field is updated. _(Verified by user.)_

## 7. Spec archive

- [x] 7.1 After implementation lands and CI is green, run `openspec archive cache-keychain-secrets` to fold the modified `connection-registry` requirements into `openspec/specs/connection-registry/spec.md`.

## 8. Verification

- [x] 8.1 Run `cargo test` and confirm all existing tests still pass plus the new cache and refresh tests are green. _(147 passed, 0 failed.)_
- [x] 8.2 Run `pnpm test:run` and confirm no regressions. _(56 passed, 0 failed.)_
- [x] 8.3 Manual end-to-end smoke test: launch Argus, connect to a saved Postgres connection (one keychain prompt), disconnect, reconnect (no prompt), open the connection edit form (no prompt), click "Re-read from Keychain" (one prompt), close and relaunch Argus, connect again (one prompt — cache cold). _(Verified by user.)_
