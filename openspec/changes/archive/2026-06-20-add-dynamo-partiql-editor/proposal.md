## Why

DynamoDB is the only Argus source without a free-form query surface. Postgres, MySQL, and MSSQL ship a full SQL editor and Athena ships a query-only editor, but DynamoDB exposes only the guided `QueryBuilder` (Scan/Query + filters). Power users cannot run ad-hoc PartiQL, and the context-query runner already specs a "Dynamo PartiQL execution path" that does not exist yet — today `openDynamoQuery` falls back to copying the substituted query to the clipboard (with a standing TODO). This change closes the last free-form-query gap and lets the already-specced behavior actually run.

## What Changes

- Add a backend Tauri command `dynamo_run_partiql` that executes PartiQL via the DynamoDB SDK `ExecuteStatement` API, returning items (for `SELECT`) or a success/affected outcome (for `INSERT`/`UPDATE`/`DELETE`), with `NextToken` pagination and `ConsumedCapacity`.
- Enforce the connection's `readOnly` flag: a mutating PartiQL statement (`INSERT`/`UPDATE`/`DELETE`) submitted on a read-only connection is rejected before any AWS call.
- Support multi-statement "run all" by splitting on `;` and invoking `ExecuteStatement` once per statement (each call is independent and non-atomic — DynamoDB has no multi-statement transaction here).
- Add a free-form PartiQL editor tab to the frontend (`src/modules/dynamo/sql/`), modeled on the **Athena** query-only editor (CodeMirror, run / run-all keymap, lightweight read-only results, export). It registers a new tab kind via `TabRegistry.register`.
- Render results with DynamoDB-native fidelity: reuse the `data-view` inferred-columns grid + `AttributeValue` cell rendering + JSON inspector for nested items, rather than a flat tabular table, since PartiQL `SELECT` returns heterogeneous nested items.
- Provide completion scoped to what DynamoDB actually knows: table names, index names, and partition/sort key attributes (from `DescribeTable`), plus attributes declared in the context folder.
- Add CSV / JSONL / XLSX export of the result set (reusing the shared export menu).
- Keep the guided `QueryBuilder` as the default per-table experience; the PartiQL editor is the new advanced mode.
- Add launch points: a command-palette entry, a `New PartiQL query` entry on the connection context menu, and an `Open in PartiQL editor` entry on a table leaf that pre-fills `SELECT * FROM "<table>"`.
- Replace the clipboard fallback in `openDynamoQuery` with `openDynamoPartiQLTab`, fulfilling the existing `context-queries-runner` spec for the Dynamo path.

## Capabilities

### New Capabilities
- `dynamo-partiql-editor`: free-form PartiQL editing for DynamoDB — the editor tab and its CodeMirror surface, the `dynamo_run_partiql` execution path (single + multi-statement), read-only gating, result rendering of nested items with inspector, completion sources, consumed-capacity readout, and CSV/JSONL/XLSX export.

### Modified Capabilities
- `dynamo-connection`: the active-row right-click context menu gains a `New PartiQL query` entry (the spec currently explicitly excludes any `New SQL Query` entry, deferring it to this change).
- `dynamo-table-browser`: the table-leaf right-click context menu gains an `Open in PartiQL editor` entry that opens the editor pre-filled with `SELECT * FROM "<tableName>"`.

## Impact

- **Frontend**: new `packages/app/src/modules/dynamo/sql/` (editor tab, run hook, result panel, completion, api, export); updates to `dynamo/index.ts` (side-effect import to register the tab + export the kind), `dynamo/commands.ts` (palette command), `dynamo/openDynamoQuery.ts` (clipboard → native tab), and the table-browser / connection context menus.
- **Backend**: new `packages/app/src-tauri/src/modules/dynamo/partiql.rs` (command + `is_mutating_partiql` classifier + request/response types), registered in `src-tauri/src/lib.rs`. Reuses the existing `DynamoClientRegistry`, `AttrValue` codec, and activity-log pattern. No new crates — `aws-sdk-dynamodb` already provides `ExecuteStatement`.
- **Fulfilled (not modified)**: `context-queries-runner` already specifies the Dynamo PartiQL execution path and result panel; this change makes that real.
- **Out of scope / follow-up**: extracting a shared `<SqlEditor dialect=… />` across Postgres/MySQL/MSSQL/Athena/DynamoDB (the 5 editors are ~90% identical chrome but diverge in result rendering — better extracted once all five real call sites exist). CloudWatch Logs Insights editor. `BatchExecuteStatement`. Native PartiQL positional parameter binding (v1 stays textual per the context-queries spec).
