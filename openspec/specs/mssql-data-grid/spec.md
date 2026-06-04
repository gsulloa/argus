# mssql-data-grid Specification

## Purpose
TBD - created by archiving change add-mssql-support. Update Purpose after archive.
## Requirements
### Requirement: Query table command

The MS SQL Server module SHALL expose a Tauri command `mssql_query_table(id, schema, relation, options, origin?)` that executes a paginated `SELECT` against a table or view and returns the rows together with the column metadata. The `options` payload MUST accept `{ limit: number, offset: number, order_by?: Array<{ column: string, direction: "ASC" | "DESC" }>, filter?: FilterTree }` (snake_case keys). The `limit` MUST be capped at 5000; values above 5000 MUST be silently clamped to 5000 and the response MUST reflect the clamped value in `applied.limit`. The default `limit` when unspecified is 1000. If `filter` is not provided, no `WHERE` clause is emitted. The optional `origin` argument MUST be `"user"` or `"auto"` and defaults to `"auto"` when absent; it is forwarded verbatim into the activity-log event for this command. The response payload MUST be `{ columns: Array<{ name: string, data_type: string, ordinal_position: number, is_nullable: boolean }>, rows: Array<Array<Value>>, applied: { limit: number, offset: number, order_by, filter }, query_ms: number, truncated: boolean }`. Rows MUST be returned as JSON-serializable arrays in the same order as `columns`. All generated SQL MUST quote schema, relation, and column identifiers with square brackets (e.g. `[sales].[orders]`); embedded `]` characters MUST be escaped by doubling (e.g. `a]b` → `[a]]b]`). All filter parameters MUST be bound using `@P1, @P2, ...` named-positional placeholders — the backend MUST NOT use `?` or `$N` placeholders anywhere. The command MUST acquire a connection from the existing pool registry, MUST quote the schema/relation/column identifiers safely, and MUST NOT open a new connection. The command MUST execute through the read-only-aware `executeQuery` path (it never mutates state). The command MUST enforce a 15-second statement timeout on the underlying query; on timeout the command MUST return an `AppError::Mssql` with `code: None` (cancellation surfaced through the TDS Attention path) and a message indicating the query was cancelled. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "query_table"`, `kind_namespace: "mssql"`, `connection_id: <id>`, `origin: <origin argument>`, `sql: <issued SELECT text>`, `params: <bind params, Debug-formatted, each truncated to 200 chars>`, `metric: { kind: "rows", value: <returned row count> }` on success (`null` on failure), and `status` matching the result. Frontend call sites that initiate the command in response to a user gesture (opening a table, paging, refreshing, sort/filter changes) MUST pass `origin: "user"`; internal pre-fetches MUST pass `origin: "auto"` (or omit the argument).

#### Scenario: Default page returns up to limit rows in declared order

- **WHEN** the user invokes `mssql.queryTable(id, "sales", "orders", { limit: 200, offset: 0 })`
- **THEN** the response contains up to 200 rows ordered by the relation's primary key ascending (the fallback when no user-supplied order is present)
- **AND** the `columns` array describes every column in `INFORMATION_SCHEMA.COLUMNS.ORDINAL_POSITION` order
- **AND** `applied.limit === 200` and `applied.offset === 0`
- **AND** the issued SQL contains no `WHERE` clause

#### Scenario: Limit is clamped at 5000

- **WHEN** the user invokes `mssql.queryTable` with `limit: 10000`
- **THEN** the issued SQL contains `OFFSET 0 ROWS FETCH NEXT 5000 ROWS ONLY`
- **AND** `applied.limit === 5000`

#### Scenario: Default limit is 1000 when omitted

- **WHEN** the user invokes `mssql.queryTable` without supplying `limit`
- **THEN** the issued SQL contains `FETCH NEXT 1000 ROWS ONLY`
- **AND** `applied.limit === 1000`

#### Scenario: Order by single column descending

- **WHEN** the user invokes `mssql.queryTable(id, "sales", "orders", { limit: 200, offset: 0, order_by: [{ column: "created_at", direction: "DESC" }] })`
- **THEN** the issued SQL contains `ORDER BY [created_at] DESC OFFSET 0 ROWS FETCH NEXT 200 ROWS ONLY`
- **AND** the rows are ordered by `created_at` descending

#### Scenario: Multi-column sort respects array order

- **WHEN** the user invokes `mssql.queryTable` with `order_by: [{ column: "country", direction: "ASC" }, { column: "created_at", direction: "DESC" }]`
- **THEN** the issued SQL contains `ORDER BY [country] ASC, [created_at] DESC`
- **AND** rows are sorted first by `country` ascending and then by `created_at` descending

#### Scenario: No user order falls back to primary key ascending

- **WHEN** the user invokes `mssql.queryTable` on a relation that has a primary key `(id)` and does not supply an `order_by`
- **THEN** the issued SQL contains `ORDER BY [id] ASC OFFSET ... ROWS FETCH NEXT ... ROWS ONLY`

#### Scenario: Heap table with no primary key falls back to SELECT NULL

- **WHEN** the user invokes `mssql.queryTable` on a heap table (no PK, no clustered index) and does not supply an `order_by`
- **THEN** the issued SQL contains `ORDER BY (SELECT NULL) OFFSET ... ROWS FETCH NEXT ... ROWS ONLY`
- **AND** the query succeeds and returns rows

#### Scenario: filter compiles to WHERE with AND root and @P placeholders

- **WHEN** the user invokes `mssql.queryTable` with `filter: { rows: [{ enabled: true, column: { kind: "named", name: "country" }, op: "=", value: "CL" }, { enabled: true, column: { kind: "named", name: "deleted_at" }, op: "IS NULL" }], combinator: "AND" }`
- **THEN** the issued SQL has a `WHERE [country] = @P1 AND [deleted_at] IS NULL` clause
- **AND** the bound parameter list is `[("@P1", "CL")]`
- **AND** the response contains only rows matching both predicates

#### Scenario: Identifiers are quoted with square brackets, never interpolated

- **WHEN** the user requests a relation whose name contains a `]` (e.g. `we]ird`)
- **THEN** the issued SQL escapes the identifier as `[we]]ird]` using the standard bracket-doubling rule
- **AND** the command does not concatenate the identifier into the SQL via plain string interpolation

#### Scenario: Read-only connection still serves queries

- **WHEN** the user invokes `mssql.queryTable` against a connection whose pool is in `read_only` mode
- **THEN** the command succeeds and returns rows (this command does not mutate state)

#### Scenario: Unknown relation returns invalid object name

- **WHEN** the user invokes `mssql.queryTable(id, "sales", "does_not_exist", { limit: 200, offset: 0 })`
- **THEN** the command returns `AppError::Mssql { code: Some(208), ... }` (SQL Server error number for `Invalid object name`)

#### Scenario: Query timeout surfaces cancellation

- **WHEN** the underlying query runs for longer than 15 seconds
- **THEN** the backend cancels the query via TDS Attention and the command returns `AppError::Mssql { code: None, message: "query cancelled", ... }`

#### Scenario: User-initiated call carries origin user in the activity log

- **WHEN** the data-grid call site invokes `mssql.queryTable` with `origin: "user"` for the initial open of a table
- **THEN** the emitted `argus:activity-log` event has `origin: "user"`, `kind: "query_table"`, `kind_namespace: "mssql"`, `sql` containing the SELECT, `params` matching the bound values, `metric: { kind: "rows", value: <row count> }`

#### Scenario: Origin defaults to auto when omitted

- **WHEN** any caller invokes `mssql.queryTable` without supplying the `origin` argument
- **THEN** the emitted `argus:activity-log` event has `origin: "auto"`

#### Scenario: Failed query emits an entry with truncated SQL/params and code

- **WHEN** `mssql.queryTable` is invoked against `[sales].[does_not_exist]` and SQL Server returns error 208
- **THEN** one `argus:activity-log` event is emitted with `kind: "query_table"`, `kind_namespace: "mssql"`, `status: "err"`, `error.code: 208`, `sql` populated with the attempted SELECT, `metric: null`

### Requirement: Filter operator set

The structured filter payload accepted by `mssql_query_table` (and `mssql_count_table`) SHALL be a `FilterTree` defined as `{ rows: FilterRow[], combinator: "AND" | "OR" }`. A `FilterRow` MUST be `{ enabled: boolean, column: ColumnRef, op: Operator, value?: Value | Array<Value> | { min: Value, max: Value }, case_insensitive?: boolean }`. A `ColumnRef` is `{ kind: "named", name: string }` or `{ kind: "any_column" }`.

The `Operator` set MUST be exactly: `=`, `!=`, `<`, `<=`, `>`, `>=`, `LIKE`, `NOT LIKE`, `CONTAINS`, `STARTS_WITH`, `ENDS_WITH`, `IN`, `NOT IN`, `BETWEEN`, `IS NULL`, `IS NOT NULL`. The backend MUST reject any other operator (including `ILIKE` and `NOT ILIKE`, which are not valid SQL Server operators) with `AppError::Validation`.

Per-operator value rules:

- `=`, `!=`, `<`, `<=`, `>`, `>=`, `LIKE`, `NOT LIKE` — `value` is a single bound parameter passed verbatim with placeholder `@PN`. The user supplies their own `%` for `LIKE` / `NOT LIKE`.
- `CONTAINS` — compiles to `[col] LIKE '%' + @PN + '%'`. `value` is bound verbatim (no escaping of `%` / `_` / `[` in v1).
- `STARTS_WITH` — compiles to `[col] LIKE @PN + '%'`.
- `ENDS_WITH` — compiles to `[col] LIKE '%' + @PN`.
- `IN`, `NOT IN` — `value` MUST be a non-empty array of scalars. Compiles to `IN (@P1, @P2, ...)` / `NOT IN (@P1, @P2, ...)` with each element bound to its own `@PN`. Empty arrays MUST be rejected with `AppError::Validation`.
- `BETWEEN` — `value` MUST be `{ min, max }`. Compiles to `BETWEEN @P1 AND @P2`. Inclusive on both bounds.
- `IS NULL`, `IS NOT NULL` — `value` MUST be absent. Providing one MUST be rejected.

The `case_insensitive` flag on a row applies only when `op` is `LIKE`, `NOT LIKE`, `CONTAINS`, `STARTS_WITH`, or `ENDS_WITH`. When `case_insensitive === true` the backend MUST wrap the column reference and the parameter in `LOWER(...)`:

- `LIKE` with `case_insensitive` → `LOWER([col]) LIKE LOWER(@PN)`
- `NOT LIKE` with `case_insensitive` → `LOWER([col]) NOT LIKE LOWER(@PN)`
- `CONTAINS` with `case_insensitive` → `LOWER([col]) LIKE LOWER('%' + @PN + '%')`
- `STARTS_WITH` with `case_insensitive` → `LOWER([col]) LIKE LOWER(@PN + '%')`
- `ENDS_WITH` with `case_insensitive` → `LOWER([col]) LIKE LOWER('%' + @PN)`

When `case_insensitive` is absent or `false`, the operator MUST compile to the plain form, relying on the column's effective collation (the SQL Server default `SQL_Latin1_General_CP1_CI_AS` and most `_CI_*` collations are case-insensitive).

The `case_insensitive` flag MUST be ignored for every other operator.

Per-column-type rules in the frontend:

- Numeric/date/time/datetime/datetime2/datetimeoffset/smalldatetime/money/smallmoney columns: surface `=`, `!=`, `<`, `<=`, `>`, `>=`, `BETWEEN`, `IN`, `NOT IN`, plus `IS NULL` / `IS NOT NULL` if nullable.
- Text columns (`CHAR`, `VARCHAR`, `TEXT`, `NCHAR`, `NVARCHAR`, `NTEXT`): surface `=`, `!=`, `LIKE`, `NOT LIKE`, `CONTAINS`, `STARTS_WITH`, `ENDS_WITH`, `IN`, `NOT IN`, plus null variants if nullable. Each `LIKE`/`CONTAINS`/`STARTS_WITH`/`ENDS_WITH` row MUST expose a "case-insensitive" toggle (default unchecked) that controls the `case_insensitive` flag in the wire payload.
- Boolean columns (`BIT`): surface `=`, `!=`, plus null variants.
- JSON columns (SQL Server 2025+ native `JSON` type): surface `=`, `!=`, plus null variants. (Path-based predicates are out of scope for v1.)
- `UNIQUEIDENTIFIER`: surface `=`, `!=`, `IN`, `NOT IN`, plus null variants.
- `XML`: surface `=`, `!=`, plus null variants. (XPath predicates are out of scope for v1.)
- Other types (`BINARY`, `VARBINARY`, `IMAGE`, `ROWVERSION`, `GEOMETRY`, `GEOGRAPHY`, `HIERARCHYID`, `SQL_VARIANT`): surface `=`, `!=`, `IN`, `NOT IN`, plus null variants.

The frontend MUST NOT expose `ILIKE` or `NOT ILIKE` as operators on MS SQL Server connections. The case-insensitive escape hatch is the toggle above. Values MUST be passed as bound parameters in Structured mode, never interpolated. The frontend MUST surface every operator from the filter bar (not from a per-column header popover; see "Filter bar surface").

#### Scenario: Unknown operator is rejected

- **WHEN** the frontend forwards a condition with `op: "DROP"` (out of the allowed set)
- **THEN** the command returns `AppError::Validation` with a message naming the offending operator
- **AND** no SQL is dispatched to SQL Server

#### Scenario: ILIKE operator is rejected

- **WHEN** the frontend forwards a condition with `op: "ILIKE"` against a MS SQL Server connection
- **THEN** the command returns `AppError::Validation { message: "operator 'ILIKE' is not supported for MS SQL Server; use LIKE with case_insensitive: true" }`
- **AND** no SQL is dispatched to SQL Server

#### Scenario: BETWEEN binds two parameters

- **WHEN** the user filters `created_at BETWEEN '2026-01-01' AND '2026-04-30'` via `{ op: "BETWEEN", value: { min: "2026-01-01", max: "2026-04-30" } }`
- **THEN** the issued SQL contains `WHERE [created_at] BETWEEN @P1 AND @P2` with both bounds bound as parameters
- **AND** rows whose `created_at` equals either bound are included

#### Scenario: CONTAINS without case_insensitive uses default collation

- **WHEN** the user filters with `{ column: { kind: "named", name: "name" }, op: "CONTAINS", value: "ana" }` and `case_insensitive` is absent
- **THEN** the issued SQL is `WHERE [name] LIKE '%' + @P1 + '%'` with the bound parameter `"ana"`
- **AND** matches honor the column's effective collation (case-insensitive by default for typical `_CI_*` collations)

#### Scenario: CONTAINS with case_insensitive forces LOWER

- **WHEN** the user filters with `{ column: { kind: "named", name: "name" }, op: "CONTAINS", value: "ana", case_insensitive: true }`
- **THEN** the issued SQL is `WHERE LOWER([name]) LIKE LOWER('%' + @P1 + '%')` with the bound parameter `"ana"`
- **AND** the match is case-insensitive regardless of the column's collation

#### Scenario: STARTS_WITH compiles to LIKE with trailing wildcard

- **WHEN** the user filters with `{ column: { kind: "named", name: "email" }, op: "STARTS_WITH", value: "admin" }`
- **THEN** the issued SQL is `WHERE [email] LIKE @P1 + '%'` with the bound parameter `"admin"`

#### Scenario: ENDS_WITH compiles to LIKE with leading wildcard

- **WHEN** the user filters with `{ column: { kind: "named", name: "email" }, op: "ENDS_WITH", value: "@example.com" }`
- **THEN** the issued SQL is `WHERE [email] LIKE '%' + @P1` with the bound parameter `"@example.com"`

#### Scenario: IN binds N parameters

- **WHEN** the user filters with `{ column: { kind: "named", name: "status" }, op: "IN", value: ["active", "pending", "trial"] }`
- **THEN** the issued SQL is `WHERE [status] IN (@P1, @P2, @P3)` with bound parameters `["active", "pending", "trial"]`

#### Scenario: Empty IN array is rejected

- **WHEN** the user forwards `{ op: "IN", value: [] }`
- **THEN** the command returns `AppError::Validation` and no SQL is dispatched

#### Scenario: IS NULL with a value is rejected

- **WHEN** the user forwards `{ op: "IS NULL", value: "x" }`
- **THEN** the command returns `AppError::Validation` and no SQL is dispatched

### Requirement: Count rows command

The MS SQL Server module SHALL expose a Tauri command `mssql_count_table(id, schema, relation, options?, origin?)` that returns `{ exact: number, approximate: boolean, query_ms: number }` describing the row count of the relation under the optional filter. The `options` payload MAY include only a `filter` field (same shape as `mssql_query_table`'s `filter`); `limit`, `offset`, and `order_by` MUST be ignored if supplied. The optional `origin` argument MUST be `"user"` or `"auto"` and defaults to `"auto"`.

When no `filter` is provided (or `filter.rows` is empty after dropping disabled/incomplete rows), the command MUST first attempt the cheap approximate path: read `SUM(row_count)` from `sys.dm_db_partition_stats` joined to `sys.objects` / `sys.schemas` for the given `(schema, relation)` restricted to `index_id IN (0, 1)` (heap or clustered index) and return `{ exact: <approx_rows>, approximate: true }`. If the row is missing or zero (e.g. the relation is a view, or the user lacks `VIEW DATABASE STATE`), the command MUST fall back to `SELECT COUNT_BIG(*) FROM [schema].[relation]` and return `{ exact: <count>, approximate: false }`.

When a `filter` is provided, the command MUST always issue `SELECT COUNT_BIG(*) FROM [schema].[relation] WHERE <compiled_where>` with `@PN` parameters bound the same way as `mssql_query_table`, and MUST return `{ exact: <count>, approximate: false }`.

The frontend MUST NOT call this command implicitly; it MUST fire only on user activation of the "Count rows" button, and that call site MUST pass `origin: "user"`. The command MUST enforce a 15-second statement timeout; on timeout it MUST return `AppError::Mssql { code: None, message: "query cancelled", ... }`. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "count_table"`, `kind_namespace: "mssql"`, `connection_id: <id>`, `origin: <origin argument>`, `sql: <issued COUNT or sys.dm_db_partition_stats text>`, `params: <bind params, Debug-formatted>`, `metric: { kind: "count", value: <returned count>, approximate: <bool> }` on success (`null` on failure), and `status` matching the result.

#### Scenario: Unfiltered count uses sys.dm_db_partition_stats approximate

- **WHEN** the user clicks "Count rows" on `sales.orders` with no filter
- **THEN** the command issues a SELECT against `sys.dm_db_partition_stats` joined to `sys.objects`/`sys.schemas` filtered on `(SCHEMA_NAME, OBJECT_NAME)` and `index_id IN (0, 1)` with parameters `["sales", "orders"]`
- **AND** the response is `{ exact: <approx>, approximate: true, query_ms: ... }`
- **AND** the bottom-bar count indicator surfaces the value with an approximate marker (e.g. `~`)

#### Scenario: Unfiltered count on a view falls back to COUNT_BIG(\*)

- **WHEN** the user clicks "Count rows" on a view `sales.daily_orders` with no filter and `sys.dm_db_partition_stats` returns zero rows for that object
- **THEN** the command issues `SELECT COUNT_BIG(*) FROM [sales].[daily_orders]`
- **AND** the response is `{ exact: <count>, approximate: false, query_ms: ... }`

#### Scenario: Filtered count uses exact COUNT_BIG(\*)

- **WHEN** the user has filters `{ country = 'CL', deleted_at IS NULL }` active and clicks "Count rows"
- **THEN** the command issues `SELECT COUNT_BIG(*) FROM [sales].[orders] WHERE [country] = @P1 AND [deleted_at] IS NULL` with bound parameter `["CL"]`
- **AND** the response is `{ exact: <count>, approximate: false, query_ms: ... }`
- **AND** the bar shows the exact count next to the per-page count

#### Scenario: Count ignores limit, offset, and order_by

- **WHEN** the user invokes `mssql.countTable` with `options: { limit: 50, offset: 100, order_by: [{ column: "id", direction: "ASC" }], filter: <f> }`
- **THEN** the issued SQL has no `OFFSET`, no `FETCH NEXT`, and no `ORDER BY`
- **AND** the count reflects all rows matching `<f>` in the relation

#### Scenario: Count is on demand, never automatic

- **WHEN** the user opens a table tab without clicking "Count rows"
- **THEN** the bar shows `Showing X rows · Page Y` and a `Count rows` button, but no total count and no implicit count call is dispatched

#### Scenario: User-initiated count emits origin user and approximate flag

- **WHEN** the user clicks "Count rows" with no active filter and the command returns `{ exact: 12345, approximate: true }`
- **THEN** one `argus:activity-log` event is emitted with `kind: "count_table"`, `kind_namespace: "mssql"`, `origin: "user"`, `status: "ok"`, `metric: { kind: "count", value: 12345, approximate: true }`

#### Scenario: Failing count emits an entry with error

- **WHEN** the count fails because the relation no longer exists
- **THEN** one `argus:activity-log` event is emitted with `kind: "count_table"`, `status: "err"`, `error.code: 208`, `metric: null`

### Requirement: Per-table viewer tab

The frontend SHALL register a tab kind `mssql-table-data` and SHALL render it when the user activates a table or view in the schema tree. The tab's payload MUST be `{ connectionId, connectionName, schema, relation, relationKind: "table" | "view" }`. There is no materialized-view variant — SQL Server has indexed views but they appear as views with `IS_INDEXED=true`; they MUST be surfaced with `relationKind: "view"` and a sub-flag, not a separate kind. The tab MUST have a stable id `mstbl:<connectionId>:<schema>:<relation>` so that re-activating the same node focuses the existing tab rather than opening a duplicate. Activating any other object kind (procedure, function, trigger, index, sequence) MUST continue to open the existing `mssql-object-placeholder` tab. The viewer tab MUST persist its scroll position across tab switches inside the same session (not across app restarts).

The viewer tab body SHALL render an internal sub-tabset with three tabs in this order: **Data**, **Structure**, **Raw**. The sub-tabset header MUST be a segmented control rendered above the body of all three subtabs and MUST be visible regardless of which subtab is active. Only one subtab is rendered at a time.

The Data subtab MUST host the data UI (filter bar, virtualized data grid, inspector, bottom bar, edit affordances). The Structure and Raw subtabs MUST be rendered by components owned by the `mssql-table-structure` capability and receive `{ connectionId, schema, relation, relationKind }` as props.

The active subtab is per-tab in-memory state with these rules:

- A freshly opened table tab MUST start on **Data**.
- Switching to a different browser tab and back to the table tab MUST preserve the active subtab.
- Closing and reopening the table tab MUST reset the active subtab to **Data** (no persistence across tab close).
- The active subtab MUST NOT be persisted across app restarts.

While the table tab is focused AND the keyboard focus is not inside an `<input>`, `<textarea>`, or a CodeMirror editor, the following keyboard shortcuts MUST be active:

- `Cmd+1` (macOS) / `Ctrl+1` (other) → activate **Data**.
- `Cmd+2` / `Ctrl+2` → activate **Structure**.
- `Cmd+3` / `Ctrl+3` → activate **Raw**.

Switching subtabs MUST NOT trigger a `mssql_query_table`, `mssql_count_table`, or any data-grid fetch.

#### Scenario: Activating a table opens the data viewer

- **WHEN** the user activates the table node `sales.orders`
- **THEN** a center-area tab of kind `mssql-table-data` opens with payload `{ connectionId, connectionName, schema: "sales", relation: "orders", relationKind: "table" }`
- **AND** the placeholder tab is NOT opened
- **AND** the active subtab is **Data**

#### Scenario: Activating a view opens the data viewer

- **WHEN** the user activates a view node
- **THEN** the same `mssql-table-data` tab opens with `relationKind: "view"`
- **AND** the active subtab is **Data**

#### Scenario: Indexed views surface as views with a sub-flag

- **WHEN** the schema browser surfaces an indexed view
- **THEN** the node carries `relationKind: "view"` (not a separate kind)
- **AND** an in-payload sub-flag (e.g. `indexed: true`) is exposed for downstream rendering

#### Scenario: Activating a procedure still opens the placeholder

- **WHEN** the user activates a procedure, function, trigger, index, or sequence node
- **THEN** the existing `mssql-object-placeholder` tab opens (this change does not implement those viewers)

#### Scenario: Reactivation focuses the existing tab

- **WHEN** the user activates the same table node a second time
- **THEN** the existing `mssql-table-data` tab is focused and no new tab is opened

#### Scenario: Sub-tabset header is always visible

- **WHEN** the table tab is open on any subtab
- **THEN** the segmented Data / Structure / Raw control is rendered at the top of the viewer body

#### Scenario: Switching subtabs does not refetch data

- **WHEN** the Data subtab has loaded rows and the user clicks **Structure**
- **THEN** no new `mssql_query_table` invocation is dispatched
- **AND** when the user clicks **Data** again, the previously buffered rows and scroll position are still in place

### Requirement: Result value serialization by MS SQL Server type

When `mssql_query_table` returns rows, the backend SHALL serialize each cell to JSON according to the column's SQL Server data type. The mapping MUST be:

- `BIT` → JSON boolean (this is the canonical boolean type in SQL Server; there is no `TINYINT(1)` convention because `TINYINT` is unsigned 0–255)
- `TINYINT` → JSON number (unsigned 0–255)
- `SMALLINT`, `INT` / `INTEGER` → JSON number
- `BIGINT` → JSON number when the value fits within the IEEE-754 safe-integer range `[-(2^53 - 1), 2^53 - 1]`; otherwise JSON string preserving full precision (mirrors Postgres `int8` handling)
- `DECIMAL` / `NUMERIC` / `MONEY` / `SMALLMONEY` → JSON string preserving precision (never JSON number)
- `FLOAT` → JSON number
- `REAL` → JSON number
- `CHAR`, `VARCHAR`, `TEXT`, `NCHAR`, `NVARCHAR`, `NTEXT` → JSON string
- `BINARY`, `VARBINARY`, `IMAGE` → JSON string containing the base64 encoding of the raw bytes
- `ROWVERSION` / `TIMESTAMP` (the SQL Server system type, NOT the MySQL `TIMESTAMP`) → JSON string containing the base64 encoding of the 8-byte binary value
- `DATE` → ISO 8601 date string `"YYYY-MM-DD"`
- `TIME` → string `"HH:MM:SS"`, or `"HH:MM:SS.fffffff"` when the column carries fractional-second precision (up to 7 digits)
- `DATETIME` / `DATETIME2` / `SMALLDATETIME` → ISO 8601 string without timezone (e.g. `"2026-05-20T14:30:00"`), with fractional seconds when the column defines them
- `DATETIMEOFFSET` → ISO 8601 string with `±HH:MM` offset preserved exactly as stored on the server (e.g. `"2026-05-20T14:30:00-03:00"`); the backend MUST NOT normalize the value to UTC
- `UNIQUEIDENTIFIER` → canonical lowercase string `"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"`
- `XML` → JSON string containing the XML text verbatim (no DOM serialization)
- `JSON` (SQL Server 2025+ native JSON type) → the parsed JSON value verbatim (object, array, number, string, boolean, or null). The backend MUST NOT double-stringify a JSON column's value.
- `GEOMETRY` / `GEOGRAPHY` → JSON string containing the WKT representation produced by `<column>.STAsText()` (the backend MUST rewrite the `SELECT` projection to call `.STAsText()` on these columns); decode-only — writes to these columns are not supported in v1
- `HIERARCHYID` → JSON string produced by `<column>.ToString()`; decode-only — writes to these columns are not supported in v1
- `SQL_VARIANT` → JSON string produced by `CONVERT(NVARCHAR(MAX), <column>)`; best-effort coercion only
- Any other / unknown column type → JSON string (raw text as returned by the driver)

`NULL` for every column type MUST serialize to JSON `null`.

The `columns[].data_type` field returned to the frontend MUST be the canonical lowercase type name as reported by `INFORMATION_SCHEMA.COLUMNS.DATA_TYPE`, with parameterized modifiers stripped (e.g. `varchar(255)` → `varchar`, `decimal(10,2)` → `decimal`, `datetime2(3)` → `datetime2`).

#### Scenario: BIT serializes as boolean

- **WHEN** a row has a `is_active BIT` column with value 1
- **THEN** the JSON cell value is `true`
- **AND** a value of 0 serializes to `false`

#### Scenario: TINYINT serializes as JSON number (not boolean)

- **WHEN** a row has a `flag TINYINT` column with value 1
- **THEN** the JSON cell value is the number `1` (NOT `true` — `TINYINT` is unsigned 0–255 in SQL Server, not a boolean type)

#### Scenario: BIGINT within safe-integer range serializes as number

- **WHEN** a row has a `id BIGINT` column with value 9007199254740991
- **THEN** the JSON cell value is the number `9007199254740991`

#### Scenario: BIGINT outside safe-integer range serializes as string

- **WHEN** a row has a `id BIGINT` column with value 9223372036854775000
- **THEN** the JSON cell value is the string `"9223372036854775000"`

#### Scenario: DECIMAL serializes as string preserving precision

- **WHEN** a row has a `price DECIMAL(10,2)` column with value 19.99
- **THEN** the JSON cell value is the string `"19.99"` (not the number `19.99`)

#### Scenario: MONEY serializes as string

- **WHEN** a row has a `total MONEY` column with value 19.9900
- **THEN** the JSON cell value is the string `"19.9900"` (preserving the MONEY precision)

#### Scenario: DATETIME2 serializes as ISO 8601 without timezone

- **WHEN** a row has a `recorded_at DATETIME2(3)` column with value `2026-05-20 14:30:00.123`
- **THEN** the JSON cell value is the string `"2026-05-20T14:30:00.123"` (no trailing `Z`)

#### Scenario: DATETIMEOFFSET preserves the stored offset

- **WHEN** a row has a `event_at DATETIMEOFFSET` column with value `2026-05-20 14:30:00 -03:00`
- **THEN** the JSON cell value is the string `"2026-05-20T14:30:00-03:00"`
- **AND** the backend does NOT normalize the value to UTC

#### Scenario: UNIQUEIDENTIFIER serializes as canonical lowercase

- **WHEN** a row has a `id UNIQUEIDENTIFIER` column with value `0BCDEF12-3456-7890-ABCD-EF1234567890`
- **THEN** the JSON cell value is the string `"0bcdef12-3456-7890-abcd-ef1234567890"`

#### Scenario: JSON column round-trips as parsed value

- **WHEN** a row has a `payload JSON` column (SQL Server 2025+) with stored value `{"foo": [1, 2, 3]}`
- **THEN** the JSON cell value is the object `{"foo": [1, 2, 3]}` (parsed, not double-stringified)

#### Scenario: VARBINARY serializes as base64 string

- **WHEN** a row has a `data VARBINARY(MAX)` column with raw bytes `[0xDE, 0xAD, 0xBE, 0xEF]`
- **THEN** the JSON cell value is the string `"3q2+7w=="` (base64 of the bytes)

#### Scenario: ROWVERSION serializes as base64

- **WHEN** a row has a `ver ROWVERSION` column with the 8-byte binary value `0x00000000000007D0`
- **THEN** the JSON cell value is the base64 encoding of those 8 bytes

#### Scenario: GEOMETRY column serializes as WKT

- **WHEN** a row has a `location GEOMETRY` column representing `POINT(-70.6 -33.4)`
- **THEN** the backend rewrites the SELECT to project `[location].STAsText() AS [location]`
- **AND** the JSON cell value is the string `"POINT (-70.6 -33.4)"`

#### Scenario: HIERARCHYID serializes via ToString

- **WHEN** a row has a `path HIERARCHYID` column with value `/1/3/`
- **THEN** the backend rewrites the SELECT to project `[path].ToString() AS [path]`
- **AND** the JSON cell value is the string `"/1/3/"`

#### Scenario: XML column serializes as string

- **WHEN** a row has a `body XML` column with stored value `<root><a>1</a></root>`
- **THEN** the JSON cell value is the string `"<root><a>1</a></root>"`

#### Scenario: SQL_VARIANT serializes via CONVERT NVARCHAR

- **WHEN** a row has a `meta SQL_VARIANT` column holding an `INT 42`
- **THEN** the backend rewrites the SELECT to project `CONVERT(NVARCHAR(MAX), [meta]) AS [meta]`
- **AND** the JSON cell value is the string `"42"`

#### Scenario: NULL across all types

- **WHEN** any column for a given row is `NULL`
- **THEN** the JSON cell value is `null`

### Requirement: Per-cell value truncation cap

The MS SQL Server data-grid backend SHALL enforce a 1 MiB (1,048,576 byte) cap on the serialized size of each individual cell value returned by `mssql_query_table`. The cap MUST be evaluated per cell, NOT per row — each column is counted independently and a large value in one column MUST NOT cause other columns of the same row to be truncated. When a cell's serialized representation exceeds the cap, the backend MUST replace the cell's JSON value with a snake_case envelope `{ "truncated": true, "size": <original_byte_count>, "preview": "<first 1 KiB of the serialized form as a UTF-8-safe string>" }` and MUST set the response's top-level `truncated` field to `true` for the page. When no cells are truncated, the response's top-level `truncated` field MUST be `false`. The cap MUST apply uniformly to text, binary (post-base64), JSON, XML, and geometry/geography columns.

#### Scenario: Large NVARCHAR cell is truncated with envelope

- **WHEN** a row has a `content NVARCHAR(MAX)` column whose UTF-8 byte length is 2 MiB
- **THEN** the JSON cell value is `{ "truncated": true, "size": 2097152, "preview": "<first 1024 bytes as UTF-8-safe string>" }`
- **AND** the response's top-level `truncated` field is `true`

#### Scenario: Truncation is per-cell, not per-row

- **WHEN** a row has one 2 MiB `content` cell and a 32-byte `email` cell
- **THEN** the `content` cell is replaced by the truncation envelope
- **AND** the `email` cell is returned in full
- **AND** the response's top-level `truncated` field is `true`

#### Scenario: Page with no truncated cells reports truncated false

- **WHEN** every cell on the page is below 1 MiB
- **THEN** the response's top-level `truncated` field is `false`
- **AND** no cell carries the truncation envelope

#### Scenario: Large VARBINARY is truncated post-base64

- **WHEN** a row has a `data VARBINARY(MAX)` whose base64 encoding exceeds 1 MiB
- **THEN** the cell is replaced by the truncation envelope and the `size` field reflects the base64 byte length

### Requirement: Inspector panel

The viewer SHALL render an inspector panel pinned to the right of the grid. When a row is selected, the inspector MUST list every column from the response's `columns` array as a field showing `column name (data_type) → value`. Columns whose value was returned with `{ truncated: true, size }` MUST display the preview plus the original byte count (formatted as `KB`/`MB`). Long text values in the inspector MUST be scrollable inside their field, not truncated. When the column type is `JSON` (SQL Server 2025+) or `XML`, the inspector MUST render the parsed value as a collapsible tree (object/array nodes expandable for JSON; element/attribute nodes expandable for XML). For binary types (`BINARY` / `VARBINARY` / `IMAGE` / `ROWVERSION`), the inspector MUST display the encoding as `base64` next to the field label. When no row is selected, the inspector MUST display a hint such as "Select a row to inspect". The inspector MUST be horizontally resizable by dragging its left edge; the width MUST persist under `msInspectorWidth` (a single global setting, not per-table) with a sensible minimum (e.g. 280px).

When the viewer is in editable mode, the inspector MUST reflect the buffer's dirty state for the selected row: cells that have been edited in the buffer MUST display the dirty value (not the server value), with a visual marker indicating the field is dirty. Editing inside the inspector MUST be supported as an alternative to inline grid editing for non-PK columns; changes commit to the buffer the same way (no direct DB writes). PK columns of existing rows MUST remain read-only in the inspector. Truncated/binary cells MUST remain read-only in the inspector regardless of mode. Cells of type `GEOMETRY`, `GEOGRAPHY`, `HIERARCHYID`, and `SQL_VARIANT` MUST be read-only in the inspector (v1 does not support writes for those types).

#### Scenario: Selecting a row populates the inspector

- **WHEN** the user clicks any row in the grid
- **THEN** the inspector lists every column with its data type and value

#### Scenario: Truncated values show preview and byte length

- **WHEN** a column was returned as `{ truncated: true, size: 5300, preview: "..." }`
- **THEN** the inspector field shows the preview plus a label like `5.2 KB`

#### Scenario: JSON column renders as expandable tree

- **WHEN** a `payload JSON` column (SQL Server 2025+) has a nested object value
- **THEN** the inspector renders the JSON as a collapsible tree (objects and arrays expandable)
- **AND** primitive leaves are shown inline

#### Scenario: XML column renders as expandable tree

- **WHEN** a `body XML` column has a nested element value
- **THEN** the inspector renders the XML as a collapsible tree

#### Scenario: Binary column shows base64 encoding label

- **WHEN** a `data VARBINARY` column has a base64-encoded value
- **THEN** the inspector field carries a `base64` marker
- **AND** the field is read-only

#### Scenario: GEOMETRY column is read-only

- **WHEN** the inspector renders a `GEOMETRY` cell
- **THEN** the field is read-only regardless of the viewer's editable mode

#### Scenario: Width persists across sessions

- **WHEN** the user resizes the inspector to 420px
- **THEN** the next time the user opens any MS SQL Server table viewer in any future app session, the inspector renders at 420px

#### Scenario: Inspector reflects dirty cell

- **WHEN** the user edits a cell in the grid then selects that row
- **THEN** the inspector field for that column shows the dirty value (not the server value)
- **AND** the field has a visual dirty marker

### Requirement: Virtualized data grid

The viewer tab SHALL render the rows in a virtualized grid powered by `@tanstack/react-table` for column / row modeling and `@tanstack/react-virtual` for vertical row virtualization. The grid MUST keep DOM row count proportional to the visible viewport (not to the dataset size) so that loading 10k+ rows is smooth. The grid MUST display column names in `Geist Mono`, tabular numerals for numeric and date/time columns, and a single hairline divider between rows (per `DESIGN.md`). Rows belonging to the active selection range (see "Drag-to-select row range") MUST be highlighted with the `--accent-soft` background. Cell padding MUST be the compact density specified in `DESIGN.md` (`5px 12px`). Long values MUST be truncated with an ellipsis at the cell boundary; full content is shown via the inspector panel.

Each column header MUST render the column name as its primary content. The header MUST NOT render an inline `data_type` chip alongside the name; the data type MUST remain discoverable via (a) the header cell's `title` attribute (`<name> : <data_type>`), and (b) the Structure subtab. The header MUST continue to render the sort badge (when sorted) and the resize hit area defined by `column-width-preferences`.

Each column's rendered width MUST be the effective width computed by the `column-width-preferences` capability: the user override if present, otherwise `Math.max(typeBaseWidth, headerFloorWidth)`. The measurement MUST be deterministic and offline (e.g., a cached canvas measurement using the header's computed font), and MUST NOT trigger synchronous layout on every render. The header floor MUST NOT be persisted to disk — it is recomputed from the column name on every mount, and user overrides take precedence as today. The sticky-header and row-container widths MUST equal the sum of all effective column widths. Overrides MUST be persisted under `msColumnWidths:<connectionId>:<schema>:<relation>` — the column-width preferences capability handles persistence using `(connectionId, schema, relation, column)` keys exactly as it does for Postgres.

