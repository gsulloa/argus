## MODIFIED Requirements

### Requirement: Query table command

The Postgres module SHALL expose a Tauri command `postgres_query_table(id, schema, relation, options, origin?)` that executes a paginated `SELECT` against a table, view, or materialized view and returns the rows together with the column metadata. The `options` payload MUST accept `{ limit: number, offset: number, order_by?: Array<{ column: string, direction: "asc" | "desc" }>, filter_tree?: FilterTree, raw_where?: string }` (snake_case keys). `filter_tree` and `raw_where` MUST be mutually exclusive — if both are provided the command MUST return `AppError::Validation { message: "filter_tree and raw_where are mutually exclusive" }` before dispatching SQL. If neither is provided, no `WHERE` clause is emitted. The optional `origin` argument MUST be `"user"` or `"auto"` and defaults to `"auto"` when absent; it is forwarded verbatim into the activity-log event for this command. The response payload MUST be `{ columns: Array<{ name: string, data_type: string, ordinal_position: number, is_nullable: boolean }>, rows: Array<Array<Value>>, applied: { limit: number, offset: number, order_by, filter_tree, raw_where }, query_ms: number, truncated_columns: string[] }`. Rows MUST be returned as JSON-serializable arrays in the same order as `columns`. Postgres values that do not have a natural JSON representation (e.g. `bytea`, large `text`) MAY be returned as a typed string envelope `{ kind: "binary"|"truncated", preview: string, byte_length?: number }` and the column name MUST then appear in `truncated_columns`. The command MUST acquire a connection from the existing pool registry, MUST quote the schema and relation identifiers safely, and MUST NOT open a new connection. The command MUST execute through the read-only-aware `executeQuery` path (it never mutates state). The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "query_table"`, `connection_id: <id>`, `origin: <origin argument>`, `sql: <issued SELECT text>`, `params: <bind params, Debug-formatted, each truncated to 200 chars>`, `metric: { kind: "rows", value: <returned row count> }` on success (`null` on failure), and `status` matching the result. Frontend call sites that initiate the command in response to a user gesture (opening a table, paging, refreshing, sort/filter changes) MUST pass `origin: "user"`; internal pre-fetches MUST pass `origin: "auto"` (or omit the argument).

#### Scenario: Default page returns up to limit rows in declared order

- **WHEN** the user invokes `postgres.queryTable(id, "public", "users", { limit: 200, offset: 0 })`
- **THEN** the response contains up to 200 rows, ordered by the relation's natural row order
- **AND** the `columns` array describes every column in `pg_attribute` ordinal-position order
- **AND** `applied.limit === 200` and `applied.offset === 0`
- **AND** the issued SQL contains no `WHERE` clause

#### Scenario: Order by single column descending

- **WHEN** the user invokes `postgres.queryTable(id, "public", "users", { limit: 200, offset: 0, order_by: [{ column: "created_at", direction: "desc" }] })`
- **THEN** the rows are ordered by `created_at` descending (NULLs last by Postgres default for `desc`)
- **AND** the issued SQL contains a quoted `ORDER BY "created_at" DESC` clause

#### Scenario: Multi-column sort respects array order

- **WHEN** the user invokes `postgres.queryTable` with `order_by: [{ column: "country", direction: "asc" }, { column: "created_at", direction: "desc" }]`
- **THEN** the rows are sorted first by `country` ascending and then by `created_at` descending

#### Scenario: filter_tree compiles to WHERE with AND root

- **WHEN** the user invokes `postgres.queryTable` with `filter_tree: { children: [{ kind: "condition", column: { kind: "named", name: "country" }, op: "=", value: "CL" }, { kind: "condition", column: { kind: "named", name: "deleted_at" }, op: "IS NULL" }] }`
- **THEN** the issued SQL has a `WHERE "country" = $1 AND "deleted_at" IS NULL` clause and the parameter is `"CL"`
- **AND** the response contains only rows matching both predicates

#### Scenario: raw_where is appended verbatim as the WHERE body

- **WHEN** the user invokes `postgres.queryTable` with `raw_where: "created_at > now() - interval '7 days' AND payload->>'source' = 'webhook'"`
- **THEN** the issued SQL has a `WHERE created_at > now() - interval '7 days' AND payload->>'source' = 'webhook'` clause
- **AND** the body is NOT parameterized (it is substituted verbatim)
- **AND** Postgres-level errors (syntax, unknown column) propagate to the caller as `AppError::Postgres`

#### Scenario: Setting both filter_tree and raw_where is rejected

- **WHEN** the user invokes `postgres.queryTable` with both `filter_tree` and `raw_where` set
- **THEN** the command returns `AppError::Validation { message: "filter_tree and raw_where are mutually exclusive" }`
- **AND** no SQL is dispatched to Postgres

#### Scenario: Identifiers are quoted, never interpolated

- **WHEN** the user requests a table whose name contains a double-quote (e.g. `we"ird`)
- **THEN** the issued SQL escapes the identifier as `"we""ird"` using the standard double-quote-doubling rule
- **AND** the command does not concatenate the identifier into the SQL via plain string interpolation

