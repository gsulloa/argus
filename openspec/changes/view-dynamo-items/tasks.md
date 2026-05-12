## 1. Backend: AttributeValue codec and shared envelope

- [x] 1.1 Define a serde-friendly `AttrValue` enum in `src-tauri/src/modules/dynamo/items.rs` mirroring AWS `AttributeValue` (tags `S`, `N`, `BOOL`, `NULL`, `L`, `M`, `SS`, `NS`, `BS`, `B`) with `#[serde(rename_all = "UPPERCASE", tag-like)]` semantics so the JSON shape is `{"S": "..."}` / `{"L": [...]}` / etc.
- [x] 1.2 Implement `From<aws_sdk_dynamodb::types::AttributeValue> for AttrValue` and `From<AttrValue> for aws_sdk_dynamodb::types::AttributeValue` with full coverage of every tag, including binary (`B`, `BS`) round-tripping through base64.
- [x] 1.3 Add unit tests for the codec: every tag round-trips, base64 binary is exact, deeply nested `L`/`M` survive.
- [x] 1.4 Define shared request envelopes `ScanRequest`, `QueryRequest`, `CountRequest` and response envelopes `ScanResponse`, `QueryResponse`, `CountResponse`. Keep snake_case for IPC.
- [x] 1.5 Define a helper `compact_activity_params(...)` that builds the activity-log `params` JSON `{ table_name, index_name?, has_filter, has_key_condition, limit, consistent_read, select?, page, scan_index_forward? }` for reuse across the three commands.

## 2. Backend: Scan command

- [ ] 2.1 Implement `pub async fn scan(...)` in `items.rs` taking `ScanRequest` plus `origin: Option<Origin>`; look up client via `DynamoClientRegistry`, return `AppError::NotFound` when absent.
- [ ] 2.2 Validate `limit` in `1..=1000` before any AWS call; reject with `AppError::Validation` otherwise.
- [ ] 2.3 Forward `filter_expression`, `expression_attribute_names`, `expression_attribute_values`, `projection_expression`, `index_name`, `consistent_read`, `select`, `exclusive_start_key` to the AWS SDK call verbatim. Do not parse or rewrite expressions.
- [ ] 2.4 Funnel AWS errors through `dynamo::errors::translate_aws_error` so the credential-expiration detector fires on `ExpiredToken*` + access-keys + session_token.
- [ ] 2.5 Emit exactly one `argus:activity-log` event with `kind: "scan_table"` and the compact params payload from 1.5; `metric: { kind: "items", value: response.count }` on success, `null` on failure; `duration_ms` is wall-clock.
- [ ] 2.6 Register `dynamo.scan` in `src-tauri/src/modules/dynamo/commands.rs` and re-export from `mod.rs`.
- [ ] 2.7 Add a Tauri integration test (mock SDK or DynamoDB Local) covering the happy path, the `limit` validation rejection, and a `ValidationException` surfaced from AWS.

## 3. Backend: Query command

- [ ] 3.1 Implement `pub async fn query(...)` mirroring `scan` but with required `key_condition_expression` and optional `scan_index_forward` (default `true`).
- [ ] 3.2 Validate `key_condition_expression` is non-empty; reject with `AppError::Validation` otherwise.
- [ ] 3.3 Emit `kind: "query_table"` activity-log event with `params.has_key_condition: true` and `params.scan_index_forward` populated.
- [ ] 3.4 Register `dynamo.query` and integration-test happy path, reverse sort (`scan_index_forward: false`), and missing-key-condition rejection.

## 4. Backend: Count command

- [ ] 4.1 Implement `pub async fn count_items(...)` accepting a `CountRequest` with `mode: "scan" | "query"`, optional filter/index/keys, and `consistent_read`. Reject `mode: "query"` without `key_condition_expression` via `AppError::Validation`.
- [ ] 4.2 Internally page with `Select: "COUNT"` and `Limit: 1000` per AWS call, accumulating `Count` and `ScannedCount` into `total_count` / `total_scanned_count` until `last_evaluated_key` is null.
- [ ] 4.3 Track `page_count` (number of AWS calls made). Sum any `ConsumedCapacity` reported by AWS if returned.
- [ ] 4.4 Funnel AWS errors through the credential-expiration contract; surface `ValidationException` verbatim.
- [ ] 4.5 Emit one `argus:activity-log` event with `kind: "count_table"` and `metric: { kind: "items", value: total_count }` on success.
- [ ] 4.6 Register `dynamo.count_items` and integration-test (a) unfiltered scan count over a small Local table, (b) filter-shrinks-count case, (c) query-mode count, (d) missing-key-condition validation.

