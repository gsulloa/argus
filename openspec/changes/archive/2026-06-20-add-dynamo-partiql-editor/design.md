## Context

Argus has four bespoke query editors today (Postgres, MySQL, MSSQL — full SQL with inline-editable result grids; Athena — query-only with a lightweight read-only table and CSV/JSONL/XLSX export). DynamoDB has none: only the guided `data-view/QueryBuilder.tsx` (Scan/Query + filters) and a clipboard fallback in `openDynamoQuery.ts`.

Relevant existing pieces this design builds on:
- **Backend**: `aws-sdk-dynamodb` (already a dependency) exposes `ExecuteStatement` for PartiQL. The `DynamoClientRegistry` (`client.rs`) hands out connected clients; `items.rs` defines the `AttrValue` enum and its bidirectional SDK ↔ serde conversion, the `Scan`/`Query` command pattern, and activity-log emission.
- **Frontend**: Athena's `sql/` folder is the closest template (query-only, export, no inline edit). DynamoDB's `data-view` already solves nested-item display: `useInferredColumns`, `AttributeValue` cell rendering, and the `JsonView`/`Inspector` side panel.
- **Specs already ahead of code**: `context-queries-runner` specifies a "Dynamo PartiQL execution path" surfacing results in the SQL result panel; `dynamo-connection` defers the `New SQL Query` menu entry to "change #13" (this change).

Constraints: SQL-authentication-equivalent here is AWS creds in the OS keychain (already handled by the connection layer). DynamoDB is schemaless, so completion is structurally weaker than SQL. `ExecuteStatement` is single-statement; there is no server-side multi-statement transaction.

## Goals / Non-Goals

**Goals:**
- A functional free-form PartiQL editor tab with run / run-all, result display, and export.
- Faithful rendering of nested, heterogeneous DynamoDB items (not a lossy flat table).
- Respect the connection `readOnly` flag for mutating statements.
- Keep the guided `QueryBuilder` as the default; PartiQL is the advanced mode.
- Fulfill the existing `context-queries-runner` Dynamo path (replace the clipboard fallback).

**Non-Goals:**
- Extracting a shared `<SqlEditor dialect=… />` across all five engines (follow-up).
- `BatchExecuteStatement` (different shape, no `SELECT` scans).
- Native PartiQL positional (`?`) parameter binding — v1 substitution stays textual, per `context-queries-runner`.
- CloudWatch Logs Insights editor.
- Inline editing of PartiQL result rows (the guided data-view grid remains the editing surface).
- A full-scan cost *blocker* — we surface consumed capacity, we do not prevent expensive queries.

## Decisions

### D1 — Template: copy Athena's `sql/`, not MySQL's
PartiQL is query-only on free-form results. MySQL's `ResultPanel` is built on the heavyweight virtualized `DataGrid` with inline-edit infrastructure (`EditableCell`, `useEditBuffer`) that PartiQL will never use. Athena is the true twin: query-only, export-first, with a `rows | succeeded` result variant that matches PartiQL's DML semantics (no `affected_rows` count). **Copy Athena's `QueryEditor.tsx`, `useQueryRun.ts`, `completionSources.ts`, `export/`, and tab-registration pattern.** *Alternative considered:* copy MySQL as the issue suggested — rejected because it drags in unused inline-edit machinery.

### D2 — Result rendering: hybrid (Athena chrome + data-view item rendering)
A PartiQL `SELECT *` returns DynamoDB items — heterogeneous, nested `AttributeValue` maps (`M`, `L`, `SS`, binary→base64), where different items can have different attributes. Athena's flat `rows: unknown[][]` + `SimpleTable` would be lossy. **The new `ResultPanel` reuses the editor chrome from Athena but renders rows with the `data-view` machinery (`useInferredColumns`, `AttributeValue` cells, JSON inspector for a selected item).** This means the result panel is a genuine merge, not a copy. *Alternative considered:* Athena's flat `SimpleTable` — rejected as lossy for nested attributes; the existing `data-view` renderer already handles the exact shape `ExecuteStatement` returns.