When the connection is writable AND the relation has a PK, the grid MUST also render in editable mode: cells edited via the buffer (kind `update` or `insert`) MUST be rendered with a dirty-state background distinct from `--accent-soft`; rows marked for delete MUST be rendered with strike-through text and a faded foreground color; insert rows MUST be rendered at the top of the buffer.

#### Scenario: Loading 10k rows stays responsive

- **WHEN** the user has loaded a table with 10,000 buffered rows
- **THEN** the grid renders no more than `viewport_height / row_height + overscan` row DOM nodes at any time

#### Scenario: Selected rows use the accent-soft stripe

- **WHEN** the user selects rows 5..10
- **THEN** each of rows 5, 6, 7, 8, 9, 10 has its background using the `--accent-soft` token from `DESIGN.md`

#### Scenario: Headers render only the column name (no inline type chip)

- **WHEN** the viewer renders a column whose name is `email` and whose `data_type` is `nvarchar`
- **THEN** the header cell visibly displays the text `email` and no other inline copy beyond the optional sort badge
- **AND** hovering the header surfaces a tooltip with `email : nvarchar`
- **AND** the Structure subtab continues to list the same column with its full `data_type` and length modifier

#### Scenario: Long column names expand the default width

- **WHEN** the viewer first opens a table with an `nvarchar` column named `customer_external_identifier` and no override record exists
- **AND** the measured `headerFloorWidth` exceeds the nvarchar base width
- **THEN** the column renders at `headerFloorWidth`
- **AND** the header cell displays the column name without ellipsis truncation

