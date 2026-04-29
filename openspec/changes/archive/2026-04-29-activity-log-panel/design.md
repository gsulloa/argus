## Context

Argus already runs every Postgres command through a small set of Tauri command handlers in `src-tauri/src/modules/postgres/` (connection lifecycle in `mod.rs` / `pool.rs`, schema browsing in `schema.rs`, data grid in `data.rs`). Each handler measures duration with `Instant::now()` and emits `tracing::info!` lines that include the relevant fields (id, schema, relation, query_ms, total_ms, etc). On the frontend, `src/modules/postgres/data/api.ts` wraps every `invoke()` with timing and `console.debug`.

Today the user can see none of this. `tracing` writes to stdout in dev and to a daily file in release; the console wrapper only helps with DevTools open. The shell (`src/platform/shell/Layout.tsx`) is a CSS grid with `grid-template-rows: 1fr 28px` — sidebar/center/inspector on row 1, status bar on row 2 — and no bottom panel slot.

This design adds a structured activity log: a typed Tauri event emitted from each Postgres command, a frontend ring buffer that listens to it, and a collapsible bottom panel that renders it.

## Goals / Non-Goals

**Goals:**
- Every Postgres command Argus executes appears as one activity-log entry, with SQL (when it ran SQL), bind params, duration, status, and a per-op secondary metric.
- The user can distinguish Argus-initiated work (`auto`) from work they triggered (`user`), and filter accordingly.
- The panel is non-intrusive: closed by default, lightweight when open, persists its state.
- Rust is the canonical timer and source of truth so durations match what `tracing` already records.
- One unified event payload shape — consumers can render any op without per-op branching at the buffer level.

**Non-Goals:**
- Persisting the activity log across app restarts. The buffer is in-memory.
- Replacing or replicating the on-disk `tracing` log file. That continues to exist independently.
- Re-running queries from the panel ("Run again", "Open in editor"). Hooks for that come once the SQL editor exists.
- Full-text search or regex filtering. v1 ships op + connection + tag filters only.
- Capturing operations from non-Postgres backends (DynamoDB, CloudWatch). Those backends do not exist yet; when they do, they will emit the same event with a different `kind` namespace.
- Redacting bind parameters. The user explicitly chose to log them verbatim.

## Decisions

### Decision 1: Rust emits, frontend listens (not frontend interception)

Rust is the source of truth. After each Postgres command, before returning, the handler emits a Tauri event `argus:activity-log` with the structured payload. The frontend mounts a single listener at app start that pushes entries onto a ring buffer in a React Context.

