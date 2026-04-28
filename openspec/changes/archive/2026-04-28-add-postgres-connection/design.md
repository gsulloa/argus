## Context

The bootstrap shipped a generic `connection-registry` (UUID + name + opaque kind + opaque params + optional keychain secret) and a sidebar "+" placeholder. Argus has no real connections yet. This change introduces the first concrete data-source module — Postgres — and is the foundation that every later Postgres change (`browse-postgres-schema`, `view-table-data`, `edit-table-data`, `run-sql`, …) plugs into.

The architecture rule from the bootstrap design must hold: the platform stays generic, and the postgres module owns everything Postgres-specific. Concretely, that means the SQLite `connections` table keeps storing `params` as opaque JSON; the Postgres module is the only piece of code that reads and writes that JSON shape, opens TCP connections, and enforces semantics like read-only.

The user's daily workflow target: open Argus → click "+" → fill host/port/db/user/password (or paste a URL) → click "Test" → click "Save" → click the connection in the sidebar to connect → see "active" indicator. Nothing else in this change.

## Goals / Non-Goals

**Goals:**

- Make the sidebar "+" launch a real, working Postgres connection form that parses URLs and tests connectivity synchronously.
- Persist Postgres connection metadata via the existing registry (no new tables, no migrations).
- Maintain a backend pool per active connection that later modules can borrow connections from without re-handshaking on every query.
- Establish the read-only safety contract once, here, so every later module that issues SQL inherits it without re-implementing.
- Define the boundary the rest of V1 will use: every Postgres query in Argus goes through `postgres::execute_*` helpers, never around them.

**Non-Goals:**

- SSH tunneling, client certificates, custom CA bundles, advanced libpq options (`connect_timeout`, `target_session_attrs`, `keepalives`, etc.). Defer to `add-ssh-tunnel` and a possible `postgres-advanced-options`.
- Auto-reconnect on transient network drops (tracked separately if pain emerges).
- Auto-connect on app launch. Connections open only on explicit user action.
- Schema browsing, data grid, SQL editor — all later changes that depend on the surface this change establishes.
- Multi-host failover, connection load-balancing.

## Decisions

### Decision: Driver — `tokio-postgres` + `deadpool-postgres`

**Choice**: Async Rust client (`tokio-postgres`) with a connection pool from `deadpool-postgres`.
**Rationale**:

- Tauri's command runtime is `tokio`-based; an async client integrates cleanly without blocking the runtime.
- `tokio-postgres` is the canonical pure-Rust Postgres client and is widely deployed.
- `deadpool-postgres` has a smaller, more obvious API than `bb8`; it is enough for an interactive desktop tool.
- Pool size for an interactive UI does not need to be large — 1 minimum, 4 maximum is plenty for "open three tabs and a SQL editor at once".
  **Alternatives considered**:
- `postgres` (sync) crate: simpler to reason about but blocks the Tokio runtime; would require `spawn_blocking` everywhere.
- `sqlx`: nice ergonomics but compile-time SQL checking is irrelevant for a tool that issues user-typed queries; pulls in extra deps.
- `bb8-postgres`: equivalent capabilities, just more verbose.

### Decision: TLS — `rustls` via `tokio-postgres-rustls`

**Choice**: Use `rustls` (pure-Rust TLS) glued to `tokio-postgres` through `tokio-postgres-rustls`. Bundle Mozilla's root CA list via `webpki-roots` for `verify-ca` / `verify-full`. For `require` (encrypt but do not verify), use a `dangerous_configuration` builder with no certificate verification.
**Rationale**:

- No system OpenSSL or Schannel dependency; static binary on every platform.
- `webpki-roots` keeps Argus self-contained without asking users to install certificates.
- Matches the rest of the stack: `rusqlite` is bundled; doing the same for TLS is consistent.
  **Alternatives considered**:
- `native-tls`: uses platform TLS — Schannel on Windows, SecureTransport on macOS, OpenSSL on Linux. Linux portability gets fragile.
- `openssl` directly: ABI-heavy on Linux, painful to ship.

