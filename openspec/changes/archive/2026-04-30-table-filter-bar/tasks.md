## 1. Backend payload shape and types

- [x] 1.1 Add `FilterTree`, `FilterNode` (`Condition` | `OrGroup`), `Condition`, `ColumnRef` (`Named` | `AnyColumn`), and `Operator` enums to `src-tauri/src/modules/postgres/data.rs`. Use `serde(tag = "kind", rename_all = "snake_case")` for the discriminated unions so wire keys are `kind: "condition"` / `kind: "or_group"` / `kind: "named"` / `kind: "any_column"`.
- [x] 1.2 Replace the legacy `filters: Option<Vec<Filter>>` field on `QueryTableOptions` with `filter_tree: Option<FilterTree>` and a new sibling `raw_where: Option<String>`. Apply the same change to the `postgres_count_table` options.
- [x] 1.3 Add validation: reject when both `filter_tree` and `raw_where` are set with `AppError::Validation { message: "filter_tree and raw_where are mutually exclusive" }`.
- [x] 1.4 Add validation: reject `or_group` nested inside `or_group` (children of an OR group MUST all be `Condition`).

## 2. Backend predicate compiler

- [x] 2.1 Extend the `Operator` set with `Contains`, `StartsWith`, `EndsWith`, `In`, `NotIn`, `ILIKE`, `NotILike`. Map each to its SQL form per the spec (Contains/StartsWith/EndsWith use `ILIKE` with concat).
- [x] 2.2 Refactor `predicate_for(column, op, value)` to accept a `cast_suffix: &str` parameter (`""` or `"::text"`). Apply the suffix after the quoted column identifier in the SQL output.
- [x] 2.3 Implement `expand_any_column(op, value, columns)`: enumerate text-castable columns (skip `bytea` and composite/row types), emit `(<col1>::text [op] $n OR <col2>::text [op] $n OR ...)` reusing the same `$n` parameter slot. Return `(SQL_FALSE, &[])` when no columns are castable.
- [x] 2.4 Implement `text_castable(data_type: &str) -> bool` covering the common Postgres OIDs that survive `::text` (skip `bytea`, composite types, row types).
- [x] 2.5 Validate per-operator value shape: `In`/`NotIn` require non-empty array; `BETWEEN` requires `{ min, max }`; `IS NULL` / `IS NOT NULL` require absent value. Reject violations with `AppError::Validation`.
- [x] 2.6 Validate Any-column operator allow-list: only `=`, `!=`, `LIKE`, `NOT LIKE`, `ILIKE`, `NOT ILIKE`, `Contains`, `StartsWith`, `EndsWith` allowed. Reject others with `AppError::Validation`.

## 3. Backend WHERE clause assembly

- [x] 3.1 Implement `compile_filter_tree(tree, columns) -> (sql: String, params: Vec<Param>)` that walks the tree and emits the AND-joined root with parenthesized OR groups.
- [x] 3.2 Update `build_select_sql` to accept `filter_tree` or `raw_where` (mutex). For `raw_where`, emit `WHERE <body>` verbatim, no parameterization. For `filter_tree`, call `compile_filter_tree`.
- [x] 3.3 Apply the same path to `postgres_count_table`.
- [x] 3.4 Ensure the activity-log `sql` and `params` fields reflect the new WHERE body (Structured = parametrized, Raw = inlined verbatim).

## 4. Backend tests

- [x] 4.1 Unit-test `compile_filter_tree` for: empty tree (no WHERE), single condition, multiple ANDed conditions, one OR group, OR group with one child still parens, mixed root + group, validation rejections (empty `In`, nested `or_group`, missing `BETWEEN` bounds).
- [x] 4.2 Unit-test `expand_any_column`: relation with mix of text + bytea + composite, relation with only bytea (compiles to `(FALSE)`), correct shared `$n` reuse.
- [x] 4.3 Integration-test `postgres_query_table` with a `raw_where` body and assert the activity-log entry contains the raw text.
- [x] 4.4 Integration-test the mutex validation: both `filter_tree` and `raw_where` set returns the `AppError::Validation` and dispatches no SQL.

