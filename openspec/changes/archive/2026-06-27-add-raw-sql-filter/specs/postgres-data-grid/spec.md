## MODIFIED Requirements

### Requirement: Filter operator set

The structured filter payload accepted by `postgres_query_table` (and `postgres_count_table`) SHALL be a `FilterTree` defined as `{ children: Array<FilterNode> }`. A `FilterNode` MUST be one of:

- `{ kind: "condition", column: ColumnRef, op: Operator, value?: Value | Array<Value> | { min: Value, max: Value } }`
- `{ kind: "or_group", children: Array<Condition> }` (a flat OR-group containing only condition leaves; the connector is implicitly OR; nesting another `or_group` inside an `or_group` MUST be rejected)

A `ColumnRef` is `{ kind: "named", name: string }`, `{ kind: "any_column" }`, or `{ kind: "raw" }`.

The `Operator` set MUST be one of: `=`, `!=`, `<`, `<=`, `>`, `>=`, `LIKE`, `NOT LIKE`, `ILIKE`, `NOT ILIKE`, `Contains`, `StartsWith`, `EndsWith`, `In`, `NotIn`, `BETWEEN`, `IS NULL`, `IS NOT NULL`, `RAW`. The backend MUST reject any other operator with `AppError::Validation`.

Per-operator value rules:

- `=`, `!=`, `<`, `<=`, `>`, `>=`, `LIKE`, `NOT LIKE`, `ILIKE`, `NOT ILIKE` — `value` is a single bound parameter passed verbatim. The user supplies their own `%` for `LIKE`-family.
- `Contains` — compiles to `ILIKE '%' || $n || '%'`. `value` is bound verbatim (no escaping of `%` / `_` in v1).
- `StartsWith` — compiles to `ILIKE $n || '%'`.
- `EndsWith` — compiles to `ILIKE '%' || $n`.
- `In`, `NotIn` — `value` MUST be a non-empty array of scalars. Compiles to `IN ($n, $n+1, ...)` / `NOT IN (...)` with each element bound. Empty arrays MUST be rejected with `AppError::Validation`.
- `BETWEEN` — `value` MUST be `{ min, max }`. Compiles to `BETWEEN $a AND $b`. Inclusive on both bounds.
- `IS NULL`, `IS NOT NULL` — `value` MUST be absent. Providing one MUST be rejected.
- `RAW` — `value` MUST be a non-empty string holding an arbitrary SQL boolean expression. It compiles to the trimmed expression wrapped in a single pair of parentheses (`(<expr>)`) and is emitted **verbatim** into the `WHERE` body — it is NOT a bound parameter and no identifier quoting is applied to it. An empty/whitespace-only `value`, an absent `value`, or a non-string `value` MUST be rejected with `AppError::Validation`.

Operator–column pairing rules:

- `op: "RAW"` is valid ONLY with `column: { kind: "raw" }`. A `RAW` operator paired with a `named` or `any_column` reference MUST be rejected with `AppError::Validation`.
- A `column: { kind: "raw" }` reference is valid ONLY with `op: "RAW"`. Any other operator on a `raw` column MUST be rejected with `AppError::Validation`.

Per-column-type rules in the frontend:

- Numeric/date/timestamp columns: surface `=`, `!=`, `<`, `<=`, `>`, `>=`, `BETWEEN`, `In`, `NotIn`, plus `IS NULL` / `IS NOT NULL` if nullable.
- Text columns: surface `=`, `!=`, `LIKE`, `NOT LIKE`, `ILIKE`, `NOT ILIKE`, `Contains`, `StartsWith`, `EndsWith`, `In`, `NotIn`, plus null variants if nullable.
- Boolean columns: surface `=`, `!=`, plus null variants.
- Other types (uuid, json, enum, etc.): surface `=`, `!=`, `In`, `NotIn`, plus null variants.
- `RAW` is NOT surfaced as a per-column operator. It is reached by selecting the `Raw SQL` entry in the column picker (see "Raw SQL filter row"), which fixes the row's operator to `RAW`.

Values MUST be passed as bound parameters in Structured mode, never interpolated — with the sole exception of the `RAW` operator, whose `value` is an explicitly trusted free-form expression interpolated verbatim. RAW rows participate in the same `filter_tree` as bound rows and join them under the tree's root combinator; mixing RAW and bound rows in one tree MUST be supported. The frontend MUST surface every operator from the filter bar (not from a per-column header popover; see "Filter bar surface").

#### Scenario: Unknown operator is rejected

- **WHEN** the frontend forwards a condition with `op: "DROP"` (out of the allowed set)
- **THEN** the command returns `AppError::Validation` with a message naming the offending operator
- **AND** no SQL is dispatched to Postgres

#### Scenario: BETWEEN binds two parameters

- **WHEN** the user filters `created_at BETWEEN '2026-01-01' AND '2026-04-30'` via `{ op: "BETWEEN", value: { min: "2026-01-01", max: "2026-04-30" } }`
- **THEN** the issued SQL contains `WHERE "created_at" BETWEEN $1 AND $2` with both bounds bound as parameters
- **AND** rows whose `created_at` equals either bound are included

#### Scenario: Contains compiles to ILIKE with wildcards

- **WHEN** the user filters with `{ column: { kind: "named", name: "name" }, op: "Contains", value: "ana" }`
- **THEN** the issued SQL is `WHERE "name" ILIKE '%' || $1 || '%'` with `$1 = "ana"`
- **AND** the match is case-insensitive

#### Scenario: In binds N parameters

- **WHEN** the user filters with `{ column: { kind: "named", name: "status" }, op: "In", value: ["active", "pending", "trial"] }`
- **THEN** the issued SQL is `WHERE "status" IN ($1, $2, $3)` with parameters `"active"`, `"pending"`, `"trial"`