#### Scenario: Read-only connection still serves queries

- **WHEN** the user invokes `postgres.queryTable` against a connection whose pool is in `read_only` mode
- **THEN** the command succeeds and returns rows (this command does not mutate state)

#### Scenario: Unknown relation returns NotFound

- **WHEN** the user invokes `postgres.queryTable(id, "public", "does_not_exist", { limit: 200, offset: 0 })`
- **THEN** the command returns `AppError::Postgres { code: Some("42P01"), ... }` (SQLSTATE for `undefined_table`)

#### Scenario: User-initiated call carries origin user in the activity log

- **WHEN** the data-grid call site invokes `postgres.queryTable` with `origin: "user"` for the initial open of a table
- **THEN** the emitted `argus:activity-log` event has `origin: "user"`, `kind: "query_table"`, `sql` containing the SELECT, `params` matching the bound values, `metric: { kind: "rows", value: <row count> }`

#### Scenario: Origin defaults to auto when omitted

- **WHEN** any caller invokes `postgres.queryTable` without supplying the `origin` argument
- **THEN** the emitted `argus:activity-log` event has `origin: "auto"`

#### Scenario: Failed query emits an entry with truncated SQL/params and code

- **WHEN** `postgres.queryTable` is invoked against `"public"."does_not_exist"` and Postgres returns `42P01`
- **THEN** one `argus:activity-log` event is emitted with `kind: "query_table"`, `status: "err"`, `error.code: "42P01"`, `sql` populated with the attempted SELECT, `metric: null`

### Requirement: Filter operator set

The structured filter payload accepted by `postgres_query_table` (and `postgres_count_table`) SHALL be a `FilterTree` defined as `{ children: Array<FilterNode> }`. A `FilterNode` MUST be one of:

- `{ kind: "condition", column: ColumnRef, op: Operator, value?: Value | Array<Value> | { min: Value, max: Value } }`
- `{ kind: "or_group", children: Array<Condition> }` (a flat OR-group containing only condition leaves; the connector is implicitly OR; nesting another `or_group` inside an `or_group` MUST be rejected)

A `ColumnRef` is `{ kind: "named", name: string }` or `{ kind: "any_column" }`.

The `Operator` set MUST be one of: `=`, `!=`, `<`, `<=`, `>`, `>=`, `LIKE`, `NOT LIKE`, `ILIKE`, `NOT ILIKE`, `Contains`, `StartsWith`, `EndsWith`, `In`, `NotIn`, `BETWEEN`, `IS NULL`, `IS NOT NULL`. The backend MUST reject any other operator with `AppError::Validation`.

Per-operator value rules:

- `=`, `!=`, `<`, `<=`, `>`, `>=`, `LIKE`, `NOT LIKE`, `ILIKE`, `NOT ILIKE` — `value` is a single bound parameter passed verbatim. The user supplies their own `%` for `LIKE`-family.
- `Contains` — compiles to `ILIKE '%' || $n || '%'`. `value` is bound verbatim (no escaping of `%` / `_` in v1).
- `StartsWith` — compiles to `ILIKE $n || '%'`.
- `EndsWith` — compiles to `ILIKE '%' || $n`.
- `In`, `NotIn` — `value` MUST be a non-empty array of scalars. Compiles to `IN ($n, $n+1, ...)` / `NOT IN (...)` with each element bound. Empty arrays MUST be rejected with `AppError::Validation`.
- `BETWEEN` — `value` MUST be `{ min, max }`. Compiles to `BETWEEN $a AND $b`. Inclusive on both bounds.
- `IS NULL`, `IS NOT NULL` — `value` MUST be absent. Providing one MUST be rejected.

Per-column-type rules in the frontend:

- Numeric/date/timestamp columns: surface `=`, `!=`, `<`, `<=`, `>`, `>=`, `BETWEEN`, `In`, `NotIn`, plus `IS NULL` / `IS NOT NULL` if nullable.
- Text columns: surface `=`, `!=`, `LIKE`, `NOT LIKE`, `ILIKE`, `NOT ILIKE`, `Contains`, `StartsWith`, `EndsWith`, `In`, `NotIn`, plus null variants if nullable.
- Boolean columns: surface `=`, `!=`, plus null variants.
- Other types (uuid, json, enum, etc.): surface `=`, `!=`, `In`, `NotIn`, plus null variants.

Values MUST be passed as bound parameters in Structured mode, never interpolated. The frontend MUST surface every operator from the filter bar (not from a per-column header popover; see "Filter bar surface").

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

## ADDED Requirements

### Requirement: Filter bar surface

The viewer tab SHALL render a filter bar pinned to the top of the data grid, above the column header row and below any tab title chrome. The filter bar MUST be the only filter surface in the data grid — there MUST NOT be a per-column header funnel or popover. Removing the popover MUST NOT remove the existing column-header sort affordance (sort remains accessible from the column header).

The bar MUST always be visible while a `postgres-table-data` tab is mounted; it MUST NOT auto-collapse on scroll. It MAY be collapsed manually by the user via a toggle (chevron) in the bar; the collapsed state MUST NOT discard any draft or applied filters.

The bar MUST contain, in order: a Mode toggle (Structured / Raw SQL), the body for the active mode (the conditions UI for Structured, the WHERE editor for Raw), and an action row with `Reset`, `Apply`, and `Open in SQL Editor`. The `Apply` button MUST be the rightmost primary control.

#### Scenario: Bar is the only filter surface

- **WHEN** the user opens a `postgres-table-data` tab
- **THEN** the filter bar is rendered above the data grid
- **AND** there is no funnel icon or filter popover trigger on any column header

#### Scenario: Sort affordance survives popover removal

- **WHEN** the user clicks a column header
- **THEN** the existing sort cycle (`asc → desc → none`) fires
- **AND** no filter popover is shown

#### Scenario: Collapsing the bar preserves state

- **WHEN** the bar has applied filters and the user toggles the bar collapsed, then expanded
- **THEN** all applied and draft filters are preserved exactly

### Requirement: Filter draft and applied state

`TableViewerTab` SHALL maintain two filter values for each tab: `draft` and `applied`. Only `applied` MUST be passed to `postgres_query_table` and `postgres_count_table`. Edits to the filter bar MUST update `draft` only. The bar MUST display a dirty indicator (a small `●` adjacent to the `Apply` button) whenever `draft` differs from `applied`. The bar MUST bind `Cmd+Enter` (macOS) / `Ctrl+Enter` (other) to "Apply" and `Esc` to "Discard draft" while focused. Pressing `Apply` MUST set `applied = draft`. Pressing `Reset` MUST set `draft` to the empty filter model AND set `applied` to the empty filter model in one update (clearing both at once). Discarding draft MUST set `draft = applied` (no fetch). Mode toggling rules are described under "Raw WHERE mode".

#### Scenario: Editing a row updates draft only

- **WHEN** the user adds a condition row and types into the value input
- **THEN** the bar dirty indicator becomes visible
- **AND** the data grid does NOT re-fetch
- **AND** `applied` is unchanged

#### Scenario: Apply commits draft and triggers fetch

- **WHEN** the user has a dirty draft and presses `Apply` (or `Cmd+Enter`)
- **THEN** `applied` becomes equal to `draft`
- **AND** the dirty indicator disappears
- **AND** `postgres.queryTable` is invoked with the new `applied` filters

#### Scenario: Esc discards draft to applied

- **WHEN** the user has a dirty draft and presses `Esc` while focused inside the bar
- **THEN** `draft` returns to the value of `applied`
- **AND** the dirty indicator disappears
- **AND** no fetch is triggered

#### Scenario: Reset clears both draft and applied

- **WHEN** the user has applied filters and presses `Reset`
- **THEN** both `draft` and `applied` become empty
- **AND** `postgres.queryTable` is invoked with no `filter_tree` and no `raw_where`

### Requirement: AND root with OR groups

The Structured filter model SHALL be a tree with an implicit `AND` root. Children of the root are either condition leaves or OR groups. An OR group MUST contain at least one condition leaf and MUST NOT contain another group (one level of nesting maximum). Removing the last condition from an OR group MUST collapse the group node out of the tree. The bar MUST expose two add affordances: `+ AND row` (adds a condition leaf as a sibling of root children) and `+ OR group` (adds an OR group with one empty condition row inside).