### Decision: Connection params shape

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostgresParams {
    pub host: String,
    pub port: u16,                 // default 5432 if absent in URL
    pub database: String,
    pub username: String,
    pub sslmode: SslMode,
    #[serde(default)]
    pub application_name: Option<String>,  // default "argus" if None at connect time
    #[serde(default)]
    pub read_only: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SslMode {
    Disable,
    Prefer,        // try TLS, fall back to plain on TLS failure
    Require,       // TLS required, no verification
    VerifyCa,      // TLS + verify CA
    VerifyFull,    // TLS + verify CA + verify hostname
}
```

The TS mirror lives in `src/modules/postgres/types.ts`. Validation rules:

- `host` non-empty after trim.
- `port` in `[1, 65535]`.
- `database` non-empty.
- `username` non-empty (Postgres allows password-less but never empty user).
- `application_name` if present trims to non-empty (Postgres limit is 64 ASCII chars but we don't enforce that here — server will).
- `read_only` is a boolean; defaults to `false`.

The secret (the password) lives only in the OS keychain via the existing `connections.getSecret` command. The Postgres module retrieves it at the moment of test/connect and never persists it elsewhere.

### Decision: URL parsing

**Choice**: Accept `postgresql://` and `postgres://` URLs. Parse via the `url` crate and map fields with explicit rules:

| URL fragment              | Maps to              | Notes                                                              |
| ------------------------- | -------------------- | ------------------------------------------------------------------ |
| user info `user:pass@`    | `username` + secret  | URL-decoded; secret prefilled into the form's password field       |
| `host`                    | `host`               | Required                                                           |
| `port`                    | `port`               | Default 5432                                                       |
| path `/dbname`            | `database`           | Required                                                           |
| query `sslmode=...`       | `sslmode`            | Mapped via lowercase match; unknown values rejected with a message |
| query `application_name`  | `application_name`   |                                                                    |
| any other query parameter | ignored with warning | Out of scope for V1                                                |

**Rationale**: `psql` and ORM connection strings are the de facto interchange format. Parsing them lets users paste-and-go without re-keying eight fields.
**Alternatives considered**: writing a libpq-compatible "DSN string" parser (`host=... port=... dbname=...`) — more work, less commonly used today.

### Decision: Pool registry — `HashMap<UUID, deadpool_postgres::Pool>` behind `tokio::sync::RwLock`

**Choice**: A backend singleton stored as Tauri state.

```rust
pub struct PgPoolRegistry {
    pools: tokio::sync::RwLock<HashMap<Uuid, ActivePool>>,
}

pub struct ActivePool {
    pub pool: deadpool_postgres::Pool,
    pub server_version: String,
    pub read_only: bool,
    pub connected_at: SystemTime,
}
```

Lifecycle:

- `postgres.connect(id)`: load params + secret → build a pool with min=0, max=4 → fetch one connection eagerly (`SELECT version()`) to fail fast → insert into `pools`.
- `postgres.disconnect(id)`: remove the entry; `Drop` closes idle connections; in-flight ones complete then drop.
- `postgres.listActive()`: returns `Vec<{ id, server_version, read_only, connected_at }>`.
- Other modules call `registry.get_pool(id)?.pool.get().await` — every later change uses this same accessor.

**Rationale**: Pools must outlive single commands (else every query reconnects). They're keyed by connection id so multiple simultaneous connections don't trample each other. `RwLock` because reads (every query) outnumber writes (connect/disconnect).
**Alternatives considered**: One global pool — wrong for a multi-connection UI; can't mix read-only and read-write semantics on the same pool.

### Decision: Read-only enforcement

**Choice**: Two layers.

1. **Session level**: every connection acquired from a `read_only` pool runs `SET SESSION default_transaction_read_only = on; SET SESSION transaction_read_only = on;` immediately after handshake (via `deadpool_postgres` `RecyclingMethod::Custom` post-create hook). Postgres rejects any DML/DDL with `ERROR: cannot execute X in a read-only transaction`.
2. **Module level**: the Postgres module exposes `execute_query(id, sql, params)` (always allowed) and `execute_mutation(id, sql, params)` (rejected at the Rust boundary if the pool is read-only, returning `AppError::Validation("connection is read-only")` before ever hitting the wire).

Future changes that mutate (`edit-table-data`, mutating SQL in `run-sql`) MUST go through `execute_mutation`. The platform does not provide a generic "raw query" escape hatch.

**Rationale**: Defence in depth. The Rust gate gives a clean UX message ("this connection is read-only — toggle off to edit"); the Postgres session setting catches anything that slips through (e.g. a stored procedure with side effects).
**Alternatives considered**: Trust the UI to disable mutating affordances — fragile; one missed disable and the user wipes a row.

### Decision: Error model

Extend `AppError` with one variant:

```rust
#[error("postgres: {message}")]
Postgres { code: Option<String>, message: String },
```

Where `code` is the `SQLSTATE` if the error came from the server, `None` if it's a client-side issue (TLS handshake, DNS, refused connection). The TS mirror gets a matching variant. Existing variants (`Validation`, `NotFound`, etc.) are reused for non-Postgres errors.

**Rationale**: Postgres errors carry structured codes that the UI may want to render specifically (auth failure → "check password", TLS error → "check sslmode"). A typed variant beats stuffing it into `Internal`.

### Decision: Test-connection semantics

**Choice**: `postgres.testConnection(params, secret?)` opens a single connection (no pool), runs `SELECT version()`, closes it, returns:

```ts
type TestResult =
  | { ok: true; latencyMs: number; serverVersion: string }
  | { ok: false; error: AppError };
```

Timeout: hard 8 seconds. Latency measured from the start of `tokio_postgres::connect` to the end of `SELECT version()`.

**Rationale**: The form needs a fast yes/no answer; opening a full pool is overkill and would complicate the "I'm typing into the form, let me try this" flow. The 8s timeout matches typical libpq defaults but is short enough to keep the UI responsive.

### Decision: Connection form UI

**Choice**: Radix `Dialog` containing a controlled React form. Two top-level views toggled by a tab: "Form" (the eight fields) and "URL" (a single text input). The URL view has a "Parse" button that fills the form fields and switches to the form view; users always finalize from the form view. Submission flow:

1. "Test" button → calls `postgres.testConnection`. Loading state. Result area below shows green "Connected to PostgreSQL 16.1 in 23ms" or red error with the `AppError` message.
2. "Save" button → calls `connections.create` (or `update` if editing) with the params + password. Closes the dialog. The new connection appears in the sidebar.
3. "Save & Connect" button → save then immediately call `postgres.connect`.

Edit mode (right-click → Edit on a sidebar connection) loads existing params, leaves the password field empty (with placeholder "leave blank to keep existing"), and on save passes `secret: undefined` to the registry update so the keychain entry is untouched unless the user typed a new password.

### Decision: Sidebar integration

**Choice**: Each row in the sidebar's "Connections" list shows:

- Postgres elephant icon (Lucide doesn't ship one — use a custom 16px SVG component `<PostgresIcon />` in `src/modules/postgres/icon.tsx`).
- Connection name.
- Active dot (green) if `useActiveConnections()` reports the id as active.
- Read-only badge ("RO" pill) if `params.read_only` is true.
- Click row → toggles connect / disconnect (calls `postgres.connect` or `postgres.disconnect`).
- Right-click → context menu with Edit, Duplicate, Delete.

The "+" button opens the new connection form. Since Postgres is the only kind in V1, no kind-picker is needed; `add-dynamo-connection` (V2) is when the picker arrives.

### Decision: Active connections — Tauri events

**Choice**: The Rust pool registry emits a Tauri event `postgres:active-changed` after every connect/disconnect. The frontend's `useActiveConnections()` hook subscribes once at app mount and keeps a local map keyed by connection id.

**Rationale**: Polling is wasteful; Tauri events are the cheapest path. One event listener, one map, no ambiguity about "is connection X live right now".

## Risks / Trade-offs

- **TLS misconfigurations** → `rustls` is strict about CA validation, so a managed Postgres with a self-signed cert under `verify-full` will fail. Mitigation: `require` exists for "encrypt but don't validate"; document the trade-off in the form's sslmode tooltip; future change can add custom CA bundle.
- **Read-only bypass via stored procedures with `SECURITY DEFINER`** → A malicious or careless function could mutate even under `default_transaction_read_only = on` if it does `RESET` internally. Mitigation: this is a Postgres-level concern, document it; for V1, the threat model assumes the user is connecting to their own database.
- **Pool starvation under load** → max=4 might be tight if many tabs run long-running queries simultaneously. Mitigation: pool acquisition has an 8s timeout; surface clearly. Bump the default if real users complain.
- **Connection re-use across tabs** → All tabs of the same connection share the pool. A long `SELECT` in one tab blocks acquisition for another only when all 4 slots are busy. Acceptable for V1.
- **Password in transit between frontend and Rust** → On the way to `testConnection` for an unsaved form, the password traverses the Tauri IPC boundary. Mitigation: Tauri IPC is in-process; no network exposure. After save, passwords live only in the keychain — `testConnection` for already-saved connections retrieves the secret in Rust without sending it back across IPC.
- **Custom Postgres icon component drift** → Lucide doesn't ship one. The custom SVG must match the visual weight of Lucide icons. Mitigation: keep it small (single component), iterate once in design polish.

## Migration Plan

Greenfield within the bootstrap. Steps:

1. Add Rust deps to `src-tauri/Cargo.toml`.
2. Create `src-tauri/src/modules/postgres/` and wire it from `lib.rs` (commands + state).
3. Extend `AppError` with the `Postgres` variant; update the TS mirror.
4. Create `src/modules/postgres/` (api, types, url, ConnectionForm, useActiveConnections, commands).
5. Replace the placeholder dialog wired to the sidebar "+" with the new form.
6. Register the two palette commands.

No SQLite migration. No keychain migration. The only schema-level change is that `kind` is now expected to take the literal value `"postgres"` for new rows, but the registry continues to accept any string by contract.

Rollback: this change introduces no breaking IPC. If the postgres module is removed, existing rows in `connections` would still be readable; only the sidebar "+" form would lose its target. There is no production user data yet, so rollback is purely a code revert.

## Open Questions

- **Pool min size 0 vs 1**: with min=0 the first query after idle pays a connect cost; with min=1 the connection stays warm. For an interactive tool, min=1 feels right — picking 1 unless dev experience disagrees.
- **Connection name auto-suggestion**: should the form prefill `name` from `host/database` (e.g. "localhost • analytics")? Probably yes, but only when the user hasn't typed a custom name. Defer to implementation polish.
- **Cancellable test**: if the user clicks "Test" and immediately clicks "Test" again, do we cancel the first request? Acceptable to ignore for V1 — the 8s timeout caps the worst case.
