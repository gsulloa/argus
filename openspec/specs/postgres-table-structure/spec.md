# postgres-table-structure Specification

## Purpose
TBD - created by archiving change table-structure-tab. Update Purpose after archive.
## Requirements
### Requirement: Table structure command

The Postgres module SHALL expose a Tauri command `postgres_table_structure(id, schema, relation, origin?)` that returns columns, primary key, foreign keys, unique constraints, check constraints, indexes, triggers, the relkind, and a reconstructed DDL string in a single response. The optional `origin` argument MUST be `"user"` or `"auto"` and defaults to `"auto"` when absent.

The response payload MUST be:

```
{
  schema: string,
  relation: string,
  relkind: "table" | "view" | "materialized-view",
  columns: Array<{
    name: string,
    data_type: string,
    is_nullable: boolean,
    default: string | null,
    ordinal_position: number,
    comment: string | null,
    is_identity: boolean,
    is_generated: boolean
  }>,
  primary_key: { name: string, columns: string[] } | null,
  foreign_keys: Option<Array<{
    name: string,
    columns: string[],
    references: { schema: string, relation: string, columns: string[] },
    on_update: "no_action" | "restrict" | "cascade" | "set_null" | "set_default",
    on_delete: "no_action" | "restrict" | "cascade" | "set_null" | "set_default",
    deferrable: boolean,
    initially_deferred: boolean
  }>>,
  unique_constraints: Option<Array<{ name: string, columns: string[] }>>,
  check_constraints: Option<Array<{ name: string, expression: string }>>,
  indexes: Option<Array<IndexInfo>>,
  triggers: Option<Array<TriggerInfo>>,
  ddl: string,
  failures: Array<{ kind: string, code: string | null, message: string }>
}
```

`IndexInfo` and `TriggerInfo` MUST reuse the existing `schema_types::IndexInfo` and `schema_types::TriggerInfo` shapes used by `postgres_list_table_extras`.

The command MUST acquire a connection from the existing pool registry, MUST quote the schema and relation identifiers safely, and MUST execute through the read-only-aware `executeQuery` path. Each per-kind sub-query (columns, constraints, indexes, triggers, FKs) MUST run under the same per-query timeout (8s) used by `postgres_list_table_extras`, and the whole command MUST run under the same outer total timeout (10s). On per-query timeout the command MUST `pg_cancel_backend` the active backend (same `fire_cancel` path) before resolving.

The partial-degradation envelope MUST be applied identically to `postgres_list_table_extras`: any per-kind sub-query that fails MUST result in `null` for that field and a `KindFailure` entry in `failures` with `kind` set to one of `"columns" | "primary_key" | "foreign_keys" | "unique_constraints" | "check_constraints" | "indexes" | "triggers"`. Permission-denied (SQLSTATE 42501) MUST NOT enter `failures` — it MUST collapse to an empty array (or `null` for `primary_key`) for that field. A failure on the columns sub-query specifically MUST cause the whole command to return `AppError::Postgres` (the columns are required to render anything useful); other sub-query failures MUST NOT.

The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "table_structure"`, `connection_id: <id>`, `origin: <origin argument>`, `sql: <NULL>` (this command issues several catalog queries; we do not concatenate them in the log), `params: <NULL>`, `metric: { kind: "items", value: <columns + indexes + triggers + foreign_keys + unique_constraints + check_constraints + (1 if primary_key else 0)> }` on success (`null` on failure), and `status` matching the result.

#### Scenario: Returns columns, constraints, indexes, triggers, FKs in one call

- **WHEN** the user invokes `postgres.tableStructure(id, "public", "orders")` against a relation with 12 columns, 1 PK, 2 FKs, 1 unique constraint, 3 indexes, 1 trigger
- **THEN** the response has `columns.length === 12`, `primary_key.columns.length >= 1`, `foreign_keys.length === 2`, `unique_constraints.length === 1`, `indexes.length === 3`, `triggers.length === 1`
- **AND** `relkind === "table"` and `ddl` is a non-empty string starting with `CREATE TABLE`

#### Scenario: Identifiers are quoted

- **WHEN** the user invokes the command for a table named `we"ird`
- **THEN** every catalog query references the relation as `"we""ird"` (double-quote-doubling)
- **AND** the reconstructed DDL also quotes the identifier with the same rule

