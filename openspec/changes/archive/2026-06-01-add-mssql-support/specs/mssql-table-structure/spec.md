## ADDED Requirements

### Requirement: Table structure command

The MS SQL Server module SHALL expose a Tauri command `mssql_table_structure(id, schema, relation, origin?)` that returns columns, primary key, unique constraints, foreign keys, indexes, check constraints, default constraints, triggers, and table options in a single response. The optional `origin` argument MUST be `"user"` or `"auto"` and defaults to `"auto"` when absent.

The response payload MUST be:

```
{
  schema: string,
  relation: string,
  columns: Array<{
    name: string,
    ordinal: number,
    data_type: string,
    full_type: string,
    nullable: boolean,
    default: string | null,
    comment: string,
    collation: string | null,
    is_identity: boolean,
    identity_seed: number | null,
    identity_increment: number | null,
    is_computed: boolean,
    computed_expression: string | null,
    is_persisted: boolean,
    is_sparse: boolean,
    category: "numeric" | "string" | "temporal" | "binary" | "spatial" | "xml" | "uniqueidentifier" | "hierarchyid" | "sql_variant" | "other"
  }>,
  primary_key: { name: string, columns: string[], identity_column: string | null } | null,
  unique_constraints: Array<{ name: string, columns: string[], is_clustered: boolean }> | null,
  foreign_keys: Array<{
    name: string,
    columns: string[],
    referenced_schema: string,
    referenced_table: string,
    referenced_columns: string[],
    on_update: string,
    on_delete: string,
    is_disabled: boolean,
    is_not_trusted: boolean
  }> | null,
  indexes: Array<{
    name: string,
    columns: Array<{ name: string, direction: "ASC" | "DESC", is_included: boolean }>,
    unique: boolean,
    type: "CLUSTERED" | "NONCLUSTERED" | "XML" | "SPATIAL" | "COLUMNSTORE" | "HEAP",
    is_column_store: boolean,
    filter_definition: string | null
  }> | null,
  check_constraints: Array<{ name: string, definition: string, is_disabled: boolean, is_not_trusted: boolean }> | null,
  default_constraints: Array<{ name: string, column: string, definition: string }> | null,
  triggers: Array<{
    name: string,
    event: "INSERT" | "UPDATE" | "DELETE" | "INSERT,UPDATE" | "INSERT,DELETE" | "UPDATE,DELETE" | "INSERT,UPDATE,DELETE",
    timing: "AFTER" | "INSTEAD OF",
    is_disabled: boolean,
    definition: string
  }> | null,
  table_options: {
    is_memory_optimized: boolean,
    temporal_type: "NON_TEMPORAL" | "HISTORY_TABLE" | "SYSTEM_VERSIONED_TEMPORAL_TABLE",
    lock_escalation_desc: string | null,
    is_partitioned: boolean,
    filegroup: string | null
  } | null,
  failures: Array<{ kind: string, code: string | null, message: string }>
}
```

The command MUST acquire a connection from the existing MS SQL Server pool registry and MUST quote all identifiers with square brackets (doubling embedded `]`). Sub-queries (columns, primary_key, unique_constraints, foreign_keys, indexes, check_constraints, default_constraints, triggers, table_options) MUST run concurrently through `tokio::join!`. Each sub-query runs under an 8s per-query timeout; the whole command runs under a 10s total timeout. On per-query timeout, the command MUST cancel the in-flight statement against the active connection before resolving the join.

`columns` MUST be sourced from `sys.columns` joined with `sys.types` (on `user_type_id`) and optionally `sys.computed_columns` (on `object_id` + `column_id`) and `sys.identity_columns` (on `object_id` + `column_id`). `full_type` MUST include length, precision, scale, and signedness (e.g., `varchar(255)`, `decimal(18,4)`, `nvarchar(max)`). `data_type` MUST be the base type name without parameters (e.g., `varchar`, `decimal`, `nvarchar`). For `varchar(max)` / `nvarchar(max)` / `varbinary(max)`, `full_type` MUST render the literal `max` keyword.

`columns.category` MUST be derived from the type name: `bit/tinyint/smallint/int/bigint/decimal/numeric/money/smallmoney/float/real` → `"numeric"`; `char/varchar/nchar/nvarchar/text/ntext` → `"string"`; `date/time/datetime/datetime2/datetimeoffset/smalldatetime` → `"temporal"`; `binary/varbinary/image` → `"binary"`; `geography/geometry` → `"spatial"`; `xml` → `"xml"`; `uniqueidentifier` → `"uniqueidentifier"`; `hierarchyid` → `"hierarchyid"`; `sql_variant` → `"sql_variant"`; otherwise `"other"`.

