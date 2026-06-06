## Why

In Single-Table Design (STD) a single physical DynamoDB table multiplexes many business entities behind PK/SK prefixes (e.g. `USER#123 / ORDER#456`). Today the Dynamo data-view QueryBuilder only filters by the raw PK/SK of the selected index, so a user querying an STD table must hand-compose key prefixes — the tool exposes the physical layout, not the data model. This change lets users filter by **entity + access pattern**, with the tool compiling their inputs into the correct key conditions.

## What Changes

- Introduce a new context-folder document kind `dynamo_model` describing an STD **entity**: its physical table and a list of **access patterns**, each pinned to an index (`table` or a GSI/LSI) with `pk`/`sk` **template strings** (e.g. `"USER#${userId}"`). Query parameters are derived by parsing `${...}` from the templates.
- Model docs live at `dynamo/tables/<physicalTable>/models/<Model>.md`. The context parser gains a **recursive** walk of that `models/` subdirectory (today it only lists `dynamo/tables/*.md` flatly).
- STD mode is detected **by presence**: a table that has model docs offers a new filtering mode; a table without them behaves exactly as today.
- The QueryBuilder gains a **"By model" / "Raw (PK/SK)"** toggle. "Raw" preserves the current builder verbatim (escape hatch + non-STD tables). "By model" presents Entity → Access pattern → derived parameter inputs, with a compiled-key preview.
- A new front-end `modelCompiler` turns (chosen access pattern + parameter values + `TableDescription`) into a raw `BuilderState.query`. **Partial-substitution rule**: all params filled → equality; a trailing param left empty → `begins_with` on the literal prefix up to the first gap; a gap before a filled param → invalid with a clear message. The existing `builderCompiler.ts` is **not modified** — it already resolves key attribute names per index and already supports `begins_with`.
- The data-view reads model docs for the open table via the existing context hooks and passes them to the QueryBuilder (today `contextPath` only reaches the Inspector for display).

## Capabilities

### New Capabilities
- `dynamo-context-models`: The `dynamo_model` document format (frontmatter schema, on-disk location under `dynamo/tables/<table>/models/`), its recursive parsing into the parsed-context model, and the read path (command/hook) that exposes a table's models to the UI.

### Modified Capabilities
- `dynamo-data-view`: The QueryBuilder gains a by-model filtering mode that compiles entity access-pattern inputs into the same Query/Scan requests, available only when the open table has model docs. Raw PK/SK filtering is unchanged.

## Impact

- **Frontend** (`src/modules/dynamo/data-view/`): `QueryBuilder.tsx` (new mode toggle + model/access-pattern/param UI), new `modelCompiler.ts`, `types.ts` (model + access-pattern types, builder mode), `DataViewTab.tsx` (load + pass model docs to the builder). `builderCompiler.ts` unchanged.
- **Backend** (`src-tauri/src/modules/context/`): `types.rs` (model doc / access-pattern types), `parser.rs` (recursive `models/` walk), `commands.rs` (expose models per table). `sync.rs` / `introspect_adapters.rs` **untouched** — model docs are authored by hand in this change.
- **Out of scope** (future change): manual model-editing UI, AI repo-inspection to generate models, "show all items of entity type X" without a declared access pattern, schema-sync of models, CloudWatch.
