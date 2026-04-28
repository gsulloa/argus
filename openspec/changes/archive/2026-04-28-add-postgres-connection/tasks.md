## 1. Rust deps and module scaffolding

- [x] 1.1 Add Rust deps to `src-tauri/Cargo.toml`: `tokio-postgres`, `deadpool-postgres`, `rustls`, `tokio-postgres-rustls`, `webpki-roots`, `url`, plus `chrono` (or use `time`) for `connectedAt` timestamps
- [x] 1.2 Create directory `src-tauri/src/modules/postgres/` with files `mod.rs`, `params.rs`, `url.rs`, `tls.rs`, `pool.rs`, `commands.rs`
- [x] 1.3 Wire `pub mod modules { pub mod postgres; }` in `src-tauri/src/lib.rs`

## 2. Error model extension

- [x] 2.1 Extend `AppError` in `src-tauri/src/error.rs` with variant `Postgres { code: Option<String>, message: String }` and update the `serde::Serialize` tag/content shape
- [x] 2.2 Add `From<tokio_postgres::Error>` impl that extracts SQLSTATE via `error.code().map(|c| c.code().to_string())`
- [x] 2.3 Mirror the new variant in `src/platform/errors.ts` so the frontend's typed error union covers `{ kind: "Postgres", message: { code: string | null, message: string } }`

## 3. Params type and validation

- [x] 3.1 In `params.rs` define `PostgresParams` struct and `SslMode` enum exactly as in `design.md`
- [x] 3.2 Implement `PostgresParams::validate(&self) -> Result<(), AppError>` enforcing non-empty host/database/username, port in `[1, 65535]`, sslmode within the enum, optional non-empty `application_name`
- [x] 3.3 Implement `PostgresParams::from_json(value: &serde_json::Value)` and `to_json` helpers used by the registry round-trip
- [x] 3.4 Mirror `PostgresParams` and `SslMode` in `src/modules/postgres/types.ts` (string-literal union for sslmode)

## 4. URL parser

- [x] 4.1 In `url.rs` implement `parse_postgres_url(input: &str) -> Result<(PostgresParams, Option<String>), AppError>` per the table in `design.md`
- [x] 4.2 Reject schemes other than `postgres` / `postgresql` with `AppError::Validation`
- [x] 4.3 URL-decode userinfo with the `url` crate's accessor; default port to 5432 when absent
- [x] 4.4 Map `?sslmode=...` to `SslMode`; reject unknown values
- [x] 4.5 Copy `?application_name=...` into params; ignore other query params (log a `tracing::warn!`)
- [x] 4.6 Add Rust unit tests covering: full URL, missing port, encoded credentials, malformed URL, unknown sslmode
- [x] 4.7 Mirror as `parsePostgresUrl(input: string)` in `src/modules/postgres/url.ts` for offline-feeling form UX (the form calls into the Rust version via Tauri command `postgres.parseUrl` to keep behavior identical and avoid duplicate parsing logic)
- [x] 4.8 Register Tauri command `postgres.parseUrl(input: string) -> { params: PostgresParams, password: string | null }` returning `AppError::Validation` on failure

## 5. TLS configuration

- [x] 5.1 In `tls.rs` build a `rustls::ClientConfig` factory: for `Disable`, return `None`; for `Prefer`/`Require`, return a config with `dangerous_configuration` no-verify CA; for `VerifyCa`/`VerifyFull`, build a config that loads `webpki_roots::TLS_SERVER_ROOTS`
- [x] 5.2 For `VerifyFull`, set the verifier to also check hostname; for `VerifyCa`, accept any matching CA but skip hostname check
- [x] 5.3 Add a helper `apply_tls_to_pg_config(pg_cfg: &mut tokio_postgres::Config, sslmode: SslMode)` that translates `Prefer/Require/VerifyCa/VerifyFull` to the appropriate `tokio_postgres` `SslMode` and keeps the rustls config pairing aligned

## 6. Test connection command