## 5. Frontend: types and IPC binding

- [ ] 5.1 In `src/modules/dynamo/data-view/types.ts`, define the TS `AttributeValue` union mirroring the backend tag shape (`{S}|{N}|{BOOL}|{NULL}|{L}|{M}|{SS}|{NS}|{BS}|{B}`), plus `AttributeMap = Record<string, AttributeValue>`.
- [ ] 5.2 Define the `TypedValue`, `FilterRow`, `BuilderState`, `ScanRequest`, `QueryRequest`, `CountRequest` TS types matching the backend envelopes.
- [ ] 5.3 In `src/modules/dynamo/data-view/api.ts`, export thin wrappers `dynamoScan`, `dynamoQuery`, `dynamoCountItems` over the existing `invoke` helper, passing `origin` explicitly.
- [ ] 5.4 Wire the new wrappers through the Dynamo module's `index.ts` so consumers import from `@/modules/dynamo` only.

## 6. Frontend: builder state and expression compiler

- [ ] 6.1 In `src/modules/dynamo/data-view/builderCompiler.ts`, implement `compile(builder: BuilderState, describe: TableDescription)` returning `{ scan: ScanRequest } | { query: QueryRequest }` ready for the backend. Always use `#nN`/`#kN` and `:vN`/`:kN` placeholders; never inline names or values.
- [ ] 6.2 Implement filter-row compilation for every operator listed in the spec (`=`, `<>`, `<`, `<=`, `>`, `>=`, `between`, `contains`, `begins_with`, `attribute_exists`, `attribute_not_exists`, `is_null`, `is_not_null`, `attribute_type`).
- [ ] 6.3 Implement sort-key compilation for `Query` mode operators (`=`, `<`, `<=`, `>`, `>=`, `between`, `begins_with`).
- [ ] 6.4 Validate types client-side: key pickers reject values whose type does not match `attribute_definitions[index].key_schema`; numeric values are validated as numeric strings.
- [ ] 6.5 Unit-test the compiler: each operator produces the expected expression text + names + values; reserved-word attribute names round-trip safely; `between` uses two placeholders.

## 7. Frontend: useDynamoItems hook (Scan/Query/pagination)

- [ ] 7.1 In `src/modules/dynamo/data-view/useDynamoItems.ts`, implement a hook that takes `{ connectionId, tableName, builder, describe }` and exposes `{ items, lastEvaluatedKey, count, scannedCount, status: "idle"|"loading"|"ready"|"error", error?, page, run(origin?: "user"|"auto"), loadMore(origin: "user"), reset() }`.
- [ ] 7.2 `run` resets pagination and fires one Scan or Query (chosen by the builder) with the compiled request; `loadMore` appends a page using the stored `last_evaluated_key`.
- [ ] 7.3 Track an `auto_scroll_disabled` boolean that flips to `true` after a failed load and resets only when the user invokes `loadMore` manually or `run`.
- [ ] 7.4 Listen for `dynamo:credentials-refreshed` for the connection id; if a request had failed with `ExpiredToken`, re-fire that request automatically with the same builder state and `exclusive_start_key`.
- [ ] 7.5 Unit-test the hook with mocked `dynamoScan`/`dynamoQuery`: happy path, append on `loadMore`, scroll-disable on failure, credentials-refreshed auto-resume.

## 8. Frontend: shared data view tab