The compiled `WHERE` body MUST place each OR group in parentheses. An empty tree (no children) MUST result in no `WHERE` clause being emitted.

#### Scenario: Flat AND children compile to ANDed predicates

- **WHEN** the tree has three sibling condition leaves at root
- **THEN** the compiled WHERE is `<p1> AND <p2> AND <p3>` with no parens

#### Scenario: OR group compiles to a parenthesized OR

- **WHEN** the tree has one root condition and one OR group of two conditions
- **THEN** the compiled WHERE is `<p_root> AND (<p_or1> OR <p_or2>)`

#### Scenario: OR group with one condition still parenthesizes

- **WHEN** an OR group contains exactly one condition
- **THEN** the compiled WHERE wraps it as `(<p>)` (the parens make the boundary explicit; the result is semantically equivalent)

#### Scenario: Empty OR group is collapsed

- **WHEN** the user removes the last condition from an OR group
- **THEN** the OR group node is removed from the tree
- **AND** the compiled WHERE no longer contains it

#### Scenario: Cannot nest OR group inside OR group

- **WHEN** the frontend attempts to send a tree with an `or_group` inside another `or_group`
- **THEN** the backend returns `AppError::Validation` and no SQL is dispatched

#### Scenario: Empty tree emits no WHERE

- **WHEN** the user has no conditions and no OR groups
- **THEN** the issued SQL has no `WHERE` clause

### Requirement: Any column search

The Structured filter model SHALL accept a special `ColumnRef` `{ kind: "any_column" }` representing a search across every text-castable column of the relation. The frontend MUST surface "Any column" as the first option in the column picker. Operators allowed for `any_column` MUST be: `=`, `!=`, `LIKE`, `NOT LIKE`, `ILIKE`, `NOT ILIKE`, `Contains`, `StartsWith`, `EndsWith`. All other operators applied to `any_column` MUST be rejected by the backend with `AppError::Validation`.

The backend MUST expand an `any_column` condition by enumerating every column of the target relation whose `data_type` is text-castable (everything except `bytea` and composite/row types) and emitting:

```sql
(col1::text [op] $n OR col2::text [op] $n OR ...)
```

…where the same single bound parameter `$n` is shared across all branches. If the target relation has zero text-castable columns, the condition MUST compile to `FALSE`.

The frontend MUST display a small warning marker (e.g. a `⚠` icon with tooltip) on Any-column rows reading "Searches every text-castable column — slow on large tables."

#### Scenario: Any column with Contains expands across columns

- **WHEN** the user adds a condition `{ column: any_column, op: "Contains", value: "argus" }` against a relation with text-castable columns `name`, `email`, `notes`
- **THEN** the compiled WHERE is `("name"::text ILIKE '%' || $1 || '%' OR "email"::text ILIKE '%' || $1 || '%' OR "notes"::text ILIKE '%' || $1 || '%')`
- **AND** `$1 = "argus"`

#### Scenario: bytea and composite columns are skipped

- **WHEN** the relation has columns `name text`, `payload bytea`, `data my_composite_type`
- **AND** the user adds an Any-column condition
- **THEN** the compiled WHERE references only the `name` column

#### Scenario: Any column with disallowed operator is rejected

- **WHEN** the frontend forwards `{ column: any_column, op: "BETWEEN", value: { min: 1, max: 10 } }`
- **THEN** the command returns `AppError::Validation` and no SQL is dispatched

#### Scenario: Any column with no text-castable columns compiles to FALSE

- **WHEN** the relation has only `bytea` columns and the user adds an Any-column condition
- **THEN** the compiled WHERE is `(FALSE)`
- **AND** the query returns zero rows

#### Scenario: Any-column row shows a performance warning

- **WHEN** the user adds an Any-column condition row
- **THEN** the row renders a `⚠` icon with the tooltip "Searches every text-castable column — slow on large tables."

### Requirement: Raw WHERE mode

The filter bar SHALL include a Mode toggle with two options: `Structured` and `Raw SQL`. Switching modes MUST follow these rules:

- **Structured → Raw SQL:** The bar MUST seed the Raw editor with the result of the TS-side `compileWhere(draft)` (the equivalent SQL `WHERE` body for the current Structured draft). No data is lost.
- **Raw SQL → Structured:** The bar MUST display a confirmation dialog reading "Switch to structured? Your raw WHERE will be discarded." with `Cancel` (default) and `Switch` actions. On `Switch`, the Raw body MUST be cleared and the Structured tree MUST be reset to empty. On `Cancel`, the mode does not change.