#### Scenario: Read-only connection still serves the command

- **WHEN** the user invokes the command on a connection in `read_only: true`
- **THEN** the command succeeds and returns the structure (it never mutates state)

#### Scenario: Unknown relation returns a hard error

- **WHEN** the user invokes the command for `public.does_not_exist`
- **THEN** the command returns `AppError::Postgres { code: Some("42P01"), ... }` (SQLSTATE for `undefined_table`)
- **AND** one `argus:activity-log` event is emitted with `kind: "table_structure"`, `status: "err"`, `error.code: "42P01"`, `metric: null`

#### Scenario: Per-kind failure is reported in failures, partial response returned

- **WHEN** the catalog query for `pg_constraint` returns SQLSTATE `42501` (insufficient_privilege) AND `pg_constraint` is the source for `unique_constraints`
- **THEN** `unique_constraints` is `[]` (empty) AND no entry is appended to `failures` (42501 collapses silently)
- **AND** the rest of the response (`columns`, `indexes`, `triggers`, …) is fully populated

#### Scenario: Per-kind failure with non-permission code is reported

- **WHEN** the catalog query for `pg_index` times out (SQLSTATE `57014` after the 8s per-query window)
- **THEN** `indexes` is `null`
- **AND** `failures` contains `{ kind: "indexes", code: "57014", message: <…> }`
- **AND** the rest of the response is still populated and the activity-log event reports `status: "ok"`

#### Scenario: Failure on the columns sub-query fails the whole command

- **WHEN** the catalog query for `pg_attribute` returns an unexpected error (e.g. SQLSTATE `08006` connection failure)
- **THEN** the command returns `AppError::Postgres` and no partial payload is returned

#### Scenario: User-initiated call carries origin user in the activity log

- **WHEN** the Structure subtab fires its first activation with `origin: "user"`
- **THEN** the emitted `argus:activity-log` event has `origin: "user"`, `kind: "table_structure"`, `metric: { kind: "items", value: <total> }`, `status: "ok"`

#### Scenario: Origin defaults to auto when omitted

- **WHEN** any caller invokes the command without supplying `origin`
- **THEN** the emitted `argus:activity-log` event has `origin: "auto"`

### Requirement: DDL reconstruction

The `ddl` field of the `postgres_table_structure` response MUST be a human-readable, copy-pasteable SQL block reconstructing the relation. The reconstruction MUST follow these rules per `relkind`:

**For `relkind === "table"`:**

- Start with `CREATE TABLE "<schema>"."<relation>" (` on its own line.
- Emit one column per indented line, in `ordinal_position` order, formatted as ``"<name>" <data_type>[ NOT NULL][ DEFAULT <default>][ GENERATED ALWAYS AS IDENTITY]``. The bracketed clauses are emitted only when applicable.
- After the last column, emit table-level constraints in this order, each on its own indented line:
  1. PRIMARY KEY (`CONSTRAINT "<name>" PRIMARY KEY ("<col1>", "<col2>", …)`)
  2. UNIQUE constraints (`CONSTRAINT "<name>" UNIQUE ("<col1>", …)`)
  3. CHECK constraints (`CONSTRAINT "<name>" CHECK (<expression>)`)
  4. FOREIGN KEYs (`CONSTRAINT "<name>" FOREIGN KEY ("<col1>", …) REFERENCES "<ref_schema>"."<ref_relation>" ("<ref_col1>", …)[ ON DELETE <action>][ ON UPDATE <action>][ DEFERRABLE [INITIALLY DEFERRED]]`)