- [ ] 8.1 Add `src/modules/dynamo/data-view/DataViewTab.tsx` orchestrating the toolbar, query-builder, results panel, inspector, and bottom bar. Read `describe` from payload; fall back to `dynamo.describeTable` on mount when null.
- [ ] 8.2 Implement the toolbar (`Toolbar.tsx`): mode toggle Tabla/JSON, Run, Reset, Consistent-read toggle, Reverse-order toggle (Query only), Page size input, Count button, Load more button, an inline "Connection waiting for credentials" notice.
- [ ] 8.3 Wire `⌘R` and `⌘⇧R` shortcuts scoped to the data view tab so they fire regardless of focus inside form controls but NOT when inside CodeMirror in JSON mode (handle the precedence with the existing shortcut router used by `app-shell`).
- [ ] 8.4 Persist `dynamoView:<connectionId>:<tableName>` and `dynamoLimit:<connectionId>:<tableName>` via the existing settings store.
- [ ] 8.5 Implement `Metadata` sub-view rendering the describe contents (key schema, attribute definitions, GSIs, LSIs, billing mode, stream state, item count, ARN) and a "Refresh metadata" button.
- [ ] 8.6 Implement a bottom bar (`BottomBar.tsx`) showing `<N> items loaded` and (when present) `Count: <total> (scanned <scanned>)` with a 1000s grouping locale.

## 9. Frontend: query builder UI

- [ ] 9.1 Add `src/modules/dynamo/data-view/QueryBuilder.tsx` with a mode selector (`Scan` / `Query`), index dropdown (primary + GSIs + LSIs), Query-only partition-key picker (typed) and optional sort-key picker (typed, with operator selector), and a list of filter rows with `attribute / operator / value` per the spec.
- [ ] 9.2 Implement the typed value editor: `S` (text input), `N` (numeric input with non-numeric rejection), `BOOL` (toggle), `NULL` (switch that sets `{ "NULL": true }`).
- [ ] 9.3 Add the collapsible "Preview" panel rendering the compiled `KeyConditionExpression` (if Query) and `FilterExpression` plus the names/values JSON.
- [ ] 9.4 Disable Run when required fields are missing or invalid (partition-key value missing in Query mode, key-picker type mismatch, etc.); show inline hints.
- [ ] 9.5 Tests: switching modes, adding/removing filter rows, building a `between` filter, building a `begins_with` sort-key clause, type-mismatch validation, Preview reflects the compiled state.

## 10. Frontend: Tabla mode

- [ ] 10.1 Add `src/modules/dynamo/data-view/TabView.tsx` using TanStack Table + TanStack Virtual for a virtualized grid.
- [ ] 10.2 Implement `useInferredColumns(items, describe)` returning a stable column order: PK, SK (if present), top-N (default 10) attributes by frequency in the loaded sample (alphabetical tie-break), then the fixed `More…` column. Once a column appears it MUST NOT move; new columns may append on the right before `More…` when their frequency exceeds the current Nth column's.
- [ ] 10.3 Implement type-aware cell rendering: primitives (`S`, `N`, `BOOL`, `NULL`) inline; `B` as `<binary NB>`; `L`/`SS`/`NS`/`BS` as `[N items]`; `M` as `{K keys}`. Complex-type cells are clickable and select the row + focus the inspector on that attribute.
- [ ] 10.4 Row click selects the row and routes it to the inspector. Selection survives load-more.
- [ ] 10.5 Implement scroll-to-load: when the last virtual row enters the viewport and `lastEvaluatedKey != null` and `auto_scroll_disabled == false`, dispatch `loadMore("user")`.
- [ ] 10.6 Tests: column ordering with mixed-shape items, column stability across pages, summary rendering for `L`/`M`/`B`/sets, click-to-inspector routing.

## 11. Frontend: JSON mode

- [ ] 11.1 Add `src/modules/dynamo/data-view/JsonView.tsx` using TanStack Virtual to render one CodeMirror block per item, lazy-mounting on scroll-into-view with a 5-row look-behind/look-ahead window. The selected item's editor stays mounted regardless.
- [ ] 11.2 Each block renders `Item #i — pk=…, sk=…` header and the pretty JSON; clicking it selects the item in the inspector.
- [ ] 11.3 Reuse the existing `language-json` CodeMirror lang extension already used by the Postgres module's JSON edit feature.
- [ ] 11.4 Tests: lazy-mount window size, selected item stays mounted on scroll-away, click selects in inspector.

## 12. Frontend: Inspector panel