The Raw editor MUST be a CodeMirror 6 instance configured with the Postgres SQL dialect for syntax highlighting only. It MUST NOT bind run shortcuts (`Cmd+Enter` is reserved for Apply at the bar level), MUST NOT enable autocomplete, and MUST NOT enforce a leading `WHERE` keyword (a leading `WHERE ` typed by the user MUST be trimmed once before being sent as `raw_where`). An empty Raw body MUST be sent as `raw_where: undefined` (no WHERE clause).

#### Scenario: Switching Structured to Raw seeds the editor

- **WHEN** the Structured draft compiles to `"country" = 'CL' AND ("status" = 'active' OR "status" = 'pending')`
- **AND** the user toggles to Raw SQL mode
- **THEN** the Raw editor is seeded with that exact body

#### Scenario: Switching Raw to Structured prompts before discarding

- **WHEN** the user has a non-empty Raw body and toggles to Structured
- **THEN** a confirm dialog is shown with `Cancel` as the default action
- **AND** Cancel keeps the mode as Raw and preserves the body
- **AND** Switch resets the Structured tree to empty AND clears the Raw body

#### Scenario: Empty Raw body sends no raw_where

- **WHEN** the user is in Raw mode with an empty editor and presses Apply
- **THEN** `postgres.queryTable` is invoked with `raw_where: undefined` and no `filter_tree`

#### Scenario: Leading WHERE keyword is trimmed

- **WHEN** the user types `WHERE created_at > now()` in the Raw editor and presses Apply
- **THEN** `raw_where` is sent as `"created_at > now()"` (the leading `WHERE ` is stripped once)
- **AND** the issued SQL has a single `WHERE created_at > now()` clause

#### Scenario: Postgres errors surface from Raw

- **WHEN** the user types a syntactically invalid WHERE (e.g. `created_at >`) and presses Apply
- **THEN** the command returns `AppError::Postgres` with the syntax error
- **AND** the bar surfaces the error inline near the Raw editor (not via a global toast)

### Requirement: Open in SQL Editor

The filter bar SHALL include an `Open in SQL Editor` action that opens a new `postgres-query` tab on the same connection with a prefilled SELECT reflecting the current `applied` filter set. The action MUST NOT require the user to apply pending draft changes first; if there is a dirty draft, the action uses `applied` (the drafted predicates are not opened). The generated SQL MUST be:

```
SELECT * FROM "<schema>"."<relation>"
[WHERE <where>]
[ORDER BY <orders>]
LIMIT <current_page_size>
```

Where:
- `<where>` is the TS-compiled WHERE body for `applied` (Structured) or the raw `applied.raw_where` body (Raw). If `applied` is empty, the WHERE clause is omitted.
- `<orders>` is the current ORDER BY for the tab's sort, comma-separated. Omitted when there is no active sort.
- `<current_page_size>` is the active per-table page size (the same value used by `useTableData`).

The new tab MUST be created via the existing `postgres-query` tab payload (`{ connectionId, connectionName, sql }`) and MUST be focused on creation.

#### Scenario: Empty applied opens a SELECT with no WHERE

- **WHEN** the user clicks "Open in SQL Editor" with no applied filters
- **THEN** a new `postgres-query` tab opens with `sql = 'SELECT * FROM "public"."users" LIMIT 200'` (no WHERE)
- **AND** the tab is focused

#### Scenario: Structured applied prefills a parameterless WHERE

- **WHEN** `applied.filter_tree` compiles to `"country" = 'CL' AND ("status" = 'active' OR "status" = 'pending')`
- **AND** the user clicks "Open in SQL Editor"
- **THEN** the prefilled SQL contains `WHERE "country" = 'CL' AND ("status" = 'active' OR "status" = 'pending')`
- **AND** the prefilled SQL has no `$n` placeholders (literals are inlined for display)

#### Scenario: Raw applied prefills the raw body

- **WHEN** `applied.raw_where = "created_at > now() - interval '7 days'"`
- **AND** the user clicks "Open in SQL Editor"
- **THEN** the prefilled SQL contains `WHERE created_at > now() - interval '7 days'`

#### Scenario: Active sort is included

- **WHEN** the tab has `order_by = [{ column: "created_at", direction: "desc" }]` and applied filters
- **THEN** the prefilled SQL includes `ORDER BY "created_at" DESC` after the WHERE

#### Scenario: Dirty draft does not influence the prefill

- **WHEN** the user has a dirty draft (different from applied) and clicks "Open in SQL Editor"
- **THEN** the prefilled SQL reflects `applied`, not `draft`
