## Why

DynamoDB context-folder linking matches docs to tables by **exact, case-sensitive physical table name**. With CDK, the same logical table (`Events`) gets a stack prefix and a random suffix that differ per environment and per deploy (`MyApp-dev-EventsTable-1A2B3C…`, `MyApp-prod-EventsTable-3M4N…`). As a result a single context folder cannot be reused across `dev`/`staging`/`prod`, and every deploy's new random suffix breaks the match and makes schema-sync create a brand-new file. The user wants one logical documentation set that matches the real physical table in every environment.

## What Changes

- Introduce a per-connection **table-name normalization rule** for Dynamo that reduces a live physical table name to a stable **logical name** before any context match. Two equivalent authoring forms: a simple `prefix` + `suffix_pattern` (regex), or a single capture `regex` exposing the logical segment.
- Apply normalization at every Dynamo context match point that is exact today:
  - `context_list_models` — normalize the incoming live table name before comparing to a model's derived `physical_table`.
  - `context_get_object` / schema-tree `📄` badge — resolve Dynamo table docs by the normalized name.
  - `context_sync_schema` — write/locate `dynamo/tables/<logical>.md` using the normalized name so re-deploys with a new suffix update the same file instead of creating a new one.
- Define **ambiguity behavior** for schema-sync when two live tables normalize to the same logical name (warn + skip the collision, keep the first; surfaced in the `SyncReport`).
- **Retrocompat**: when no normalization rule is configured, behavior is identical to today (exact match; `shape.name` filenames).
- Add the normalization config to the Dynamo connection params shape and validate it (a malformed regex is rejected with `AppError::Validation`).
- Scope: **DynamoDB only** for now (the engine where the CDK case appears). A per-doc glob (`physical_match`) escape hatch is explicitly out of scope, noted as future work.

## Capabilities

### New Capabilities
- `dynamo-table-name-normalization`: the per-connection rule that reduces a live physical Dynamo table name to a logical name (prefix + suffix-regex strip, or a single capture regex), with an identity fallback when unconfigured and a defined behavior when multiple live tables collide on one logical name. Owns the normalization algorithm consumed by all Dynamo context lookups and schema-sync.

### Modified Capabilities
- `dynamo-connection`: the DynamoDB params shape gains an optional table-name normalization config, validated before persistence.
- `dynamo-context-models`: `context_list_models` matches a model's `physical_table` against the **normalized** live table name rather than raw string equality.
- `connection-context-folders`: Dynamo schema-sync derives the target file path from the **logical** (normalized) name and dedups colliding live tables, instead of using the raw live `shape.name`.
- `context-objects-browser`: the Dynamo `📄` documented-object badge / `context_get_object` resolves the table doc via the normalized live name.

## Impact

- **Rust** (`src-tauri/src/modules/`):
  - `dynamo/params.rs` — extend `DynamoParams` with the normalization config + validation.
  - `context/commands.rs` — `context_list_models` (`:388`), `context_get_object`/`identity` (`:157,:340`) load the connection's rule and normalize before matching.
  - `context/sync.rs` (`target_path_for`, `:57`) + `context/introspect_adapters.rs` (Dynamo introspector, `shape.name`) — apply normalization to the sync write path and dedup.
  - A new normalization helper module (the only place using regex in `context/`; no glob/regex utility exists today — adds a `regex` dependency or uses an existing one).
- **TypeScript** (`src/modules/`): Dynamo connection form gains the normalization fields (`dynamo/.../ConnectionForm` and params types); no change to the `context_list_models` / `getObject` call signatures (normalization is server-side).
- **No DB migration**: config rides the existing opaque `params` JSON on the connection row.
- **Backward compatible**: unconfigured connections and non-Dynamo engines are unaffected.
