## Context

The Dynamo data-view (`src/modules/dynamo/data-view/`) builds Query/Scan requests from a `BuilderState`:

- `QueryBuilder.tsx` renders the index selector, partition-key input, sort-key clause, and filter rows.
- `builderCompiler.ts` turns `BuilderState` + `TableDescription` into a `QueryRequest`/`ScanRequest`. It resolves the PK/SK **attribute names** from the selected index's `key_schema` (`builderCompiler.ts:282-298`) and already emits `begins_with` for sort-key prefix conditions (`builderCompiler.ts:197-203`).
- `DataViewTab.tsx` owns the builder state and reads the connection's `context_path`, but only forwards it to the `Inspector` for documentation display — the query path ignores context entirely.

On the backend, context folders are parsed by `src-tauri/src/modules/context/parser.rs`. For Dynamo, `load_folder` walks `dynamo/tables/*.md` **flatly** and parses each into an `ObjectDoc` (`system:` + `human:` frontmatter, typed via `types.rs`). `commands.rs` exposes `context_list_objects` / `context_get_object`.

In Single-Table Design the physical table is not the unit of meaning — the **entity** is. A user wants "orders for user 123", not "items where pk = USER#123 and sk begins_with ORDER#". This change adds an entity layer on top of the existing raw machinery without rewriting it.

## Goals / Non-Goals

**Goals:**
- Let a user filter an STD table by selecting an entity, then an access pattern, then filling derived parameters.
- Capture entity access patterns as hand-authored `dynamo_model` docs that live in the context folder alongside the physical-table docs.
- Compile entity inputs into the exact same Query/Scan requests the raw builder produces — reusing `builderCompiler.ts` unchanged.
- Keep non-STD tables (and STD tables in "raw" mode) behaving exactly as today.

**Non-Goals:**
- UI for creating/editing model docs (authored by hand in this change).
- AI repo-inspection to generate model docs.
- "Show all items of entity type X" with no declared access pattern (no entity-type discriminator / scan-fallback in this change).
- Schema-sync or introspection of models; CloudWatch.

## Decisions

### D1. Model layer compiles to raw `BuilderState`, not to a new request type

`modelCompiler.ts` produces a `BuilderState.query` (partition key `{name, value}` + optional sort-key clause `{name, op, value}`) and the existing `compile()` does the rest. The model layer supplies key **values** from templates; the existing compiler supplies key **names** from the index's `key_schema` and serializes the request.

- **Why:** `builderCompiler.ts` is the single, tested path to a wire request and already handles index name resolution, `begins_with`, type validation, and filter merging. Layering avoids duplicating any of it and guarantees model-mode and raw-mode produce identical requests for equivalent inputs.
- **Alternative considered:** a dedicated model→request compiler. Rejected — it would re-implement key-name resolution and risk drifting from raw mode.

### D2. STD detection by presence of model docs

A table is "STD" for UI purposes iff at least one `dynamo_model` doc names it as `physical_table`. Presence toggles availability of the "By model" mode; absence means the toggle is hidden and behavior is identical to today.

- **Why:** zero configuration, fully reversible, no manifest flag to maintain. Deleting the model docs reverts the table to raw-only.
- **Alternative considered:** an explicit `std: true` flag in the manifest or table doc. Rejected as redundant — the model docs themselves are the signal.

### D3. Access patterns are a list pinned to an index, with optional names

Each `dynamo_model` declares `access_patterns: [{ name?, index, pk, sk? }]`. `index` is `"table"` or a GSI/LSI name. Multiple patterns MAY target the same index (e.g. GSI1 used both "by status" and "by date"). The UI access-pattern label is `name` when present, otherwise derived from the index + templates.

- **Why:** matches the user's model classes, where several key-composition methods can map onto one physical index. A map keyed by index could not express two patterns on the same index.

### D4. Parameters are derived from `${...}` in templates, not declared

`pk: "USER#${userId}"` yields parameter `userId`. The UI renders one input per distinct parameter across the chosen pattern's `pk` and `sk`. No separate parameter declaration.

