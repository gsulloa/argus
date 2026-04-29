## MODIFIED Requirements

### Requirement: Schema-aware autocomplete from in-memory cache

The editor SHALL offer autocomplete suggestions from **three composed sources** running in parallel inside a single `autocompletion({ override: [...] })` extension:

1. **Keyword source** — `keywordCompletionSource(PostgreSQL, /*upperCase=*/ true)` from `@codemirror/lang-sql`. Always available; suggests reserved words and built-in functions of the Postgres dialect.

2. **Schema source** — `schemaCompletionSource({ dialect: PostgreSQL, schema: namespace })` from `@codemirror/lang-sql`, where `namespace` is built from `globalSchemaCache.getNamespace(connectionId)`. This source MUST canonically handle:
   - Qualified names (`<schema>.<partial>`) by anchoring `from` immediately after the dot and filtering only the partial — no greedy capture of the schema portion.
   - Default-schema unqualified table completion (when the configuration includes a default schema).
   - FROM-clause aware column scoping: when the editor's parse tree shows `SELECT … FROM users u`, completing `u.` MUST suggest only the columns of `users`.
   - CTE awareness: tables declared in `WITH name AS (...)` MUST be available as completions in the body of the same statement.

3. **Document identifier source** — a custom source that walks the editor's syntax tree (via `syntaxTree(state)` from `@codemirror/language`) and extracts:
   - CTE names declared in `WITH … AS (…)` clauses.
   - Aliases declared in `FROM <table> [AS] <alias>` and `JOIN <table> [AS] <alias>` clauses.
   - Other identifiers that appear in `FromClause` / `JoinClause` positions.
   This source MUST NOT use raw regex to identify these tokens — it MUST use the parser's syntax tree so that strings, comments, and dollar-quoted bodies are correctly excluded.

The editor MUST keep the `sql({ dialect: PostgreSQL })` language configuration in a separate `Compartment` from `autocompletion`, so that reconfiguring the autocomplete sources (when the schema cache changes) does NOT re-instantiate the language or invalidate the syntax tree / highlighting / indent logic.

When `globalSchemaCache` notifies of a change, the editor MUST reconfigure the autocomplete `Compartment` to re-bind `schemaCompletionSource` to the new namespace, debounced 100ms. If the new namespace is shape-equal to the previous (same schema names with same relation name sets), the reconfigure MUST be skipped to avoid editor churn.

When neither schemas, relations, nor columns are loaded for the current connection, the editor MUST still function and offer **keyword-only completion** plus document identifiers found in the current buffer.

#### Scenario: Keywords always complete

- **WHEN** the editor is empty and the user types `SEL`
- **THEN** the autocomplete popup opens with `SELECT` as a top suggestion
- **AND** the suggestion has type `keyword`

#### Scenario: Qualified name completion is canonical

- **WHEN** the schema cache contains `public.users`, `public.orders`, `analytics.events`
- **AND** the user types `SELECT * FROM public.us`
- **THEN** the autocomplete popup shows `users` (and any other public.* relations matching `us`) as the top suggestion
- **AND** the popup does NOT consume the `public.` portion as part of the typed prefix — only `us` is the partial

#### Scenario: Alias-aware column completion

- **WHEN** the document is `SELECT u. FROM "public"."users" u` with the cursor right after `u.`
- **AND** the cache has columns for `public.users`
- **THEN** the autocomplete popup suggests every column of `public.users` (e.g. `id`, `email`, `created_at`)
- **AND** does NOT suggest columns of unrelated relations

#### Scenario: CTE name appears in completion

- **WHEN** the document is `WITH recent AS (SELECT * FROM events) SELECT * FROM rec`
- **AND** the cursor is right after `rec`
- **THEN** the autocomplete popup includes `recent` as a suggestion (sourced from the document identifier source)
- **AND** the suggestion's `detail` indicates it is a CTE

#### Scenario: Identifier with digits completes correctly

- **WHEN** the cache has `public.users_2024`
- **AND** the user types `SELECT * FROM users_20`
- **THEN** the autocomplete popup includes `users_2024` (the digit characters do not break the match)

#### Scenario: Cache update reconfigures autocomplete without breaking the editor

- **WHEN** a new schema `analytics` is bulk-loaded into the cache while a query tab is open
- **THEN** within ~100ms the editor's autocomplete reflects the new schema (typing `FROM analytics.` shows its relations)
- **AND** the editor's syntax highlighting, current selection, undo history, and any in-flight popup state are NOT disrupted

#### Scenario: Empty cache falls back gracefully

- **WHEN** the connection has just been activated and no schemas or columns are cached yet
- **AND** the user types `SEL`
- **THEN** the autocomplete popup shows `SELECT` (keyword source)
- **AND** does NOT throw or error
- **AND** the document identifier source returns no suggestions because the buffer is small

#### Scenario: Same-shape namespace skips reconfigure

- **WHEN** the cache notifies of a change but the resulting namespace has the same schemas and the same relations per schema as the previous reconfigure
- **THEN** the editor does NOT dispatch a reconfigure effect
- **AND** the autocomplete state is unchanged

## REMOVED Requirements

### Requirement: Column cache populated by query results

**Reason**: superseded by the bulk pre-fetch mechanism. Columns are now populated by `postgres_list_columns_bulk` on schema visibility, not opportunistically by SELECT runs. The narrow opportunistic path was a stop-gap that gave inconsistent autocomplete (only after running a SELECT). The bulk fetch covers the same use case proactively and consistently.

**Migration**: any existing call site in the codebase that invoked `maybeRecordColumnsFromSelect` MUST be removed; the schema browser tree triggers `loadColumnsBulk` automatically when a schema's relations are loaded. No user-visible migration required.