- [ ] 12.1 Add `src/modules/dynamo/data-view/Inspector.tsx` rendering the selected item as a tree with type badges (`S | N | B | BOOL | NULL | L | M | SS | NS | BS`). PK / SK rows accented per `DESIGN.md`.
- [ ] 12.2 Nested `L` and `M` expand on click; sets render their elements read-only.
- [ ] 12.3 Resizable width with persistence per tab (mirror `useInspectorWidth` pattern from Postgres without sharing the hook — copy with a Dynamo-specific storage key).
- [ ] 12.4 `Escape` clears row selection and empties the inspector.

## 13. Frontend: Count integration

- [ ] 13.1 Wire the Count button in the toolbar to invoke `dynamoCountItems` with the current builder state. Show a spinner and disable the button while in flight.
- [ ] 13.2 Render the result (or its absence) in the bottom bar as `Count: <total> (scanned <scanned>)` with comma grouping.
- [ ] 13.3 Clear the rendered count when the builder state's mode, index, filter, or key condition changes.
- [ ] 13.4 Tests: never fires automatically, double-click doesn't double-fire, result clears on builder change.

## 14. Frontend: activation flow swap + placeholder retirement

- [ ] 14.1 Update `src/modules/dynamo/tables/openTableTab.ts` (introduced in #10) so it opens a `dynamo-data-view` tab (kind change only; id stays `dynamotbl:<connectionId>:<tableName>`).
- [ ] 14.2 Remove the `dynamo-table-placeholder` tab kind from the tab-kind registry; delete the placeholder component if no other call site uses it.
- [ ] 14.3 Add a session-state migration that, on load, rewrites any persisted tab record with `kind: "dynamo-table-placeholder"` to `kind: "dynamo-data-view"` while preserving its payload's `describe`.
- [ ] 14.4 Update the per-cached-table palette command `argus.dynamo.openTable:<connectionId>:<tableName>` registration to call the same `openTableTab` helper (already does via shared id) so palette activation opens the data view.
- [ ] 14.5 Tests: activation opens the data view, session migration rewrites placeholder records, palette command opens the data view.

## 15. Frontend: disconnect / delete tab cleanup

- [ ] 15.1 Hook a listener on `dynamo:active-changed` so that when a connection becomes inactive, any open `dynamo-data-view` tabs for that connection are closed.
- [ ] 15.2 Hook a listener on `connections.delete` so that deleting a Dynamo connection closes its data view tabs.
- [ ] 15.3 Tests: disconnect closes the tab; delete closes the tab.

## 16. Frontend: credentials-refresh resume

- [ ] 16.1 In `DataViewTab`, observe `dynamo:credentials-refreshed` for the tab's `connectionId` and instruct `useDynamoItems` to re-fire the last failed request automatically.
- [ ] 16.2 While `params.needs_credentials` is true for the connection, disable Run / Load more / Count / index / mode controls and show the inline "Connection waiting for credentials" notice.
- [ ] 16.3 Tests: refresh triggers automatic re-run; controls disabled while waiting.

## 17. Documentation and design fidelity

- [ ] 17.1 Update `design/preview.html` if any new component classes / tokens are introduced so the preview reflects the Dynamo data view.
- [ ] 17.2 Verify every new component against `DESIGN.md`: font choices, accent color, border radii, motion. No decorative gradients, no AI-slop layouts.
- [ ] 17.3 Add a brief module-level comment at the top of `src/modules/dynamo/data-view/index.ts` summarizing what this directory owns and what it does not (no editing, no PartiQL, no export — those land in #12 and #13).

## 18. End-to-end validation

- [ ] 18.1 With DynamoDB Local or a sandbox AWS account, manually run the golden path: open a Dynamo connection, click a table, run a scan, load more, switch to JSON, select an item, switch to Query mode against a GSI, run, count items, change page size, change consistent-read, hit ⌘R / ⌘⇧R.
- [ ] 18.2 Verify the read-only flag: a read-only Dynamo connection still browses items normally (no UI gating beyond the existing `RO` badge).
- [ ] 18.3 Simulate an `ExpiredToken` mid-scan in access-keys mode with a session token and confirm the existing re-prompt + auto-resume contract still holds end to end.
- [ ] 18.4 Run `openspec validate view-dynamo-items --strict` and resolve any issues before opening the PR.
