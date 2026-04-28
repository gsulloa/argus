## Why

`browse-postgres-schema` shipped a working tree but the UI groups every kind under its own folder ("Tables (12)", "Views (3)", "Materialized Views (1)", "Functions (5)", "Sequences (4)", "Types (2)", "Extensions (1)"). In real schemas the user spends most of their time scanning **what data lives here** versus **what supports that data**. Splitting by kind hides that — the user has to expand five folders to see the full inventory.

Two pain points came up immediately on first use:

1. The grouping by kind doesn't match how the user actually thinks. They want one alphabetical list of "things with rows" (tables, views, mat-views) and another of "things that aren't data" (functions, types, extensions, plus the indexes/triggers attached to a table). Sequences in particular are noise — Argus doesn't have a sequence viewer planned for V1, so they shouldn't take up real estate.
2. Some schemas take many seconds to load and there's no signal that anything is happening past the initial "Loading…" — no timeout, no retry, no recovery if the connection hiccups. The user is stuck staring at a spinner.

## What Changes

### UI restructure (presentation only — same data)

- The schema's children are now **two groups**: "Data" (tables / partitioned tables / foreign tables / views / materialized views) and "Structure" (functions, types, extensions). Both groups list items **alphabetically by name**, mixing kinds within each group; iconography distinguishes kind, not tree position.
- Sequences are no longer rendered. The backend still doesn't query them.
- Indexes and triggers remain nested under their parent table (unchanged from the previous design); the table node, when it has any, exposes them as `Indexes` and `Triggers` sub-groups exactly as before.
- The kind-specific iconography is unchanged. Tables that are partitioned or foreign carry a small badge (`partitioned` / `FDW`) since they share the same icon as a regular table.

### Performance — cut latency on `postgres_list_objects`

- The backend currently runs **9 sequential queries** on a borrowed client for each `list_objects` call. Replace with:
  - One **UNION-ALL** query covering all 5 "data" relkinds (`r`, `p`, `f`, `v`, `m`) — replacing 3 of the existing sequential queries.
  - The remaining 5 queries (functions, types, extensions, indexes, triggers) run **concurrently** on the same client via `tokio::try_join!` — `tokio_postgres` pipelines requests over a single connection.
- Net effect: latency drops from `Σ(9 queries)` to roughly `max(1 UNION query, 5 pipelined queries)`. Realistic 3–5× speedup on schemas with many functions/extensions.

### Resilience — timeout, retry, and real cancellation

- The backend wraps `list_objects` in a **15-second timeout**. On timeout, it returns `AppError::Postgres { code: Some("57014"), message: "schema load timed out (15s)" }` (SQLSTATE 57014 = `query_canceled`).
- Before raising the timeout, the backend uses `tokio_postgres::Client::cancel_token()` to send a real `pg_cancel_backend` to the server, so the lingering query stops consuming server CPU. Achieving this requires `ActivePool` to remember the connection's `SslMode` (so the cancel can be issued through the same TLS connector); `params.read_only` and `application_name` are already kept.
- The frontend, on receiving SQLSTATE 57014, does **one automatic retry** with a brief inline indicator ("Slow — retrying…"). If the retry also times out (or any other error fires), the schema node renders a `Retry` button next to the schema name — manual retry only from that point.
- For non-timeout errors (auth, permission, network) there is **no auto-retry**: those are unlikely to be transient, and silent retries muddy the diagnosis. The user clicks `Retry` to attempt again.

## Capabilities

### Modified Capabilities

- `postgres-schema-browser`:
  - **MODIFIED Requirement: List objects command** — `SchemaObjects` no longer carries `sequences`; backend now uses a UNION-ALL data query plus pipelined structure queries.
  - **MODIFIED Requirement: Schema tree UI under each active connection** — children of a schema are two flat groups ("Data", "Structure") instead of seven kind-specific groups; sequences are not rendered.
  - **ADDED Requirement: Per-schema load timeout** — `postgres_list_objects` enforces a 15-second timeout and cancels the in-flight query on the server.
  - **ADDED Requirement: Auto-retry on timeout** — the frontend retries once on SQLSTATE 57014; subsequent failures or non-timeout errors expose a manual retry affordance on the schema node.

### New Capabilities

<!-- None — this change reshapes the existing capability rather than introducing a new one. -->

## Impact

- **Backend Rust**:
  - `src-tauri/src/modules/postgres/schema.rs` — new `SQL_LIST_DATA` (UNION-ALL); `list_objects` rewires to one data query + `tokio::try_join!` of five structure queries; `list_sequences` deleted.
  - `src-tauri/src/modules/postgres/schema_commands.rs` — wraps the call in `tokio::time::timeout`; on timeout, fires `cancel_token.cancel_query(make_tls)` and returns the typed error.
  - `src-tauri/src/modules/postgres/pool.rs` — `ActivePool` gains `sslmode: SslMode` so the cancel TLS connector can be reconstructed without re-reading the connections row.
  - `src-tauri/src/modules/postgres/schema_types.rs` — `SchemaObjects` drops the `sequences` field; `SequenceInfo` removed.
- **Frontend TS**:
  - `src/modules/postgres/schema/types.ts` — drop `SequenceInfo`, drop `sequences` field on `SchemaObjects`.
  - `src/modules/postgres/schema/SchemaTree.tsx` — rewrite `buildSchemaNode` to build two flat groups (Data, Structure) with alphabetical ordering; remove the per-kind group construction; preserve indexes/triggers as children of their table.
  - `src/modules/postgres/schema/objectIcons.tsx` — remove sequence icon and group; partitioned-table badge gets a small visual treatment.
  - `src/modules/postgres/schema/useSchemaTree.ts` — handle SQLSTATE 57014 specifically: one auto-retry with a `retrying` state; surface `error` for everything else with a manual retry method.
- **No breaking IPC change** for clients that aren't part of this app — the only consumer is the same React frontend, which is updated in lockstep.
- **No new Rust deps**, **no new JS deps**.
- **Settings**: no migration. The `pgVisibleSchemas:<id>` key is unchanged.
- **User-visible**: the schema tree looks markedly different on first expand. The new shape is more compact and faster to scan; users who liked the per-kind folders will notice. Sequences "disappear" — call this out in release notes once we have any.