#### Scenario: User override still wins over the header floor

- **WHEN** the user has previously resized `email` to 96px on `connectionA.sales.customers`
- **THEN** `email` renders at 96px (the override)
- **AND** double-click on the resize handle resets the column to `Math.max(typeBaseWidth, headerFloorWidth)`

#### Scenario: Resizing a column persists per relation

- **WHEN** the user drags the `email` header handle to set its width to 320px on `connectionA.sales.customers`
- **THEN** the record `msColumnWidths:A:sales:customers` is updated to include `{ email: 320 }` and persisted via `useSetting`
- **AND** opening `connectionA.sales.orders` is unaffected

### Requirement: Drag-to-select row range

The data grid SHALL support multi-row selection via vertical mouse drag inside the body region. The viewer MUST track selection as a pair `{ anchor: number | null, active: number | null }` where `anchor` is the row index where the drag started and `active` is the row index currently (or most recently) under the cursor. The set of selected indices MUST be derived as the inclusive range `[min(anchor, active), max(anchor, active)]`. When `anchor === null`, no rows are selected.

Mouse interaction MUST follow these rules:

- **Mouse-down on a row** sets `anchor = active = rowIndex` but does NOT yet visually commit a multi-row selection; the drag intent is unresolved until the cursor has moved at least 4 pixels.
- **Mouse-move while in drag-pending state**: if the cursor has moved < 4px, the gesture is still a click; if it has moved ≥ 4px, the gesture transitions to drag-active and `active` updates on every subsequent mousemove to the row index under the cursor (computed from `scrollTop` and `clientY`, NOT from DOM presence — virtualized rows that are not mounted are still selectable).
- **Mouse-move near the body's top or bottom edge** (within 20px) while drag-active MUST trigger auto-scroll of the grid viewport in that direction. Auto-scroll velocity MUST be proportional to how close the cursor is to the edge.
- **Mouse-up while drag-active** finalizes the selection at `[anchor, active]` and exits drag mode.
- **Mouse-up while drag-pending** (cursor never crossed the threshold) is treated as a click: if the clicked row was already selected as a single row, deselect; otherwise select that single row.
- **Mouse-up outside the grid**: the same finalization MUST apply.

