## Context

The first cut of the schema browser was deliberately conservative: each Postgres object kind got its own folder ("Tables", "Views", "Materialized Views", …), and `postgres_list_objects` ran nine sequential queries on a borrowed client. That shape parallels the Rust struct cleanly, but is wrong for two reasons:

1. **Mental model mismatch**. Users group their attention as "data containers" (tables, views, mat-views) versus "supporting machinery" (functions, types, extensions). Splitting the data containers across three folders forces them to expand and visually merge three lists. The first time the schema tree was used in earnest, the request was immediate: collapse to two groups, alphabetical.
2. **Latency is too visible**. Schemas with PostGIS / pg_trgm / many extensions can take 3–10 seconds to load with the sequential approach because of `pg_get_function_arguments()` over hundreds of `pg_proc` rows. With no timeout and no retry, a slow schema looks broken.

The previous change archived its specs into `openspec/specs/postgres-schema-browser/spec.md` and `app-shell/spec.md`. This change modifies the postgres-schema-browser spec only. The `SidebarTree` primitive in `app-shell` is unchanged; the new tree shape composes the same primitive with a different node graph.

## Goals / Non-Goals

**Goals:**

- Reshape the per-schema node into two flat alphabetical groups while keeping indexes/triggers nested under their parent table.
- Drop sequences from the rendered tree (and from the backend payload).
- Cut typical `list_objects` latency 3–5× by eliminating the 9-query sequential chain.
- Bound worst-case latency at 15 s with a real server-side cancellation, plus a single auto-retry on timeout.
- Make the failure case visible: after a final failure, the schema node shows a clearly clickable `Retry`.

**Non-Goals:**

- Adding columns, sample data, or DDL preview to the tree itself — those are tab-content concerns covered by future changes (`view-table-data`, `table-structure-tab`).
- Streaming partial results as queries complete. The frontend still waits for the full `SchemaObjects` payload per schema.
- Per-kind cancellation. Cancellation is at the schema level; you cancel "load this schema", not "load this schema's functions".
- Configurable timeout. 15 s is hard-coded for V1.
- Caching across app launches.

## Decisions

### Decision: Two flat groups, alphabetical within each

**Choice**: A schema node has exactly two children: `Data` (tables, partitioned tables, foreign tables, views, materialized views) and `Structure` (functions, types, extensions). Within each group, items are sorted alphabetically by `name` (case-insensitive `localeCompare`). Indexes and triggers remain nested under their parent table node — they do **not** move into Structure.

```
▼ public
  ▾ Data (16)
    📦 accounts
      ▾ Indexes (2)
        🔑 idx_users_email
        🔑 accounts_pkey
      ▾ Triggers (1)
        ⚡ trg_audit
    📦 events                           partitioned
    📦 ext_users                        FDW
    📊 active_users
    📦 users
    💎 user_metrics
  ▾ Structure (24)
    🧩 pg_trgm  1.6
    ƒ  calc_age(int)
    ƒ  calc_age(text)
    ⌘  geometry
    …
```

**Rationale**:

