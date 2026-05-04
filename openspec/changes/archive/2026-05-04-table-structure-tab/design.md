## Context

The V1 Postgres workflow already has the rows-and-edits side: filter, sort, paginate, edit cells, run SQL, see history. What is missing is the second half of TablePlus's mental model — the **schema** of the relation: types, defaults, PK, FKs, indexes, triggers, and the raw `CREATE …` text. Today the user has to drop to `psql` (or to the schema browser, which only surfaces high-level info) for any of that. This change closes the gap by adding sub-tabs inside the existing table viewer.

The Postgres backend already knows how to query indexes and triggers via `postgres_list_table_extras`, and how to get column metadata via `postgres_list_columns_bulk`. What it does not yet know how to do is enumerate constraints (PK/UNIQUE/CHECK/FK target) or render a DDL string. This change adds both, packaged in one new command so the Structure subtab is one round-trip away from being interactive.

Stakeholders: the user (single-user app). The roadmap pins this as item 8 of V1 Postgres; depends on item 3 (schema browser) being landed, which it is.

## Goals / Non-Goals

**Goals:**
- One round-trip to populate the Structure subtab. Sub-second on tables with reasonable column / index / FK counts.
- Reuse the existing partial-degradation envelope: if `pg_constraint` returns 42501 for an unprivileged user, we still render the columns we can.
- Reconstructed DDL is *readable*, not byte-identical to `pg_dump`. The goal is "I can copy this and recreate the table on another database with the same shape", not "this matches what `pg_dump -t schema.relation` would emit".
- Fits inside `DESIGN.md`: hairline dividers, Geist Mono for SQL, tabular numerals for ordinals, no decorative chrome.
- Read-only. Even on writable connections the Structure and Raw subtabs do not mutate state.

**Non-Goals:**
- Editing the schema (ALTER TABLE / CREATE INDEX / DROP CONSTRAINT) — that is `edit-postgres-schema` in V1.5.
- Function / type / extension viewers (Definition / Signature / Calls subtabs the roadmap mentions for functions). Those still go to `postgres-object-placeholder`. The capability boundary is "table-shaped relations": tables, views, materialized views.
- Diffing two schemas, ER diagrams, or visualizing FK graphs.
- A live "watch" of structure changes — the Structure tab is fetched once on first activation per tab and refreshed only on an explicit refresh button (or by closing/reopening the tab).
- Sharing the Structure response across two open table tabs of the same relation. Each tab has its own cache.

## Decisions

### One command, not five

The backend exposes a single `postgres_table_structure(id, schema, relation, origin?)` that returns columns, primary key, foreign keys, unique constraints, check constraints, indexes, triggers, and the reconstructed DDL string in one response. This avoids a fan of five small commands and matches the pattern set by `postgres_list_table_extras` (one command, partial-degradation envelope). The trade-off is a heavier response payload, but the Structure tab is fully populated when the user first switches to it — no skeleton-then-fill flicker. Alternatives considered:

- **One command per concern** (columns, constraints, indexes, triggers, FKs, DDL). Rejected: more round-trips, more loading states, more failure surfaces. The schema browser already learned this lesson.
- **Reuse `postgres_list_table_extras` and add only constraints + DDL.** Rejected: that command does not return columns either, so the Structure tab would still need at minimum two calls (columns + extras + new constraints/DDL). Not worth the seam.

### Where DDL reconstruction lives

DDL is built **server-side** in Rust, from catalog data already loaded for the rest of the response. Reasons: (1) all the inputs are in the same Postgres round-trip, so there is nothing to gain by shipping them to the frontend and re-rendering there; (2) keeps the frontend dumb (it is a `<CodeMirror readOnly value={ddl} />`); (3) when we add Dynamo / CloudWatch later, *each* module will own its own "raw definition" rendering, so the convention "the source module owns the raw view" is the right one. Trade-off: the reconstruction is opinionated and will never exactly match `pg_dump`. We accept that — the goal is readability, not reproducibility.

For views and materialized views the backend uses `pg_get_viewdef(oid, true)` directly; for tables it composes the body from columns + constraints + indexes (separate `CREATE INDEX …` statements after the `CREATE TABLE`, since they live outside the table body).

### Sub-tabset lives in `postgres-data-grid`

The Data/Structure/Raw selector is a property of the `postgres-table-data` viewer tab — it is not a new tab kind. The Structure and Raw subtab *contents* are owned by the new `postgres-table-structure` capability, but their *placement* (which tab is active, which keyboard shortcut activates which) is part of `postgres-data-grid`. This keeps the tab-kind registry thin (still one `postgres-table-data` kind, not three) and means the sub-tabs are always co-located with the Data view, which is what the user expects from TablePlus.

The sub-tabset state is in-memory only. On a fresh tab the active subtab is **Data**. Switching tabs and back preserves the active subtab. Closing and reopening the table tab resets to Data. We deliberately do not persist the subtab choice across app restarts: the user's expectation when they reopen a table is to land on data, not on the last surface they were poking at.

### Lazy fetch + tab-lifetime cache

