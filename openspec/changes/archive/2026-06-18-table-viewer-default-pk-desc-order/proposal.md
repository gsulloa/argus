## Why

When a user opens a table in the data viewer, the default order is the relation's
natural row order (`orderBy = []`). For tables with an incremental or temporal
primary key this buries the most recent — and usually most relevant — rows, forcing
the user to sort manually on every open. The desired behaviour: **whenever a table
has a primary key and the user has not chosen an order, default to `ORDER BY <PK> DESC`.**

## What Changes

- Introduce a single, cross-engine rule for the table viewer's *initial* order:
  - When a relation has a primary key **and** no user-selected/persisted order exists,
    seed the order with every PK column `DESC`, in PK definition order.
  - When a relation has **no** primary key, or is a view (no PK), keep the current
    behaviour (`orderBy = []` → natural/fallback order).
- The default is derived from the asynchronously-loaded PK. The viewer MUST NOT issue
  its first-page fetch with an empty order and then immediately re-fetch with the PK
  default; it defers/uses the PK-derived order so a table opens with a single fetch.
- A user-selected order always wins and is never overwritten by the default:
  - **Postgres**: a persisted order (`pgTableOrder:*`) is respected as-is, including
    an explicitly empty order. The PK default applies only when nothing is persisted.
  - **MySQL / MSSQL**: an in-session user order change is respected for the life of
    the tab; the default only seeds the initial state.
- Shared helper `deriveDefaultOrderBy(pkColumns, relationKind)` so the rule is identical
  across Postgres, MySQL, and MSSQL.

Out of scope: adding cross-session order persistence to MySQL/MSSQL (they currently
keep order in-memory only — a pre-existing gap, untouched here); changing the backend
`query_table` contracts or the MSSQL backend PK-ascending no-order fallback.

## Capabilities

### New Capabilities

_None._ This refines existing data-grid ordering behaviour.

### Modified Capabilities

- `postgres-data-grid`: the "Per-table sort persistence" requirement changes — when no
  order is persisted, the default becomes PK-`DESC` (was the empty/natural order).
- `mysql-data-grid`: the "Per-table ordering controls" requirement changes — the
  initial order when none is selected becomes PK-`DESC` (was the empty/natural order).
- `mssql-data-grid`: the "Per-table ordering controls" requirement changes — the
  initial order when none is selected becomes PK-`DESC` (was the empty/PK-ascending fallback).

## Impact

- Frontend only (`packages/app`). No Rust/Tauri command changes.
- Postgres: `useTableOrderBy.ts` (distinguish "unset" from "explicitly empty"),
  `TableViewerTab.tsx` (derive default from `useTablePrimaryKey`, gate first fetch on
  PK only when nothing is persisted).
- MySQL: `useTableData.ts` (PK-aware initial order + first-fetch gate),
  `data/TableViewerTab.tsx` (pass PK-derived initial order).
- MSSQL: `useTableData.ts` and `data/TableViewerTab.tsx` (same as MySQL).
- New shared helper for `deriveDefaultOrderBy`; new/updated unit tests for each engine.
- User-visible: tables with a PK open showing newest rows first; views and PK-less
  tables are unchanged.