- **Why:** single source of truth; the template *is* the contract. Less to author, nothing to keep in sync.

### D5. Partial-substitution rule (equality vs `begins_with`)

For a template split into literal/`${param}` segments, fill values left-to-right:
- All params filled → fully substituted string, compiled as **equality** (`op: "="`).
- The **trailing** run of params left empty → take the literal prefix up to the first empty param and compile as **`begins_with`** on that prefix.
- A trailing-empty template with **no literal prefix at all** (e.g. a bare `sk: "${x}"` with `x` empty) → **drop the SK condition** entirely (partition-only Query) rather than emit `begins_with("")`, which is a degenerate match-all.
- A param left empty **before** a filled param (a gap) → **invalid**; `modelCompiler` returns an error with the offending parameter name.
- An empty PK template (no value at all) → invalid (PK is mandatory for Query).

Applies independently to PK and SK, except PK must fully resolve to a single value (DynamoDB requires an equality PK condition); only SK may degrade to `begins_with`.

- **Why:** mirrors how STD keys are queried — a fully specified key is an exact get; a prefix is a range scan within a partition. The "gap" case is genuinely uncompilable (you cannot `begins_with` across an unfilled interior segment).

### D5-bis. Key value typing — infer from the index, not always string

Template substitution yields text, but `builderCompiler.validateKeyType` (builderCompiler.ts:223-260) **rejects** a string value for an `N`-typed key — and STD GSIs frequently use numeric sort keys (epoch, version, sequence). So `modelCompiler` MUST set each emitted `TypedValue`'s type from the resolved key attribute's type in `TableDescription.attribute_definitions` (`S` → `{type:"S"}`, `N` → `{type:"N"}`). Because the value type is correct at emit time, `builderCompiler` stays **unchanged**.

`begins_with` is a string operation: the partial-substitution degrade to `begins_with` is **only valid on `S`-typed keys**. On a non-`S` key, a partially-filled template is **invalid** (error naming the key) — it cannot become a prefix match.

- **Why:** without this, "By model" mode hard-fails on every numeric-keyed access pattern with a confusing raw-builder error, and the "model mode == raw mode" guarantee is false. Caught in eng-review outside-voice pass.

### D10. Model-mode state ownership and live fallback

`BuilderState` gains a `modelSelection { entity, accessPattern, params: Record<string,string> }` that is the **source of truth** in model mode and is persisted. The `query` field is **always derived** from `modelSelection` via `modelCompiler` while in model mode — never hand-edited there. Switching to raw mode seeds the raw builder from the last compiled `query`; switching back re-derives from `modelSelection` (params are never lost on round-trip). When the open table's model docs change or disappear (live folder watcher) such that `isStd` flips false, the builder falls back to raw mode using the last compiled `query`, and the toggle hides.

- **Why:** `query` would otherwise be shared mutable state written by two producers with no ownership rule, losing the user's entity/params when they toggle to raw and back. Caught in eng-review outside-voice pass.

### D6. Backend recursive walk; reuse the existing doc pipeline

`parser.rs` `load_folder` for Dynamo additionally walks `dynamo/tables/<table>/models/*.md` recursively, parsing each via the existing `parse_object_doc` into the same `ObjectDoc` shape with `kind: "dynamo_model"`. The current Dynamo branch (`parser.rs:365-389`) only reads `p.is_file()` `.md` files in `tables/`, so a `tables/<table>/` directory is skipped today — adding the sub-walk does not conflict, and a `tables/AppTable.md` file and a `tables/AppTable/` directory coexist on disk.

`types.rs` gains **typed** fields on `ObjectSystem`: `access_patterns: Option<Vec<AccessPattern>>` and `physical_table: Option<String>`, where `AccessPattern { name: Option<String>, index: String, pk: String, sk: Option<String> }` (decision: explicit + validated over the `extras` bag). These are `None` for non-Dynamo docs.

