## Why

The bootstrap shell ships an empty `connection-registry` and a sidebar "+" that opens a placeholder dialog. To start replacing TablePlus we need real Postgres connections: persisted, testable, openable, with a read-only safety flag. This change introduces the first data-source module — `postgres-connection` — and is the prerequisite for every later Postgres capability (schema browser, data grid, SQL editor, etc.).

The slice is intentionally narrow: only what is needed to define a Postgres connection, verify it works, and open/close a backend pool. No schema browsing, no data grid, no SQL execution.

## What Changes

- New Postgres module on the Rust side (`src-tauri/src/modules/postgres/`) and the TS side (`src/modules/postgres/`).
- Strongly-typed Postgres connection params: `host`, `port`, `database`, `username`, `sslmode` (one of `disable | prefer | require | verify-ca | verify-full`), optional `application_name`, and a `read_only: bool` toggle. Stored in the registry's generic `params` field as JSON, owned and validated by the Postgres module.
- Connection form UI launched from the sidebar's "+" button: full form (host/port/database/user/password/sslmode/application_name + read-only toggle) and an alternative "paste connection URL" input that parses a `postgresql://` URL into the same form fields.
- Tauri command `postgres.testConnection(params, secret)`: opens a single connection, runs `SELECT version()`, closes it, and returns `{ ok: true, latencyMs, serverVersion }` or a typed error.
- Tauri commands `postgres.connect(connectionId)` and `postgres.disconnect(connectionId)`: maintain a per-connection pool in a backend registry. `connect` opens the pool (size 1–4) and reports success once the first connection is healthy; `disconnect` drains and removes the pool.
- Read-only enforcement at the Postgres module boundary: when `read_only: true`, the module's session sets `default_transaction_read_only = on` and rejects any later command that would mutate. Future changes (`edit-table-data`, `run-sql` with mutating SQL) are required to call into this module and inherit the enforcement.
- Frontend "active connections" state: hook + sidebar visual indicator showing which connections are connected vs disconnected.
- Wire the sidebar "+" button to the new Postgres connection dialog. The placeholder dialog from the bootstrap is removed.
- Register two commands in the command palette: `Connection: New Postgres…` (opens the form) and `Connection: Test…` (tests the currently selected connection).

**Out of scope** (deferred):

- SSH tunnels, client certificates, custom CA bundles, advanced libpq options like `connect_timeout`, `target_session_attrs`. Future change `add-ssh-tunnel` and a possible `postgres-advanced-options`.
- Schema browsing, data viewing, data editing, SQL execution. Those are later changes that depend on this one.
- Auto-connect on app launch (the user opens connections explicitly in V1).

## Capabilities

### New Capabilities

- `postgres-connection`: Postgres-specific connection lifecycle — params shape, URL parser, read-only flag, `testConnection` / `connect` / `disconnect` Tauri commands, backend pool registry, and the connection form UI invoked from the sidebar.

### Modified Capabilities

<!-- None — connection-registry stays generic by design (platform never interprets `params`); the Postgres module owns its own validation. The sidebar "+" button binding to a real form is a wiring detail of `connection-registry`'s frontend hooks, not a spec contract change. -->

## Impact

- **New code**:
  - Rust: `src-tauri/src/modules/postgres/{mod.rs, params.rs, url.rs, commands.rs, pool.rs, error.rs}`.
  - TypeScript: `src/modules/postgres/{api.ts, types.ts, url.ts, ConnectionForm.tsx, useActiveConnections.ts, commands.ts}`.
  - Migration: none — reuses the existing `connections` table; `kind` becomes the literal `"postgres"`.
- **New dependencies**:
  - Rust: `tokio-postgres`, `deadpool-postgres` (or `bb8-postgres`), `rustls` + `tokio-postgres-rustls` for TLS, `url` for URL parsing.
  - JS: none new — form built with existing Radix Dialog + form primitives.
- **Modified files**:
  - `src/platform/shell/Sidebar.tsx` — "+" button now dispatches to `postgres.openCreateForm` (the only kind in V1) instead of the placeholder dialog.
  - `src/platform/connection-registry/api.ts` — typed wrapper learns the `"postgres"` kind discriminant for the params field.
  - `src-tauri/src/lib.rs` — registers the Postgres module's commands and pool registry as Tauri state.
- **No breaking changes** to the registry contract. Existing rows from the bootstrap (none in production) remain compatible.
- **User-visible change**: the sidebar "+" now opens a real working form. The first usable Postgres connection can be saved, tested, opened, and closed.
