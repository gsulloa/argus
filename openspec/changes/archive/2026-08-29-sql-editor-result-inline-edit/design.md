## Context

The Postgres SQL editor renders results through `AdhocResultGrid`
(`packages/app/src/modules/postgres/data/AdhocResultGrid.tsx`). It shares DOM and
CSS with the table viewer's `DataGrid` but deliberately has no edit path: cells are
plain `<div className={styles.cell}>` nodes, `RowContextMenu` is mounted with
`copyOnly` + `canEditCell={false}`, and `ResultPanel` passes a throwaway
`useEditBuffer()` to the inspector purely to satisfy its prop contract.

The table viewer already owns every piece we need:

| Piece | File | Reused as-is? |
| --- | --- | --- |
| Inline editor (double-click, NULL toggle, enum select, JSON validation) | `data/EditableCell.tsx` | yes |
| Edit buffer + undo + PK-keyed row identity | `data/useEditBuffer.ts` | yes |
| Write path (`postgres_apply_table_edits`) | `src-tauri/.../edit.rs` | yes, unchanged |
| Discard confirmation | `data/DiscardChangesDialog.tsx` | yes |
| Dirty-state publication | `useDirtySummary` / `useCloseConfirm` | yes |

The only genuinely new problem is **provenance**: given an arbitrary result set,
decide whether its rows can be written back, to which table, and through which
column names. Postgres answers this exactly, on the wire, with no SQL parsing:
every `RowDescription` field carries `table_oid` and `column_id` (attnum), which
are `0` for anything that isn't a plain column reference of a plain relation.
`tokio_postgres::Column` exposes them as `Option<u32>` / `Option<i16>` (already
normalised — `0` becomes `None`, see `tokio-postgres-0.7.17/src/prepare.rs:100`),
and `columns_from_row_meta` (`sql.rs:668`) currently throws them away.

Constraints:

- `postgres_apply_table_edits(id, schema, relation, edits)` performs its own
  read-only check, PK lookup and `list_columns` call. It does **not** require the
  caller to have selected every column — a partial projection is already fine.
  So no backend write-path change is needed.
- `DataColumn` is shared by `postgres_query_table`, `list_columns`, the columns
  cache and autocomplete. Widening it would ripple through six construction sites
  and three capabilities for a field only the SQL editor consumes.
- `AdhocResultGrid` has three existing test files (`copy`, `contextMenu`, `resize`)
  that mount it with today's props. Read-only behaviour must not shift.

## Goals / Non-Goals

**Goals:**

- Double-click a cell in the SQL editor result grid → inline editor, same
  interaction, keys and validation as the table viewer.
- Commit through the existing edit buffer and the existing
  `postgres_apply_table_edits` command.
- Decide editability from wire-level provenance, never from parsing the SQL text.
- When a cell is not editable, say why on hover instead of silently doing nothing.
- Zero behavioural change for callers that don't opt in (read-only grid stays
  identical; MySQL/MSSQL/Athena/CloudWatch/Dynamo untouched).

**Non-Goals:**

- Inserting or deleting rows from the result grid (no `+` gutter, no
  Backspace-to-delete). Cell UPDATE only.
- Making the result-panel inspector editable, or bulk-edit across a row range.
- Editing multi-statement (`Run all`) results.
- Editing while a streaming run is still in flight.
- Editing results from views, materialized views, joins, `RETURNING`-less DML,
  CTEs that project from more than one relation, or computed/aliased expressions.
- Porting this to MySQL / MSSQL. The `sql-result-editability` capability is written
  engine-neutrally so they can adopt it later, but this change ships Postgres only.
- Surgical row reconciliation from `refreshed_rows` — v1 re-runs the statement.

## Decisions

### D1. Provenance from `RowDescription`, not from parsing SQL

**Decision.** Read `table_oid` / `column_id` off `stmt.columns()` and resolve them
against the catalog.

**Why.** It is exact and free of parser drift. `SELECT u.* FROM users u JOIN orders o …`
reports two distinct `table_oid`s; `SELECT count(*)` reports none; `SELECT id AS pk`
still reports `users.id`, so we can write to the real column name rather than the
alias. A SQL parser would have to re-implement Postgres name resolution, search_path
handling and CTE scoping to get the same answers.

**Alternative rejected.** Parse the statement client-side and pattern-match
`SELECT … FROM <one table>`. Cheap for the trivial case, wrong for aliases,
subqueries, CTEs and `search_path`, and it would have to be duplicated per engine.

**Alternative rejected.** Require the user to tell us the target table via a picker.
Extra ceremony for the 95% case (`SELECT * FROM t WHERE …`), and still needs
provenance to validate the answer.

### D2. `editability` as a sibling field, not fields on `DataColumn`

**Decision.** Add one `editability: ResultEditability` field to the rows-shaped
payloads. Leave `DataColumn` alone.

**Why.** The base-column mapping is a property of the *result set*, not of a column
in isolation, and it has to carry schema/relation/PK anyway. Keeping it in one
field means one resolver, one test surface, and no churn across
`postgres_query_table`, the columns cache, or autocomplete tooltips.