- [x] 6.1 In `commands.rs` implement `postgres_test_connection(params: PostgresParams, secret: Option<String>) -> Result<TestResult, AppError>` matching the spec; build a `tokio_postgres::Config` from params + secret, attach the rustls connector via `tokio-postgres-rustls`, connect, run `SELECT version()`, close
- [x] 6.2 Wrap the whole operation in `tokio::time::timeout(Duration::from_secs(8), ...)` and return a typed `Postgres` error on timeout
- [x] 6.3 Measure `latency_ms` from start of `connect` to end of `SELECT version()` using `Instant::now()`
- [x] 6.4 Register the command and add Rust unit tests covering: invalid params (validation), unreachable host (DNS error), wrong password (`28P01`), success (gated behind a `cfg(feature = "live-pg-tests")` env flag so CI doesn't need a live server)

## 7. Pool registry and connect/disconnect

- [x] 7.1 In `pool.rs` define `PgPoolRegistry { pools: tokio::sync::RwLock<HashMap<Uuid, ActivePool>> }` and `ActivePool { pool, server_version, read_only, connected_at }`
- [x] 7.2 Implement `PgPoolRegistry::connect(app, id)` that loads params via the connections table, fetches the secret via the keychain helper, builds a `deadpool_postgres::Pool` with `max_size=4`, applies a post-create hook that runs the read-only `SET SESSION` statements when `params.read_only` is true, and eagerly fetches one connection to verify
- [x] 7.3 Implement idempotency: if `id` is already present in `pools`, return the existing `ActivePool` snapshot (server_version, read_only) without rebuilding
- [x] 7.4 Implement `PgPoolRegistry::disconnect(id)` removing the entry and dropping the pool (deadpool's `Drop` closes idle connections)
- [x] 7.5 Implement `PgPoolRegistry::list_active() -> Vec<ActivePoolSummary>`
- [x] 7.6 Register the registry as `tauri::State<PgPoolRegistry>` in `setup()` of `lib.rs`
- [x] 7.7 Implement Tauri commands `postgres.connect`, `postgres.disconnect`, `postgres.listActive`
- [x] 7.8 After every successful connect/disconnect, call `app_handle.emit("postgres:active-changed", ())`
- [x] 7.9 Add Rust unit tests for the registry behavior using a stub pool builder (live-pg-tests feature for the actual handshake)

## 8. Read-only enforcement helpers

- [x] 8.1 In `pool.rs` expose `executeQuery(state, id, sql, params) -> Result<Vec<Row>, AppError>` that acquires from the pool and runs `query`
- [x] 8.2 Expose `executeMutation(state, id, sql, params) -> Result<u64, AppError>` that first checks `ActivePool.read_only` and returns `AppError::Validation("connection is read-only")` if true; otherwise runs `execute`
- [x] 8.3 Make the raw pool field non-`pub` outside the module so other crates / modules cannot bypass the helpers
- [x] 8.4 Add unit tests: read-only pool rejects `executeMutation` before any wire activity; permissive pool runs both helpers

## 9. Frontend Postgres module — types and API

- [x] 9.1 Create `src/modules/postgres/types.ts` with `PostgresParams`, `SslMode`, `TestResult`, `ActiveConnection` types matching the Rust shapes
- [x] 9.2 Create `src/modules/postgres/api.ts` with typed wrappers: `testConnection`, `connect`, `disconnect`, `listActive`, `parseUrl`
- [x] 9.3 Each wrapper uses `invoke` and re-throws typed `AppError`

## 10. Active connections hook and event subscription

- [x] 10.1 Create `src/modules/postgres/useActiveConnections.ts` — on mount calls `listActive`, subscribes to the `postgres:active-changed` Tauri event via `@tauri-apps/api/event`, refreshes on every event
- [x] 10.2 Provide a `Map<uuid, ActiveConnection>` plus convenience getters `isActive(id)`, `getActive(id)`
- [x] 10.3 Mount the subscription once at app root (e.g. in `src/app/App.tsx`) so a single listener serves all consumers

## 11. Connection form

- [x] 11.1 Create `src/modules/postgres/ConnectionForm.tsx` — a Radix `Dialog` with a controlled form
- [x] 11.2 Implement two views via a tab control: "Form" (eight fields + read-only toggle) and "URL" (single text input + Parse button)
- [x] 11.3 Implement field-level client validation that mirrors the Rust validator (so users see errors before clicking Test/Save)
- [x] 11.4 Implement "Test" button: calls `postgres.testConnection`, shows loading state, renders green `serverVersion` + `latencyMs` row or red `AppError` row
- [x] 11.5 Implement "Save" button: calls `connections.create` (or `connections.update` in edit mode), closes dialog
- [x] 11.6 Implement "Save & Connect": save then immediately call `postgres.connect(newId)`
- [x] 11.7 Implement edit mode: load existing params, leave the password field empty with placeholder "leave blank to keep existing", and on save pass `secret: undefined` to the registry update
- [x] 11.8 Implement URL "Parse" flow: call `postgres.parseUrl`, fill the form fields, switch to Form view, prefill password if provided

## 12. Sidebar integration

- [x] 12.1 Replace the placeholder dialog wired to the sidebar "+" button (added in bootstrap task 7.4) with `ConnectionForm` open in create mode
- [x] 12.2 Render each connection row with: `<PostgresIcon />`, name, green active dot from `useActiveConnections`, "RO" badge if `params.read_only`
- [x] 12.3 Click row toggles `postgres.connect` / `postgres.disconnect`
- [x] 12.4 Right-click row opens a Radix context menu with `Edit`, `Duplicate`, `Delete`
- [x] 12.5 Implement `Edit` (open form in edit mode), `Duplicate` (open form in create mode prefilled with same params and a name suffix), `Delete` (confirm dialog → `connections.delete` → `postgres.disconnect`)
- [x] 12.6 Create `src/modules/postgres/icon.tsx` with a 16px Postgres elephant SVG component matching Lucide visual weight

## 13. Palette commands

- [x] 13.1 In `src/modules/postgres/commands.ts` register on app mount: `Connection: New Postgres…`, `Connection: Test…`, `Connection: Connect…`, `Connection: Disconnect…`
- [x] 13.2 `Connection: New Postgres…` opens the form in create mode
- [x] 13.3 `Connection: Test…` / `Connect…` / `Disconnect…` use the currently selected connection if one is selected; otherwise transition the palette to a chooser listing connections (via cmdk's nested-page support or a simple custom subview)

## 14. Frontend wiring and cleanup

- [x] 14.1 Mount the postgres module's command-registration and event-subscription side-effects in `src/app/App.tsx` (or an equivalent app-root effect)
- [x] 14.2 Remove the bootstrap's "coming soon" placeholder dialog from `src/platform/connection-registry/` (or the sidebar) once the real form is wired
- [x] 14.3 Update `src/platform/connection-registry/api.ts` (if needed) to expose a typed discriminated union over `kind`, narrowing `params` to `PostgresParams` when `kind === "postgres"`

## 15. Acceptance verification

- [ ] 15.1 Manual: launch `pnpm tauri dev`, click "+", fill a real local Postgres, click "Test" — green success row appears with latency and version
- [ ] 15.2 Manual: paste `postgresql://user:pass@localhost:5432/postgres?sslmode=disable` in the URL view, click "Parse" — form view fills correctly, password populated
- [ ] 15.3 Manual: click "Save & Connect" — dialog closes, sidebar row appears, green active dot lights up
- [ ] 15.4 Manual: click the active row — green dot clears, `listActive` returns empty
- [ ] 15.5 Manual: right-click → Edit, change name, leave password empty, save — name updates, connection still authenticates next connect
- [ ] 15.6 Manual: create a connection with `read_only: true`, connect, then from the Tauri dev console call `executeMutation(id, "UPDATE x SET y=1", [])` — error is `Validation: connection is read-only`
- [ ] 15.7 Manual: stop Postgres, click row to connect — red error toast with the typed Postgres message; sidebar row stays inactive
- [ ] 15.8 Manual: ⌘K → "Connection: New Postgres…" opens the form
- [ ] 15.9 Build a release bundle with `pnpm tauri build` and confirm the binary connects to the same database as the dev build