### D3 — Multi-statement: split + loop `ExecuteStatement`
`ExecuteStatement` runs one statement. To preserve the shared editor's Mod-Shift-Enter "run all" affordance, the backend splits the editor body on `;` and calls `ExecuteStatement` once per statement, returning an array of per-statement outcomes (mirroring Athena's `run_sql_many` / `StatementOutcome`). Each call is independent and **non-atomic** — surfaced in copy so users do not expect transactional semantics. *Alternatives considered:* single-statement only (simpler, but breaks UX parity and the run-all affordance); `BatchExecuteStatement` (wrong fit — no `SELECT` scans, ≤25 cap, different shape).

### D4 — Read-only gating via `is_mutating_partiql`
There is no PartiQL parser available; classify by the first significant keyword: `SELECT` → read; `INSERT`/`UPDATE`/`DELETE` → mutating. On a `readOnly` connection, a mutating statement is rejected **before** any AWS call, with a clear error. This mirrors `is_mutating_sql` on the SQL engines. *Risk note:* keyword classification is coarse but safe — it can only over-reject (block a read), never under-reject, because PartiQL statements always begin with their verb.

### D5 — Completion scoped to what DynamoDB knows
Adapt Athena's `completionSources.ts`: keywords + table names + index names + partition/sort key attributes (from the cached `DescribeTable`) + attributes declared in the context folder docs. Arbitrary item attributes are **not** completable (schemaless). Set expectations in copy/tooltips rather than sampling items (sampling is a cost/perf hazard and out of scope).

### D6 — Free-form tab, not a per-table toggle
The editor is a new free-form tab kind (e.g. `dynamo-query`), analogous to `mysql-query` — not bound to a single table, since PartiQL can `FROM` any table/index. It is registered via a **value/side-effect import** in `dynamo/index.ts` (not `export type`), so `TabRegistry.register` actually runs (the issue's explicit note). "Guided vs advanced mode" is realized at the product level: the per-table `data-view` keeps the guided builder, and an `Open in PartiQL editor` affordance on the table leaf pre-fills `SELECT * FROM "<table>"` to give the advanced mode an on-ramp. Launch points: command palette, connection context menu (`New PartiQL query`), table-leaf context menu (`Open in PartiQL editor`), and the context-query runner.

### D7 — Consumed capacity readout (cheap, in scope)
`ExecuteStatement` returns `ConsumedCapacity` when requested; a PartiQL `SELECT` without a partition key is a full table scan (the DynamoDB analog of Athena's bytes-scanned cost). The result panel surfaces consumed capacity per run, mirroring Athena's `data_scanned_bytes` display. A heuristic "this looks like a full scan" *warning* is deferred — only the factual readout ships in v1.

## Risks / Trade-offs

- **Lossy results if D2 is skipped under time pressure** → keep D2 firm; the `data-view` renderer already exists, so reuse cost is low.
- **Non-atomic multi-statement surprises users** → label the run-all path clearly; each statement reports its own outcome, errors halt the batch like Athena.
- **Weak completion sets wrong expectations** → scope completion to keys + context-doc attributes and communicate the limit; do not sample items.
- **Read-only classifier over-rejects** → acceptable (fail-safe); document that only `SELECT` runs on read-only connections.
- **`ExecuteStatement` pagination differs from data-view's page model** → use `NextToken` (opaque cursor) with a row cap like Athena's, rather than the data-view's offset-style paging.
- **Five near-identical editors now** → accepted debt; the shared-editor extraction is an explicit follow-up with all five call sites available to design against.

## Migration Plan

Additive, no data migration. New backend command + new frontend folder + small edits to three existing dynamo files (`index.ts`, `commands.ts`, `openDynamoQuery.ts`) and two context menus. Rollback = revert the change; the clipboard fallback in `openDynamoQuery` is the prior behavior. Session-persisted tab records: the new tab kind is purely additive (no existing kind retired), so no tab-migration step is required.

## Open Questions

- Should the `Open in PartiQL editor` affordance also live as a toggle button inside the `data-view` toolbar (not just the leaf context menu)? Leaning yes if cheap, but not required for the acceptance criteria.
- Row cap for `SELECT` results — match Athena's 10,000, or a lower DynamoDB-appropriate default given per-item cost? Default to Athena parity unless profiling says otherwise.