The Structure response is fetched on first activation of the Structure or Raw subtab and cached in the tab's component state for as long as the tab is open. A small **Refresh** button in the Structure subtab header (and in the Raw subtab header) re-issues the same call. The Data subtab is unaffected — it continues to fetch via `postgres_query_table` as today.

The cache is per-tab, not global. This is intentional: two tabs on the same relation can show different snapshots if the user refreshes one but not the other. The simpler one-shared-cache design would tie tab lifetimes together and force us to invalidate on every tab open. Per-tab is cheaper to reason about.

### Origin / activity-log contract

`postgres_table_structure` follows the same contract every other Postgres command in the codebase already follows: optional `origin: "user" | "auto"` (default `"auto"`), one `argus:activity-log` event per call with `kind: "table_structure"`, `metric: { kind: "items", value: <columns + indexes + triggers + fks + constraints> }` on success and `null` on failure. The first activation of the Structure or Raw subtab passes `origin: "user"` (it is a user-initiated open). The Refresh button also passes `origin: "user"`. We add one new `ActivityKind::TableStructure` variant on the Rust side and one new entry on the TS side (`src/platform/activity-log/types.ts`, `ActivityLogRow.tsx`).

### Read-only execution path

The command goes through `executeQuery` (the read-only-aware path), same as `postgres_query_table` and `postgres_list_table_extras`. It runs against the existing pool registry and never mutates state. Connections in `read_only: true` mode work fine; the Structure / Raw subtabs render identically.

### Sub-tab navigation

Click on the segmented Data / Structure / Raw control switches subtabs immediately. While the table tab is focused (and the focus is not inside an input or the CodeMirror editor), `Cmd+1` / `Cmd+2` / `Cmd+3` (`Ctrl` on non-mac) activate Data / Structure / Raw respectively. We use the same modifier-detection convention used in the rest of the app (see `useShortcut` / the existing keyboard map). If a fourth subtab ever lands the shortcut grows linearly.

### View / materialized view handling

Both kinds get the same Structure subtab treatment: columns + (indexes if any) + (triggers if any). Views never have constraints or FKs in `pg_constraint` against themselves (they would be on the underlying tables), so those sections render with empty-state copy ("Views do not declare constraints — see the underlying tables.") rather than being hidden, to keep the UI shape stable across relkinds. The Raw subtab uses `pg_get_viewdef(oid, true)` and prefixes it with `CREATE OR REPLACE VIEW "schema"."name" AS\n` for views, and `CREATE MATERIALIZED VIEW "schema"."name" AS\n…\n[WITH NO DATA]` for materialized views (with an `is_populated` check).

## Risks / Trade-offs

- **DDL reconstruction drift** → the reconstructed `CREATE TABLE` will diverge from `pg_dump` for edge cases (storage parameters, `INHERITS`, `PARTITION BY`, custom collations, generated columns, identity vs serial, etc.). We are not chasing parity. Mitigation: header note above the CodeMirror block reading "Reconstructed for readability — not a `pg_dump` substitute." Out-of-the-ordinary table shapes (partition tables, foreign tables) get a small warning chip and a "best-effort" badge.
- **Permission-denied on `pg_constraint` / `pg_trigger`** → on locked-down read replicas a user may have `SELECT` on a relation but no rights on the catalog. Mitigation: the partial-degradation envelope already in use for `postgres_list_table_extras` extends here. The frontend renders an inline "Couldn't load <kind>" chip per missing section, the rest of the subtab still renders.
- **Heavy command on huge schemas** → tables with hundreds of columns or dozens of indexes / triggers will produce a larger payload, but everything is bounded by the relation size, not the cluster size. The same per-query 8s timeout + 10s outer total used by `postgres_list_table_extras` applies. If we ever see a table that times out we will revisit slicing.
- **Sub-tab keyboard collisions** → `Cmd+1/2/3` is currently unbound app-wide, but if a future change wants those for top-level tab switching we will have to renegotiate. Mitigation: scope the binding to "table tab focused, focus not inside an editor". Easy to lift later.
- **Cache staleness across tabs of the same relation** → two open tabs can show different snapshots after a refresh on one. Acceptable: the user can refresh the second tab if they care. Sharing the cache across tabs adds invalidation complexity that is not worth it for a single-user app.

## Migration Plan

No data migration. The change is additive:
1. Land the Rust command + activity-log kind behind no flag — it is callable from the moment it ships, but nothing invokes it until the frontend lands.
2. Land the frontend sub-tabset and the Structure / Raw subtab components. The Data subtab is the existing UI moved one level deep — visually unchanged.
3. Update `openspec/specs/postgres-data-grid/spec.md` (via the delta in this change) and create `openspec/specs/postgres-table-structure/spec.md` on archive.

Rollback: revert the PR. The command and the new activity-log kind are inert once the frontend that calls them is gone.

## Open Questions

- Should the Structure subtab also include a small "indexes used" hint per column (e.g. mark columns that are the leading column of a btree index)? Useful but adds catalog joins. Defer to a follow-up `enhance-table-structure` change if the unadorned view feels thin.
- Should `Cmd+R` (refresh) on a table tab refresh the *active* subtab specifically (Data → re-fetch first page; Structure / Raw → re-fetch structure) or always re-fetch both? Proposed: refresh the active subtab only. Confirm during implementation.