## 5. Frontend payload wiring

- [x] 5.1 Update `dataApi.queryTable` and `dataApi.countTable` (in `src/modules/postgres/data/api.ts`) to accept the new `{ filter_tree, raw_where }` shape and remove the legacy `filters` field.
- [x] 5.2 Update TypeScript types: `FilterModel`, `FilterTree`, `FilterNode`, `Condition`, `ColumnRef`, `Operator`. Mirror the Rust serde shape (`kind`-tagged unions).
- [x] 5.3 Update `useTableData.ts` to consume `applied: FilterModel` and forward it as `{ filter_tree, raw_where }` to the Tauri command.

## 6. Frontend WHERE compiler (TS, display-only)

- [x] 6.1 Implement `compileWhere(model: FilterModel): { mode: "structured" | "raw", body: string }` in `src/modules/postgres/data/filter-bar/compileWhere.ts`. For Structured, emit the same WHERE body shape as the backend but with literals inlined (single-quoted strings, escaped `'`). For Raw, return the raw body verbatim.
- [x] 6.2 Implement `compilePrefilledSelect({ schema, relation, model, orderBy, limit })` that wraps `compileWhere` into `SELECT * FROM "<schema>"."<relation>" [WHERE ...] [ORDER BY ...] LIMIT <N>`.
- [x] 6.3 Unit-test `compileWhere` against the same scenarios as the Rust compiler (empty, AND-only, OR-group, Any-column expansion, Raw passthrough). Test under `src/modules/postgres/data/filter-bar/compileWhere.test.ts`.

## 7. Frontend filter bar UI — scaffolding

- [x] 7.1 Create `src/modules/postgres/data/filter-bar/FilterBar.tsx` as the orchestrator. Owns mode toggle, dispatches to children, exposes `Apply` / `Reset` / `Open in SQL Editor`. Reads `draft` and `applied` from props provided by `TableViewerTab`.
- [x] 7.2 Add `TableViewerTab` state: `const [draft, setDraft] = useState<FilterModel>(empty)` and `const [applied, setApplied] = useState<FilterModel>(empty)`. Wire `applied` to `useTableData`.
- [x] 7.3 Implement the dirty marker: compute `isDirty = !shallowEq(draft, applied)` (using a small structural compare util — no `lodash.isEqual` import). Render `●` next to Apply when dirty.
- [x] 7.4 Bind `Cmd+Enter` (Apply) and `Esc` (Discard draft) inside the bar. Use scoped key handlers; do not steal `Cmd+Enter` outside the bar.
- [x] 7.5 Wire `Reset` to clear both draft and applied in a single batched update, then trigger fetch.
- [x] 7.6 Wire `Apply` to `setApplied(draft)`.
- [x] 7.7 Render the bar in `TableViewerTab` above the data grid; respect `DESIGN.md` tokens (`--surface`, `--border`, `--accent`, Geist Mono for operator labels).

## 8. Frontend filter bar UI — Structured mode

- [x] 8.1 Implement `ConditionRow.tsx`: column picker + operator picker + value input + remove button. Reads/writes a single `Condition` node via callback.
- [x] 8.2 Implement `ColumnPicker.tsx` as a typeahead. The first option MUST be "Any column" (`{ kind: "any_column" }`). Subsequent options come from `columns` of the current relation. Geist Mono in the input.
- [x] 8.3 Implement `OperatorPicker.tsx`. Filters the operator list by `(column type, nullable, isAnyColumn)` per the spec rules (text/numeric/date/bool/other).
- [x] 8.4 Implement `ValueInput.tsx` with adaptive shape: single text input for most ops, two inputs side-by-side for `BETWEEN`, chip/tag input for `In` / `NotIn`, hidden when op is `IS NULL` / `IS NOT NULL`, date picker for date/timestamp columns, true/false select for boolean.
- [x] 8.5 Implement `OrGroup.tsx`: renders a bordered container around its child `ConditionRow`s, an internal `+ row` to add a condition leaf, a remove-group affordance, and a header label "OR".
- [x] 8.6 Implement add-affordances: `+ AND row` (root-level new condition leaf) and `+ OR group` (root-level new OR group with one empty condition).
- [x] 8.7 Implement the Any-column warning: when a `ConditionRow` has `column.kind === "any_column"`, render a `⚠` icon with tooltip "Searches every text-castable column — slow on large tables."
- [x] 8.8 Implement the auto-collapse rule: when the user removes the last condition from an OR group, remove the group from the tree.