Selected rows MUST render with the same `data-selected="true"` attribute and `--accent-soft` background. The selection MUST survive vertical scroll and tail pagination. The selection MUST be cleared when the user changes sort, filter, or page size. The selection MUST be cleared when the user presses `Escape` outside of an active inline editor.

#### Scenario: Click without drag selects a single row

- **WHEN** the user mouse-downs on row 5 and mouse-ups within 4px without moving
- **THEN** the selection is `{ anchor: 5, active: 5 }`

#### Scenario: Drag from row 5 to row 8 selects rows 5..8

- **WHEN** the user mouse-downs on row 5, drags vertically down through rows 6 and 7, and mouse-ups on row 8
- **THEN** the selection is `{ anchor: 5, active: 8 }`
- **AND** rows 5, 6, 7, 8 all render with `data-selected="true"`

#### Scenario: Selection survives virtualization

- **WHEN** the user drags from row 5 into row 9500 of a 10000-row buffer
- **THEN** the selection is `{ anchor: 5, active: 9500 }`
- **AND** when the user later scrolls to any row in `[5, 9500]`, that row renders selected

#### Scenario: Sort change clears the selection

- **WHEN** the user has rows 5..10 selected and changes the sort
- **THEN** the buffer is reset and the selection becomes `{ anchor: null, active: null }`

#### Scenario: Escape clears the selection outside of an editor

- **WHEN** the user has rows 5..10 selected and no inline editor is active
- **AND** presses Escape
- **THEN** the selection becomes `{ anchor: null, active: null }`

### Requirement: Cell selection and copy-to-clipboard

The data grid SHALL support single-cell focus and multi-cell rectangular selection in addition to row selection. Single-clicking a cell MUST set the focused cell to `(rowIndex, columnId)` without entering edit mode. Holding the primary mouse button on a cell and dragging across rows/columns MUST extend the selection into a rectangular range; the rectangle MUST highlight every cell in `[min(anchorRow, activeRow), max(anchorRow, activeRow)] × [min(anchorCol, activeCol), max(anchorCol, activeCol)]`.

Copying via `Cmd+C` (macOS) / `Ctrl+C` (other) MUST place a string on the system clipboard formed as:

- For a single-cell selection: the cell's displayed string value (the inspector's full value, NOT the ellipsis-truncated grid value). Truncation-envelope cells MUST be copied as the preview text only.
- For a multi-cell selection: a tab-separated-values representation. Rows are separated by `\n`, columns within a row by `\t`. Cell order follows the visible column order at the time of the copy.

`Cmd+C` MUST NOT fire when keyboard focus is inside an inline editor (the editor handles its own copy).

#### Scenario: Single-cell copy puts full value on clipboard

- **WHEN** the user selects a single cell whose value is `"alice@example.com"` and presses `Cmd+C`
- **THEN** the system clipboard contains the string `"alice@example.com"`

#### Scenario: Multi-cell copy uses tab-separated rows

- **WHEN** the user drag-selects a 2×3 rectangle covering rows 5–6 and columns `id`, `name`, `email`
- **AND** presses `Cmd+C`
- **THEN** the clipboard contains two lines, each with three tab-separated cell values in `id\tname\temail` order

#### Scenario: Copy from within an inline editor is ignored by the grid

- **WHEN** focus is inside an inline cell editor and the user presses `Cmd+C`
- **THEN** the grid's clipboard handler does NOT fire
- **AND** the editor's native copy occurs (copying the selected substring)

### Requirement: Scroll-to-load pagination

The viewer SHALL load additional pages by issuing `mssql_query_table` with an incremented `offset` whenever the user scrolls within `2 * page_size` rows of the loaded buffer's tail. While a page request is in flight the grid MUST display a subtle inline loading row at the buffer's tail. If the request fails, an inline error row with a Retry affordance MUST replace the loading row; activating Retry MUST re-issue the same request. Sort and filter changes MUST reset the buffer to the first page.

#### Scenario: Approaching the buffer tail triggers the next page

- **WHEN** the user has 200 rows loaded and scrolls so that row 100 (within `2 * 200` rows of the tail) becomes visible
- **THEN** `mssql.queryTable` is invoked with the next `offset = 200` and the same `limit`
- **AND** the new rows append to the buffer

#### Scenario: Sort change resets the buffer

- **WHEN** the user changes the sort while 1,000 rows are buffered
- **THEN** the buffer is cleared and the first page is re-fetched with the new `order_by`

#### Scenario: Filter change resets the buffer

- **WHEN** the user adds, removes, or edits a column filter
- **THEN** the buffer is cleared and the first page is re-fetched with the new `filter`

#### Scenario: Failed page renders an inline retry

- **WHEN** a page request fails
- **THEN** the loading row is replaced by an error row with the typed error message and a Retry button
- **AND** activating Retry re-issues the same request without resetting the buffer

### Requirement: Per-table page size

The frontend SHALL persist a per-table page size under the settings key `msTableLimit:<connectionId>:<schema>:<relation>` (number). When unset, the page size MUST default to 1000 rows (matching the backend's default `limit`). A control in the viewer's bottom bar MUST let the user pick from `100 / 200 / 500 / 1000 / 5000` and changes MUST persist immediately and reset the buffer to a fresh first page using the new size. Selecting a value larger than 5000 MUST NOT be possible from the UI. The setting MUST be scoped per connection — two connections inspecting the same `<schema>.<relation>` MUST NOT share state.

#### Scenario: Default page size is 1000

- **WHEN** the user opens a table tab for the first time and no setting is stored
- **THEN** the first `mssql.queryTable` invocation has `limit: 1000`

#### Scenario: Changing page size persists and refetches

- **WHEN** the user changes the page-size selector to `500`
- **THEN** the buffer is cleared, a new first page is fetched with `limit: 500`
- **AND** the next time the user reopens that table in a future app session, the page size is still `500`

#### Scenario: Page size selector does not exceed 5000

- **WHEN** the user opens the page-size selector
- **THEN** no option above `5000` is rendered

### Requirement: Per-table ordering controls

The data grid SHALL support changing the active order via column header clicks. Clicking a column header MUST cycle that column's sort through `ASC → DESC → unsorted`. Holding `Shift` while clicking a column header MUST extend the existing `order_by` array by appending (or toggling) that column — preserving multi-column sort. The new `order_by` array MUST be persisted per `(connectionId, schema, relation)` under `msTableOrder:<connectionId>:<schema>:<relation>` (a JSON array of `{ column, direction: "ASC" | "DESC" }`). When unset, the order MUST default to the empty array (the relation's primary-key-ascending fallback per the query-table requirement). The header MUST show a visible sort badge (e.g. `↑` / `↓`) on every column currently participating in the sort, with the badge order or index reflecting the column's position in the array.

The setting MUST be scoped per connection — two connections inspecting the same `<schema>.<relation>` MUST NOT share sort state.

#### Scenario: Single-column sort cycle

- **WHEN** the user clicks the `created_at` header on a relation with no active sort
- **THEN** the next click triggers ASC; clicking again triggers DESC; clicking again removes the sort
- **AND** each transition triggers a buffer reset and a fresh first page

#### Scenario: Shift-click extends the sort

- **WHEN** the user has `order_by = [{ column: "country", direction: "ASC" }]` and Shift-clicks the `created_at` header
- **THEN** `order_by` becomes `[{ column: "country", direction: "ASC" }, { column: "created_at", direction: "ASC" }]`
- **AND** the issued SQL contains `ORDER BY [country] ASC, [created_at] ASC`

#### Scenario: Sort persists across tab switches and restarts

- **WHEN** the user sets `order_by: [{ column: "created_at", direction: "DESC" }]` on `sales.orders` and switches tabs
- **AND** the user returns (or quits Argus and relaunches and reopens the table)
- **THEN** the same `order_by` is restored and the issued SQL contains `ORDER BY [created_at] DESC`

#### Scenario: Sort is per connection

- **WHEN** the user has `created_at DESC` on `connectionA.sales.orders` and opens `connectionB.sales.orders`
- **THEN** `connectionB.sales.orders` issues SQL with the primary-key-ascending fallback (no user `ORDER BY`)

### Requirement: Bottom bar status

The viewer SHALL display a bottom bar with: a row counter `Showing <N> rows · Page <P>` (where N is the current buffer size and P is the highest loaded page), the page-size selector, a `Count rows` button, an inline `query_ms` indicator from the most recent successful `mssql.queryTable`, a `Refresh` button that re-runs the current query with the active filter/order/page, a `Reset filters` button (visible when one or more filters are active), and the dirty/edit indicators below.

After the user clicks `Count rows`, the bar MUST replace `Showing <N> rows` with `Showing <N> of <Total> rows` (or `Showing <N> of ~<Total> rows` when the count is approximate). The total MUST be invalidated whenever the filter set changes.

When the viewer is in editable mode, the bottom bar MUST also render: an "Add row" button (hidden on views), a "Save" button enabled only when the buffer has dirty entries (showing `Save (<N>)`), and an unsaved-changes indicator. When the connection is read-only, the bottom bar MUST instead render a "Read-only connection — edits disabled" banner replacing the "Add row" / "Save" controls. When the relation has no PK on a writable connection, the bottom bar MUST render a "No primary key — existing rows are not editable" banner alongside the "Add row" button.

When the selection range contains 2 or more rows, the bottom bar MUST render a selection chip showing `<N> rows selected` followed by a `Clear` button. The chip MUST use `--accent-soft` background and `--accent` text color. The chip MUST NOT be rendered when the selection contains 0 or 1 row.

#### Scenario: Default bar shows partial info

- **WHEN** the user has 400 rows buffered across two pages and has not clicked `Count rows`
- **THEN** the bar reads `Showing 400 rows · Page 2`, plus the page-size selector, the `Count rows` button, the most recent `query_ms`, the `Refresh` button

#### Scenario: Approximate count is labeled with a tilde

- **WHEN** the user clicks `Count rows` with no filter and the response is `{ exact: 12345, approximate: true }`
- **THEN** the bar reads `Showing 400 of ~12,345 rows · Page 2`

#### Scenario: Exact filtered count omits the tilde

- **WHEN** the user clicks `Count rows` with a filter and the response is `{ exact: 1200, approximate: false }`
- **THEN** the bar reads `Showing 400 of 1,200 rows · Page 2` (no tilde)

#### Scenario: Filter change invalidates the count

- **WHEN** the bar shows `Showing 400 of ~12,345 rows` and the user adds a new column filter
- **THEN** the bar reverts to `Showing <N> rows · Page <P>`

#### Scenario: Refresh re-runs the active query

- **WHEN** the user has filters and a sort active and clicks `Refresh`
- **THEN** the buffer is cleared and a fresh first page is fetched with the same filter, order_by, and limit
- **AND** the activity log records a `query_table` event with `origin: "user"`

#### Scenario: Reset filters clears the filter tree

- **WHEN** the user has filters active and clicks `Reset filters`
- **THEN** both `draft` and `applied` filter trees are emptied to the default empty state
- **AND** the buffer is reset and a fresh first page is fetched with no `filter`

#### Scenario: Save button reflects pending edit count

- **WHEN** the user has 2 dirty cells and has marked 1 row for delete
- **THEN** the bar's Save button reads `Save (3)` and is enabled

#### Scenario: Read-only banner replaces edit controls

- **WHEN** the user is viewing a table on a connection with `params.read_only: true`
- **THEN** the bottom bar does NOT render the "Add row" or "Save" controls
- **AND** the bar shows a banner reading "Read-only connection — edits disabled"

#### Scenario: No-PK banner appears alongside Add row