**Shape** (serde `tag = "status"`, snake_case):

```rust
pub enum ResultEditability {
    Editable {
        schema: String,
        relation: String,
        /// PK column names in declared order.
        pk_columns: Vec<String>,
        /// Result-column index carrying each PK column, aligned to `pk_columns`.
        pk_column_indexes: Vec<usize>,
        /// Per result column: the base-table column it projects, or null for
        /// computed / non-table columns. Length == `columns.len()`.
        column_sources: Vec<Option<String>>,
        /// Enum labels keyed by BASE column name.
        enums: BTreeMap<String, Vec<String>>,
    },
    NotEditable { reason: EditBlockReason },
}
```

`column_sources` is what makes aliasing safe: the grid displays `columns[i].name`
(the alias) but writes `column_sources[i]` (the real column).

### D3. Reason taxonomy is machine-readable, copy lives in the frontend

**Decision.** `EditBlockReason` is a closed enum serialised snake_case:
`no_base_table`, `multiple_tables`, `not_a_table`, `no_primary_key`,
`pk_not_selected`, `duplicate_projection`. `multiple_tables` carries no table
names — the count is enough and keeps the payload cheap.

**Why.** English copy belongs next to the rest of the UI strings, and a closed enum
gives the frontend an exhaustive `switch`. The two frontend-only reasons
(`read_only_connection`, `multi_statement_run`) are synthesised client-side from
state the frontend already has, and never appear on the wire.

### D4. Reject duplicate projections of the same base column

**Decision.** `SELECT id, id AS also_id FROM t` resolves to
`not_editable { reason: "duplicate_projection" }`.

**Why.** The buffer is keyed by *base column name*, so two cells would share one
buffer entry: editing one would silently repaint the other dirty with a value the
user never typed there. Allowing it would need per-cell buffer identity, which is a
much larger change to `useEditBuffer` for a rare query shape. Blocking it with a
clear hover reason is honest and cheap. Note this only counts columns that
resolved to a base column — two unrelated computed columns are fine.

### D5. Only `relkind IN ('r','p')` is editable

**Decision.** Ordinary tables and partitioned tables. Views (`v`), materialized
views (`m`), foreign tables (`f`) and everything else resolve to `not_a_table`.

**Why.** Auto-updatable views would mostly work through
`postgres_apply_table_edits`, but "mostly" is exactly the wrong guarantee for a
write path: a view with a non-trivial rule set fails at commit with a Postgres error
the user can't act on. Partitioned tables are included because `UPDATE … WHERE pk`
routes correctly. Foreign tables are excluded because writability depends on the
FDW.

### D6. One extra catalog round-trip per rows-shaped run, short-circuited

**Decision.** After `prepare`, if no result column carries a `table_oid`, emit
`not_editable { no_base_table }` without touching the catalog. Otherwise issue a
single query joining `pg_class`/`pg_namespace`/`pg_attribute` for the relation and
its projected attnums, plus the existing `SQL_PK_LOOKUP` and `SQL_ENUM_LOOKUP`.

**Why.** `SELECT 1`, `SELECT count(*)`, `EXPLAIN` and every DDL/DML statement pay
nothing. A real `SELECT * FROM t` pays ~1–3 ms against catalog tables that are
already hot. Caching per `(connection, table_oid)` is a plausible follow-up but
adds an invalidation problem (DDL between runs) for a saving smaller than the
statement's own latency.

**Failure handling.** The resolver never fails the run. Any catalog error, timeout
or unexpected shape degrades to `not_editable { no_base_table }` and is logged at
`warn`. A user who cannot edit their result is inconvenienced; a user whose
`SELECT` fails because a metadata lookup hiccupped is blocked.

### D7. `AdhocResultGrid` gains one optional `edit` prop

**Decision.**

```ts
export interface AdhocGridEdit {
  buffer: UseEditBufferResult;
  /** Aligned to `columns`; null entries are not editable. */
  columnSources: (string | null)[];
  /** Result-column indexes carrying the PK, in declared order. */
  pkColumnIndexes: number[];
  /** PK column names, in declared order. */
  pkColumns: string[];
  /** Keyed by BASE column name. */
  enumValuesByColumn: Record<string, string[]>;
  /** Hover copy shown on every non-editable cell. Empty when editing is live. */
  blockedReason: string;
}
```

`edit` absent → today's behaviour exactly.

**Cell rendering.** Even in the read-only case, the plain cell `<div>` is replaced
by `EditableCell` with `readOnly` computed. `EditableCell`'s display path renders
the same `styles.cell` + `data-col` + `styles.cellValue` DOM and already handles
`isActiveCell`, so `[data-col]`-based column detection, drag-select, copy and the
context menu keep working, and the three existing test files keep passing. One code
path beats two divergent ones.