- Close the parenthesized body with `);` on its own line.
- Below the `CREATE TABLE` block, append one `CREATE [UNIQUE] INDEX "<name>" ON "<schema>"."<relation>" USING <method> (<columns>);` line per non-implicit index. Indexes that back the PRIMARY KEY constraint MUST be skipped (the PK already declared the index implicitly).
- Below the indexes, append column comments as `COMMENT ON COLUMN "<schema>"."<relation>"."<col>" IS '<comment>';` (with single-quote escaping) for every column whose `comment` is non-null.
- The block MUST end with a trailing newline.

**For `relkind === "view"`:**

- The `ddl` MUST be `CREATE OR REPLACE VIEW "<schema>"."<relation>" AS\n<pg_get_viewdef body>` followed by a trailing newline.

**For `relkind === "materialized-view"`:**

- The `ddl` MUST be `CREATE MATERIALIZED VIEW "<schema>"."<relation>" AS\n<pg_get_matviewdef body>` followed by `WITH NO DATA;` if the matview reports `is_populated = false`, or `WITH DATA;` otherwise. Trailing newline at the end.

The reconstruction is **not required to be byte-identical to `pg_dump` output**. It is required to be syntactically valid SQL that, when executed against an empty database, produces a relation with the same columns, constraints, indexes (and matview body) as the source.

#### Scenario: Plain table reconstructs to CREATE TABLE + CREATE INDEX lines

- **WHEN** the relation `public.orders` has columns `id bigint NOT NULL`, `total numeric(10,2)`, a PK on `id`, an FK on `customer_id REFERENCES public.customers(id) ON DELETE CASCADE`, and one btree index on `created_at`
- **THEN** `ddl` starts with `CREATE TABLE "public"."orders" (`
- **AND** contains the lines for each column in order
- **AND** contains the line `CONSTRAINT "<pk_name>" PRIMARY KEY ("id")`
- **AND** contains a `FOREIGN KEY ("customer_id") REFERENCES "public"."customers" ("id") ON DELETE CASCADE` clause
- **AND** ends the table body with `);`
- **AND** a separate line `CREATE INDEX "<idx_name>" ON "public"."orders" USING btree ("created_at");` follows
- **AND** the PK index is NOT emitted as a separate `CREATE INDEX` line

#### Scenario: Column with default and identity is rendered correctly

- **WHEN** a column is `id bigint NOT NULL GENERATED ALWAYS AS IDENTITY`
- **THEN** the emitted line is ``"id" bigint NOT NULL GENERATED ALWAYS AS IDENTITY``
- **AND** no `DEFAULT` clause is emitted for that column even if `pg_attrdef` has an entry

#### Scenario: Column comment becomes a COMMENT ON COLUMN statement

- **WHEN** a column `email` has comment `'primary contact'`
- **THEN** `ddl` contains `COMMENT ON COLUMN "<schema>"."<relation>"."email" IS 'primary contact';`
- **AND** single-quotes inside the comment are escaped (`it''s`)

#### Scenario: View DDL uses pg_get_viewdef

- **WHEN** `relkind === "view"` and `pg_get_viewdef(oid, true)` returns `SELECT id, name FROM users WHERE deleted_at IS NULL;`
- **THEN** `ddl` is `CREATE OR REPLACE VIEW "<schema>"."<relation>" AS\n SELECT id, name FROM users WHERE deleted_at IS NULL;\n`

#### Scenario: Materialized view appends WITH NO DATA when unpopulated

- **WHEN** `relkind === "materialized-view"` and the matview has `pg_class.relispopulated = false`
- **THEN** `ddl` ends with `\nWITH NO DATA;\n`

#### Scenario: Materialized view appends WITH DATA when populated

- **WHEN** the matview is populated (`relispopulated = true`)
- **THEN** `ddl` ends with `\nWITH DATA;\n`

### Requirement: Structure subtab UI

The frontend SHALL render a Structure subtab as one of the three subtabs of the `postgres-table-data` viewer (see the `postgres-data-grid` capability for the sub-tabset rules). The subtab MUST consume the response of `postgres_table_structure` and render the following sections in this order, each with a hairline-bordered section header in the `DESIGN.md` typography:

1. **Columns** — a borderless table with one row per column. Columns: `#` (ordinal_position), `Name`, `Type`, `Nullable` (✓ / —), `Default` (or `—`), `PK` (✓ if member of primary_key), `FK` (a small chip linking to the referenced relation if member of any FK; clicking the chip MUST open the referenced table in a new `postgres-table-data` tab), `Comment`. Names use `Geist Mono`. Numeric ordinals use tabular numerals.
2. **Indexes** — one row per index: `Name`, `Method`, `Unique` (✓ / —), `Primary` (✓ / —). Hidden if `indexes` is empty (after partial-degradation collapse) AND `failures` does not list `"indexes"`.
3. **Foreign keys** — one row per FK: `Name`, `Columns`, `→ References`, `On delete`, `On update`. The `→ References` cell renders as `schema.relation(col1, …)` and is clickable (opens the referenced table in a new `postgres-table-data` tab). Hidden if `foreign_keys` is empty AND `failures` does not list `"foreign_keys"`.
4. **Unique constraints** — one row per UNIQUE constraint: `Name`, `Columns`. Hidden if empty AND not in failures.
5. **Check constraints** — one row per CHECK constraint: `Name`, `Expression` (rendered in `Geist Mono`). Hidden if empty AND not in failures.
6. **Triggers** — one row per trigger: `Name`, `Timing` (Before / After / Instead Of), `Events` (e.g. `INSERT, UPDATE`), `Function`. Hidden if empty AND not in failures.

