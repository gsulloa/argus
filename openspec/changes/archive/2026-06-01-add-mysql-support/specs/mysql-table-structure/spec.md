## ADDED Requirements

### Requirement: Table structure command

The MySQL module SHALL expose a Tauri command `mysql_table_structure(id, schema, relation, origin?)` that returns columns, primary key, unique constraints, foreign keys, indexes, triggers, and table options in a single response. The optional `origin` argument MUST be `"user"` or `"auto"` and defaults to `"auto"` when absent.

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
    extra: string,
    comment: string,
    collation: string | null,
    character_set: string | null
  }>,
  primary_key: { columns: string[], auto_increment_column: string | null } | null,
  unique_constraints: Array<{ name: string, columns: string[] }> | null,
  foreign_keys: Array<{
    name: string,
    columns: string[],
    referenced_schema: string,
    referenced_table: string,
    referenced_columns: string[],
    on_update: string,
    on_delete: string
  }> | null,
  indexes: Array<{
    name: string,
    columns: Array<{ name: string, sub_part: number | null, direction: "ASC" | "DESC" }>,
    unique: boolean,
    type: "BTREE" | "HASH" | "FULLTEXT" | "SPATIAL",
    comment: string
  }> | null,
  triggers: Array<{
    name: string,
    event: "INSERT" | "UPDATE" | "DELETE",
    timing: "BEFORE" | "AFTER",
    action_statement: string,
    comment: string
  }> | null,
  table_options: {
    engine: string | null,
    row_format: string | null,
    collation: string | null,
    character_set: string | null,
    comment: string,
    auto_increment: number | null
  } | null,
  failures: Array<{ kind: string, code: string | null, message: string }>
}
```

The command MUST acquire a connection from the existing MySQL pool registry and MUST quote all identifiers with backticks (doubling embedded backticks). Sub-queries (columns, primary_key, unique_constraints, foreign_keys, indexes, triggers, table_options) MUST run concurrently through `tokio::join!`. Each sub-query runs under an 8s per-query timeout; the whole command runs under a 10s total timeout. On per-query timeout, the command MUST cancel the in-flight statement against the active connection before resolving the join.

`columns.full_type` MUST be populated from `INFORMATION_SCHEMA.COLUMNS.COLUMN_TYPE` (including length, precision, signedness, and enum/set members) and MUST NOT be derived from `DATA_TYPE` which strips parameters. `columns.extra` MUST be preserved verbatim from `INFORMATION_SCHEMA.COLUMNS.EXTRA` (carrying `auto_increment`, `on update CURRENT_TIMESTAMP`, `VIRTUAL GENERATED`, etc.).

`primary_key` MUST be derived from `INFORMATION_SCHEMA.STATISTICS` where `INDEX_NAME = 'PRIMARY'`, ordered by `SEQ_IN_INDEX`. `primary_key.auto_increment_column` MUST be the name of the column whose `EXTRA` contains `auto_increment`, or `null` if no such column exists.

`unique_constraints` MUST come from `INFORMATION_SCHEMA.TABLE_CONSTRAINTS` filtered by `CONSTRAINT_TYPE = 'UNIQUE'` joined with `KEY_COLUMN_USAGE` on `(CONSTRAINT_SCHEMA, CONSTRAINT_NAME, TABLE_NAME)`, ordered by `ORDINAL_POSITION`.

`foreign_keys` MUST come from `INFORMATION_SCHEMA.KEY_COLUMN_USAGE` joined with `INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS` on `(CONSTRAINT_SCHEMA, CONSTRAINT_NAME)`. `on_update` and `on_delete` MUST be one of `"NO ACTION"`, `"RESTRICT"`, `"CASCADE"`, `"SET NULL"`, `"SET DEFAULT"`.

`indexes` MUST come from `INFORMATION_SCHEMA.STATISTICS` grouped by `INDEX_NAME` (excluding `PRIMARY`), ordered by `SEQ_IN_INDEX`. `INDEX_TYPE` populates `type`; `NON_UNIQUE = 0` populates `unique`; `SUB_PART` populates `sub_part`; `COLLATION` (`A` → `"ASC"`, `D` → `"DESC"`, `NULL` → `"ASC"`) maps to `direction`.

`triggers` MUST come from `INFORMATION_SCHEMA.TRIGGERS` filtered by `EVENT_OBJECT_SCHEMA = <schema>` and `EVENT_OBJECT_TABLE = <relation>`.

`table_options` MUST come from `INFORMATION_SCHEMA.TABLES` (one row) reading `ENGINE`, `ROW_FORMAT`, `TABLE_COLLATION`, `TABLE_COMMENT`, `AUTO_INCREMENT`. `character_set` MUST be derived from the collation prefix when available.

The partial-degradation envelope MUST be applied identically to other MySQL multi-query commands: any sub-query that fails MUST result in `null` for that field and a `KindFailure` entry in `failures` with `kind` set to one of `"columns" | "primary_key" | "unique_constraints" | "foreign_keys" | "indexes" | "triggers" | "table_options"`. A failure on the columns sub-query specifically MUST cause the whole command to return `AppError::Mysql` (columns are required to render anything useful); other sub-query failures MUST NOT fail the command.

The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "table_structure"`, `connection_id: <id>`, `origin: <origin argument>`, `sql: null`, `params: null`, `metric: { kind: "items", value: <columns + indexes + triggers + foreign_keys + unique_constraints + (1 if primary_key else 0)> }` on success (`null` on failure), and `status` matching the result.

