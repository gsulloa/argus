## 1. Backend — PartiQL execution (Rust)

- [x] 1.1 Add `is_mutating_partiql(statement)` helper in `src-tauri/src/modules/dynamo/` that classifies by first significant keyword (case-insensitive, skips whitespace/line comments): `SELECT` → read, `INSERT`/`UPDATE`/`DELETE` → mutating. Unit-test both directions.
- [x] 1.2 Create `src-tauri/src/modules/dynamo/partiql.rs` with request/response types: `PartiQLRequest { connection_id, statement, origin? }`, and a `RunPartiQLResult` enum mirroring the spec — `Rows { items: Vec<HashMap<String, AttrValue>>, count, query_ms, truncated, consumed_capacity }` and `Succeeded { statement_type, query_ms, consumed_capacity }`. Reuse the existing `AttrValue` codec from `items.rs`.
- [x] 1.3 Implement `dynamo_run_partiql` command: acquire client from `DynamoClientRegistry`, enforce the read-only gate via `is_mutating_partiql` BEFORE any AWS call, call `ExecuteStatement` with `ReturnConsumedCapacity: TOTAL`, map items via `AttrValue`, classify result as `Rows`/`Succeeded`, surface AWS errors as `AppError::Aws` verbatim, emit one `argus:activity-log` event.
- [x] 1.4 Implement `NextToken` pagination loop: accumulate items across pages to a fixed cap (Athena parity unless a lower default is chosen), set `truncated` when capped, aggregate `ConsumedCapacity` across pages.
- [x] 1.5 Implement `dynamo_run_partiql_many(connection_id, statements, origin?)`: run each statement as a separate `ExecuteStatement` sequentially, apply the read-only gate per statement, stop at first failure (remaining `skipped`), return `{ outcomes: [{ index, statement, outcome, result?, error? }] }`.
- [x] 1.6 Register both commands in `src-tauri/src/lib.rs` alongside the existing `dynamo_*` commands.

## 2. Frontend — API + editor scaffold

- [x] 2.1 Create `src/modules/dynamo/sql/` and add `api.ts` with `dynamoRunPartiql` / `dynamoRunPartiqlMany` `invoke` wrappers + TS result types mirroring the Rust envelopes (reuse `AttributeValue`/`AttributeMap` from `data-view/types.ts`).
- [x] 2.2 Add `QueryEditor.tsx` adapted from `athena/sql/QueryEditor.tsx`: CodeMirror surface, `Mod-Enter` (run), `Mod-Shift-Enter` (run all), error mark field, autocomplete compartment.
- [x] 2.3 Add `useQueryRun.ts` adapted from Athena: single vs multi-statement split-on-`;` orchestration, run state machine, calls the `api.ts` wrappers.
- [x] 2.4 Add `QueryTab.tsx` defining the `dynamo-query` tab kind + payload (`connectionId`, `connectionName`, `initialPartiql?`) and calling `TabRegistry.register`.

## 3. Frontend — results, completion, export

- [x] 3.1 Add `ResultPanel.tsx` (hybrid): render `rows` outcomes with the `data-view` inferred-columns grid + `AttributeValue` cells + JSON inspector; render `succeeded` outcomes as a status summary (statement type + consumed capacity, no grid).
- [x] 3.2 Surface consumed-capacity readout per run in the result panel (mirroring Athena's bytes-scanned display).
- [x] 3.3 Add `completionSources.ts`: keywords + table names + index names + PK/SK key attributes from cached `DescribeTable` + context-folder-declared attributes. No data sampling.
- [x] 3.4 Wire CSV/JSONL/XLSX export reusing the shared `export/` menu and `saveExport` flow.

## 4. Wiring — launch points

- [x] 4.1 Update `src/modules/dynamo/index.ts` to export the tab kind as a value and add a side-effect import of the tab module so `TabRegistry.register` runs (NOT `export type`).
- [x] 4.2 Add an `openDynamoPartiQLTab(tabs, connectionId, connectionName, initialPartiql?)` helper and a command-palette entry in `commands.ts` (group `"Dynamo"`) to open a new PartiQL query for the focused connection.
- [x] 4.3 Replace the clipboard fallback in `openDynamoQuery.ts` with `openDynamoPartiQLTab`, pre-filling the substituted query body (removes the standing TODO; fulfills `context-queries-runner`).
- [x] 4.4 Add the `New PartiQL query` entry to the active-row connection context menu (per `dynamo-connection` delta).
- [x] 4.5 Add the `Open in PartiQL editor` entry to the table-leaf context menu, pre-filling `SELECT * FROM "<tableName>"` (per `dynamo-table-browser` delta).

## 5. Verification

- [x] 5.1 Manual: run a `SELECT` returning heterogeneous/nested items; confirm inferred columns + JSON inspector render without flattening loss.
- [x] 5.2 Manual: confirm `INSERT`/`UPDATE`/`DELETE` are rejected on a `read_only` connection before any AWS call, and run on a writable one.
- [x] 5.3 Manual: confirm `Mod-Shift-Enter` multi-statement run halts at first failure with remaining skipped; confirm context-query + both context-menu launch points open the editor.
- [x] 5.4 Confirm CSV/JSONL/XLSX export of a result set; confirm consumed-capacity readout appears.
- [x] 5.5 Run the project's lint/typecheck/test suite and `cargo` checks for the new Rust module.