If a section's underlying field is `null` (per-kind failure outside permission-denied), the section MUST render with an inline error chip reading `Couldn't load <kind> — <message>` and a `Retry` button that re-issues the whole `postgres_table_structure` call. The Retry button MUST issue with `origin: "user"`.

The subtab MUST also render a header with: the relation's fully-qualified name (`schema.relation` in `Geist Mono`), the `relkind` ("Table" / "View" / "Materialized view"), and a **Refresh** button that re-issues `postgres_table_structure(origin: "user")` and replaces the cached response on success.

For `relkind === "view"` and `relkind === "materialized-view"`, the **Foreign keys**, **Unique constraints**, and **Check constraints** sections MUST render an empty-state copy reading "Views do not declare constraints — see the underlying tables." instead of being hidden, to keep the section list stable across relkinds.

The Structure subtab MUST be entirely read-only. There are no edit affordances regardless of connection mode (`read_only` or writable).

#### Scenario: First activation fetches the structure

- **WHEN** the user opens a table tab and clicks the **Structure** subtab for the first time
- **THEN** exactly one `postgres_table_structure` call is dispatched with `origin: "user"`
- **AND** while the call is in flight, the Structure subtab renders a skeleton or spinner

#### Scenario: Cached after first fetch, no refetch on re-activation

- **WHEN** the user has activated Structure once (loaded the cached response), navigates to Data, and returns to Structure
- **THEN** no new `postgres_table_structure` call is dispatched
- **AND** the cached response is rendered immediately

#### Scenario: Refresh button re-issues the call

- **WHEN** the user clicks **Refresh** in the Structure subtab header
- **THEN** a new `postgres_table_structure` call is dispatched with `origin: "user"`
- **AND** the cached response is replaced on success

#### Scenario: Columns section lists every column

- **WHEN** the response has 12 columns
- **THEN** the Columns section renders 12 rows in `ordinal_position` order with name, data type, nullability, default, PK marker, FK marker (if applicable), and comment

#### Scenario: FK chip opens the referenced table

- **WHEN** the user clicks the FK chip on the `customer_id` column referencing `public.customers(id)`
- **THEN** a new `postgres-table-data` tab is opened for `public.customers` and focused
- **AND** the original tab remains open with the same active subtab

#### Scenario: Empty section is hidden by default

- **WHEN** the relation has zero triggers AND `failures` does not list `"triggers"`
- **THEN** the Triggers section is not rendered

#### Scenario: View / matview keeps constraint sections with empty state

- **WHEN** `relkind === "view"`
- **THEN** the Foreign keys, Unique constraints, and Check constraints sections are rendered with the empty-state copy "Views do not declare constraints — see the underlying tables."

#### Scenario: Per-kind failure surfaces an inline retry

- **WHEN** the response has `indexes: null` and `failures` contains `{ kind: "indexes", code: "57014", message: "…" }`
- **THEN** the Indexes section renders an inline error chip "Couldn't load indexes — …" with a `Retry` button
- **AND** clicking Retry re-issues `postgres_table_structure(origin: "user")`

### Requirement: Raw subtab UI

The frontend SHALL render a Raw subtab as one of the three subtabs of the `postgres-table-data` viewer. On first activation it MUST trigger the same fetch path as the Structure subtab (or reuse the cached response if one already exists from the Structure subtab) and render the `ddl` field in a read-only CodeMirror 6 editor configured with the Postgres SQL dialect for syntax highlighting only. The editor MUST:

- Have `EditorView.editable.of(false)` so the user cannot type into it.
- Be wrapped (no horizontal scrollbar by default — long DDL lines wrap).
- NOT enable autocomplete, the run shortcut (`Cmd+Enter`), or any keymap beyond the default text-selection bindings.
- Use the same theme tokens already in use by the existing CodeMirror surfaces in the app (matched to `DESIGN.md`).

The Raw subtab MUST also render:

- A header reading `Reconstructed DDL — not a pg_dump substitute.` in muted text above the editor.
- A **Copy** button that copies the entire `ddl` string to the system clipboard via the Tauri clipboard API and shows a brief "Copied" affordance.
- A **Refresh** button identical in behavior to the one in the Structure subtab (re-issues `postgres_table_structure(origin: "user")` and replaces the cache on success).
- A "best-effort" badge if the relation is a partition table, foreign table, or otherwise outside the simple-table reconstruction scope. The badge MUST read `Best effort — this relation has features the reconstruction may simplify.` in muted text.

The Raw subtab MUST be entirely read-only on every connection (`read_only` or writable).

#### Scenario: First activation reuses cached structure if present

- **WHEN** the user has activated the Structure subtab once (response is cached) and then clicks the Raw subtab
- **THEN** no additional `postgres_table_structure` call is dispatched
- **AND** the Raw subtab renders the cached `ddl`

#### Scenario: First activation fires the fetch when no cache

- **WHEN** the user opens a fresh table tab and clicks **Raw** without first visiting Structure
- **THEN** exactly one `postgres_table_structure` call is dispatched with `origin: "user"`

#### Scenario: Copy button writes the DDL to clipboard

- **WHEN** the user clicks the **Copy** button on the Raw subtab
- **THEN** the system clipboard contains exactly the `ddl` string (including trailing newline)
- **AND** the button shows a brief "Copied" affordance for ~1.5s

#### Scenario: Editor is read-only

- **WHEN** the user clicks inside the CodeMirror editor and types
- **THEN** no characters are inserted (the editor rejects input)
- **AND** the user can still select and copy text via the OS

#### Scenario: View renders CREATE OR REPLACE VIEW

- **WHEN** the relation is a view named `public.active_users`
- **THEN** the Raw subtab editor shows `CREATE OR REPLACE VIEW "public"."active_users" AS\n…`

#### Scenario: Best-effort badge appears for partitioned tables

- **WHEN** the relation is a partitioned table (`pg_class.relkind = 'p'`)
- **THEN** the Raw subtab renders the "Best effort — this relation has features the reconstruction may simplify." badge

### Requirement: Per-tab structure cache

The frontend SHALL cache the response of `postgres_table_structure` on the `TableViewerTab` instance for the lifetime of the tab AND for the lifetime of a single `(connectionId, schema, relation)` triple. The cache MUST be populated on first successful response and replaced atomically on every subsequent successful Refresh. The cache MUST NOT be shared across tabs — two `postgres-table-data` tabs of the same `(connectionId, schema, relation)` MUST each have their own independent cache.

The cache MUST be keyed on `(connectionId, schema, relation)`. When the same `useTableStructureCache` invocation is rerun with a different triple — which happens when the user switches between two open `postgres-table-data` tabs, since `TabContent` reuses the same `TableViewerTab` component instance across tabs — the hook MUST detect the change synchronously during render, reset its state to `{ status: "idle", response: null, error: null }`, and clear the in-flight promise reference. The next render MUST NOT show the previous triple's `response` or `error`, and a follow-up `ensureLoaded` MUST dispatch a fresh `postgres_table_structure` call against the new triple, not return the previous triple's stale promise.

A `postgres_table_structure` response that started before a triple change MUST NOT update the cache after the triple change. The hook MUST track an internal generation counter that increments on every triple change, capture it at the start of each dispatch, and discard the response if the generation has advanced when the response resolves.

When a fetch is in flight and a second activation of Structure or Raw occurs against the *same* triple, no second fetch MUST be dispatched; both subtabs MUST share the in-flight promise.

#### Scenario: Two tabs of the same relation have independent caches

- **WHEN** the user has tab A and tab B open on `public.users` (two separate `postgres-table-data` tabs)
- **AND** the user clicks Refresh on tab A
- **THEN** tab A's cache is replaced
- **AND** tab B's cache is unchanged

#### Scenario: Concurrent Structure + Raw activation deduplicates the fetch

- **WHEN** the user clicks Structure (which triggers a fetch) and immediately clicks Raw before the fetch resolves
- **THEN** only one `postgres_table_structure` call is dispatched
- **AND** both subtabs render from the same response when it resolves

#### Scenario: Switching to a different table tab clears stale Structure / Raw

- **WHEN** the user has loaded the Structure subtab on tab A (`public.orders`) — its cache is `ready` with `response_A`
- **AND** the user switches to tab B (`public.customers`) and clicks the Structure subtab
- **THEN** the Structure subtab on tab B does NOT render `response_A`
- **AND** a fresh `postgres_table_structure` call is dispatched for `public.customers`
- **AND** the loading state is shown until the response for `public.customers` resolves

#### Scenario: Switching tabs while a fetch is in flight does not poison the new tab's cache

- **WHEN** the user clicks Structure on tab A (`public.orders`), a `postgres_table_structure` call starts but has not resolved
- **AND** the user switches to tab B (`public.customers`) and clicks Structure before tab A's fetch resolves
- **THEN** tab A's pending response, when it eventually resolves, MUST NOT be written into the cache
- **AND** a fresh fetch is dispatched for `public.customers`
- **AND** tab B's cache only ever holds `response_B`

#### Scenario: Returning to the original tab does not refetch when its triple is unchanged

- **WHEN** the user switches from tab A to tab B and then back to tab A
- **AND** the cache for tab A's triple is still `ready` with the previously loaded response
- **THEN** no new `postgres_table_structure` call is dispatched for tab A
- **AND** the Structure / Raw subtabs render the previously loaded response immediately

### Requirement: Activity-log kind

The platform activity-log type union (`src/platform/activity-log/types.ts`) and its renderer (`ActivityLogRow.tsx`) MUST recognize `kind: "table_structure"` as a first-class entry. The renderer MUST display:

- A short label: `Table structure`.
- The `connectionId` and the parsed `(schema, relation)` triple as a subtitle (e.g. `connection_name · schema.relation`), parsed from the activity-log entry's structured fields the same way the existing `query_table` and `count_table` rows are rendered.
- The metric `<n> items` from `metric.value` on success.
- The error code on failure (e.g. `42P01`).

The Rust `ActivityKind` enum MUST gain a `TableStructure` variant whose serde representation is `"table_structure"`.

#### Scenario: TS type accepts the new kind without exhaustiveness errors

- **WHEN** the TS activity-log union is used in `ActivityLogRow.tsx`'s `switch` over `kind`
- **THEN** `"table_structure"` is a valid case and the `default` branch (or exhaustiveness check) does not trigger for it

#### Scenario: Renderer shows the items metric on success

- **WHEN** an activity-log entry has `kind: "table_structure"`, `status: "ok"`, `metric: { kind: "items", value: 18 }`
- **THEN** the rendered row reads "Table structure · 18 items" (with the connection / relation subtitle)