**Per-cell `readOnly`** is true when any of: `edit` is absent; `blockedReason` is
non-empty; `columnSources[colIndex] === null`; the base column is a PK column;
`looksLikeBytea(column.data_type)`; `isCellEnvelope(serverValue)`. This mirrors
`DataGrid.tsx:759-766` minus the insert/delete cases, which don't exist here.

**Row identity.** `buildRowKey(pk)` from `useEditBuffer`, where `pk` is built from
`pkColumnIndexes` against the *unsorted server values* of that row. Because the key
is PK-derived rather than index-derived, the existing client-side sort in
`RowsResultView` cannot corrupt the buffer.

**Alternative rejected.** A second `EditableAdhocResultGrid` component. It would
duplicate 400 lines of virtualization, drag-select and context-menu logic that
already drifted once between `DataGrid` and `AdhocResultGrid`.

### D8. Save lives in the result-panel header; no keyboard shortcut

**Decision.** `Save (N)` / `Discard` render in `QueryTab`'s `resultHeader`, next to
`ExportMenu`, only when the result is editable, the connection is writable, and the
buffer is dirty (`Save` renders disabled when clean, matching `BottomBar`).
**No ⌘S binding** — ⌘S already saves the *query* in this tab.

**Why.** Rebinding ⌘S contextually ("saves the query, unless the result grid has
edits") is exactly the kind of hidden modality that produces data-loss bug reports.
An explicit button costs one click and is unambiguous.

### D9. Commit → clear buffer → re-run the same statement

**Decision.** On `outcome: "ok"`, call `buffer.commitSuccess()` then
`runner.rerunLast()`, a new method on `useQueryRun` that re-executes the last
single-statement run with its original `sql` and `startOffset` preserved. On
`outcome: "op_failed"`, show `Op #N failed: [code] message` on a dismissable banner
above the grid and leave the buffer intact — identical to `TableViewerTab:475-482`.

**Why not reconcile from `refreshed_rows`.** `RefreshedRow.row` is ordered by the
*table's* columns (`list_columns`), not by the result's projection, and the response
carries no column names to realign them. Mapping would mean a second contract to
keep in sync for a latency saving on a query the user just ran.

**Why `rerunLast()` rather than reusing `run()`.** `run()` derives what to execute
from editor offsets; calling it with `fullSql: state.sql` would reset `startOffset`
to 0 and break the error panel's "Show in editor" jump.

### D10. Dirty-state guards mirror the table viewer

**Decision.** In `QueryTab`: publish `useDirtySummary(tabId, dirty ? {connectionId, label: "<schema>.<relation> (result)"} : null)`;
register `useCloseConfirm`; and gate re-run, `Run all`, and connection switch behind
`DiscardChangesDialog`. Switching connection or running a *different* statement
discards the buffer after confirmation, since the rows it references no longer
correspond to what's on screen.

**Why.** A result-grid buffer is exactly as losable as a table-viewer buffer, and
the app already has one confirmation vocabulary for it.

## Risks / Trade-offs

- **A user edits a stale row.** The result may be minutes old; another writer may
  have changed the row. → `postgres_apply_table_edits` issues
  `UPDATE … WHERE <pk> = …`, so a concurrent change is overwritten, not corrupted —
  the same semantics the table viewer has shipped since v0.4. A deleted row yields
  a `refreshed_rows` entry with `row: null`; the post-commit re-run makes the
  disappearance visible. Not adding optimistic concurrency here; that would be a
  cross-cutting change to both grids.
- **`table_oid` resolution vs. `search_path`.** OIDs are absolute, so the resolved
  `(schema, relation)` is correct even when the query used an unqualified name and a
  non-default `search_path`. The write then goes to a fully-qualified name. This is
  a behaviour *improvement* over name-based resolution, but worth stating: the write
  can target a schema the user never typed.
- **DDL between run and save.** The table could be dropped or altered after the
  result was fetched. → `postgres_apply_table_edits` re-reads PK and columns at
  commit time and fails with a Postgres error surfaced on the banner. No silent
  corruption.
- **Extra catalog query on every SELECT run.** → Short-circuited when no column has
  a `table_oid` (D6), and it is one round-trip on hot catalog tables. If it ever
  shows up in profiles, the follow-up is a per-`(connection, table_oid)` cache
  invalidated on any DDL-shaped run in the same tab.
- **Replacing the plain cell div with `EditableCell` in the read-only case.**
  Regression risk in copy / context-menu / resize behaviour. → The three existing
  `AdhocResultGrid.*.test.tsx` files run unchanged as the regression gate, plus a
  new test asserting double-click on a read-only grid starts no editor.
- **Reason copy could read as scolding.** "Primary key not in the selected columns"
  is a fact, not a rebuke — copy is reviewed against `DESIGN.md` tone in the QA
  task, and each reason names the concrete fix where one exists ("add the primary
  key to the SELECT list").
- **Scope creep pressure toward insert/delete.** Explicitly out (Non-Goals). The
  row gutter stays selection-only in the result grid, so there is no affordance
  suggesting otherwise.