#### Scenario: Empty In array is rejected

- **WHEN** the user forwards `{ op: "In", value: [] }`
- **THEN** the command returns `AppError::Validation` and no SQL is dispatched

#### Scenario: IS NULL with a value is rejected

- **WHEN** the user forwards `{ op: "IS NULL", value: "x" }`
- **THEN** the command returns `AppError::Validation` and no SQL is dispatched

#### Scenario: RAW expression compiles verbatim into the WHERE body

- **WHEN** the user forwards `{ kind: "condition", column: { kind: "raw" }, op: "RAW", value: "data->>'estado' = 'activo'" }`
- **THEN** the issued SQL `WHERE` body is `(data->>'estado' = 'activo')`
- **AND** the expression is emitted verbatim with no bound parameter slot allocated for it
- **AND** no identifier quoting is applied to the expression

#### Scenario: RAW row combines with a bound row under the root combinator

- **WHEN** the tree has root combinator `AND` and children `[{ column: { kind: "named", name: "country" }, op: "=", value: "CL" }, { column: { kind: "raw" }, op: "RAW", value: "payload @> '{\"source\":\"webhook\"}'" }]`
- **THEN** the issued SQL `WHERE` body is `"country" = $1 AND (payload @> '{"source":"webhook"}')`
- **AND** `$1 = "CL"` is bound while the RAW fragment carries no parameter

#### Scenario: Empty RAW value is rejected

- **WHEN** the user forwards `{ column: { kind: "raw" }, op: "RAW", value: "" }` (or a whitespace-only or absent value)
- **THEN** the command returns `AppError::Validation` and no SQL is dispatched

#### Scenario: RAW operator on a named column is rejected

- **WHEN** the user forwards `{ column: { kind: "named", name: "data" }, op: "RAW", value: "data->>'x' = '1'" }`
- **THEN** the command returns `AppError::Validation` and no SQL is dispatched

#### Scenario: Non-RAW operator on a raw column is rejected

- **WHEN** the user forwards `{ column: { kind: "raw" }, op: "=", value: "1" }`
- **THEN** the command returns `AppError::Validation` and no SQL is dispatched

## ADDED Requirements

### Requirement: Raw SQL filter row

The filter bar SHALL let the user add a **RAW** filter row that carries a free-form SQL boolean expression, so that predicates the structured operators cannot express — most notably reaching inside `jsonb` columns (`->`, `->>`, `@>`, `?`, …) — are reachable from the data grid.

A RAW row is entered through the column picker: in addition to the named columns and the existing `Any column` pseudo-entry, the picker MUST offer a `Raw SQL` entry. Selecting `Raw SQL` MUST set the row's column to `{ kind: "raw" }` and fix its operator to `RAW`. While a row is in RAW mode:

- The operator picker MUST be hidden or disabled (the operator is implicitly `RAW`).
- In place of the structured value input, the row MUST render a single free-form expression input that spans the operator+value region, using the monospace token from `DESIGN.md`, with a placeholder illustrating the intended use (e.g. `data->>'estado' = 'activo'`).
- The row MUST retain its checkbox, per-row `Apply` / `Applied` affordance, and `−` / `+` buttons, identical to every other row.

A RAW row is **complete** (eligible for `Apply All` and per-row `Apply`) iff its expression is a non-empty, non-whitespace string. Incomplete RAW rows MUST be excluded from the wire payload exactly as incomplete structured rows are.

RAW rows MUST combine with structured rows: they are emitted into the same `filter_tree` and joined with the other enabled-complete rows under the bar's root combinator (`AND` / `OR`). The user MUST be able to clear a RAW row the same way as any other row — via its `−` button or via `Unset` (which clears all draft rows). Switching a row's column back from `Raw SQL` to a named column or `Any column` MUST restore the structured operator + value inputs.

The footer `SQL` preview and any copy-WHERE / export-of-WHERE path MUST render a RAW row's expression verbatim (wrapped in parentheses) interleaved with the parametrized fragments of the other rows, consistent with what the backend executes.

#### Scenario: Raw SQL entry appears in the column picker

- **WHEN** the user opens a filter row's column picker
- **THEN** a `Raw SQL` entry is listed alongside the named columns and the `Any column` entry

#### Scenario: Selecting Raw SQL switches the row to an expression input

- **WHEN** the user picks `Raw SQL` in a row's column picker
- **THEN** the operator picker is no longer shown (the operator is fixed to `RAW`)
- **AND** a single free-form expression input is rendered in place of the structured value input, with a `jsonb` example placeholder

#### Scenario: Empty RAW row is not applied

- **WHEN** the user has a RAW row with an empty expression and clicks `Apply All`
- **THEN** the RAW row is omitted from the applied filter and from the wire payload
- **AND** no `RAW` condition is sent to `postgres_query_table`

#### Scenario: RAW row queries inside a jsonb column and combines with a structured row

- **WHEN** the user has an enabled structured row `country = 'CL'` and an enabled RAW row `data->>'estado' = 'activo'` with the root combinator `AND`, and clicks `Apply All`
- **THEN** the grid re-fetches with a `filter_tree` containing both conditions
- **AND** only rows where `country = 'CL'` AND `data->>'estado' = 'activo'` are returned

#### Scenario: RAW row is cleared like any other row

- **WHEN** the user clicks the `−` button on a RAW row (or clicks `Unset`)
- **THEN** the RAW row is removed from the draft
- **AND** the remaining rows are unaffected

#### Scenario: Footer SQL preview shows the RAW expression verbatim

- **WHEN** the user has an applied RAW row `data->>'estado' = 'activo'` and opens the footer `SQL` preview
- **THEN** the previewed `WHERE` contains `(data->>'estado' = 'activo')` verbatim, joined with any other rows under the root combinator