Alternatives considered:
- **Frontend wrapper interception** (instrument `api.ts`'s `call()`): simpler, but loses anything the Rust side does internally (post-create connection hook, future background tasks) and uses the JS clock instead of `Instant`. Rejected.
- **Custom `tracing::Layer` that captures structured fields and emits to Tauri**: "free" because logs already exist, but couples the panel to `tracing`'s on-the-wire field format and is hard to evolve. Rejected.

Rationale: explicit emission is one extra line per command, matches the existing pattern (`postgres:active-changed`), and keeps the contract visible in the code.

### Decision 2: Single payload schema, discriminated by `kind`

```rust
struct ActivityLogEntry {
    v: u8,                      // schema version, starts at 1
    id: Uuid,                   // entry id
    timestamp_unix_ms: i64,
    connection_id: Option<Uuid>,// None for ops not yet bound to a connection (test_connection)
    kind: ActivityKind,         // enum below
    origin: Origin,             // Auto | User
    duration_ms: u64,
    status: Status,             // Ok | Err
    sql: Option<String>,
    params: Option<Vec<String>>,// stringified bind params (Display-formatted)
    metric: Option<Metric>,     // per-kind secondary metric
    error: Option<ActivityError>,
}

enum ActivityKind {
    TestConnection, Connect, Disconnect,
    ListSchemas, ListRelations, ListStructure,
    QueryTable, CountTable,
}

enum Metric {
    Rows(u64), Count(i64), ServerVersion(String), Items(u32), None,
}

struct ActivityError { message: String, code: Option<String> }
```

Alternatives considered:
- **One event per kind** (`argus:activity-log:query`, `argus:activity-log:connect`, ...): requires the frontend to register N listeners and complicates ordering. Rejected.
- **Untyped JSON blob**: easy to evolve but loses the contract entirely. Rejected.

Rationale: the discriminated union is cheap, idiomatic in `serde`, and lets the panel render rows uniformly. The `v` field is in place from day one so future changes can branch on schema version.

### Decision 3: `origin` decided at the call site, defaulting to `auto`

The `origin` flag is set by the frontend when it invokes a command, and passed through to Rust as part of the command arguments. Rust forwards the value into the activity-log event verbatim; it does not infer.

- `postgres_query_table` / `postgres_count_table`: gain a new optional `origin: Origin` arg. The data-grid call sites pass `"user"` for the initial open, paging, and refresh; pass `"auto"` for any internal pre-fetch we might add later.
- `postgres_connect` / `postgres_disconnect` / `postgres_test_connection`: triggered by user action (clicking Connect, Save, Test) → `"user"`.
- `postgres_list_schemas` / `postgres_list_relations` / `postgres_list_structure`: triggered by sidebar expansion or auto-load → `"auto"`. If a future "Refresh schemas" button exists, it passes `"user"`.

Alternatives considered:
- **Rust infers based on kind**: e.g. all metadata calls are auto, all query calls are user. Brittle — the "Refresh sidebar" case breaks the rule. Rejected.
- **Implicit via UI state**: harder to test, harder to reason about. Rejected.

Rationale: origin is a property of *why* the call was made, which only the caller knows. Letting the call site declare it is the simplest correct model.

### Decision 4: Ring buffer in a Context, capacity 1000

The frontend keeps entries in a `useReducer`-driven ring buffer of fixed capacity 1000. New entries push to the end; oldest dropped when over capacity. The reducer also maintains a derived counter of `auto` vs `user` entries for the status-bar badge without recomputing on every render.

Alternatives considered:
- **Unbounded buffer**: memory creep over a long session. Rejected.
- **Persisted to IndexedDB**: outside scope; user explicitly chose ephemeral.
- **Zustand**: project does not use it elsewhere. Stay with Context.

### Decision 5: Layout — new optional grid row above the status bar

Modify `Layout.module.css` from `grid-template-rows: 1fr 28px` to `grid-template-rows: 1fr var(--logs-row-height, 0px) 28px`, plus a 4px drag handle when open. When the panel is closed, `--logs-row-height: 0px` and the row collapses (no DOM child rendered). When open, it spans `grid-column: 1 / -1` like the status bar.

Resize behavior follows the existing `useDragHandle` pattern. Min height 120px, max 480px. Default 220px on first open. Persisted via `useSetting`.

```
┌──────────────────────────────────────────────────────┐
│ Sidebar │      Center        │      Inspector        │  row 1: 1fr
├─────────┴──────[drag]────────┴───────────────────────┤  row 2: 4px when open
│            Activity Log Panel                        │  row 3: var(--logs-row-height)
├──────────────────────────────────────────────────────┤
│  StatusBar  · Logs (12)  ⌃                          │  row 4: 28px
└──────────────────────────────────────────────────────┘
```

Alternatives considered:
- **Floating overlay** (absolute, slide up): visually fancy but conflicts with content; harder to size. Rejected.
- **Replace inspector when open**: too destructive; user might want both. Rejected.

### Decision 6: Status bar gains the toggle, not a global hotkey (yet)

The status bar adds a chevron + counter on its right side: `Logs (N) ⌃`. Clicking toggles open/closed. A global keyboard shortcut (e.g. ⌘J) is intentionally deferred to keep this change small; once the command palette grows command bindings, "Toggle activity log" registers there.

### Decision 7: Bind params stringified at the boundary

Rust converts each bind param to its `Debug` representation at emit time and stores `Vec<String>`. This avoids serializing raw `tokio_postgres` value types and lets the panel render them without per-type knowledge. Truncation at 200 chars per param happens at emit time; truncation marker `…` appended.

### Decision 8: Errors recorded as a status, not a separate event

A failed command emits one activity-log event with `status: Err` and the populated `error` field; the duration is measured up to the failure point. There is no "started" event — the panel only shows completed (success or failure) operations. Pending/in-flight visibility can be added later without breaking the schema.

## Risks / Trade-offs

- **Volume from auto-loads** → drowns out `user` entries when both are visible. Mitigated by default-hiding `auto` and adding the filter from v1.
- **Bind params can contain PII** (emails, ids). User opted in. Mitigated by keeping the buffer in-memory and never writing it to the on-disk `tracing` file. A future opt-in toggle for "Hide params" is straightforward — the data is already a separate field.
- **Large SQL strings inflate memory**. Mitigated by per-row truncation in the panel display (first 120 chars), keeping the full string only in the entry object; with 1000 entries × ~2KB average = ~2MB worst case, acceptable.
- **Event flood during big paginations** could backpressure the webview event channel. Tauri events are queued; deadpool max-size is 4 so practical concurrency is bounded. Acceptable for v1.
- **Schema evolution**: `v: 1` lets a future change introduce `v: 2` and let the listener handle either. New optional fields can be added without bumping `v`.
- **Activity log of activity-log work**: the command-palette, settings load, and any non-Postgres Tauri call do not emit. That is intentional — the panel is scoped to "Postgres command activity" for v1; renaming and broadening can come when there is a second backend to log.

## Migration Plan

This is purely additive. No data migration. Rollout is a single deploy:

1. Land Rust changes (new module + per-command emits) — no behavior change to existing returns; old frontends ignore the event.
2. Land frontend changes (Context, panel, status-bar toggle, layout grid row) in the same release.
3. Settings keys default to closed/220px on first launch.

Rollback: revert the change. The on-disk `tracing` log is unaffected. No persisted state to clean up.

## Open Questions

- Should the panel scroll-lock to the bottom by default, with a "pause" affordance when the user scrolls up (DevTools-style)? Default proposal: yes, auto-stick to bottom when within 32px of the end; pause otherwise. Confirm during implementation.
- Where should the "Show internal activity" toggle live — inside the panel header, or as a status-bar dropdown? Proposal: panel header, alongside connection filter.