`columns.is_identity`, `columns.identity_seed`, `columns.identity_increment` MUST be populated from `sys.identity_columns` when the column is an IDENTITY column. `identity_seed` and `identity_increment` MUST be `null` when `is_identity` is `false`.

`columns.is_computed`, `columns.computed_expression`, `columns.is_persisted` MUST be populated from `sys.computed_columns` when the column is computed. `is_computed` MUST be `false` for regular columns and `computed_expression` / `is_persisted` MUST be `null`.

`columns.is_sparse` MUST be populated from `sys.columns.is_sparse`.

`primary_key` MUST be derived from `sys.indexes` joined with `sys.index_columns` filtered by `is_primary_key = 1`, ordered by `key_ordinal`. `identity_column` MUST be the name of the IDENTITY column whose ordinal participates in the PK, or `null` if no PK column is IDENTITY.

`unique_constraints` MUST come from `sys.indexes` joined with `sys.index_columns` filtered by `is_unique_constraint = 1`, ordered by `key_ordinal`. `is_clustered` MUST be `true` when `sys.indexes.type_desc = 'CLUSTERED'`.

`foreign_keys` MUST come from `sys.foreign_keys` joined with `sys.foreign_key_columns`, with `referenced_schema` / `referenced_table` resolved via `sys.objects` + `sys.schemas`. `on_update` and `on_delete` MUST be one of `"NO_ACTION"`, `"CASCADE"`, `"SET_NULL"`, `"SET_DEFAULT"` (from `delete_referential_action_desc` / `update_referential_action_desc`).

`indexes` MUST come from `sys.indexes` joined with `sys.index_columns` (excluding `is_primary_key = 1` and `is_unique_constraint = 1`), ordered by `key_ordinal`. `type` MUST be derived from `type_desc`. `is_column_store` MUST be `true` when `type_desc IN ('CLUSTERED COLUMNSTORE', 'NONCLUSTERED COLUMNSTORE')`. `columns[].is_included` MUST be `true` when `sys.index_columns.is_included_column = 1`. `filter_definition` MUST be the verbatim filter predicate for filtered indexes (or `null`).

`check_constraints` MUST come from `sys.check_constraints` filtered by `parent_object_id = OBJECT_ID(@table)`. `definition` MUST be the verbatim predicate text.

`default_constraints` MUST come from `sys.default_constraints` joined with `sys.columns` (on `parent_object_id` + `parent_column_id`). `definition` MUST be the verbatim default expression text.

`triggers` MUST come from `sys.triggers` filtered by `parent_id = OBJECT_ID(@table)` joined with `OBJECT_DEFINITION(object_id)` for the body. `event` MUST be the comma-joined set of trigger events (`INSERT`, `UPDATE`, `DELETE`) derived from `sys.trigger_events`. `timing` MUST be `"INSTEAD OF"` when `is_instead_of_trigger = 1`, else `"AFTER"`.

`table_options` MUST come from `sys.tables` reading `is_memory_optimized`, `temporal_type_desc` (mapped to the `temporal_type` enum), `lock_escalation_desc`, `partition_scheme_id` (non-null → `is_partitioned = true`), and the data filegroup via `sys.data_spaces`.

The partial-degradation envelope MUST be applied identically to other MS SQL Server multi-query commands: any sub-query that fails MUST result in `null` for that field and a `KindFailure` entry in `failures` with `kind` set to one of `"columns" | "primary_key" | "unique_constraints" | "foreign_keys" | "indexes" | "check_constraints" | "default_constraints" | "triggers" | "table_options"`. A failure on the columns sub-query specifically MUST cause the whole command to return `AppError::Mssql` (columns are required to render anything useful); other sub-query failures MUST NOT fail the command.

For Azure SQL Database, certain `sys.*` views may be unavailable or restricted (e.g., cross-database `sys.databases` queries). Sub-queries that hit unavailable catalog views on Azure SQL MUST degrade gracefully via the partial-degradation envelope rather than failing the whole command.