- **WHEN** the user is viewing a table without a PK on a writable connection
- **THEN** the bar shows the "Add row" button
- **AND** also shows a banner reading "No primary key — existing rows are not editable"

#### Scenario: Selection chip appears when 2+ rows are selected

- **WHEN** the user has selected rows 5..12 by dragging
- **THEN** the bottom bar renders a chip `8 rows selected · Clear`
- **AND** the chip uses `--accent-soft` background and `--accent` text color

### Requirement: Empty state

The data grid SHALL render a distinct empty state when `mssql_query_table` returns zero rows. The empty state MUST distinguish between two cases based on whether any filter is active:

- **Table is empty** (no filter applied OR all rows in the relation are gone): show the message "This table is empty." with no call-to-action beyond the existing top-of-tab affordances.
- **No rows match the current filter**: show the message "No rows match the current filter." with a `Clear filters` action that resets the applied filter (same behavior as the bottom bar's `Reset filters`).

The empty state MUST be rendered inside the grid body region, below the column header row. The column header row MUST remain visible in both cases so the user can still see the relation's columns. The empty state MUST NOT be confused with the loading-first spinner — once the first page resolves to zero rows, the spinner is removed before the empty state appears.

#### Scenario: Empty table renders the "table is empty" message

- **WHEN** the first page resolves with zero rows AND no filter is applied
- **THEN** the empty state reads "This table is empty."
- **AND** no `Clear filters` action is rendered
- **AND** the column header row remains visible

#### Scenario: Filtered-empty renders the "no rows match" message

- **WHEN** the first page resolves with zero rows AND at least one filter is applied
- **THEN** the empty state reads "No rows match the current filter."
- **AND** a `Clear filters` action is rendered
- **AND** clicking `Clear filters` empties both `draft` and `applied` and refetches the first page

### Requirement: Read-only execution path

`mssql_query_table` and `mssql_count_table` MUST execute through the pool's read-only-aware execute helper (the same `executeQuery` path used by the schema browser) so that future read-only enforcement changes apply uniformly. They MUST NOT use any `executeMutation`-style helper. When the connection is writable AND the relation has a PK, the viewer SHALL expose mutation affordances (inline cell editing, "Add row", delete-on-`⌫`, `⌘S` to commit) routed through the `mssql-data-edit` capability commands. When the connection is `read_only: true`, mutation affordances MUST NOT be rendered AND the viewer MUST display a "Read-only connection — edits disabled" banner in the bottom bar.

Mutation affordances and the read-only banner are scoped to the **Data** subtab. The Structure and Raw subtabs are read-only on every connection and MUST NOT render an "edits disabled" banner of their own.

#### Scenario: Read-only flag does not block reads

- **WHEN** the user opens the viewer on a connection in `read_only: true`
- **THEN** rows load normally on the Data subtab and no error is surfaced
- **AND** no UI affordance for mutating the data is rendered
- **AND** the bottom bar shows the "Read-only connection — edits disabled" banner on the Data subtab only

#### Scenario: Writable connection exposes mutation affordances

- **WHEN** the user opens a table viewer on a connection with `params.read_only: false` for a relation that has a PK
- **THEN** double-clicking a non-PK cell on the Data subtab enters inline edit mode
- **AND** the bottom bar renders the "Add row" and "Save" controls

### Requirement: Adhoc result grid sub-component

The `mssql-data-grid` capability SHALL expose a reusable read-only sub-component `<AdhocMssqlResultGrid columns rows onSelectRow />` consumable by other capabilities (notably `mssql-sql-editor`). The component MUST:

- Accept `columns: ColumnInfo[]` and `rows: Array<Array<Value>>` matching the same shape as `mssql_query_table`'s response (`ColumnInfo` has `name`, `data_type`, `ordinal_position`, `is_nullable`; `Value` MAY be a truncation envelope `{ truncated: true, size: number, preview: string }`).
- Render the rows in a virtualized grid with the same DOM-row count behavior, styling tokens (`Geist Mono`, tabular numerals, hairline dividers, compact `5px 12px` cell padding), and active-row `--accent-soft` highlight as the table viewer's grid.
- Support row selection via click or keyboard arrow keys; the selected row index is reported through the `onSelectRow(rowIndex: number)` callback.
- Truncate long values with an ellipsis at the cell boundary; full content is shown via the consumer-provided inspector.
- NOT include sort/filter controls, scroll-to-load pagination, edit affordances, or a bottom bar.
- Render no rows and a configurable empty-state when `rows.length === 0`; the consumer passes the empty-state element via an `emptyState` prop.
- Render each column at its effective width using the `column-width-preferences` capability with `storageKey: null` (in-memory only). Widths MUST reset whenever the `columns` prop's signature (`columns.map(c => c.name).join("|")`) changes.

#### Scenario: Adhoc grid renders rows with shared styling

- **WHEN** the consumer renders `<AdhocMssqlResultGrid columns={cols} rows={rs} onSelectRow={fn} />` with 50 rows and 4 columns
- **THEN** the grid renders with `Geist Mono`, hairline dividers between rows, and compact cell padding
- **AND** the active-row highlight uses `--accent-soft`

#### Scenario: Adhoc grid does not render edit affordances

- **WHEN** the consumer renders the adhoc grid against any data
- **THEN** there are no edit inputs, no `+` button, no Save button, no sort/filter chrome rendered by the component

#### Scenario: Empty state is rendered when rows is empty

- **WHEN** the consumer renders `<AdhocMssqlResultGrid columns={cols} rows={[]} emptyState={<p>No rows</p>} />`
- **THEN** the grid renders the column header row and the consumer-provided empty state below it

#### Scenario: Truncated cells render as preview

- **WHEN** a cell value is `{ truncated: true, size: 5300, preview: "…" }`
- **THEN** the cell shows the preview truncated to fit

### Requirement: Deterministic first-page load on viewer mount

The data viewer's loading state machine SHALL guarantee that, on a clean mount with the connection reachable and the relation accessible, the viewer transitions from `loading-first` to either `ready` (with rows populated) or `error` (with the error surfaced) without depending on any subsequent re-render, user interaction, or upstream state change. The transition MUST hold under React 18 StrictMode (mount → unmount → remount) so that development and production behave identically.

The first-page fetch's stale-response check MUST NOT discard a response whose underlying query parameters match the viewer's current `(connectionId, schema, relation, pageSize, orderBy, applied)` tuple. The cancellation identity used to determine whether a response is stale MUST be derived from the canonical params themselves (advanced synchronously when params change), NOT from a separate counter advanced through a reducer dispatch that can fall out of phase with the params under React batching. As a corollary, when the per-relation persisted settings (`msTableFilter:*`, `msTableOrder:*`, `msPageSize:*`, etc.) resolve from disk *after* the viewer mounts and update the params in the same render cycle that the first-page fetch effect fires, the resulting fetch MUST either be applied (if its params still match) or superseded by a fresh fetch that itself reaches a terminal state. The viewer MUST NOT remain in `loading-first` after the backend has responded.

#### Scenario: Empty table renders empty state, not infinite spinner

- **WHEN** the user activates a table whose `SELECT` returns zero rows AND the underlying Tauri command resolves successfully
- **THEN** the viewer transitions out of `loading-first` to `ready`
- **AND** the spinner is no longer shown
- **AND** the empty state is rendered

#### Scenario: Non-empty table renders rows on first mount

- **WHEN** the user activates a table whose `SELECT` returns N rows AND the underlying Tauri command resolves successfully
- **THEN** the viewer transitions to `ready`
- **AND** the grid renders all N returned rows in column order

#### Scenario: First-page error surfaces to the error banner

- **WHEN** the user activates a table AND the underlying Tauri command rejects with an `AppError`
- **THEN** the viewer transitions out of `loading-first` to `error`
- **AND** the error banner is shown with the error message and a retry control

#### Scenario: StrictMode mount/unmount/remount does not strand the viewer

- **WHEN** the viewer hook is mounted under `<React.StrictMode>` so that React invokes mount → cleanup → mount a second time
- **THEN** the second mount's first-page fetch reaches a `ready` (or `error`) terminal state

#### Scenario: Cold-mount disk-load race does not strand the viewer

- **WHEN** the user activates a table whose `(connectionId, schema, relation)` has no entry in the `useSetting` in-memory cache, so that the persisted filter, order-by, and page-size settings each complete their disk read asynchronously and update the viewer's params after the first render
- **AND** the underlying `mssql_query_table` Tauri command resolves successfully with N rows
- **THEN** the viewer transitions out of `loading-first` to `ready`
- **AND** the grid renders the returned rows
- **AND** no in-flight response whose params match the viewer's current params is silently discarded

#### Scenario: Stale-by-params response is still discarded

- **WHEN** the first-page fetch is in flight against params P1
- **AND** the user changes the filter / sort / page size to P2 before the response arrives
- **THEN** the response carrying P1 results is discarded
- **AND** a fresh fetch against P2 is issued and reaches a terminal state

### Requirement: Cold-load and header race protection

When a fresh query is initiated (first mount, filter change, sort change, page-size change, refresh), the grid MUST NOT render the previous query's rows. The viewer MUST clear the row buffer synchronously with the dispatch of the new request — there MUST be no window in which the user sees stale rows alongside the new column header set. Additionally, the column header row MUST be cleared (or kept in lockstep with the row buffer) at the same instant so the headers cannot show the previous query's columns above the new (empty or loading) body. This rule applies even when the new query carries the same `columns` shape as the previous one — the visual transition through `loading-first` is mandatory.

The previous-rows display MAY be replaced by either the `loading-first` spinner or the empty body region; what is forbidden is the simultaneous display of previous rows with the new fetch in flight.

#### Scenario: Filter change does not flash previous rows under new headers

- **WHEN** the user has 200 rows loaded and applies a new filter that produces a different column subset
- **THEN** at no rendered frame between the filter change and the new response are the previous 200 rows visible
- **AND** the headers visible during the transition do NOT show the previous filter's results above the new fetch

#### Scenario: Refresh clears the buffer before the next fetch resolves

- **WHEN** the user clicks `Refresh` while 1000 rows are loaded
- **THEN** the buffer is empty in the next render
- **AND** the loading-first spinner appears until the response resolves
- **AND** rows reappear only after the response is applied

### Requirement: Server-side cancellation of in-flight queries

When the user navigates away from a table tab whose `mssql_query_table` is still in flight, OR clicks `Refresh` while a previous query is in flight, the backend SHALL cancel the in-flight query at the SQL Server. The primary cancellation mechanism MUST be the TDS Attention packet: each cancellable query MUST be wrapped in a `tokio::select!` against a cancellation token, and on cancellation the future MUST be dropped so that `tiberius` issues a TDS Attention to the server during shutdown. The viewer MUST track the active server process id (the SPID, obtained via `SELECT @@SPID` at the start of the query and stored on the in-flight request handle) for the fallback path.

The fallback cancellation path MUST fire when the TDS Attention path does not reliably terminate the query (e.g. the pooled connection cannot be returned in a clean state). To fall back, the backend MUST open a short-lived fresh connection to the same SQL Server (using the same connection params) and issue `KILL <spid>`, then close that fresh connection. The fallback connection MUST NOT be drawn from the existing pool (so the kill cannot deadlock against the pool itself) and MUST honor a 3-second timeout — if the fallback connection cannot be established within 3 seconds, the backend MUST log the failure and abandon the kill (the query will eventually be reaped by SQL Server's own timeout machinery or by the dropped TDS connection).

Cancellation MUST NOT use `pg_cancel_backend` or any Postgres-specific helper, and MUST NOT use `KILL QUERY` (the MySQL form). The activity log MUST emit a `query_table` event with `kind_namespace: "mssql"`, `status: "cancelled"` for any in-flight query that was killed via either path, with `metric: null`.

#### Scenario: Tab close cancels the in-flight query via TDS Attention

- **WHEN** the user opens `sales.orders`, the first-page fetch is in flight, and the user closes the tab before the response arrives
- **THEN** the cancellation token fires, the query future is dropped, and `tiberius` sends a TDS Attention packet to the server
- **AND** an activity-log event with `kind_namespace: "mssql"`, `status: "cancelled"` is recorded
- **AND** the response that eventually arrives (if any) is discarded by the now-unmounted viewer

#### Scenario: Refresh cancels the previous in-flight query

- **WHEN** the user clicks `Refresh` while the previous `mssql_query_table` is still in flight
- **THEN** the cancellation token for the previous request fires, the previous future is dropped, and the connection's TDS Attention is sent
- **AND** the new request runs to completion (or its own cancellation)

#### Scenario: KILL fallback fires when TDS Attention does not terminate

- **WHEN** the TDS Attention path fails to terminate the query (e.g. the driver cannot guarantee a clean connection state)
- **THEN** the backend opens a short-lived fresh connection and issues `KILL <spid>` against the captured SPID
- **AND** the fallback connection is closed immediately after the KILL completes

#### Scenario: Cancellation failure does not block tab close

- **WHEN** the fallback cancellation connection cannot be established within 3 seconds
- **THEN** the backend logs the failure and returns without raising
- **AND** the tab close completes normally
- **AND** the abandoned query is left to SQL Server's own server-side timeout or the dropped TDS connection to reap

### Requirement: Filter bar surface

The viewer tab SHALL conditionally render a filter bar pinned above the column header row and below any tab title chrome. The filter bar MUST be the only filter surface in the data grid — there MUST NOT be a per-column header funnel or popover. Removing the popover MUST NOT remove the existing column-header sort affordance.

The bar MUST be **hidden by default** when a `mssql-table-data` tab is first opened (no persisted preference). When hidden, the bar MUST NOT reserve vertical space. The user MUST be able to toggle the bar visible via either (a) the `Filter` icon button in the subtab header chrome, or (b) the `⌘F` (macOS) / `Ctrl+F` (other) keyboard shortcut. Visibility MUST be persisted per-table.

When visible, the bar MUST contain, top to bottom: a vertical stack of filter rows (each row: checkbox, column picker, operator picker, value input, optional case-insensitive toggle for `LIKE`/`CONTAINS`/`STARTS_WITH`/`ENDS_WITH` ops, Apply / Applied button, `−`, `+`), and a single-line footer strip (Unset, SQL, shortcut hints, Apply All ▾). When visible with no persisted rows, the bar MUST render exactly one empty row.

The `⌘F` shortcut MUST resolve identically to the Postgres viewer:
- If the bar is hidden: show the bar AND move focus to the first row's value input.
- If the bar is visible and focus is outside the bar: move focus to the first row's value input.
- If the bar is visible and focus is inside the bar: hide the bar (preserve `draft` and `applied`).

The handler MUST NOT fire on the Structure or Raw subtab. The handler MUST NOT fire when focus is inside a CodeMirror editor surface.

#### Scenario: Bar is hidden by default

- **WHEN** the user opens a `mssql-table-data` tab for the first time
- **THEN** the filter bar is not rendered
- **AND** the column header row sits immediately under the subtab header chrome

#### Scenario: Cmd+F shows a hidden bar and focuses the first row

- **WHEN** the bar is hidden and the user presses `⌘F` while the Data subtab is active
- **THEN** the filter bar becomes visible
- **AND** keyboard focus moves to the first row's value input
- **AND** no browser/webview "find in page" UI appears

#### Scenario: Case-insensitive toggle is rendered only for applicable ops

- **WHEN** a filter row has `op = LIKE`, `CONTAINS`, `STARTS_WITH`, or `ENDS_WITH`
- **THEN** the row renders a `Aa` toggle button (or equivalent affordance) next to the value input
- **AND** clicking the toggle flips `case_insensitive` between `true` and `false` in `draft`
- **WHEN** the row's `op` is any other operator
- **THEN** the `Aa` toggle is NOT rendered

### Requirement: Filter draft and applied state

`TableViewerTab` SHALL maintain two filter values for each tab: `draft` and `applied`, each of shape `FilterTree = { rows: FilterRow[], combinator: "AND" | "OR" }`. Only `applied` MUST be passed (after wire-shape conversion) to `mssql_query_table` and `mssql_count_table`. Edits to the filter bar MUST update `draft` only. The bar MUST display a dirty indicator (a small `●` adjacent to the `Apply All` button) whenever `draft` differs from `applied`.

The `Apply All` button and the `⌘↵` / `⇧⌘↵` shortcuts commit `draft` to `applied`. The per-row `Apply` button commits exactly that single row to `applied`. The `Unset` button resets `draft.rows` but does NOT touch `applied`.

The filter bar is always in Structured mode. Switching to Raw is only reachable indirectly via `SQL` (footer button) which opens the SQL Editor with a compiled WHERE.

#### Scenario: Editing a row updates draft only

- **WHEN** the user types into a row's value input
- **THEN** the dirty indicator becomes visible
- **AND** the data grid does NOT re-fetch
- **AND** `applied` is unchanged

#### Scenario: Apply All commits draft and triggers fetch

- **WHEN** the user has a dirty draft and clicks `Apply All` (or presses `⌘↵`)
- **THEN** `applied` becomes equal to the enabled-complete subset of `draft.rows` joined by `draft.combinator`
- **AND** the dirty indicator disappears
- **AND** `mssql.queryTable` is invoked with the new `applied` filter

#### Scenario: Per-row Apply replaces the active filter with that single row

- **WHEN** the user has three rows in `draft` and clicks the per-row Apply button on the second row
- **THEN** `applied.rows === [thatRow]`
- **AND** `applied.combinator === draft.combinator`
- **AND** `draft` is unchanged

### Requirement: Filter bar visibility persistence

The viewer SHALL persist the filter bar's open/hidden state as a per-table viewer setting. The store key MUST be `filter_bar_visible` and MUST be scoped by `(connection_id, schema, relation)`. The default value MUST be `false` (hidden). Toggling MUST be persisted synchronously. Toggling MUST NOT discard the in-memory `draft` filter rows or `applied` filter.

The toggle MUST be reachable via:
- A `Filter` icon button rendered in the table tab's subtab header chrome.
- The `⌘F` (macOS) / `Ctrl+F` (other) keyboard shortcut.

#### Scenario: Bar defaults to hidden on first open

- **WHEN** the user opens a `mssql-table-data` tab for a table with no persisted `filter_bar_visible` setting
- **THEN** the filter bar is not rendered

#### Scenario: Visibility survives table reopen

- **WHEN** the user opens table `orders`, toggles the filter bar visible, then closes the tab
- **AND** later reopens table `orders` on the same connection
- **THEN** the filter bar is rendered visible on reopen

#### Scenario: Hiding preserves draft and applied state

- **WHEN** the user has a dirty draft and applied filters, toggles the bar hidden, then toggles it visible
- **THEN** the draft rows are restored exactly as before hiding
- **AND** `applied` is unchanged throughout
- **AND** the data grid was never re-fetched purely from the hide/show toggle

### Requirement: Filter row inclusion checkbox

The Structured filter row SHALL render a checkbox at its left edge whose checked state controls whether that row participates in `Apply All`. New rows MUST be created with `enabled = true`. Toggling the checkbox MUST update `draft` only. The checkbox state MUST NOT affect per-row Apply.

#### Scenario: New row defaults to checked

- **WHEN** the user adds a new filter row via `+` or `⌘I`
- **THEN** the new row's checkbox is checked (`enabled = true`)

#### Scenario: Unchecked row is excluded from Apply All

- **WHEN** `draft` contains three rows (R1 checked, R2 unchecked, R3 checked) and the user presses `Apply All`
- **THEN** `applied.rows` contains only R1 and R3

#### Scenario: Per-row Apply ignores checkbox state

- **WHEN** the user clicks the per-row Apply button on an unchecked row R2
- **THEN** `applied.rows` becomes `[R2]` regardless of R2's `enabled` flag

### Requirement: Per-row Apply and Applied visual state

Every Structured filter row SHALL render a `Apply` / `Applied` button at its right edge. The button MUST show `Apply` (neutral) when the row is NOT part of `applied`, and `Applied` (green, using `--success`) when the row IS part of `applied`. A row is part of `applied` iff there exists a row in `applied.rows` whose `(column, op, value, case_insensitive)` tuple is structurally equal to the draft row's tuple, regardless of either row's `enabled` flag.

When a row is in the Applied state:
- The button label MUST read `Applied`.
- The row's value input MUST render with the `--success-soft` background tint and a `--success` border.
- The button MUST remain clickable; clicking it MUST re-apply only that row (idempotent).

Activating the per-row Apply button MUST set `applied` to `{ rows: [thisRow], combinator: draft.combinator }`. The button MUST NOT modify `draft`.

Editing any of `column`, `op`, `value`, `enabled`, or `case_insensitive` on an Applied row MUST cause structural equality with `applied` to break, and the row's Applied state MUST drop to the neutral `Apply` state on the next render.

#### Scenario: Applied state is per-row and based on structural equality

- **WHEN** `applied.rows = [{ column: "status", op: "=", value: "ok", enabled: true }]`
- **AND** `draft.rows[0]` is structurally equal
- **THEN** `draft.rows[0]` renders with the green Applied badge

#### Scenario: Editing the case-insensitive toggle drops the Applied badge

- **WHEN** a `CONTAINS` row is in the Applied state with `case_insensitive: false` and the user toggles it to `true`
- **THEN** the row's Applied badge becomes the neutral `Apply` label

### Requirement: Apply All with persistent root combinator

The filter bar SHALL render an `Apply All` button composed of a primary click area labeled `Apply All` and a chevron menu. The menu MUST contain:

1. `Apply All Checked Filters with AND – Default` with shortcut `⌘↵`
2. `Apply All Checked Filters with OR` with shortcut `⇧⌘↵`

The active combinator MUST be reflected in the menu with a `✓` checkmark. Activating either menu item MUST first set `draft.combinator` then immediately perform Apply All.

Pressing plain `Enter` (no modifier) while focus is inside a filter row's value input MUST perform Apply All using whatever value `draft.combinator` currently holds — identical to clicking the primary `Apply All` click area. Plain `Enter` MUST NOT modify `draft.combinator`.

`draft.combinator` MUST persist across Applies. The combinator MUST be persisted per-table under `filter_root_combinator` (default `"AND"`).

Apply All MUST set `applied` to `{ rows: draft.rows.filter(r => r.enabled && isComplete(r)), combinator: draft.combinator }`. A row is `complete` when `column` is set, `op` is set, AND the operator has a non-empty `value` (where required).

If the filtered subset is empty, Apply All MUST send no `filter` (no WHERE clause) and the bar MUST surface an unobtrusive inline status `No filters enabled` for ~2 seconds.

#### Scenario: Apply All joins only checked complete rows

- **WHEN** `draft` has rows R1 (checked, complete), R2 (unchecked, complete), R3 (checked, incomplete), R4 (checked, complete) and `draft.combinator === "AND"`
- **AND** the user clicks `Apply All`
- **THEN** `applied.rows === [R1, R4]`
- **AND** the compiled WHERE is `<p_R1> AND <p_R4>`

#### Scenario: Cmd+Enter applies with AND

- **WHEN** focus is inside the filter bar and the user presses `⌘↵`
- **THEN** `draft.combinator` is set to `"AND"` and Apply All is performed

#### Scenario: Shift+Cmd+Enter applies with OR

- **WHEN** focus is inside the filter bar and the user presses `⇧⌘↵`
- **THEN** `draft.combinator` is set to `"OR"` and Apply All is performed

#### Scenario: Plain Enter applies with current combinator

- **WHEN** focus is in a filter row's value input, `draft.combinator === "OR"`, and the user presses `Enter` with no modifier
- **THEN** Apply All is performed
- **AND** `applied.combinator === "OR"` (the persisted combinator is unchanged)
- **AND** `mssql.queryTable` is invoked with the new `applied` filter

#### Scenario: Combinator persists across reopens

- **WHEN** the user picks `OR`, closes the tab, and reopens the table
- **THEN** the reopened tab loads `filter_root_combinator === "OR"`

### Requirement: Filter bar keyboard shortcuts

While the filter bar is visible AND focus is inside the bar AND focus is NOT inside a CodeMirror surface, the following keyboard shortcuts MUST be active. Each handler MUST call `preventDefault()`.

| Shortcut | Action |
|---|---|
| `⌘F` / `Ctrl+F` | Toggle visibility |
| `⌘I` / `Ctrl+I` | Insert a new empty row below the focused row. Defaults: `enabled = true`, `column = any_column`, `op = CONTAINS`, `value = ""`. Focus moves to the new row's column picker. |
| `⌘⇧I` / `Ctrl+Shift+I` | Remove the focused row. If last, clear to default empty state. |
| `⌘↑` / `Ctrl+↑` | Move focus to same logical control of row above. No wrap at top. |
| `⌘↓` / `Ctrl+↓` | Move focus to same logical control of row below. No wrap at bottom. |
| `⌘←` / `Ctrl+←` | Open the column picker dropdown on the focused row. |
| `Enter` | Apply All using the current `draft.combinator` (does NOT force AND or OR). Fires from any filter-row value input. |
| `⌘↵` / `Ctrl+Enter` | Apply All with AND |
| `⇧⌘↵` / `Ctrl+Shift+Enter` | Apply All with OR |

#### Scenario: Cmd+I inserts a row below the focused row

- **WHEN** `draft.rows` has three rows, focus is in row 1's value input, and the user presses `⌘I`
- **THEN** `draft.rows.length === 4`
- **AND** the new row is at index 2
- **AND** the new row has the default empty state with `op = CONTAINS`

#### Scenario: Cmd+Down navigates to the same control on the next row

- **WHEN** focus is in row 0's value input and the user presses `⌘↓`
- **THEN** focus moves to row 1's value input

#### Scenario: Cmd+← opens the column picker of the focused row

- **WHEN** focus is in row 0's value input and the user presses `⌘←`
- **THEN** row 0's column picker dropdown opens

#### Scenario: Plain Enter on a value input applies all

- **WHEN** focus is in row 0's text value input, the row is enabled and complete, and the user presses `Enter` with no modifier
- **THEN** Apply All is performed
- **AND** `draft.combinator` is NOT changed
- **AND** `mssql.queryTable` is invoked with the new `applied` filter

### Requirement: Filter bar footer Unset, SQL, hints

The filter bar SHALL render a footer strip with the following controls, in order from left to right:

- `SQL` button — opens a new `mssql-query` tab on the same connection with a prefilled SELECT reflecting the current `applied` filter set. The button MUST use `applied`, NOT `draft`.
- Shortcut hint strip: `Show: ⌘F`, `Insert: ⌘I`, `Remove: ⌘⇧I`, `Apply All: ⌘↵`, `Up: ⌘↑`, `Down: ⌘↓`, `Columns: ⌘←`.
- `Operator: [Unset]` — a button labeled `Unset`. Activating it MUST reset all `draft.rows` to a single empty row. It MUST NOT modify `applied` or `draft.combinator`.
- `Apply All ▾` (covered by "Apply All with persistent root combinator").

#### Scenario: Unset clears draft rows to a single empty row

- **WHEN** `draft.rows` has three populated rows AND `applied` has those same three rows AND the user clicks `Unset`
- **THEN** `draft.rows.length === 1`
- **AND** the single remaining row has the default empty state
- **AND** `applied` is unchanged (the grid remains filtered)

#### Scenario: SQL button uses applied, not draft

- **WHEN** the user has dirty draft rows (different from `applied`) and clicks `SQL`
- **THEN** the opened SQL editor tab is prefilled with a SELECT that uses the current `applied` filter set
- **AND** the prefilled SQL inlines literals (no `@PN` placeholders)

### Requirement: Flat root combinator

The Structured filter model SHALL be a flat list of condition rows joined by a single root combinator. The model MUST be:

```
interface FilterRow {
  enabled: boolean;
  column: ColumnRef;
  op: Operator;
  value?: FilterValue;
  case_insensitive?: boolean;
}
interface FilterTree {
  rows: FilterRow[];
  combinator: "AND" | "OR";
}
```

Nesting (sub-groups, OR groups) MUST NOT be expressible. The frontend MUST emit `filter` on the wire as `{ rows: [...rows], combinator }` where each row contains the same shape. The `enabled` flag is filtering-side only and MUST NOT be emitted on rows that survive the `Apply All` filter step (disabled/incomplete rows are dropped). The compiled `WHERE` body MUST join row predicates with `" AND "` or `" OR "` based on the wire `combinator`. The expression MUST NOT add outer parentheses. An empty `rows` payload MUST result in no `WHERE` clause.

#### Scenario: Flat AND children compile to ANDed predicates

- **WHEN** the wire `filter` has three condition rows and `combinator === "AND"`
- **THEN** the compiled WHERE is `<p1> AND <p2> AND <p3>` with no outer parens

#### Scenario: Flat OR children compile to ORed predicates

- **WHEN** the wire `filter` has three condition rows and `combinator === "OR"`
- **THEN** the compiled WHERE is `<p1> OR <p2> OR <p3>` with no outer parens

### Requirement: Any column search

The Structured filter model SHALL accept a special `ColumnRef` `{ kind: "any_column" }` representing a search across every text-castable column of the relation. The frontend MUST surface "Any column" as the first option in the column picker. Operators allowed for `any_column` MUST be: `=`, `!=`, `LIKE`, `NOT LIKE`, `CONTAINS`, `STARTS_WITH`, `ENDS_WITH`. The `case_insensitive` flag MAY be applied. All other operators MUST be rejected with `AppError::Validation`.

The backend MUST expand an `any_column` condition by enumerating every column of the target relation whose `data_type` is text-castable (everything except `BINARY` / `VARBINARY` / `IMAGE` / `ROWVERSION` / `GEOMETRY` / `GEOGRAPHY` / `HIERARCHYID` / `SQL_VARIANT` / `XML`) and emitting:

```sql
([col1] [op] @P1 OR [col2] [op] @P2 OR ...)
```

…where each branch binds the same value but uses a distinct `@PN` placeholder (tiberius requires unique placeholder names, so the parameter MUST be bound N times — once per branch with its own name).

When `case_insensitive` is set, every branch MUST be wrapped in `LOWER(...)` per the operator's case-insensitive form. When no text-castable columns exist, the condition MUST compile to `(1 = 0)`.

#### Scenario: Any column with CONTAINS expands across columns and binds the parameter N times

- **WHEN** the user adds a condition `{ column: any_column, op: "CONTAINS", value: "argus" }` against a relation with text-castable columns `name`, `email`, `notes`
- **THEN** the compiled WHERE is `([name] LIKE '%' + @P1 + '%' OR [email] LIKE '%' + @P2 + '%' OR [notes] LIKE '%' + @P3 + '%')`
- **AND** the bound parameter list is `[("@P1", "argus"), ("@P2", "argus"), ("@P3", "argus")]`

#### Scenario: Any column with case_insensitive applies LOWER to every branch

- **WHEN** the user adds `{ column: any_column, op: "CONTAINS", value: "argus", case_insensitive: true }`
- **THEN** every branch is wrapped: `(LOWER([name]) LIKE LOWER('%' + @P1 + '%') OR LOWER([email]) LIKE LOWER('%' + @P2 + '%') OR LOWER([notes]) LIKE LOWER('%' + @P3 + '%'))`

#### Scenario: VARBINARY and GEOMETRY columns are skipped

- **WHEN** the relation has columns `name NVARCHAR(255)`, `payload VARBINARY(MAX)`, `location GEOMETRY`
- **AND** the user adds an Any-column condition
- **THEN** the compiled WHERE references only `name`

#### Scenario: Any column with disallowed operator is rejected

- **WHEN** the frontend forwards `{ column: any_column, op: "BETWEEN", value: { min: 1, max: 10 } }`
- **THEN** the command returns `AppError::Validation`

#### Scenario: Any column with no text-castable columns compiles to 1=0

- **WHEN** the relation has only `VARBINARY` columns and the user adds an Any-column condition
- **THEN** the compiled WHERE is `(1 = 0)` and the query returns zero rows

### Requirement: Open in SQL Editor

The filter bar SHALL include an `Open in SQL Editor` action that opens a new `mssql-query` tab on the same connection with a prefilled SELECT reflecting the current `applied` filter set. The action MUST NOT require the user to apply pending draft changes first; if there is a dirty draft, the action uses `applied`. The generated SQL MUST be:

```
SELECT * FROM [<schema>].[<relation>]
[WHERE <where>]
ORDER BY <orders or pk-fallback>
OFFSET 0 ROWS FETCH NEXT <current_page_size> ROWS ONLY
```

Where `<where>` is the compiled WHERE body for `applied` with literals inlined (no `@PN` placeholders), `<orders>` is the current ORDER BY for the tab's sort using bracket-quoted column names (falling back to the primary key ascending if no user sort is active, or `(SELECT NULL)` if the table has no PK), and `<current_page_size>` is the active per-table page size.

#### Scenario: Empty applied opens a SELECT with no WHERE

- **WHEN** the user clicks "Open in SQL Editor" with no applied filters on a PK table `sales.orders` with PK `(id)`
- **THEN** a new `mssql-query` tab opens with `sql = "SELECT * FROM [sales].[orders] ORDER BY [id] ASC OFFSET 0 ROWS FETCH NEXT 1000 ROWS ONLY"` (no WHERE)
- **AND** the tab is focused

#### Scenario: Structured applied prefills a parameterless WHERE

- **WHEN** `applied` compiles to `[country] = 'CL' AND [status] = 'active'`
- **AND** the user clicks "Open in SQL Editor"
- **THEN** the prefilled SQL contains `WHERE [country] = 'CL' AND [status] = 'active'`
- **AND** the prefilled SQL has no `@PN` placeholders (literals are inlined for display)

#### Scenario: Active sort is included

- **WHEN** the tab has `order_by = [{ column: "created_at", direction: "DESC" }]` and applied filters
- **THEN** the prefilled SQL includes `ORDER BY [created_at] DESC` after the WHERE

#### Scenario: Heap table prefill uses SELECT NULL fallback

- **WHEN** the user clicks "Open in SQL Editor" on a heap table with no PK and no active sort
- **THEN** the prefilled SQL contains `ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT <page_size> ROWS ONLY`

### Requirement: Per-table filter persistence

The frontend SHALL persist the filter bar's `draft` and `applied` FilterTree per `(connectionId, schema, relation)` tuple under the settings key `msTableFilter:<connectionId>:<schema>:<relation>`. The persisted record MUST contain both halves as a single coherent JSON object. The persisted record MUST include the root `combinator` field; when reading a persisted record written without `combinator`, the loader MUST coerce it to `"AND"`. Each row's `case_insensitive` field MUST round-trip; missing values MUST default to `false`.

The persisted filter MUST survive: switching tabs and back, closing the tab and reopening, switching connections and back, and restarting the app. The persisted filter MUST be cleared only when the user explicitly invokes the `Reset filters` chip in the bottom bar or the filter bar's `Unset` followed by `Apply All`.

When the persisted filter references a column that no longer exists, the system MUST surface the resulting `AppError::Mssql` (typically SQL Server error 207 `Invalid column name`) through the same error UX. The system MUST NOT auto-prune predicates.

The setting MUST be scoped per connection.

#### Scenario: Default filter is empty

- **WHEN** the user opens a table tab for the first time and no setting is stored
- **THEN** the filter bar shows the empty filter model and `applied` is empty
- **AND** the first `mssql.queryTable` invocation has no `filter`

#### Scenario: Filter persists across tab switches

- **WHEN** the user has applied a filter on `sales.orders` and clicks a different tab, then clicks back
- **THEN** both the filter bar `draft` and the `applied` filter are restored exactly as they were

#### Scenario: Filter persists across app restart

- **WHEN** the user has applied a filter on `sales.orders` and quits Argus
- **AND** the user re-launches Argus and opens `sales.orders`
- **THEN** the filter bar shows the previously applied filter as both `draft` and `applied`

#### Scenario: Schema drift surfaces a SQL Server error and does not auto-clear

- **WHEN** the persisted filter references a column that no longer exists in the relation
- **AND** the user opens that table
- **THEN** the data grid surfaces an `AppError::Mssql` (e.g. `code: Some(207)` invalid column name) through the existing error UX
- **AND** the persisted filter is unchanged

#### Scenario: case_insensitive round-trips through persistence

- **WHEN** the user toggles `case_insensitive: true` on a `CONTAINS` row, applies, quits and re-launches
- **THEN** the persisted record contains `case_insensitive: true` on that row
- **AND** reopening the table restores the toggle in the on position

### Requirement: Per-relation state isolation across tab switches

When the same `TableViewerTab` React instance is rendered with a different `(connectionId, schema, relation)` triple — which happens when the user switches between two open `mssql-table-data` tabs of different relations — the bar's `draft`, `applied`, and `order_by` MUST reflect the *new* triple's persisted state on first paint, NOT the previous triple's state.

The persistence pipeline (`useSetting` and the hooks built on it) MUST detect the key change synchronously during render and re-derive `value` and `isLoaded` from the per-key memory cache (or default) before the render commits.

#### Scenario: Switching between two open table tabs shows the correct filter

- **WHEN** the user has table A and table B open as separate `mssql-table-data` tabs
- **AND** table A has applied filter X persisted, table B has applied filter Y persisted
- **AND** the user switches from tab A to tab B
- **THEN** on the first paint after the switch the filter bar shows filter Y, not filter X

#### Scenario: First paint of the new tab is not stale

- **WHEN** the user switches between two open table tabs
- **THEN** there is no frame in which the filter bar shows the previous tab's filter
- **AND** the data grid does NOT issue a `queryTable` call with the previous tab's `applied` filter against the new tab's relation

### Requirement: Type-aware structured filter parameter binding

When `mssql_query_table` (and `mssql_count_table`) compile a `filter` to SQL, the backend SHALL bind every parameter using a Rust type compatible with the resolved SQL Server data type of the referenced column. Binding MUST consult the column metadata fetched via the `mssql-columns-cache` capability. The structured filter MUST NOT propagate raw driver errors that originate purely from a Rust↔SQL Server type-name mismatch.

The minimum supported mapping (SQL Server column type → Rust bind type, placeholder shape) MUST be:

- `bit` → `bool`, placeholder `@PN`
- `tinyint` → `u8`, placeholder `@PN` (unsigned 0–255)
- `smallint` → `i16`, placeholder `@PN`
- `int` / `integer` → `i32`, placeholder `@PN`
- `bigint` → `i64`, placeholder `@PN`
- `real` → `f32`, placeholder `@PN`
- `float` → `f64`, placeholder `@PN`
- `decimal` / `numeric` / `money` / `smallmoney` → `bigdecimal::BigDecimal` parsed from string, placeholder `@PN`
- `char` / `varchar` / `text` → `&str`, placeholder `@PN`
- `nchar` / `nvarchar` / `ntext` → `&str` (tiberius converts to UTF-16 on the wire), placeholder `@PN`
- `binary` / `varbinary` / `image` → `Vec<u8>` (frontend MAY pass base64 string; backend MUST decode), placeholder `@PN`
- `rowversion` / `timestamp` → reject as bind (read-only system type); the backend MUST return `AppError::Validation` if a filter targets a `rowversion` column with a non-`IS NULL` / `IS NOT NULL` operator
- `date` → `chrono::NaiveDate` parsed from `YYYY-MM-DD`, placeholder `@PN`
- `time` → `chrono::NaiveTime` parsed from `HH:MM:SS[.fffffff]`, placeholder `@PN`
- `datetime` / `datetime2` / `smalldatetime` → `chrono::NaiveDateTime` parsed from ISO 8601 without TZ, placeholder `@PN`
- `datetimeoffset` → `chrono::DateTime<chrono::FixedOffset>` parsed from ISO 8601 with `±HH:MM`, placeholder `@PN`
- `uniqueidentifier` → `uuid::Uuid` parsed from canonical form, placeholder `@PN`
- `xml` → `&str`, placeholder `@PN`
- `json` (SQL Server 2025+) → `&str` (server parses), placeholder `@PN`
- `geometry` / `geography` → reject as bind (decode-only in v1); the backend MUST return `AppError::Validation` indicating the SQL editor should be used for spatial predicates
- `hierarchyid` → reject as bind (decode-only in v1)
- `sql_variant` → reject as bind (decode-only in v1)

For any column data type not listed above, the backend MUST fall back to binding `&str` with a plain `@PN` placeholder and let SQL Server perform the conversion.

For the pattern operators (`LIKE`, `NOT LIKE`, `CONTAINS`, `STARTS_WITH`, `ENDS_WITH`), parameters MUST always bind as Rust `&str` with a plain `@PN` placeholder regardless of the column type — the column reference itself is unchanged from today's behavior. For the `any_column` branch, parameters MUST bind as Rust `&str` with a plain `@PN` placeholder (one per branch with a distinct name).

For `IN` / `NOT IN`, every array element MUST bind with the same column-typed coercion as `=`. For `BETWEEN`, both `min` and `max` MUST bind with the same column-typed coercion as `=`.

JSON-shape validation MUST run before binding. If a value cannot be coerced to the column's bind type, the backend MUST return `AppError::Validation { message: "expected <kind> for column '<name>', got '<repr>'" }`. Numeric inputs MAY arrive as `JsonValue::String` (frontend escape hatch for very large numbers) and MUST be parsed with the target type's range check before binding. `JsonValue::Null` MUST be rejected with the existing "use IS NULL / IS NOT NULL" message.

If a `filter` references a named column that does not appear in the resolved column list, the backend MUST return `AppError::Validation { message: "filter references unknown column '<name>'" }`.

#### Scenario: INT column with int binds as i32

- **WHEN** the user invokes `mssql.queryTable(id, "inventory", "movement", { filter: { rows: [{ enabled: true, column: { kind: "named", name: "product_id" }, op: "=", value: 20528 }], combinator: "AND" } })` and `inventory.movement.product_id` is `int`
- **THEN** the issued SQL contains `WHERE [product_id] = @P1` with the parameter bound as Rust `i32(20528)`
- **AND** the query succeeds

#### Scenario: SMALLINT column binds as i16

- **WHEN** the user filters `{ column: { kind: "named", name: "tier" }, op: "=", value: 3 }` on a `smallint` column
- **THEN** the parameter is bound as Rust `i16(3)`

#### Scenario: TINYINT column binds as u8

- **WHEN** the user filters `{ column: { kind: "named", name: "level" }, op: "=", value: 200 }` on a `tinyint` column
- **THEN** the parameter is bound as Rust `u8(200)`

#### Scenario: BIGINT column binds as i64

- **WHEN** the user filters `{ column: { kind: "named", name: "id" }, op: "=", value: 9223372036854775000 }` on a `bigint` column
- **THEN** the parameter is bound as Rust `i64`

#### Scenario: DECIMAL binds as BigDecimal

- **WHEN** the user filters `{ column: { kind: "named", name: "price" }, op: "<", value: 19.99 }` on a `decimal(10,2)` column
- **THEN** the issued SQL contains `WHERE [price] < @P1` and the parameter is bound as Rust `BigDecimal::from_str("19.99")`

#### Scenario: MONEY binds as BigDecimal

- **WHEN** the user filters `{ column: { kind: "named", name: "total" }, op: ">=", value: "100.00" }` on a `money` column
- **THEN** the parameter is bound as Rust `BigDecimal::from_str("100.00")`

#### Scenario: DATETIME2 column binds as NaiveDateTime

- **WHEN** the user filters `{ column: { kind: "named", name: "created_at" }, op: ">=", value: "2026-01-01T00:00:00" }` on a `datetime2` column
- **THEN** the issued SQL contains `WHERE [created_at] >= @P1` with the parameter bound as Rust `NaiveDateTime`

#### Scenario: DATETIMEOFFSET column preserves the offset on bind

- **WHEN** the user filters `{ column: { kind: "named", name: "event_at" }, op: ">=", value: "2026-01-01T00:00:00-03:00" }` on a `datetimeoffset` column
- **THEN** the parameter is bound as Rust `DateTime<FixedOffset>` with the -03:00 offset preserved
- **AND** the backend does NOT normalize the value to UTC

#### Scenario: UNIQUEIDENTIFIER binds as Uuid

- **WHEN** the user filters `{ column: { kind: "named", name: "id" }, op: "=", value: "0bcdef12-3456-7890-abcd-ef1234567890" }` on a `uniqueidentifier` column
- **THEN** the parameter is bound as Rust `uuid::Uuid::parse_str(...)`

#### Scenario: BETWEEN on a date column binds both bounds

- **WHEN** the user filters `{ op: "BETWEEN", value: { min: "2026-03-01", max: "2026-03-31" } }` on a `date` column
- **THEN** the issued SQL contains `WHERE [due_date] BETWEEN @P1 AND @P2` with both parameters bound as Rust `NaiveDate`

#### Scenario: IN on an integer column binds each element as i32

- **WHEN** the user filters `{ op: "IN", value: [200, 201, 204] }` on an `int` column
- **THEN** the issued SQL contains `WHERE [status_code] IN (@P1, @P2, @P3)` and each parameter is bound as Rust `i32`

#### Scenario: CONTAINS on an nvarchar column binds as plain string

- **WHEN** the user filters `{ column: { kind: "named", name: "description" }, op: "CONTAINS", value: "argus" }` on an `nvarchar` column
- **THEN** the issued SQL contains `WHERE [description] LIKE '%' + @P1 + '%'` and the parameter is bound as Rust `&str("argus")`

#### Scenario: GEOMETRY filter is rejected

- **WHEN** the user filters `{ column: { kind: "named", name: "location" }, op: "=", value: "POINT(-70.6 -33.4)" }` on a `geometry` column
- **THEN** the command returns `AppError::Validation` indicating spatial predicates are not supported in the structured filter (use the SQL editor instead)

#### Scenario: ROWVERSION filter with comparison op is rejected

- **WHEN** the user filters `{ column: { kind: "named", name: "ver" }, op: "=", value: "..." }` on a `rowversion` column
- **THEN** the command returns `AppError::Validation` indicating rowversion is read-only for filtering (only `IS NULL` / `IS NOT NULL` are accepted)

#### Scenario: Mismatched value type returns a clear validation error

- **WHEN** the user invokes `mssql.queryTable` with `value: "abc"` on an `int` column
- **THEN** the command returns `AppError::Validation { message: "expected integer for column 'product_id', got 'abc'" }`

#### Scenario: Out-of-range integer is rejected

- **WHEN** the user filters with `value: 99999999999` on an `int` column (max `2147483647`)
- **THEN** the command returns `AppError::Validation` indicating the value is out of range

#### Scenario: Unknown column in filter is rejected before SQL dispatch

- **WHEN** the user invokes `mssql.queryTable` with a `filter` referencing a column name that does not exist on the relation
- **THEN** the command returns `AppError::Validation { message: "filter references unknown column '<name>'" }`

#### Scenario: Same coercion applies to count_table

- **WHEN** the user invokes `mssql.countTable` with the same `filter` shape used in `mssql.queryTable`
- **THEN** the bound parameters and placeholder shapes match exactly what `mssql.queryTable` produces

### Requirement: Table viewer tab state survives tab switches without refetch

A `mssql-table-data` tab SHALL retain its full in-memory state across any sequence of tab activations and deactivations within the same app session. The retained state MUST include:

- The fetched row buffer (every page loaded so far) and pagination cursor.
- The columns metadata returned by the most recent successful `mssql_query_table`.
- The selected row index (if any) and the inspector panel state.
- The unsaved edit buffer (pending row edits not yet applied).
- The active sub-tab (Data / Structure / Raw) and the data-grid scroll position.
- The filter "draft" state in the filter bar and any local UI state (column widths, inspector width).

Switching away from the tab and back MUST NOT dispatch any `mssql_query_table` or `mssql_count_table` invocation. The activity log MUST NOT show new `query_table` or `count_table` events as a result of tab activation alone.

A refetch of the first page MAY only be triggered by:
- A change to one of the query inputs that already resets the data buffer per the existing reset rules — applied filter, order-by, or page size.
- An explicit user-initiated refresh affordance (the `Refresh` button).
- The very first time the tab is rendered after being opened.

Closing the tab MUST discard all retained state. Reopening the same `(connectionId, schema, relation)` afterward MUST behave as a fresh first-time open.

#### Scenario: Returning to a table tab shows the same rows with no new fetch

- **WHEN** the user opens `sales.orders`, scrolls partway, selects row 17, switches tabs, then switches back
- **THEN** the data grid shows exactly the same rows as before
- **AND** the scroll position is preserved
- **AND** row 17 is still the selected row
- **AND** no new `mssql_query_table` event appears in the activity log between deactivation and reactivation

#### Scenario: Unsaved edits survive a tab switch

- **WHEN** the user edits a cell in `sales.orders` without applying, switches tabs, then switches back
- **THEN** the edited cell still shows the pending value with its dirty indicator

#### Scenario: Applying a filter still refetches

- **WHEN** the user is on a returned-to table tab and applies a new filter
- **THEN** a fresh `mssql_query_table` is dispatched per the existing reset rules

#### Scenario: Closing and reopening a table tab refetches

- **WHEN** the user closes the `sales.orders` tab and then reopens it
- **THEN** a fresh `mssql_query_table` is dispatched (first-time-open behavior)

### Requirement: Filter Apply always refetches

Every commit from `draft` to `applied` (via **Apply All**, the `⌘↵` / `⇧⌘↵` shortcuts, or the per-row **Apply** button) in the MSSQL filter bar MUST cause `mssql.queryTable` to be invoked, even when the resulting `applied` value is structurally equal to the previous `applied` value. The user's Apply gesture SHALL be treated as an explicit refresh signal.

`useTableData.refresh()` (the function bound to FilterBar's `onApply`) MUST unconditionally reset the buffer and trigger a first-page fetch. The internal `depsKey` guard in `useTableData` MUST NOT suppress the fetch when `refresh()` is invoked, even if `filterModel` (and therefore `depsKey`) is unchanged.

#### Scenario: Re-applying the same filter value refetches

- **WHEN** the user has `applied.rows = [{column: "n", op: "=", value: "1"}]`
- **AND** the user clears the value, then re-enters `"1"` and clicks `Apply All`
- **THEN** `applied` is structurally equal to its previous value
- **AND** `mssql.queryTable` is invoked again
- **AND** the grid displays the freshly-fetched rows

#### Scenario: Per-row Apply refetches even when the single row is unchanged

- **WHEN** `applied.rows === [R1]` and the user clicks per-row Apply on the same `R1`
- **THEN** `mssql.queryTable` is invoked again

#### Scenario: Empty Apply with already-empty applied still refetches

- **WHEN** `applied.rows === []` and the user presses `Apply All` from a draft with no enabled-complete rows
- **THEN** `mssql.queryTable` is invoked again with no filter

#### Scenario: Editing draft without Apply still does not fetch

- **WHEN** the user types into a row's value input without pressing Apply
- **THEN** `mssql.queryTable` is NOT invoked

### Requirement: Reload current table query

The MSSQL table viewer (Data subtab) SHALL provide a user-initiated **Reload** affordance that refetches the first page of the current relation, preserving the active filter model, sort order, and page size. Reload MUST be exposed as BOTH (a) a visible icon button placed in the tab header next to the Filter toggle (Data subtab only), and (b) a global keyboard shortcut **⌘R** (macOS) / **Ctrl+R** (Linux/Windows) bound while the table-viewer tab is the active tab.

The Reload button MUST use the lucide `RotateCw` icon at 13px, MUST render only when the Data subtab is active, and MUST be disabled while `tableData.isLoading` reflects the first-page fetch path. When disabled, the icon MUST animate (continuous rotation). The hover title MUST read `"Reload (⌘R)"`.

Triggering Reload (button click or shortcut) MUST call `tableData.refresh()`, which is the existing always-refetch entry point on `useTableData` (it bumps the internal `applyToken` and reissues the current query unconditionally). Reload MUST NOT modify the draft or applied filter model, MUST NOT modify the sort or page size, MUST NOT clear the row selection, MUST NOT mutate the edit buffer, and MUST NOT change the current subtab.

The ⌘R / Ctrl+R shortcut MUST fire even when focus is inside an `<input>`, `<textarea>`, or `<select>` element. The shortcut MUST be ignored when focus is inside a CodeMirror editor surface. The shortcut handler MUST call `event.preventDefault()` whenever it acts, to suppress the browser/Tauri default reload. The shortcut MUST only fire when the tab is the active tab.

#### Scenario: Reload button visible on Data subtab

- **WHEN** the user opens an MSSQL table viewer tab on the Data subtab
- **THEN** a Reload icon button (lucide `RotateCw`, 13px) is rendered next to the Filter toggle
- **AND** hovering shows the title `"Reload (⌘R)"`

#### Scenario: Reload button hidden on non-Data subtabs

- **WHEN** the user switches to a non-Data subtab (e.g. Structure, Raw)
- **THEN** the Reload button is not rendered

#### Scenario: Clicking Reload invokes tableData.refresh

- **WHEN** the user clicks the Reload button while `tableData.isLoading === false`
- **THEN** `tableData.refresh()` is called exactly once
- **AND** the internal `applyToken` advances by 1
- **AND** `useTableData` issues a fresh `mssql_query_table` request with the current `limit`, `offset: 0`, `order_by`, and applied filter model

#### Scenario: ⌘R fires the same refetch as the button

- **WHEN** the MSSQL table viewer tab is active and the user presses ⌘R (or Ctrl+R on non-macOS)
- **THEN** `tableData.refresh()` is called
- **AND** the default page-reload behavior does NOT occur

#### Scenario: ⌘R fires from input focus

- **WHEN** the user is focused inside a filter-bar input and presses ⌘R
- **THEN** `tableData.refresh()` is called
- **AND** the input's value is not modified

#### Scenario: ⌘R is suppressed when CodeMirror has focus

- **WHEN** the user is focused inside a CodeMirror surface and presses ⌘R
- **THEN** `tableData.refresh()` is NOT called

#### Scenario: Reload disabled during first-page fetch

- **WHEN** the data view is in a first-page loading state
- **THEN** the Reload button is disabled
- **AND** the icon rotates continuously to signal in-flight work

#### Scenario: Reload preserves filter, sort, page size, edit buffer, and selection

- **GIVEN** filters, sort, page size, row selection, and pending edits are all set
- **WHEN** the user triggers Reload
- **THEN** all of those values are preserved across the refetch

#### Scenario: Reload does not fire from inactive tabs

- **GIVEN** two MSSQL table viewer tabs are open, only the second is active
- **WHEN** the user presses ⌘R
- **THEN** only the active tab refetches

