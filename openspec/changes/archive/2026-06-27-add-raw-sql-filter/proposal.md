## Why

The data-grid filter bar only offers a closed set of per-column operators applied to a single column value, so users cannot reach *inside* a `jsonb` column (e.g. `data->>'estado' = 'activo'`) or write any other free-form SQL predicate. The reported need (in-app feedback, issue #194) is a **RAW** filter that accepts an arbitrary SQL expression in the `WHERE`, while still combining with the structured rows the user already has.

A whole-bar "Raw mode" backed by the mutually-exclusive `raw_where` field used to exist and was deliberately removed because it *replaced* structured filters instead of composing with them. This change brings RAW back the right way: as one more **filter row** that lives inside the structured `filter_tree` and joins the others via the existing AND/OR combinator.

## What Changes

- Add a **RAW filter row** to the Postgres data-grid filter bar. The user picks `Raw SQL` from the column picker (a new pseudo-column next to the existing `Any column`); the row then shows a single wide expression input instead of the operator + value pair.
- The RAW expression is injected **verbatim** into the compiled `WHERE` (wrapped in parentheses), so JSON operators (`->`, `->>`, `@>`, `?`, etc.) and any other valid SQL work. It is the one filter row whose value is **not** bound as a parameter — this matches the trust level the user already has via the SQL editor (read-only `SELECT` path).
- RAW rows **combine** with structured rows under the same root combinator, can be enabled/disabled per row, applied per row or via `Apply All`, and cleared via the row `−` button or `Unset` — identical lifecycle to every other row.
- The footer `SQL` preview and `Export`/copy-WHERE paths render RAW rows verbatim alongside the parametrized rows.
- Backend (`postgres_query_table` / `postgres_count_table`) accepts a new `RAW` operator and `raw` column reference inside `filter_tree`, validates the pairing, and emits the expression verbatim. The pre-existing top-level `raw_where` field is unchanged.
- **Out of scope (v1):** MySQL and MSSQL keep their own filter-model copies and are not modified here; the same pattern can follow once Postgres ships. DynamoDB / Athena / CloudWatch are unaffected.

## Capabilities

### New Capabilities

_None._ This extends an existing capability rather than introducing a new one.

### Modified Capabilities

- `postgres-data-grid`: the **Filter operator set** requirement gains a `RAW` operator and a `raw` `ColumnRef` variant (verbatim, unbound, carved out of the "values MUST be bound parameters" rule); the **Filter bar surface** and **Filter draft and applied state** requirements gain the RAW row presentation (column-picker entry, expression input, completeness rule, combine/clear behavior).

## Impact

- **Frontend** (`packages/app/src/modules/postgres/data/`): `types.ts` (`Operator`, `ColumnRef`, `isCompleteRow`, wire conversion), `filter-bar/operatorRules.ts`, `filter-bar/ColumnPicker.tsx`, `filter-bar/ConditionRow.tsx`, `filter-bar/ValueInput.tsx`, `filter-bar/compileWhere.ts` (footer SQL preview), plus their tests.
- **Backend** (`packages/app/src-tauri/src/modules/postgres/data.rs`): `Operator` enum, `ColumnRef` enum, `predicate_for` / `compile_condition`, validation, plus Rust unit tests.
- **Security posture**: introduces a deliberately unparametrized predicate path. Scoped to the read-only query path; documented in design as equivalent to the user's existing SQL-editor access to their own connection.
- **Docs/spec**: `openspec/specs/postgres-data-grid/spec.md` delta. No DB migrations, no new dependencies, no IPC command signature changes.