#### Scenario: Returns columns, constraints, indexes, triggers, FKs in one call

- **WHEN** the user invokes `mysql.tableStructure(id, "shop", "orders")` against a table with 12 columns, 1 PK, 2 FKs, 1 unique constraint, 3 indexes, 1 trigger
- **THEN** the response has `columns.length === 12`, `primary_key.columns.length >= 1`, `foreign_keys.length === 2`, `unique_constraints.length === 1`, `indexes.length === 3`, `triggers.length === 1`
- **AND** `table_options.engine` is non-null (e.g., `"InnoDB"`)

#### Scenario: Backtick identifier quoting

- **WHEN** the user invokes the command for a table named `we`ird` (containing a backtick)
- **THEN** every catalog query references the schema/relation parameters as bound parameters (not interpolated identifiers)
- **AND** any direct identifier use in emitted SQL escapes the backtick by doubling it (`` `we``ird` ``)

#### Scenario: Read-only connection still serves the command

- **WHEN** the user invokes the command on a connection in `read_only: true`
- **THEN** the command succeeds and returns the structure (it never mutates state)

#### Scenario: Unknown relation returns a hard error

- **WHEN** the user invokes the command for `shop.does_not_exist`
- **THEN** the command returns `AppError::Mysql` with the underlying server error or an empty-columns failure
- **AND** one `argus:activity-log` event is emitted with `kind: "table_structure"`, `status: "err"`, `metric: null`

#### Scenario: Per-kind failure with non-permission code is reported

- **WHEN** the catalog query for indexes times out after the 8s per-query window
- **THEN** `indexes` is `null`
- **AND** `failures` contains `{ kind: "indexes", code: <sqlstate or null>, message: <…> }`
- **AND** the rest of the response is still populated and the activity-log event reports `status: "ok"`

#### Scenario: Failure on the columns sub-query fails the whole command

- **WHEN** the catalog query for `INFORMATION_SCHEMA.COLUMNS` returns an unexpected error (e.g., connection reset)
- **THEN** the command returns `AppError::Mysql` and no partial payload is returned

#### Scenario: User-initiated call carries origin user in the activity log

- **WHEN** the Structure subtab fires its first activation with `origin: "user"`
- **THEN** the emitted `argus:activity-log` event has `origin: "user"`, `kind: "table_structure"`, `metric: { kind: "items", value: <total> }`, `status: "ok"`

#### Scenario: Origin defaults to auto when omitted

- **WHEN** any caller invokes the command without supplying `origin`
- **THEN** the emitted `argus:activity-log` event has `origin: "auto"`

#### Scenario: COLUMN_TYPE preserves parameters

- **WHEN** a column is declared `VARCHAR(255) CHARACTER SET utf8mb4`
- **THEN** `full_type` is exactly `"varchar(255)"` (the server-normalized form)
- **AND** `data_type` is `"varchar"`

#### Scenario: EXTRA preserves auto_increment and on update clauses

- **WHEN** a column is declared `id BIGINT NOT NULL AUTO_INCREMENT`
- **THEN** `extra` contains `"auto_increment"` verbatim
- **AND** `primary_key.auto_increment_column === "id"` when `id` is the PK

#### Scenario: Index sub_part and direction surface

- **WHEN** an index is declared `INDEX idx_email (email(20) DESC)`
- **THEN** the index entry has `columns[0] = { name: "email", sub_part: 20, direction: "DESC" }`
- **AND** `type === "BTREE"` and `unique === false`

### Requirement: SHOW CREATE TABLE command

The MySQL module SHALL expose a Tauri command `mysql_table_ddl(id, schema, relation, origin?)` that returns `{ ddl: string }`. The DDL MUST come directly from a `SHOW CREATE TABLE ` ``\`<schema>\`.\`<relation>\``` `` invocation against the live connection. For views, the command MUST detect the relkind via `INFORMATION_SCHEMA.TABLES.TABLE_TYPE` and instead issue `SHOW CREATE VIEW ` ``\`<schema>\`.\`<relation>\``` ``. The command MUST run under a single 5s timeout.

The response `ddl` MUST be the exact second-column value from the server result (`Create Table` for tables, `Create View` for views). The command MUST NOT modify whitespace, line endings, quoting, or capitalization in the server output. This is preferred over manual reconstruction because MySQL's `SHOW CREATE TABLE` produces canonical DDL the server itself accepts unmodified.

The command MUST emit exactly one `argus:activity-log` event with `kind: "table_ddl"`, `origin: <origin>`, `sql: null`, `params: null`, `metric: { kind: "items", value: 1 }` on success (`null` on failure), and `status` matching the result.

#### Scenario: SHOW CREATE TABLE output is returned verbatim

- **WHEN** the user invokes `mysql.tableDdl(id, "shop", "orders")` and the server returns `CREATE TABLE \`orders\` (\n  \`id\` bigint NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (\`id\`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
- **THEN** the response `ddl` is byte-identical to that string
- **AND** no whitespace, newlines, or backtick quoting is altered

#### Scenario: View dispatches SHOW CREATE VIEW

- **WHEN** the relation is a view (`TABLE_TYPE = 'VIEW'`)
- **THEN** the command issues `SHOW CREATE VIEW` instead of `SHOW CREATE TABLE`
- **AND** the `Create View` column from the server result populates `ddl` unmodified

#### Scenario: Timeout returns a hard error

- **WHEN** the `SHOW CREATE TABLE` invocation does not return within 5s
- **THEN** the command returns `AppError::Mysql` with a timeout indication
- **AND** the activity-log event reports `status: "err"` and `metric: null`

#### Scenario: Unknown relation surfaces server error

- **WHEN** the user invokes the command for `shop.does_not_exist`
- **THEN** the command returns `AppError::Mysql` carrying the MySQL error (`1146` `ER_NO_SUCH_TABLE`)

### Requirement: Structure subtab UI

The frontend SHALL render a Structure subtab as one of the two subtabs of the `mysql-table-data` viewer (see the `mysql-data-grid` capability for the sub-tabset rules). The subtab MUST consume the response of `mysql_table_structure` and render the following sections in this order, each with a hairline-bordered section header in the `DESIGN.md` typography:

1. **Columns** — a borderless table with one row per column. Columns: `#` (ordinal), `Name`, `Type` (renders `full_type`, e.g., `VARCHAR(255)`), `Nullable` (✓ / —), `Default` (or `—`), `Extra` (renders the verbatim `EXTRA` string, e.g., `AUTO_INCREMENT`, `on update CURRENT_TIMESTAMP`), `PK` (✓ if member of `primary_key.columns`), `FK` (a small chip linking to the referenced relation if member of any FK; clicking the chip MUST open the referenced table in a new `mysql-table-data` tab), `Comment`. Names use `Geist Mono`. Numeric ordinals use tabular numerals.
2. **Indexes** — one row per index: `Name`, `Type` (BTREE / HASH / FULLTEXT / SPATIAL badge), `Columns` (rendered as `col1, col2(20) DESC` — sub_part rendered as `(N)` suffix, direction suffix only when `DESC`), `Unique` (✓ / —), `Comment`. Hidden if `indexes` is empty (after partial-degradation collapse) AND `failures` does not list `"indexes"`.
3. **Foreign keys** — one row per FK: `Name`, `Columns`, `→ References` (rendered as `schema.relation(col1, …)` and clickable — opens the referenced table in a new `mysql-table-data` tab), `On update`, `On delete`. Hidden if `foreign_keys` is empty AND `failures` does not list `"foreign_keys"`.
4. **Unique constraints** — one row per UNIQUE constraint: `Name`, `Columns`. Hidden if empty AND not in failures.
5. **Triggers** — one row per trigger: `Name`, `Timing + Event` (e.g., `BEFORE INSERT`), `Action` (rendered in a collapsible code block in `Geist Mono`), `Comment`. Hidden if empty AND not in failures.
6. **Table options** — a key/value list rendering `engine`, `character_set` / `collation`, `row_format`, `auto_increment` counter, and `comment` (when non-empty). Hidden if `table_options` is `null` AND not in failures.