## 9. Frontend filter bar UI — Raw SQL mode

- [x] 9.1 Implement `RawWhereEditor.tsx`: a CodeMirror 6 instance with `@codemirror/lang-sql` (PostgreSQL dialect). No autocomplete extension. No run keymap. Geist Mono.
- [x] 9.2 Wire the mode toggle: Structured → Raw seeds the editor with `compileWhere(draft).body` (or empty if structured was empty).
- [x] 9.3 Wire the mode toggle: Raw → Structured shows a confirm dialog ("Switch to structured? Your raw WHERE will be discarded.") with Cancel as default. On Switch, clear raw body AND reset structured tree to empty.
- [x] 9.4 Trim a single leading `WHERE ` prefix (case-insensitive) from the body before sending as `raw_where`.
- [x] 9.5 Empty raw body sends `raw_where: undefined`.
- [x] 9.6 Surface `AppError::Postgres` from raw applies inline near the editor (not via global toast).

## 10. Frontend Open in SQL Editor

- [x] 10.1 Implement the `Open in SQL Editor` button in `FilterBar.tsx`. Always uses `applied`, never `draft`.
- [x] 10.2 Use `compilePrefilledSelect` to generate the SQL with the active `orderBy` and current page size.
- [x] 10.3 Dispatch the existing tab-open action with payload `{ connectionId, connectionName, sql }` to open a new `postgres-query` tab. Focus the new tab.
- [x] 10.4 If `applied` is empty, the SQL omits the WHERE clause entirely.

## 11. Frontend cleanup — remove the popover

- [x] 11.1 Delete `src/modules/postgres/data/ColumnFilter.tsx`.
- [x] 11.2 Remove the funnel icon and the popover trigger from `DataGrid.tsx`'s column header rendering. Keep the sort cycle on header click.
- [x] 11.3 Remove dead imports / props that fed the popover.
- [x] 11.4 Update or remove any unit tests that targeted the popover's behavior.

## 12. Frontend tests

- [x] 12.1 Component tests for `FilterBar`: dirty indicator toggles correctly, Apply commits draft, Esc discards draft, Reset clears both, Cmd+Enter applies.
- [x] 12.2 Component tests for `OrGroup`: removing the last condition collapses the group; cannot nest a group inside a group via the UI.
- [x] 12.3 Component test for the mode toggle confirm flow (Raw → Structured): Cancel keeps the body, Switch resets both sides.
- [x] 12.4 Component test for `Open in SQL Editor`: click with applied filters opens a new query tab whose `sql` matches the expected prefilled SELECT.
- [x] 12.5 Snapshot/scenario tests asserting the wire payload shape for representative drafts (matches Rust serde).

## 13. Spec sync and docs

- [x] 13.1 Once implementation lands, run `openspec validate --change table-filter-bar --strict` and address any drift.
- [x] 13.2 Update `DESIGN.md` only if the bar introduces a token not already specified (e.g. dirty-indicator color). Default: reuse `--accent` for the dirty dot.
- [x] 13.3 Manual smoke test: open a table with > 50 columns, exercise Structured (AND only), Structured (with OR group), Any column with Contains, Raw mode with a `payload->>'x'` predicate, Open in SQL Editor.
