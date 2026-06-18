## Context

The table viewer opens a relation with `orderBy = []` (natural order). For tables with
incremental/temporal primary keys this hides the newest rows. We want a cross-engine
default of `ORDER BY <PK> DESC` while keeping any user-selected order intact.

Current state (verified in code):

- **Postgres** persists order under `pgTableOrder:*` via `useTableOrderBy` (default `[]`),
  loads the PK asynchronously via `useTablePrimaryKey` (`metadata.pk_columns: string[] | null`),
  and gates the first fetch on `filterLoaded && orderByLoaded` (`useTableData` has an
  `enabled` param). `RelationKind` is `"table" | "view" | "materialized-view"`.
- **MySQL / MSSQL** hold `orderBy` *in-memory* inside `useTableData` (reducer, initialized
  from `initialOrderBy`, default `[]`); the component (`TableViewerTab`) does **not** wire
  `myTableOrder`/`msTableOrder` persistence today and `useTableData` has **no** first-fetch
  gate. The PK is fetched in a `useEffect` in the component (`dataApi.tablePrimaryKey`,
  exposed as `pkColumns: string[] | null`, with `pkLoading`). `RelationKind` is `"table" | "view"`.
- The `OrderBy` shape is identical everywhere: `{ column: string; direction: "asc"|"desc" }`
  (MySQL/MSSQL surface the direction uppercased in SQL but store the same lowercased union).
- MSSQL's backend already applies a PK-**ascending** (or `SELECT NULL`) fallback when no
  `order_by` is supplied; this change sends an explicit PK-**descending** order from the
  frontend instead, leaving that backend fallback as the no-order safety net.

## Goals / Non-Goals

**Goals:**
- A relation with a PK opens at `ORDER BY <all PK cols> DESC` when the user has not chosen an order.
- A user's chosen order always wins and is never clobbered by the default.
- Identical rule across Postgres, MySQL, MSSQL via one shared helper.
- No redundant double fetch (empty-order fetch immediately superseded by PK-default fetch).
- Views / PK-less relations keep today's behaviour.

**Non-Goals:**
- Adding cross-session order persistence to MySQL/MSSQL (pre-existing gap; they remain
  session-only). The "respect the user's choice" guarantee for those engines is per-tab-session.
- Any backend / Tauri command change (including the MSSQL backend fallback).
- Changing the column-header sort-cycle UX or sort badges.

## Decisions

### D1 — Compound PK rule: all PK columns DESC, in definition order

Use **every** PK column `DESC` in PK definition order, not just the first.

- *Why:* deterministic and stable; aligns with the PK index for an efficient descending
  scan; for the common single-column (often auto-increment) PK it is exactly "newest first".
- *Alternative — first PK column only:* simpler SQL but ambiguous ordering within a leading
  key group and no real performance win. Rejected for determinism.

Encoded once in a shared helper:

```ts
// deriveDefaultOrderBy(pkColumns, relationKind) -> OrderBy[]
// returns [] for views / null / empty pkColumns; else pkColumns.map(c => ({column: c, direction: "desc"}))
```

The helper is the single source of truth; each engine imports it (or a thin per-module
re-export to satisfy module-local `OrderBy` typing).

### D2 — Postgres: distinguish "unset" from "explicit empty"

`useTableOrderBy` currently returns `[]` both when nothing is stored and when the user
stored `[]`. To apply a default only in the first case, change the persisted/in-memory
representation so "unset" is observable:

- `useTableOrderBy` exposes the persisted value as `OrderBy[] | null` (null = key absent)
  plus the existing `isLoaded`. `setOrderBy` always writes a concrete array (including `[]`).
- `TableViewerTab` computes the effective order:
  `effectiveOrderBy = persisted ?? deriveDefaultOrderBy(pkColumns, relationKind)`.
- *Persistence shape:* keep the on-disk JSON as the array; "absent key" is the null signal,
  so no migration is needed (already-persisted arrays load unchanged; never-persisted keys
  read as null → default).

### D3 — First-fetch gating (avoid the double fetch)

The default depends on the async PK, so the first fetch must wait for it — but only when
we actually need the default.

- **Postgres:** extend the existing `enabled` gate:
  `enabled = filterLoaded && orderByLoaded && (persisted !== null || pkResolved)`.
  When a persisted order exists we do **not** wait on the PK (no latency regression for the
  common revisit case). `pkResolved` = PK status is `ready` or `error` (treat error as no PK).
- **MySQL / MSSQL:** add an `enabled?: boolean` param to `useTableData` (default `true`,
  preserving all other call sites) that defers the first auto-fetch when false. The component
  passes `enabled: pkResolved` (PK fetch settled, success or failure) and an
  `initialOrderBy = deriveDefaultOrderBy(pkColumns, relationKind)`. Since the reducer seeds
  `orderBy` once at mount (before the PK resolves), `useTableData` syncs `orderBy` from a
  changed `initialOrderBy` **only before the first fetch and only if the user has not yet
  changed the order** (guards: `hasFetchedRef`, `userTouchedRef`). Sequence: mount
  (`enabled=false`, `orderBy=[]`, no fetch) → PK resolves → `enabled=true` + `initialOrderBy`
  set → sync seeds `orderBy` → single first-page fetch with PK DESC.

### D4 — Frontend-only, backend untouched

All three backends already accept `order_by`; sending PK DESC needs no command change. MSSQL's
backend PK-asc fallback stays as the safety net for the no-PK / explicit-empty path.

## Risks / Trade-offs

- **[Slight first-open latency when nothing is persisted]** → first fetch waits for the PK
  query. Mitigation: PK lookup is a fast metadata query; gate only applies when no persisted
  order exists (Postgres) / always-short PK fetch (MySQL/MSSQL); net effect replaces a wasted
  double fetch with one correct fetch.
- **[`initialOrderBy` sync racing a user sort]** → could overwrite a fast user click.
  Mitigation: `userTouchedRef`/`hasFetchedRef` guards; PK is one-shot so `initialOrderBy`
  stabilizes immediately and the sync window is the pre-first-fetch instant.
- **[Behaviour change surprises users used to natural order]** → newest-first becomes the
  default. Mitigation: matches the issue's intent; views/PK-less tables unchanged; user
  override persists (Postgres) / holds for the session (MySQL/MSSQL).
- **[MySQL/MSSQL "respect + persist" only holds per session]** → spec text claims cross-session
  persistence that the code does not implement. Out of scope here; acceptance is interpreted
  as "respected within the tab session" for those engines, called out in the proposal.
- **[Spec scenarios asserting "no ORDER BY by default"]** → updated in the delta specs to the
  PK-DESC default; the connection-isolation scenarios now assert each connection's own default.

## Migration Plan

No data migration. Postgres reads already-persisted arrays unchanged; the only representational
change is treating an absent key as `null` rather than `[]`. Rollback is reverting the frontend
diff; persisted settings remain compatible.

## Open Questions

- None blocking. (Considered and resolved: compound-PK rule = all columns DESC per D1.)