The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "table_structure"`, `connection_id: <id>`, `origin: <origin argument>`, `sql: null`, `params: null`, `metric: { kind: "items", value: <columns + indexes + triggers + foreign_keys + unique_constraints + check_constraints + default_constraints + (1 if primary_key else 0)> }` on success (`null` on failure), and `status` matching the result.

#### Scenario: Returns columns, constraints, indexes, triggers, FKs in one call

- **WHEN** the user invokes `mssql.tableStructure(id, "dbo", "Orders")` against a table with 12 columns, 1 PK, 2 FKs, 1 unique constraint, 3 indexes, 1 trigger, 1 check, 2 default constraints
- **THEN** the response has `columns.length === 12`, `primary_key.columns.length >= 1`, `foreign_keys.length === 2`, `unique_constraints.length === 1`, `indexes.length === 3`, `triggers.length === 1`, `check_constraints.length === 1`, `default_constraints.length === 2`
- **AND** `table_options.is_memory_optimized` is a boolean

#### Scenario: Square-bracket identifier quoting

- **WHEN** the user invokes the command for a table named `we]ird` (containing a closing bracket)
- **THEN** every catalog query references the schema/relation parameters as bound parameters (not interpolated identifiers)
- **AND** any direct identifier use in emitted SQL escapes `]` by doubling it (`[we]]ird]`)

#### Scenario: Read-only connection still serves the command

- **WHEN** the user invokes the command on a connection in `read_only: true`
- **THEN** the command succeeds and returns the structure (it never mutates state)

#### Scenario: Unknown relation returns a hard error

- **WHEN** the user invokes the command for `dbo.does_not_exist`
- **THEN** the command returns `AppError::Mssql` with the underlying server error (e.g., `208` `Invalid object name`) or an empty-columns failure
- **AND** one `argus:activity-log` event is emitted with `kind: "table_structure"`, `status: "err"`, `metric: null`

#### Scenario: Per-kind failure with non-permission code is reported

- **WHEN** the catalog query for indexes times out after the 8s per-query window
- **THEN** `indexes` is `null`
- **AND** `failures` contains `{ kind: "indexes", code: <sqlstate or null>, message: <…> }`
- **AND** the rest of the response is still populated and the activity-log event reports `status: "ok"`

#### Scenario: Failure on the columns sub-query fails the whole command

- **WHEN** the catalog query for `sys.columns` returns an unexpected error (e.g., connection reset)
- **THEN** the command returns `AppError::Mssql` and no partial payload is returned

#### Scenario: User-initiated call carries origin user in the activity log

- **WHEN** the Structure subtab fires its first activation with `origin: "user"`
- **THEN** the emitted `argus:activity-log` event has `origin: "user"`, `kind: "table_structure"`, `metric: { kind: "items", value: <total> }`, `status: "ok"`

#### Scenario: Origin defaults to auto when omitted

- **WHEN** any caller invokes the command without supplying `origin`
- **THEN** the emitted `argus:activity-log` event has `origin: "auto"`

#### Scenario: full_type preserves parameters including max

- **WHEN** a column is declared `nvarchar(max)` and another `decimal(18,4)`
- **THEN** the first column's `full_type` is `"nvarchar(max)"` and `data_type` is `"nvarchar"`
- **AND** the second column's `full_type` is `"decimal(18,4)"` and `data_type` is `"decimal"`

#### Scenario: IDENTITY column metadata is surfaced

- **WHEN** a column is declared `Id BIGINT IDENTITY(1000, 5) NOT NULL`
- **THEN** the column entry has `is_identity: true`, `identity_seed: 1000`, `identity_increment: 5`
- **AND** when `Id` is the PK, `primary_key.identity_column === "Id"`

#### Scenario: Computed column surfaces expression and persisted flag

- **WHEN** a column is declared `TotalWithTax AS (Total * 1.19) PERSISTED`
- **THEN** the column entry has `is_computed: true`, `computed_expression: "([Total]*(1.19))"` (or the verbatim server-normalized form), `is_persisted: true`

#### Scenario: Spatial / xml / hierarchyid columns carry category badges

- **WHEN** a column is declared `geography` and another `xml` and another `hierarchyid`
- **THEN** the three column entries have `full_type` of `"geography"`, `"xml"`, `"hierarchyid"` respectively
- **AND** their `category` fields are `"spatial"`, `"xml"`, `"hierarchyid"` respectively

#### Scenario: Sparse column flag is surfaced

- **WHEN** a column is declared `MiddleName VARCHAR(100) SPARSE NULL`
- **THEN** the column entry has `is_sparse: true`

#### Scenario: Column-store index flag is surfaced

- **WHEN** an index is `CREATE NONCLUSTERED COLUMNSTORE INDEX ix_orders_cs ON Orders (...)`
- **THEN** the index entry has `type: "COLUMNSTORE"` and `is_column_store: true`

#### Scenario: Included index columns surface

- **WHEN** an index is declared with `INCLUDE (col_a, col_b)`
- **THEN** the index entry's `columns` array contains entries for `col_a` and `col_b` with `is_included: true`

#### Scenario: Filtered index surfaces filter definition

- **WHEN** an index is declared `WHERE IsDeleted = 0`
- **THEN** the index entry's `filter_definition` is `"([IsDeleted]=(0))"` (verbatim server form)

### Requirement: Synthesized table DDL command

The MS SQL Server module SHALL expose a Tauri command `mssql_table_ddl(id, schema, relation, origin?)` that returns `{ ddl: string }`. For tables, the DDL MUST be SYNTHESIZED by stitching together `sys.columns`, `sys.indexes`, `sys.foreign_keys`, `sys.check_constraints`, `sys.default_constraints`, and IDENTITY info into a single `CREATE TABLE` statement. For views, procedures, functions, and triggers, the DDL MUST be sourced from `OBJECT_DEFINITION(object_id)` which returns the original source text verbatim. The command MUST run under a single 5s timeout.

The command MUST detect the relkind via `sys.objects.type` (`U` → table, `V` → view, `P` → procedure, `FN`/`IF`/`TF`/`FS`/`FT` → function, `TR` → trigger) and route accordingly.

The synthesized `CREATE TABLE` output is explicitly NOT a byte-perfect reproduction of SSMS `Script Table As → CREATE`. v1 ships a reasonable approximation covering:

- All columns with `full_type`, NULL/NOT NULL, DEFAULT, IDENTITY, computed-column expressions (PERSISTED when applicable), SPARSE, COLLATE clauses
- PRIMARY KEY constraint (clustered / non-clustered as declared)
- UNIQUE constraints (clustered / non-clustered)
- FOREIGN KEY constraints with ON UPDATE / ON DELETE clauses, WITH NOCHECK when disabled / untrusted
- CHECK constraints (WITH NOCHECK when disabled / untrusted)
- DEFAULT constraints with their constraint names
- Non-PK / non-unique indexes emitted as separate `CREATE INDEX` statements after the `CREATE TABLE` block, including INCLUDE columns, filter predicates, and CLUSTERED / NONCLUSTERED / COLUMNSTORE modifiers
- Identifiers quoted with square brackets

The synthesized DDL MUST NOT attempt to reproduce: partition schemes, file groups, indexed-view metadata, full-text indexes, extended properties, table-level options (LOCK_ESCALATION, MEMORY_OPTIMIZED, SYSTEM_VERSIONING). A v1 banner in the Raw subtab MUST disclose this (see the Raw subtab requirement).

For views / procedures / functions / triggers, the returned `ddl` MUST be the exact string returned by `SELECT OBJECT_DEFINITION(OBJECT_ID(@qualified_name))`. The command MUST NOT modify whitespace, line endings, quoting, or capitalization in that output. If `OBJECT_DEFINITION` returns `NULL` (e.g., the object's definition is encrypted via `WITH ENCRYPTION`), the command MUST return `AppError::Mssql` with a message indicating the definition is unavailable.

The command MUST emit exactly one `argus:activity-log` event with `kind: "table_ddl"`, `origin: <origin>`, `sql: null`, `params: null`, `metric: { kind: "items", value: 1 }` on success (`null` on failure), and `status` matching the result.

#### Scenario: Synthesized CREATE TABLE for a table

- **WHEN** the user invokes `mssql.tableDdl(id, "dbo", "Orders")` against a table with 3 columns, 1 PK, 1 FK, 1 default constraint
- **THEN** the response `ddl` starts with `CREATE TABLE [dbo].[Orders]` (or equivalent quoted form)
- **AND** the body contains the column definitions, the PK constraint, the FK constraint with ON DELETE / ON UPDATE clauses, and the default constraint
- **AND** the output is a single well-formed `CREATE TABLE` statement that the server would accept (modulo extended metadata)

#### Scenario: Synthesized DDL emits indexes as separate CREATE INDEX statements

- **WHEN** the table has 2 non-PK / non-unique indexes
- **THEN** the response `ddl` contains the `CREATE TABLE` block followed by exactly 2 `CREATE [NONCLUSTERED] INDEX` statements separated by `GO` batch separators (or blank lines if the simpler form is chosen)

#### Scenario: View dispatches OBJECT_DEFINITION

- **WHEN** the relation is a view (`sys.objects.type = 'V'`)
- **THEN** the command issues `SELECT OBJECT_DEFINITION(OBJECT_ID(@qualified_name))` instead of synthesizing DDL
- **AND** the returned column value populates `ddl` byte-identically (including comments, whitespace, original casing)

#### Scenario: Procedure dispatches OBJECT_DEFINITION

- **WHEN** the relation is a stored procedure (`sys.objects.type = 'P'`)
- **THEN** the command issues `OBJECT_DEFINITION` and returns the verbatim `CREATE PROCEDURE …` source text

#### Scenario: Encrypted object returns a hard error

- **WHEN** the relation is a view / procedure / function / trigger created `WITH ENCRYPTION` such that `OBJECT_DEFINITION` returns `NULL`
- **THEN** the command returns `AppError::Mssql` with a message indicating the definition is encrypted / unavailable
- **AND** the activity-log event reports `status: "err"` and `metric: null`

#### Scenario: Timeout returns a hard error

- **WHEN** the synthesis or `OBJECT_DEFINITION` query does not return within 5s
- **THEN** the command returns `AppError::Mssql` with a timeout indication
- **AND** the activity-log event reports `status: "err"` and `metric: null`

#### Scenario: Unknown relation surfaces server error

- **WHEN** the user invokes the command for `dbo.does_not_exist`
- **THEN** the command returns `AppError::Mssql` carrying the MS SQL Server error (`208` `Invalid object name`)

#### Scenario: Computed and IDENTITY columns are emitted in the synthesized DDL

- **WHEN** a table has a column `Id BIGINT IDENTITY(1, 1) NOT NULL` and a computed `TotalWithTax AS (Total * 1.19) PERSISTED`
- **THEN** the synthesized DDL contains `[Id] [bigint] IDENTITY(1,1) NOT NULL` (or equivalent) and `[TotalWithTax] AS ([Total]*(1.19)) PERSISTED`

### Requirement: Structure subtab UI

The frontend SHALL render a Structure subtab as one of the two subtabs of the `mssql-table-data` viewer (see the `mssql-data-grid` capability for the sub-tabset rules). The subtab MUST consume the response of `mssql_table_structure` and render the following sections in this order, each with a hairline-bordered section header in the `DESIGN.md` typography:

1. **Columns** — a borderless table with one row per column. Columns: `#` (ordinal), `Name`, `Type` (renders `full_type`, e.g., `VARCHAR(255)`, `DECIMAL(18,4)`, with a category badge for `spatial` / `xml` / `hierarchyid` / `sql_variant` / `binary` columns), `Nullable` (✓ / —), `Default` (renders the default-constraint expression or `—`), `Extra` (badges for `IDENTITY(seed, increment)`, `COMPUTED` + optional `PERSISTED`, `SPARSE`), `PK` (✓ if member of `primary_key.columns`), `FK` (a small chip linking to the referenced relation if member of any FK; clicking the chip MUST open the referenced table in a new `mssql-table-data` tab), `Comment`. Names use `Geist Mono`. Numeric ordinals use tabular numerals.
2. **Indexes** — one row per index: `Name`, `Type` (CLUSTERED / NONCLUSTERED / COLUMNSTORE / XML / SPATIAL badge), `Columns` (rendered as `col1, col2 DESC` with included columns shown as a separate `INCLUDE (col_a, col_b)` clause), `Unique` (✓ / —), `Filter` (the `filter_definition` for filtered indexes, or `—`). Hidden if `indexes` is empty (after partial-degradation collapse) AND `failures` does not list `"indexes"`.
3. **Foreign keys** — one row per FK: `Name`, `Columns`, `→ References` (rendered as `schema.relation(col1, …)` and clickable — opens the referenced table in a new `mssql-table-data` tab), `On update`, `On delete`, `Status` (chip for `disabled` / `not trusted` when applicable). Hidden if `foreign_keys` is empty AND `failures` does not list `"foreign_keys"`.
4. **Unique constraints** — one row per UNIQUE constraint: `Name`, `Columns`, `Clustered` (✓ / —). Hidden if empty AND not in failures.
5. **Check constraints** — one row per CHECK: `Name`, `Definition` (rendered in a collapsible code block in `Geist Mono`), `Status` (chip for `disabled` / `not trusted` when applicable). Hidden if empty AND not in failures.
6. **Default constraints** — one row per DEFAULT: `Name`, `Column`, `Definition`. Hidden if empty AND not in failures.
7. **Triggers** — one row per trigger: `Name`, `Timing + Event` (e.g., `AFTER INSERT,UPDATE`), `Definition` (rendered in a collapsible code block in `Geist Mono`, sourced from `OBJECT_DEFINITION`), `Status` (chip for `disabled` when applicable). Hidden if empty AND not in failures.
8. **Table options** — a key/value list rendering `is_memory_optimized`, `temporal_type`, `lock_escalation_desc`, `is_partitioned`, `filegroup` (when non-null). Hidden if `table_options` is `null` AND not in failures.

