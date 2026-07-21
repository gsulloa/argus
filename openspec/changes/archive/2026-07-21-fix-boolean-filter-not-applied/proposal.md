## Why

A Postgres data-grid filter on a boolean column (`email_verified = true`) shows a green **"Applied"** badge but is silently dropped from the query: the issued SQL carries no `WHERE` clause and rows with `false` still appear. The user trusts the "Applied" state, gets wrong results, and has no signal that the filter never took effect. This is a correctness bug in a core browsing workflow.

## What Changes

- A newly-created boolean filter row MUST hold a concrete boolean value in its model (defaulting to `true`) instead of the empty-string placeholder, so that a `boolean = true` row is treated as **complete** and compiles into the `WHERE` clause. Today the boolean `<select>` renders `true` visually as its first option but never commits it to the row model, because selecting the already-displayed option fires no `change` event.
- The per-row **"Applied"** badge MUST reflect whether the row was actually applied to the running query — an **incomplete** row (one that `modelToPayload` would drop) MUST NOT display the green "Applied" state, even if its `(column, op, value)` triple matches a row in `applied`. This removes the "lies green" behavior that masked the dropped filter.
- Row **completeness** MUST explicitly accept a boolean value (`true` or `false`) as complete; the current check rejects any falsy/empty value and would drop a legitimate `= false` row.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `postgres-data-grid`: the filter-bar boolean value input MUST commit a concrete default boolean to the row model so boolean structured rows are complete and compile into the `filter_tree`; row completeness MUST treat boolean values as complete; and the per-row "Applied" visual state MUST be gated on the row actually being part of the applied payload (not merely on triple equality with an incomplete draft row).

## Impact

- **Frontend (`packages/app/src/modules/postgres/data/`)**:
  - `filter-bar/ValueInput.tsx` — boolean `<select>` must establish/commit a default boolean value rather than leaving the model at `""`.
  - `types.ts` — `EMPTY_FILTER_ROW_FIELDS` boolean defaulting, `isCompleteRow` accepting boolean values, and the applied-badge derivation gating "Applied" on completeness.
  - `filter-bar/FilterBar.tsx` — `buildAppliedSet` / applied-badge logic must only mark complete rows as "Applied".
  - Possibly `filter-bar/treeMutations.ts` — `coerceValueForOperator` may need a boolean-aware default when the column type is boolean.
- **Backend (Rust)**: no change — `build_where_body` / `build_select_sql` correctly emit no `WHERE` given an empty `filter_tree`; the defect is entirely frontend.
- **Tests**: unit coverage for boolean-row completeness, `modelToPayload` emitting a boolean condition, and the applied-badge no longer showing green for an incomplete row.