- **Why:** the frontmatter parser, atomic-write rules, and `human:`/body preservation already work for any `system:` block; reusing them keeps model docs first-class context objects (browsable, AI-payloadable) for free.

### D7-bis. `physical_table` is derived from the directory path, not authored

A model at `dynamo/tables/<table>/models/<Model>.md` belongs to `<table>` by location. The Dynamo walk populates `system.physical_table` from the parent directory name; it is **not** required (or read) from frontmatter, so it cannot drift from the file's location.

- **Why:** DRY — the path already encodes the table. One source of truth.
- **Alternative considered:** require + validate it in frontmatter. Rejected as redundant authoring with a drift failure mode.

### D8. Dedicated `context_list_models(table)` read command

A new command returns the models whose `physical_table` matches a given table, each with `name` and `access_patterns`. The existing `context_list_objects` is not extended (it omits `access_patterns` and keys entities by `name` alone, which collides across tables — two `Order` entities in different tables).

- **Why:** explicit, collision-free (keyed by physical table), and keeps the shared list-item shape free of Dynamo-only fields. The UI calls one command to populate Entity + Access pattern selectors.

### D9. Template grammar — single authoritative parser in TypeScript

A template is literal text with zero or more placeholders `${ident}` where `ident` matches `[A-Za-z_][A-Za-z0-9_]*`. A literal `$` not followed by `{` is literal text. An unterminated `${` is malformed.

The **TS `modelCompiler` is the single authoritative parser** (it does the real substitution). The **Rust backend does minimal well-formedness validation only** — it warns (via `LoadWarning`) on an unterminated `${` and otherwise stores templates verbatim. The grammar is documented here once; the two sides do not maintain independent full parsers.

- **Why:** the parsing logic can't be shared across the FFI boundary, so minimize what's duplicated. Backend warns early on obviously-broken docs; TS owns compilation.

### D7. UI mode toggle preserves raw builder verbatim

`QueryBuilder.tsx` gains a `builderMode: "model" | "raw"` toggle. "raw" renders today's UI unchanged. "model" renders Entity → Access pattern → param inputs + a compiled-key preview. The toggle is hidden when the table has no model docs (mode is forced to "raw").

- **Why:** the raw builder is the escape hatch for ad-hoc queries and the only path for non-STD tables; it must not regress.

## Risks / Trade-offs

- **Hand-authored model docs can drift from the real key schema** (wrong attribute name, typo'd index) → `modelCompiler` validates the resolved PK/SK attribute names against `TableDescription` and surfaces a clear error rather than issuing a malformed query; the preview shows the compiled expression before running.
- **Template parsing edge cases** (literal `$`, `${` without close, nested braces) → define a strict, documented grammar (`${ident}` where `ident` matches `[A-Za-z_][A-Za-z0-9_]*`); anything else is a literal. Reject malformed templates at parse time with a warning, surfaced like other `LoadWarning`s.
- **PK that can't fully resolve** (user only has a prefix) → not supported in model mode by design (DynamoDB requires equality PK); the user falls back to "raw" mode. Documented, not a bug.
- **Two access patterns rendering ambiguous labels** when neither has a `name` and templates are similar → label derivation includes the index name and both templates to disambiguate; encourage `name` for same-index patterns.

## Migration Plan

Additive only. No data migration: existing context folders without `models/` subdirectories parse exactly as before, and tables without model docs show only the raw builder. Rollback = revert the code; hand-authored model docs are inert to older builds (unknown subdirectory is simply not walked).

## Open Questions

- Should model docs participate in the AI payload now (they're valid context objects) or be excluded until the generation change ships? Default: include, since it's free and harmless.

## Resolved (eng review)

- **Storage of access patterns:** typed fields on `ObjectSystem` (validated, explicit) rather than the `extras` bag — see D6.
- **Read path:** dedicated `context_list_models(table)` command, not an extension of `context_list_objects` — see D8.
- **`physical_table`:** derived from the directory path, not authored in frontmatter — see D7-bis.
- **Template validation:** TS is the authoritative parser; backend warns only on malformed `${` — see D9.