If a section's underlying field is `null` (per-kind failure), the section MUST render with an inline error chip reading `Couldn't load <kind> — <message>` and a `Retry` button that re-issues the whole `mssql_table_structure` call. The Retry button MUST issue with `origin: "user"`.

The subtab MUST also render a header with: the relation's fully-qualified name (`[schema].[relation]` in `Geist Mono`), the relkind label ("Table" or "View"), and a **Refresh** button that re-issues `mssql_table_structure(origin: "user")` and replaces the cached response on success.

For views, the **Foreign keys**, **Unique constraints**, **Check constraints**, **Default constraints**, and **Triggers** sections MUST render an empty-state copy reading "Views do not declare constraints — see the underlying tables." instead of being hidden, to keep the section list stable across relkinds.

The Structure subtab MUST be entirely read-only in v1. There are no inline DDL edit affordances regardless of connection mode (`read_only` or writable). This matches the Postgres v1 and MySQL v1 contract.

#### Scenario: First activation fetches the structure

- **WHEN** the user opens a table tab and clicks the **Structure** subtab for the first time
- **THEN** exactly one `mssql_table_structure` call is dispatched with `origin: "user"`
- **AND** while the call is in flight, the Structure subtab renders a skeleton or spinner

#### Scenario: Cached after first fetch, no refetch on re-activation

- **WHEN** the user has activated Structure once (loaded the cached response), navigates to Data, and returns to Structure
- **THEN** no new `mssql_table_structure` call is dispatched
- **AND** the cached response is rendered immediately

#### Scenario: Refresh button re-issues the call

- **WHEN** the user clicks **Refresh** in the Structure subtab header
- **THEN** a new `mssql_table_structure` call is dispatched with `origin: "user"`
- **AND** the cached response is replaced on success

#### Scenario: Columns section renders full_type and identity badge

- **WHEN** the response has a column with `full_type: "bigint"`, `is_identity: true`, `identity_seed: 1`, `identity_increment: 1`
- **THEN** the Type cell reads `bigint` and the Extra cell renders an `IDENTITY(1,1)` badge

#### Scenario: Computed column renders PERSISTED badge

- **WHEN** the response has a column with `is_computed: true`, `is_persisted: true`, `computed_expression: "([Total]*(1.19))"`
- **THEN** the Extra cell renders `COMPUTED PERSISTED` badges and the Default cell shows the expression `([Total]*(1.19))`

#### Scenario: Spatial column renders category badge

- **WHEN** the response has a column with `full_type: "geography"`, `category: "spatial"`
- **THEN** the Type cell renders `geography` alongside a small `spatial` category badge

#### Scenario: Index INCLUDE columns are rendered separately

- **WHEN** an index has key columns `[col_a]` and included columns `[col_b, col_c]`
- **THEN** the Indexes row renders `col_a` in the key columns area and `INCLUDE (col_b, col_c)` as a secondary clause

#### Scenario: Index DESC direction is rendered

- **WHEN** an index has `columns: [{ name: "CreatedAt", direction: "DESC", is_included: false }]`
- **THEN** the Indexes row renders the column as `CreatedAt DESC`

#### Scenario: FK chip opens the referenced table

- **WHEN** the user clicks the FK chip on the `CustomerId` column referencing `dbo.Customers(Id)`
- **THEN** a new `mssql-table-data` tab is opened for `dbo.Customers` and focused
- **AND** the original tab remains open with the same active subtab

#### Scenario: FK disabled chip is shown

- **WHEN** a foreign key has `is_disabled: true`
- **THEN** the Status cell renders a `disabled` chip
- **AND** when `is_not_trusted: true`, an additional `not trusted` chip is rendered

#### Scenario: Check constraint definition is collapsible

- **WHEN** a check constraint has a multi-line `definition`
- **THEN** the Definition cell renders a collapsible code block, collapsed by default to a single-line preview

#### Scenario: Trigger definition is collapsible

- **WHEN** a trigger's `definition` (from `OBJECT_DEFINITION`) spans many lines
- **THEN** the Definition cell renders a collapsible code block, collapsed by default to a single-line preview

#### Scenario: View keeps constraint sections with empty state

- **WHEN** the relation is a view
- **THEN** the Foreign keys, Unique constraints, Check constraints, Default constraints, and Triggers sections are rendered with the empty-state copy "Views do not declare constraints — see the underlying tables."

#### Scenario: Per-kind failure surfaces an inline retry

- **WHEN** the response has `indexes: null` and `failures` contains `{ kind: "indexes", code: null, message: "…" }`
- **THEN** the Indexes section renders an inline error chip "Couldn't load indexes — …" with a `Retry` button
- **AND** clicking Retry re-issues `mssql_table_structure(origin: "user")`

### Requirement: Raw subtab UI

The frontend SHALL render a Raw subtab as one of the two subtabs of the `mssql-table-data` viewer. On first activation it MUST dispatch a `mssql_table_ddl` call (independent of the Structure subtab's `mssql_table_structure` cache — these are two separate commands) and render the `ddl` field in a read-only CodeMirror 6 editor configured with the MS SQL Server SQL dialect (T-SQL) for syntax highlighting only. The editor MUST:

- Have `EditorView.editable.of(false)` so the user cannot type into it.
- Be wrapped (no horizontal scrollbar by default — long DDL lines wrap).
- NOT enable autocomplete, the run shortcut (`Cmd+Enter`), or any keymap beyond the default text-selection bindings.
- Use the same theme tokens already in use by the existing CodeMirror surfaces in the app (matched to `DESIGN.md`).

The Raw subtab MUST render:

- For tables: the v1 synthesized `CREATE TABLE` output produced by `mssql_table_ddl`. Above the editor, in muted text, a header MUST read `Synthesized CREATE TABLE — v1 approximation. Does not include partition schemes, file groups, full-text indexes, extended properties, or table-level options (LOCK_ESCALATION, MEMORY_OPTIMIZED, SYSTEM_VERSIONING). For full DDL, use SSMS Script Table As.`
- For views / procedures / functions / triggers: the verbatim `OBJECT_DEFINITION` output. The header MUST read `OBJECT_DEFINITION — server output, unmodified.`

For verbatim `OBJECT_DEFINITION` output (views / procedures / functions / triggers), the editor MUST render the server output byte-identically — no whitespace normalization, no re-quoting, no capitalization changes.

The Raw subtab MUST also render:

- A **Copy** button that copies the entire `ddl` string to the system clipboard via the Tauri clipboard API and shows a brief "Copied" affordance.
- A **Refresh** button that re-issues `mssql_table_ddl(origin: "user")` and replaces the cache on success.

The Raw subtab MUST be entirely read-only on every connection (`read_only` or writable).

#### Scenario: First activation dispatches mssql_table_ddl

- **WHEN** the user opens a fresh table tab and clicks **Raw** without first visiting Structure
- **THEN** exactly one `mssql_table_ddl` call is dispatched with `origin: "user"`
- **AND** no `mssql_table_structure` call is dispatched

#### Scenario: Cached DDL is reused on re-activation

- **WHEN** the user has activated Raw once (response is cached), navigates to Structure, and returns to Raw
- **THEN** no new `mssql_table_ddl` call is dispatched
- **AND** the cached `ddl` is rendered immediately

#### Scenario: Copy button writes the DDL to clipboard

- **WHEN** the user clicks the **Copy** button on the Raw subtab
- **THEN** the system clipboard contains exactly the `ddl` string (byte-identical to the command response)
- **AND** the button shows a brief "Copied" affordance for ~1.5s

#### Scenario: Editor is read-only

- **WHEN** the user clicks inside the CodeMirror editor and types
- **THEN** no characters are inserted (the editor rejects input)
- **AND** the user can still select and copy text via the OS

#### Scenario: Synthesized DDL header is shown for tables

- **WHEN** the relation is a table and the Raw subtab is active
- **THEN** the header above the editor reads `Synthesized CREATE TABLE — v1 approximation. Does not include partition schemes, file groups, full-text indexes, extended properties, or table-level options (LOCK_ESCALATION, MEMORY_OPTIMIZED, SYSTEM_VERSIONING). For full DDL, use SSMS Script Table As.`

#### Scenario: View renders OBJECT_DEFINITION output

- **WHEN** the relation is a view named `dbo.ActiveUsers`
- **THEN** the Raw subtab editor shows the unmodified `OBJECT_DEFINITION` value (typically starting with `CREATE VIEW [dbo].[ActiveUsers]` or `create view dbo.ActiveUsers` depending on original source casing)
- **AND** the header reads `OBJECT_DEFINITION — server output, unmodified.`

#### Scenario: Encrypted object surfaces an error state in the Raw subtab

- **WHEN** the relation is a view created `WITH ENCRYPTION` and `mssql_table_ddl` returns `AppError::Mssql`
- **THEN** the Raw subtab renders an inline error state with the encryption message and a `Retry` button
- **AND** the editor is not rendered

### Requirement: Per-tab structure cache

The frontend SHALL cache the responses of `mssql_table_structure` and `mssql_table_ddl` on the `MssqlTableViewerTab` instance for the lifetime of the tab AND for the lifetime of a single `(connectionId, schema, relation)` triple. The structure cache and the DDL cache are separate slots — fetching one MUST NOT populate the other. Each cache MUST be populated on first successful response and replaced atomically on every subsequent successful Refresh. The caches MUST NOT be shared across tabs — two `mssql-table-data` tabs of the same `(connectionId, schema, relation)` MUST each have their own independent caches.

The caches MUST be keyed on `(connectionId, schema, relation)`. When the same `useMssqlTableStructureCache` (or `useMssqlTableDdlCache`) invocation is rerun with a different triple — which happens when the user switches between two open `mssql-table-data` tabs — the hook MUST detect the change synchronously during render, reset its state to `{ status: "idle", response: null, error: null }`, and clear the in-flight promise reference. The next render MUST NOT show the previous triple's `response` or `error`, and a follow-up `ensureLoaded` MUST dispatch a fresh call against the new triple.

A response that started before a triple change MUST NOT update the cache after the triple change. The hook MUST track an internal generation counter that increments on every triple change, capture it at the start of each dispatch, and discard the response if the generation has advanced when the response resolves.

When a fetch is in flight and a second activation of the same subtab occurs against the *same* triple, no second fetch MUST be dispatched; the second activation MUST share the in-flight promise.

The structure cache and DDL cache MUST be invalidated on:

- A `Schema: Refresh` palette command for the connection — both caches cleared for every tab on that connection.
- A successful `mssql_apply_table_edits` against the table — both caches cleared for tabs whose `(connectionId, schema, relation)` matches the edited table (the synthesized DDL may have changed via triggers, computed columns, or default constraints; conservative invalidation).
- A `mssql:active-changed` event reporting that the connection has disconnected — both caches cleared for every tab on that connection.

#### Scenario: Two tabs of the same relation have independent caches

- **WHEN** the user has tab A and tab B open on `dbo.Users` (two separate `mssql-table-data` tabs)
- **AND** the user clicks Refresh on tab A's Structure subtab
- **THEN** tab A's structure cache is replaced
- **AND** tab B's structure cache is unchanged

#### Scenario: Structure and DDL caches are independent

- **WHEN** the user clicks Structure on a fresh tab and waits for the response, then clicks Raw
- **THEN** `mssql_table_structure` has been dispatched once AND `mssql_table_ddl` has been dispatched once
- **AND** Refreshing Structure does not invalidate the DDL cache, and vice versa

#### Scenario: Switching to a different table tab clears stale Structure and Raw

- **WHEN** the user has loaded Structure and Raw on tab A (`dbo.Orders`) — both caches are `ready`
- **AND** the user switches to tab B (`dbo.Customers`) and clicks the Structure subtab
- **THEN** the Structure subtab on tab B does NOT render tab A's response
- **AND** a fresh `mssql_table_structure` call is dispatched for `dbo.Customers`

#### Scenario: Switching tabs while a fetch is in flight does not poison the new tab's cache

- **WHEN** the user clicks Structure on tab A (`dbo.Orders`), the call starts but has not resolved
- **AND** the user switches to tab B (`dbo.Customers`) and clicks Structure before tab A's fetch resolves
- **THEN** tab A's pending response, when it eventually resolves, MUST NOT be written into the cache
- **AND** a fresh fetch is dispatched for `dbo.Customers`

#### Scenario: Schema refresh invalidates both caches

- **WHEN** the user runs the `Schema: Refresh` palette command for the connection while tab A's Structure and Raw caches are populated
- **THEN** both caches are cleared for tab A
- **AND** the next activation of either subtab dispatches a fresh call

#### Scenario: Successful apply_table_edits invalidates the matching table's caches

- **WHEN** `mssql_apply_table_edits` succeeds for `dbo.Orders`
- **THEN** every `mssql-table-data` tab whose triple matches `(connectionId, "dbo", "Orders")` clears both its structure cache and its DDL cache
- **AND** tabs on other tables are unaffected

#### Scenario: Disconnect clears caches on that connection

- **WHEN** a `mssql:active-changed` event reports the connection has disconnected
- **THEN** every tab on that connection clears both its structure cache and its DDL cache

### Requirement: Activity-log kinds

The platform activity-log type union (`src/platform/activity-log/types.ts`) and its renderer (`ActivityLogRow.tsx`) MUST recognize `kind: "table_structure"` and `kind: "table_ddl"` for MS SQL Server connections. The renderer MUST display:

- A short label: `Table structure` or `Table DDL` respectively.
- The `connectionId` and the parsed `(schema, relation)` triple as a subtitle (e.g., `connection_name · schema.relation`), parsed from the activity-log entry's structured fields the same way the existing MS SQL Server `query_table` and `count_table` rows are rendered.
- The metric `<n> items` from `metric.value` on success.
- The error code (when available) on failure.

The Rust `ActivityKind` enum's existing `TableStructure` and `TableDdl` variants (added for Postgres / MySQL) are reused for MS SQL Server — no new variant is introduced. Entries are distinguished by `kind_namespace: "mssql"`.

#### Scenario: TS type accepts table_ddl without exhaustiveness errors

- **WHEN** the TS activity-log union is used in `ActivityLogRow.tsx`'s `switch` over `kind`
- **THEN** `"table_ddl"` is a valid case and the `default` branch (or exhaustiveness check) does not trigger for it

#### Scenario: Renderer shows the items metric on success for table_structure

- **WHEN** an activity-log entry has `kind: "table_structure"`, `status: "ok"`, `metric: { kind: "items", value: 24 }`, and MS SQL Server connection metadata
- **THEN** the rendered row reads "Table structure · 24 items" (with the connection / relation subtitle)

#### Scenario: Renderer shows table_ddl with single-item metric

- **WHEN** an activity-log entry has `kind: "table_ddl"`, `status: "ok"`, `metric: { kind: "items", value: 1 }`, `kind_namespace: "mssql"`
- **THEN** the rendered row reads "Table DDL · 1 item" (with the connection / relation subtitle)