- Two groups is the minimum that still answers "is this schema empty?" at a glance with a count.
- Alphabetical mixing matches how the user reads from a schema (they don't usually care whether `users` is a table or a view).
- Keeping indexes/triggers under their table is the strict win: they belong to a table semantically, and the user almost never asks "show me all indexes in the schema".
- Iconography + badge handles the kind disambiguation without taking a row of vertical space per kind.

**Alternatives considered**:

- Indexes/triggers as flat items in Structure with a `[parent_table]` badge. Rejected: would split a table's index from the table itself, requires a click to relate them.
- One single flat list (no groups). Rejected: `Data` count vs `Structure` count is genuinely useful at a glance; "this schema has 0 data objects but 800 functions" is an interesting, common shape (extensions schemas).

### Decision: Drop sequences from the payload (backend)

**Choice**: `SchemaObjects` loses the `sequences: Vec<SequenceInfo>` field. `SequenceInfo` is deleted. `list_sequences` and `SQL_LIST_SEQUENCES` are deleted. The TS mirror loses the `sequences` field on `SchemaObjects` and the `SequenceInfo` type.

**Rationale**: The previous change shipped sequences for completeness, but no current or planned tab-content viewer covers them. They added noise to the tree and a query to the load path with zero current value. When we ship a sequence editor (post-V1), we'll re-introduce them in the same change as the editor.

**Alternatives considered**: Keep them in the payload but hide them in the UI. Rejected: dead weight in the IPC.

### Decision: Single UNION-ALL for "data" relkinds

**Choice**: Replace the three queries `list_tables` (relkind in r/p/f), `list_views` (v), `list_materialized_views` (m) with one SQL:

```sql
SELECT
  c.relkind::text                                     AS rk,
  c.relname                                           AS name,
  pg_catalog.pg_get_userbyid(c.relowner)              AS owner,
  c.reltuples::bigint                                 AS estimated_rows,
  d.description                                       AS comment
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_description d
       ON d.objoid = c.oid AND d.objsubid = 0
       AND d.classoid = 'pg_class'::regclass
WHERE n.nspname = $1
  AND c.relkind IN ('r','p','f','v','m')
ORDER BY c.relname;
```

In Rust, dispatch each row by `rk`:
- `r` / `p` / `f` → push to `tables`, with `kind = TableKind::Regular | Partitioned | Foreign`.
- `v` → push to `views`.
- `m` → push to `materialized_views`.

The output struct keeps the existing tables/views/materialized_views fields. The frontend's flatten step still works.

**Rationale**: One round-trip instead of three. The Postgres planner handles a single `pg_class` scan with an `IN` filter cleanly. Estimated rows from `reltuples` is meaningful for views/matviews too (matviews have it; views report 0 — fine).

**Alternatives considered**:
- 5 separate queries pipelined. Less code change but more round-trips and three duplicate `pg_class`/`pg_namespace`/`pg_description` joins.
- One mega-UNION-ALL across all kinds (functions, types, extensions, indexes, triggers too). Rejected: column structures diverge too much; would require 6+ NULLed-out columns and post-processing in Rust to reconstruct typed structs. The two-tier split (UNION for data, separate queries for structure) is the readable middle ground.

### Decision: Pipeline the five "structure" queries with `tokio::try_join!`

**Choice**: After acquiring the client and running the data query, fire the 5 remaining queries concurrently:

```rust
let (data_rows, functions, types, extensions, indexes, triggers) = tokio::try_join!(
    client.query(SQL_LIST_DATA, &[&schema]),
    list_functions(&client, schema),
    list_types(&client, schema),
    list_extensions(&client, schema),
    list_indexes(&client, schema),
    list_triggers(&client, schema),
)?;
```

`tokio_postgres::Client::query` takes `&self`; `tokio_postgres` already pipelines simultaneous calls over a single connection (the wire protocol allows it, and the runtime multiplexes request frames). All 6 queries can be in flight on the same client without contention.

**Rationale**: No new connections needed (still one borrow from the pool). Latency becomes max(query) instead of sum(query). For schemas where `list_functions` is the slow query (the common case), this is dominated by that single query — everything else completes in parallel and overlaps.

**Alternatives considered**:
- Spawn 5 tokio tasks each acquiring its own pool client. Defeats the purpose of "one borrowed client", and the pool max is 4. Would deadlock if every visible schema tried to load simultaneously.

### Decision: 15-second backend timeout with real `pg_cancel_backend`

**Choice**: `postgres_list_objects` wraps the entire `list_objects` call in `tokio::time::timeout(Duration::from_secs(15), …)`. When the timer fires:

1. The backend uses the client's `cancel_token` (captured before launching the work) to send a cancellation to Postgres via `cancel_token.cancel_query(make_tls).await`. Postgres aborts the running query with SQLSTATE 57014 (`query_canceled`).
2. The Rust task is dropped via the timeout. The deadpool client is recycled.
3. The command returns `AppError::Postgres { code: Some("57014"), message: "schema load timed out (15s)" }`.

This requires the `MakeTlsConnect` matching the connection's `SslMode`. To avoid re-reading params from SQLite at cancel time, `ActivePool` is extended with `sslmode: SslMode` (small enum copy, 1 byte effectively). The cancel path builds the connector from this stored `SslMode` via the existing `client_config_for(sslmode)` helper.

```rust
// In schema_commands.rs
let started = Instant::now();
let pool_entry_sslmode = pools.sslmode_for(&id).await?;     // new accessor
let work = async {
    let client = pools.acquire(&id).await?;
    let cancel_token = client.cancel_token();
    let outcome = tokio::time::timeout(
        Duration::from_secs(15),
        schema::list_objects(&client, &schema_name),
    ).await;
    match outcome {
        Ok(r) => r,
        Err(_) => {
            // Fire the real cancel; ignore failure (best effort).
            let _ = match client_config_for(pool_entry_sslmode)? {
                Some(cfg) => {
                    let connector = MakeRustlsConnect::new((*cfg).clone());
                    cancel_token.cancel_query(connector).await
                }
                None => cancel_token.cancel_query(NoTls).await,
            };
            Err(AppError::postgres_with_code("57014", "schema load timed out (15s)"))
        }
    }
};
work.await
```

**Rationale**: Without `cancel_query`, abandoning the future on timeout leaves the Postgres backend running the query to completion; on a slow schema (10 functions × 30s each), the server burns CPU for nothing while the client never sees the result. Cancelling cleans up both ends. SQLSTATE 57014 is the standard signal Postgres itself uses for "query was cancelled by the user", so the frontend can match on it precisely.

**Alternatives considered**:
- Use `RecyclingMethod::Verified` to make the pool defensively re-check clients. Doesn't fix the wasted-server-time problem and adds a `SELECT 1` on every acquire.
- Detach the client from the pool on timeout. Adds complexity (deadpool pool size accounting), and doesn't tell the server to stop.

### Decision: Frontend retry — auto on 57014, manual on everything else

**Choice**: In `useSchemaTree`, the per-schema state machine grows two states:

```
idle → loading → loaded                          (happy path)
              ↘ retrying (auto, once) → loaded
                                     ↘ error
              ↘ error                            (non-timeout failures)
```

Logic:

- `loading` → success → `loaded`.
- `loading` → SQLSTATE 57014 (`code === "57014"` on the AppError.postgres) → `retrying` and **immediately re-fire the request** (no backoff delay; the user is already waiting). The retry has its own 15-second budget on the backend.
- `retrying` → success → `loaded`.
- `retrying` → any failure (timeout or otherwise) → `error`.
- `loading` → any non-57014 failure → `error`.

The schema tree node UI:
- `loading`: existing "Loading…" placeholder child.
- `retrying`: same row, label changes to "Slow — retrying…", a small spinning icon next to the schema name in the parent row.
- `error`: a small `↻ Retry` button is rendered next to the schema name. The error message is shown as a child placeholder (truncated with full text in `title`).

The hook exposes a new method `retrySchema(name: string)` that re-runs `fetchObjects(name)` from any state. The button calls it.

**Rationale**:
- Auto-retry on cancellation matches the typical cause: a slow first query with cold catalog cache. The second often fits in 15 s.
- No auto-retry on, e.g., `42501` (permission denied) or `28P01` (auth) — those won't recover by trying again.
- One auto-retry, not exponential backoff: the user is waiting; piling on a third silent attempt is worse than telling them.

**Alternatives considered**:
- Two automatic retries with backoff (1 s, 4 s). Too slow for a feedback loop the user is staring at. Worse UX than a manual button.
- Retry on any `Postgres` error. Risk of looping forever on persistent errors like permission denied.

### Decision: Visual treatment

The schema row (always visible at the top of each subtree) gets a status indicator slot:
- `idle`/`loaded`: nothing extra.
- `loading`: small spinner glyph (CSS animation, no library).
- `retrying`: same spinner + text "(retrying)".
- `error`: a `↻` button rendered with `aria-label="Retry"`.

Items inside `Data` and `Structure`:
- `Data` icons: regular table = `Box`, partitioned = `Box` + `partitioned` text badge, foreign = `Box` + `FDW` text badge, view = `Eye`, mat-view = `Layers` (already chosen).
- `Structure` icons: function = `FunctionSquare`, type = `Sigma`, extension = `Puzzle`. (Already chosen — no new icons needed.)

Color (`style={{ color }}` on the icon component, respecting CSS variables):
- table-family: default (`var(--text-muted)`)
- view: `#0ea5e9` (blue)
- mat-view: `#a855f7` (violet)
- function: `#f59e0b` (amber)
- type: `#ec4899` (fuchsia)
- extension: `#10b981` (green)

Defined as CSS custom properties in `SchemaTree.module.css` so the values can be themed centrally if dark/light needs separate tints.

## Risks / Trade-offs

- **Pipelined queries on a single client**: if `tokio_postgres`'s pipelining doesn't pan out (e.g., a future version serializes them), latency falls back to a sum but stays correct. Risk is performance, not correctness.
- **`cancel_query` opens a fresh TCP connection**: the cancellation request goes over a new short-lived connection (Postgres protocol requires this). On a flaky network, the cancel itself can fail. Mitigated by best-effort `let _ = …`. The timeout error is returned regardless.
- **Slow schemas → user keeps clicking retry**: harmless; each retry is a fresh 15 s budget. After the second timeout the schema effectively becomes "click to retry" — not great UX, but correct, and the user has visibility.
- **Sequences disappearing**: anyone who relied on seeing them in the previous build will miss them. Acceptable; we have no users yet.
- **Group counts `(N)`**: `Data (16)` shows the post-load count. While loading it shows nothing. While retrying it shows the previous count if any (we don't reset the loaded payload until either success or final error).
- **Data UNION-ALL ordering**: the SQL orders by `relname` only, so two objects with the same name (impossible within a schema) are not at risk; the global alphabetical order in the UI is enforced after frontend grouping anyway.

## Migration Plan

1. Update `schema_types.rs`: drop `SequenceInfo` + `sequences` field.
2. Update `schema.rs`: replace `SQL_LIST_TABLES`/`SQL_LIST_VIEWS`/`SQL_LIST_MATVIEWS` with a single `SQL_LIST_DATA`; rewrite `list_objects` to one data query + `tokio::try_join!` of 5 structure queries; delete `list_sequences`, `list_tables`, `list_views_with_sql`, `list_views`, `list_materialized_views` and replace with a single `populate_data(rows, &mut SchemaObjects)` helper.
3. Update `pool.rs`: store `sslmode: SslMode` on `ActivePool`; add `pub(crate) async fn sslmode_for(&self, id: &Uuid) -> AppResult<SslMode>` accessor.
4. Update `schema_commands.rs`: wrap `list_objects` in `tokio::time::timeout` with cancel_query on expiry.
5. Update TS types and `useSchemaTree`: add `retrying` state, auto-retry on 57014, manual `retrySchema` method.
6. Update `SchemaTree.tsx`: rebuild node graph as Data + Structure groups, alphabetical merge; drop sequence handling; render `↻` retry button on error state.
7. Update spec via `MODIFIED Requirements` (List objects, Schema tree UI) plus `ADDED Requirements` (Per-schema timeout, Auto-retry).

Rollback: revert the migration. The previous build remains compatible with the same SQLite settings (the `pgVisibleSchemas:<id>` key is unchanged) and the same `connections` rows.

## Open Questions

- **Should the `Data` group come before `Structure` always, or alphabetically by group name?** Default: Data first (data-centric mental model). Open to flipping if it ever feels wrong.
- **Should we render group counts during `retrying`?** Currently leaning yes — show the previous (stale) count rather than blank. Marginal call.
- **Should `↻ Retry` also live in the visible-schemas picker for batch retries?** Probably overkill; the per-schema button is enough.