If a section's underlying field is `null` (per-kind failure), the section MUST render with an inline error chip reading `Couldn't load <kind> — <message>` and a `Retry` button that re-issues the whole `mysql_table_structure` call. The Retry button MUST issue with `origin: "user"`.

The subtab MUST also render a header with: the relation's fully-qualified name (``` `schema`.`relation` ``` in `Geist Mono`), the relkind label ("Table" or "View"), and a **Refresh** button that re-issues `mysql_table_structure(origin: "user")` and replaces the cached response on success.

For views, the **Foreign keys**, **Unique constraints**, and **Triggers** sections MUST render an empty-state copy reading "Views do not declare constraints — see the underlying tables." instead of being hidden, to keep the section list stable across relkinds.

The Structure subtab MUST be entirely read-only in v1. There are no inline DDL edit affordances regardless of connection mode (`read_only` or writable). This matches the Postgres v1 contract.

#### Scenario: First activation fetches the structure

- **WHEN** the user opens a table tab and clicks the **Structure** subtab for the first time
- **THEN** exactly one `mysql_table_structure` call is dispatched with `origin: "user"`
- **AND** while the call is in flight, the Structure subtab renders a skeleton or spinner

#### Scenario: Cached after first fetch, no refetch on re-activation

- **WHEN** the user has activated Structure once (loaded the cached response), navigates to Data, and returns to Structure
- **THEN** no new `mysql_table_structure` call is dispatched
- **AND** the cached response is rendered immediately

#### Scenario: Refresh button re-issues the call

- **WHEN** the user clicks **Refresh** in the Structure subtab header
- **THEN** a new `mysql_table_structure` call is dispatched with `origin: "user"`
- **AND** the cached response is replaced on success

#### Scenario: Columns section renders full_type and extra

- **WHEN** the response has a column with `full_type: "varchar(255)"`, `extra: "on update CURRENT_TIMESTAMP"`
- **THEN** the Type cell reads `varchar(255)` and the Extra cell reads `on update CURRENT_TIMESTAMP`

#### Scenario: Index sub_part is rendered with parentheses

- **WHEN** an index has `columns: [{ name: "email", sub_part: 20, direction: "ASC" }]`
- **THEN** the Indexes row renders the column as `email(20)` (no direction suffix because ASC is implicit)

#### Scenario: Index DESC direction is rendered

- **WHEN** an index has `columns: [{ name: "created_at", sub_part: null, direction: "DESC" }]`
- **THEN** the Indexes row renders the column as `created_at DESC`

#### Scenario: FK chip opens the referenced table

- **WHEN** the user clicks the FK chip on the `customer_id` column referencing `shop.customers(id)`
- **THEN** a new `mysql-table-data` tab is opened for `shop.customers` and focused
- **AND** the original tab remains open with the same active subtab

#### Scenario: Trigger action is collapsible

- **WHEN** a trigger has a multi-line `action_statement`
- **THEN** the Action cell renders a collapsible code block, collapsed by default to a single-line preview

#### Scenario: View keeps constraint sections with empty state

- **WHEN** the relation is a view
- **THEN** the Foreign keys, Unique constraints, and Triggers sections are rendered with the empty-state copy "Views do not declare constraints — see the underlying tables."

#### Scenario: Per-kind failure surfaces an inline retry

- **WHEN** the response has `indexes: null` and `failures` contains `{ kind: "indexes", code: null, message: "…" }`
- **THEN** the Indexes section renders an inline error chip "Couldn't load indexes — …" with a `Retry` button
- **AND** clicking Retry re-issues `mysql_table_structure(origin: "user")`

### Requirement: Raw subtab UI

The frontend SHALL render a Raw subtab as one of the two subtabs of the `mysql-table-data` viewer. On first activation it MUST dispatch a `mysql_table_ddl` call (independent of the Structure subtab's `mysql_table_structure` cache — these are two separate commands) and render the `ddl` field in a read-only CodeMirror 6 editor configured with the MySQL SQL dialect for syntax highlighting only. The editor MUST:

- Have `EditorView.editable.of(false)` so the user cannot type into it.
- Be wrapped (no horizontal scrollbar by default — long DDL lines wrap).
- NOT enable autocomplete, the run shortcut (`Cmd+Enter`), or any keymap beyond the default text-selection bindings.
- Use the same theme tokens already in use by the existing CodeMirror surfaces in the app (matched to `DESIGN.md`).

The Raw subtab MUST render the server output verbatim — no whitespace normalization, no re-quoting, no capitalization changes.

The Raw subtab MUST also render:

- A header reading `SHOW CREATE TABLE — server output, unmodified.` in muted text above the editor (or `SHOW CREATE VIEW` when the relation is a view).
- A **Copy** button that copies the entire `ddl` string to the system clipboard via the Tauri clipboard API and shows a brief "Copied" affordance.
- A **Refresh** button that re-issues `mysql_table_ddl(origin: "user")` and replaces the cache on success.

The Raw subtab MUST be entirely read-only on every connection (`read_only` or writable).

#### Scenario: First activation dispatches mysql_table_ddl

- **WHEN** the user opens a fresh table tab and clicks **Raw** without first visiting Structure
- **THEN** exactly one `mysql_table_ddl` call is dispatched with `origin: "user"`
- **AND** no `mysql_table_structure` call is dispatched

#### Scenario: Cached DDL is reused on re-activation

- **WHEN** the user has activated Raw once (response is cached), navigates to Structure, and returns to Raw
- **THEN** no new `mysql_table_ddl` call is dispatched
- **AND** the cached `ddl` is rendered immediately

#### Scenario: Copy button writes the DDL to clipboard

- **WHEN** the user clicks the **Copy** button on the Raw subtab
- **THEN** the system clipboard contains exactly the `ddl` string (byte-identical to the server output)
- **AND** the button shows a brief "Copied" affordance for ~1.5s

#### Scenario: Editor is read-only

- **WHEN** the user clicks inside the CodeMirror editor and types
- **THEN** no characters are inserted (the editor rejects input)
- **AND** the user can still select and copy text via the OS

#### Scenario: View renders SHOW CREATE VIEW output

- **WHEN** the relation is a view named `shop.active_users`
- **THEN** the Raw subtab editor shows the unmodified `Create View` column value (typically starting with `CREATE ALGORITHM=…`)
- **AND** the header reads `SHOW CREATE VIEW — server output, unmodified.`

### Requirement: Per-tab structure cache

The frontend SHALL cache the responses of `mysql_table_structure` and `mysql_table_ddl` on the `MysqlTableViewerTab` instance for the lifetime of the tab AND for the lifetime of a single `(connectionId, schema, relation)` triple. The structure cache and the DDL cache are separate slots — fetching one MUST NOT populate the other. Each cache MUST be populated on first successful response and replaced atomically on every subsequent successful Refresh. The caches MUST NOT be shared across tabs — two `mysql-table-data` tabs of the same `(connectionId, schema, relation)` MUST each have their own independent caches.

The caches MUST be keyed on `(connectionId, schema, relation)`. When the same `useMysqlTableStructureCache` (or `useMysqlTableDdlCache`) invocation is rerun with a different triple — which happens when the user switches between two open `mysql-table-data` tabs — the hook MUST detect the change synchronously during render, reset its state to `{ status: "idle", response: null, error: null }`, and clear the in-flight promise reference. The next render MUST NOT show the previous triple's `response` or `error`, and a follow-up `ensureLoaded` MUST dispatch a fresh call against the new triple.

A response that started before a triple change MUST NOT update the cache after the triple change. The hook MUST track an internal generation counter that increments on every triple change, capture it at the start of each dispatch, and discard the response if the generation has advanced when the response resolves.

When a fetch is in flight and a second activation of the same subtab occurs against the *same* triple, no second fetch MUST be dispatched; the second activation MUST share the in-flight promise.

The structure cache and DDL cache MUST be invalidated on:

- A `Schema: Refresh` palette command for the connection — both caches cleared for every tab on that connection.
- A successful `mysql_apply_table_edits` against the table — both caches cleared for tabs whose `(connectionId, schema, relation)` matches the edited table (the DDL may have changed via triggers or generated columns; conservative invalidation).
- A `mysql:active-changed` event reporting that the connection has disconnected — both caches cleared for every tab on that connection.

#### Scenario: Two tabs of the same relation have independent caches

- **WHEN** the user has tab A and tab B open on `shop.users` (two separate `mysql-table-data` tabs)
- **AND** the user clicks Refresh on tab A's Structure subtab
- **THEN** tab A's structure cache is replaced
- **AND** tab B's structure cache is unchanged

#### Scenario: Structure and DDL caches are independent

- **WHEN** the user clicks Structure on a fresh tab and waits for the response, then clicks Raw
- **THEN** `mysql_table_structure` has been dispatched once AND `mysql_table_ddl` has been dispatched once
- **AND** Refreshing Structure does not invalidate the DDL cache, and vice versa

#### Scenario: Switching to a different table tab clears stale Structure and Raw

- **WHEN** the user has loaded Structure and Raw on tab A (`shop.orders`) — both caches are `ready`
- **AND** the user switches to tab B (`shop.customers`) and clicks the Structure subtab
- **THEN** the Structure subtab on tab B does NOT render tab A's response
- **AND** a fresh `mysql_table_structure` call is dispatched for `shop.customers`

#### Scenario: Switching tabs while a fetch is in flight does not poison the new tab's cache

- **WHEN** the user clicks Structure on tab A (`shop.orders`), the call starts but has not resolved
- **AND** the user switches to tab B (`shop.customers`) and clicks Structure before tab A's fetch resolves
- **THEN** tab A's pending response, when it eventually resolves, MUST NOT be written into the cache
- **AND** a fresh fetch is dispatched for `shop.customers`

#### Scenario: Schema refresh invalidates both caches

- **WHEN** the user runs the `Schema: Refresh` palette command for the connection while tab A's Structure and Raw caches are populated
- **THEN** both caches are cleared for tab A
- **AND** the next activation of either subtab dispatches a fresh call

#### Scenario: Successful apply_table_edits invalidates the matching table's caches

- **WHEN** `mysql_apply_table_edits` succeeds for `shop.orders`
- **THEN** every `mysql-table-data` tab whose triple matches `(connectionId, "shop", "orders")` clears both its structure cache and its DDL cache
- **AND** tabs on other tables are unaffected

#### Scenario: Disconnect clears caches on that connection

- **WHEN** a `mysql:active-changed` event reports the connection has disconnected
- **THEN** every tab on that connection clears both its structure cache and its DDL cache

### Requirement: Activity-log kinds

The platform activity-log type union (`src/platform/activity-log/types.ts`) and its renderer (`ActivityLogRow.tsx`) MUST recognize `kind: "table_structure"` and `kind: "table_ddl"` as first-class entries. The renderer MUST display:

- A short label: `Table structure` or `Table DDL` respectively.
- The `connectionId` and the parsed `(schema, relation)` triple as a subtitle (e.g., `connection_name · schema.relation`), parsed from the activity-log entry's structured fields the same way the existing MySQL `query_table` and `count_table` rows are rendered.
- The metric `<n> items` from `metric.value` on success.
- The error code (when available) on failure.

The Rust `ActivityKind` enum MUST gain a `TableDdl` variant whose serde representation is `"table_ddl"`. The existing `TableStructure` variant (added for Postgres) is reused for MySQL — no new variant is introduced for it.

#### Scenario: TS type accepts table_ddl without exhaustiveness errors

- **WHEN** the TS activity-log union is used in `ActivityLogRow.tsx`'s `switch` over `kind`
- **THEN** `"table_ddl"` is a valid case and the `default` branch (or exhaustiveness check) does not trigger for it

#### Scenario: Renderer shows the items metric on success for table_structure

- **WHEN** an activity-log entry has `kind: "table_structure"`, `status: "ok"`, `metric: { kind: "items", value: 18 }`, and MySQL connection metadata
- **THEN** the rendered row reads "Table structure · 18 items" (with the connection / relation subtitle)

#### Scenario: Renderer shows table_ddl with single-item metric

- **WHEN** an activity-log entry has `kind: "table_ddl"`, `status: "ok"`, `metric: { kind: "items", value: 1 }`
- **THEN** the rendered row reads "Table DDL · 1 item" (with the connection / relation subtitle)
