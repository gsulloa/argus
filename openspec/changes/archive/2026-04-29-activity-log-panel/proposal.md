## Why

Argus runs Postgres operations on the user's behalf — connection acquisition, schema/relation listing, count queries, paged data reads — and today they are invisible. When a click feels slow, when a result seems wrong, or when a user wants to learn what query Argus actually issued, there is no surface that answers it. The Rust side already records per-query duration via `tracing`, but those logs only reach stdout (debug) or a daily file (release); nothing is reachable from the app itself.

A bottom activity-log panel turns Argus from an opaque data inspector into one whose work is legible. It makes Argus debuggable by its own users, surfaces real query timings as a feedback signal, and creates the foundation for future affordances ("re-run this query in the editor", "copy SQL", "explain plan").

## What Changes

- Add an in-app activity log that records every Postgres operation as a structured entry: timestamp, connection id, op kind, SQL (when applicable), bind params (when applicable), duration, status, and a per-op secondary metric (rows / count / server version).
- Rust emits a Tauri event `argus:activity-log` from each Postgres command (`postgres_test_connection`, `postgres_connect`, `postgres_disconnect`, `postgres_list_active`, `postgres_list_schemas`, `postgres_list_relations`, `postgres_list_structure`, `postgres_query_table`, `postgres_count_table`) on both success and error.
- Frontend keeps a 1000-entry ring buffer in a new React Context, populated by listening to that event.
- Add a bottom panel to the shell, between the center pane and the status bar, that renders the buffer. Closed by default; resizable; height and open/closed state persisted via `useSetting`.
- Each entry is tagged `auto` (Argus-initiated, e.g. schema browsing) or `user` (user-initiated, e.g. opening a table to view data). The panel filters out `auto` entries by default; a toggle reveals them.
- Status bar gains a logs counter + chevron toggle as the entry point.
- Bind params are stored verbatim in the entry; the buffer is in-memory only and never persisted to disk by this feature.

## Capabilities

### New Capabilities
- `activity-log`: Captures and surfaces every Postgres operation Argus runs, with SQL, params, duration, and per-op metrics, in a bottom panel of the shell.

### Modified Capabilities
- `app-shell`: Shell layout grows a new optional bottom panel row (between content and status bar) and the status bar gains a logs toggle affordance.
- `postgres-connection`: Each connection lifecycle command (`test`, `connect`, `disconnect`) emits a structured activity-log event in addition to its existing return value.
- `postgres-schema-browser`: Each metadata command (`list_schemas`, `list_relations`, `list_structure`) emits a structured activity-log event tagged `auto`.
- `postgres-data-grid`: `query_table` and `count_table` emit structured activity-log events; entries originating from data-grid user actions are tagged `user`.

## Impact

- **Rust** (`src-tauri/src/modules/postgres/`): every command file gains a call to a shared `emit_activity` helper at success and error sites; new module `src-tauri/src/modules/activity_log/` holds the event payload type and helper.
- **Tauri events**: new event name `argus:activity-log`. Single payload schema, versioned via a `v` field for future migrations.
- **Frontend** (`src/platform/activity-log/`): new module — Context provider, ring-buffer reducer, panel component, row component, filter toolbar.
- **Shell** (`src/platform/shell/Layout.tsx`, `Layout.module.css`, `StatusBar.tsx`): grid grows a logs row; status bar adds a toggle.
- **Settings** (`src/platform/settings/`): two new keys — `activityLog.open` (boolean), `activityLog.height` (number, px).
- **Frontend invocation wrapper** (`src/modules/postgres/data/api.ts`): each call site that initiates a `query_table` or `count_table` from a user gesture passes an `origin: "user"` flag through to Rust so the event can be tagged correctly. Auto-loaded metadata calls default to `auto`.
- No new Rust crates required — `tracing` already in tree; Tauri event API already in use (`postgres:active-changed`).
- No new frontend deps.
- No data migrations; the buffer is ephemeral.
