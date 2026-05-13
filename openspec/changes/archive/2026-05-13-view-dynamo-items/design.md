## Context

After #9 (`add-dynamo-connection`) and #10 (`browse-dynamo-tables`), Argus knows how to connect to DynamoDB and list/describe tables. Clicking a table opens a `dynamo-table-placeholder` tab that shows describe metadata only — it cannot show items. This change builds the first real data plane for DynamoDB: Scan/Query with pagination, two view modes (Tabla, JSON), a structured query builder, and an inspector panel. It is the prerequisite for the edit change (#12).

Key existing pieces this change builds on:

- `DynamoClientRegistry` (backend, `src-tauri/src/modules/dynamo/client.rs`) — already holds connected SDK clients with the `read_only` snapshot envelope. The new commands look up the client here and never instantiate a fresh client.
- The credential-expiration / re-prompt contract in `dynamo-connection` — every new command MUST funnel its AWS errors through the same detector so that an expired session token triggers `needs_credentials = true` and the toast + re-prompt dialog, with open tabs surviving the refresh.
- The `dynamo-table-browser` tab activation flow — currently opens `dynamo-table-placeholder` with id `dynamotbl:<connectionId>:<tableName>`. We keep the id stable but swap the kind, so palette commands and double-activation focus continue to work.
- The Postgres data grid in `src/modules/postgres/data/DataGrid.tsx`. It is rich (editable cells, primary-key-aware row identity, filter bar integration, type-aware binding) and is **not** a good shared base for Dynamo's heterogeneous Tabla mode without rework.

UI constraints from the roadmap that apply to this change:

- Dynamo has no schemas. The data view sits directly under the connection in the tab hierarchy; the sidebar subtree is flat (already enforced in #10).
- Item shape is heterogeneous. The Tabla view infers columns from a sample; the JSON view shows raw pretty JSON per item.
- All reads are eventually consistent by default; a per-query toggle opts into Consistent reads.

## Goals / Non-Goals

**Goals:**

- Add backend Scan / Query / Count commands that respect the existing client registry, activity-log envelope, and credential-expiration contract.
- Open a real data view tab when the user activates a table leaf, replacing the placeholder kind. Preserve the existing stable tab id `dynamotbl:<connectionId>:<tableName>` and the palette command behavior.
- Provide a Tabla mode with inferred columns and complex-type summaries that route to the inspector, and a JSON mode that scales to large pages via virtualization.
- Provide a DSL-less query builder (Scan vs Query, index picker, key pickers, filter rows) that compiles to `KeyConditionExpression` + `FilterExpression`. The user never types raw DynamoDB DSL in this change.
- Page incrementally via `LastEvaluatedKey` with both scroll-to-load and a "Load more" button fallback. Default page size 100, persisted per table.
- Make Count explicit and opt-in (a button), never automatic, since `Select=COUNT` over large tables can consume significant capacity.
- Keep all new code inside `src/modules/dynamo/` and `src-tauri/src/modules/dynamo/`. The Postgres module is not touched.

**Non-Goals:**

- Editing items. Put/Update/Delete arrive in #12; until then the Tabla view is read-only and cells do not enter edit mode.
- PartiQL. The PartiQL editor lands in #13 with its own tab kind.
- Exporting results (`dynamo-export-items`) or bulk import (`dynamo-import-items`) — crossroads, not in this change.
- A richer editor for complex types (`L`, `M`, sets) — this change shows them as summaries that open in the inspector but does not provide structural editing of nested values.
- Saved queries / favorites — covered by the `saved-queries` capability if and when it lands.
- Refactoring the Postgres grid to be source-agnostic. See the decision below.

## Decisions

### 1. Backend commands shape

Three commands in `src-tauri/src/modules/dynamo/items.rs`, registered through `commands.rs`. All three are read-only and do not invoke `require_writable`.

```rust
// dynamo.scan
pub struct ScanRequest {
  connection_id: Uuid,
  table_name: String,
  index_name: Option<String>,
  limit: u32,                              // 1..=1000, default 100
  exclusive_start_key: Option<Value>,      // opaque JSON map from a previous response
  filter_expression: Option<String>,
  expression_attribute_names: Option<HashMap<String, String>>,
  expression_attribute_values: Option<HashMap<String, AttrValue>>,
  projection_expression: Option<String>,
  consistent_read: bool,                   // default false
  select: Option<SelectMode>,              // ALL_ATTRIBUTES (default) | ALL_PROJECTED_ATTRIBUTES | SPECIFIC_ATTRIBUTES
  origin: Option<Origin>,                  // "user" | "auto"
}

pub struct ScanResponse {
  items: Vec<HashMap<String, AttrValue>>,
  last_evaluated_key: Option<HashMap<String, AttrValue>>,
  scanned_count: u32,
  count: u32,
  consumed_capacity: Option<ConsumedCapacity>,
}
```

`dynamo.query` mirrors `ScanRequest` but additionally requires `key_condition_expression` and accepts `scan_index_forward: bool`. `dynamo.count_items` accepts the same filter + index inputs as Scan/Query but ignores `limit` / `exclusive_start_key` in its caller-facing API; internally it paginates with `Select: COUNT` and `Limit: 1000` per page until exhausted, aggregating `Count` and `ScannedCount`.

`AttrValue` is a tagged enum mirroring the AWS SDK's `AttributeValue` and serializing as JSON `{"S":"..."} / {"N":"..."} / {"BOOL":true} / {"NULL":true} / {"L":[...]} / {"M":{...}} / {"SS":[...]} / {"NS":[...]} / {"BS":["b64", ...]} / {"B":"b64"}`. This shape is the same one the frontend uses to render Tabla / JSON / Inspector views, so we don't pay a translation tax at the IPC boundary.

Errors funnel through the existing `dynamo::errors` helpers so the credential-expiration detector still fires. Validation rules (rejected up-front before any AWS call):

- `limit < 1 || limit > 1000` → `AppError::Validation`.
- Query without `key_condition_expression` → `AppError::Validation`.
- `count_items` always sets `Select: COUNT` regardless of caller-provided `select`.
- The Rust layer does NOT parse or rewrite the user's expressions. They are forwarded verbatim. AWS validates them and returns `ValidationException` on bad input; we surface the message verbatim.

Activity-log envelope (one event per command, emitted before returning):

- `kind`: `scan_table` | `query_table` | `count_table`. Yes, `query_table` collides with the Postgres command's kind value; this is acceptable because activity-log already includes `connection_id`, and the connection's `kind` (`postgres` vs `dynamodb`) is available from the connections table. If filtering by kind matters later, we can prefix Dynamo's kinds, but no behavior breaks today.
- `connection_id`: the id.
- `origin`: from the request (defaults to `"auto"`).
- `sql`: `null` (Dynamo is not SQL).
- `params`: a compact JSON envelope holding `{ table_name, index_name?, has_filter, has_key_condition, limit, consistent_read, select?, page: number }` so the activity log is readable without dumping AttributeValue payloads. `page` is the 1-indexed page number computed by the caller (frontend tracks it).
- `metric`: `{ kind: "items", value: <returned item count> }` on success (or `<count>` for count_items); `null` on failure.
- `duration_ms`: wall-clock.
- `status`: `ok` / `err`.

### 2. Tab kind: replace placeholder, keep id

We retire `dynamo-table-placeholder` and introduce `dynamo-data-view`. Activating a leaf in the sidebar opens / focuses a tab with `id: "dynamotbl:<connectionId>:<tableName>"` (unchanged) and `kind: "dynamo-data-view"`. The placeholder's metadata content becomes a sub-tab inside the data view labeled `Metadata`.

Why not introduce a second tab id (`dynamodata:...`) and keep the placeholder alive? Two reasons:

1. Two tabs per table is bad UX. The user opened the placeholder to look at items.
2. The placeholder kind only existed to be replaced in #11. Retiring it now keeps the tab-kind registry honest.

The tab payload becomes `{ connectionId, connectionName, tableName, describe: TableDescription | null }`. The data view re-fetches `describe` on mount if `describe` is `null`, just like the placeholder did. Cached describe from #10's frontend cache is still consumed.

### 3. Tabla mode: write Dynamo-specific, don't extract from Postgres

The roadmap leaves this as a decision to make at proposal time. We choose **Dynamo-specific Tabla view built directly on TanStack Table + virtualizer**, without extracting `src/modules/postgres/data/DataGrid.tsx` into a shared component.

Rationale:

- Dynamo's shape is fundamentally different from Postgres's. Items are heterogeneous; columns are inferred and re-computed as the user scrolls; there's a "More…" column that has no Postgres equivalent; cells render type-tagged summaries (`L`, `M`, `B`, sets) that route to an inspector. Postgres rows are tabular by definition; the grid hard-codes notions like primary-key-aware row identity, editable cells with type-aware binding, and a filter bar tied to column metadata. Generalizing those concepts costs more than it saves.
- Extraction risks regressing Postgres. The current data grid is well-tested and used heavily; pulling it out as a shared primitive in the same change that introduces a totally new view is two large refactors at once.
- The shared primitives we actually need (TanStack Table, virtualizer, CodeMirror, basic typography) already live at the framework level. There is no Argus-specific composition that's worth extracting yet.
- If a second NoSQL data view appears later (e.g., Mongo, or PartiQL results in #13 reusing this view), we revisit. For now, a Dynamo-specific Tabla view inside `src/modules/dynamo/data-view/` is the simplest correct answer.

Concrete implementation:

- `src/modules/dynamo/data-view/TabView.tsx` consumes a `useDynamoItems({ tab, request })` hook that returns `{ items, lastEvaluatedKey, count, scannedCount, status, error, loadMore, reset }`. The hook owns Scan/Query dispatch (the only difference between modes at this layer is the request shape).
- Column inference runs inside `useInferredColumns(items, describe)`: PK first, SK second (if present, from `describe.key_schema`), then top-N attributes (default N=10) sorted by frequency of appearance in the loaded sample, ties broken by alphabetical name. The "More…" column is always last. Frequency recomputes when `items` grows, but the column order is stable: once a column is shown it stays in place; new less-frequent attributes append on the right (before "More…") only when their frequency exceeds the current Nth column's frequency. This avoids horizontal layout shift while keeping the inferred set useful.
- Cell rendering by AttributeValue tag: `S`/`N`/`BOOL`/`NULL` render inline; `B` renders `<binary 128B>` with byte length; `L`/`SS`/`NS`/`BS` render `[N items]`; `M` renders `{K keys}`. All non-primitive renders are clickable and open the inspector with the path pre-selected.

### 4. JSON mode: virtualized CodeMirror blocks, read-only

`src/modules/dynamo/data-view/JsonView.tsx` renders each item as one CodeMirror instance in read-only mode with `language-json` and pretty-printed `JSON.stringify(item, null, 2)`. The list is virtualized using the same virtualizer family as the Postgres grid (TanStack Virtual is already in the project). Each block has a header `Item #i — pk=…, sk=…` and a click handler that selects it in the inspector.

A naive implementation would mount one CodeMirror per visible item, which is fine at 20 items in the viewport but can be expensive on slower hardware. To keep it responsive: each row's CodeMirror is mounted lazily on first scroll into view, and unmounted with a 5-row look-behind / look-ahead window. The selected item's editor is exempt from unmounting so it stays mounted while the inspector references it.

### 5. Query builder: structured, DSL-less, types from the schema

The builder UI lives in `src/modules/dynamo/data-view/QueryBuilder.tsx` and produces a `BuilderState` that compiles to the backend request shape.

```ts
type BuilderState = {
  mode: 'scan' | 'query';
  indexName: string | null;       // null = primary index
  pageSize: number;
  consistentRead: boolean;
  scanIndexForward: boolean;      // query only
  query?: {
    partitionKey: { name: string; value: TypedValue };
    sortKey?: {
      name: string;
      op: '=' | '<' | '<=' | '>' | '>=' | 'between' | 'begins_with';
      value: TypedValue | { min: TypedValue; max: TypedValue };
    };
  };
  filters: FilterRow[];           // applied as FilterExpression on both modes
};

type FilterRow =
  | { kind: 'compare'; attribute: string; op: '=' | '<>' | '<' | '<=' | '>' | '>=' | 'contains' | 'begins_with' | 'between'; value: TypedValue | { min: TypedValue; max: TypedValue } }
  | { kind: 'unary'; attribute: string; op: 'attribute_exists' | 'attribute_not_exists' | 'is_null' | 'is_not_null' }
  | { kind: 'attribute_type'; attribute: string; type: 'S' | 'N' | 'B' | 'BOOL' | 'NULL' | 'L' | 'M' | 'SS' | 'NS' | 'BS' };

type TypedValue =
  | { type: 'S'; value: string }
  | { type: 'N'; value: string }    // string per AWS spec, validated as numeric
  | { type: 'BOOL'; value: boolean }
  | { type: 'NULL' };
```

Compilation rules (in TS, the result is passed verbatim to the backend):

- Attribute names are always referenced via `ExpressionAttributeNames` placeholders (`#n0`, `#n1`, …) to handle reserved words.
- Attribute values are always referenced via `ExpressionAttributeValues` placeholders (`:v0`, `:v1`, …).
- Filter rows are AND-joined into `FilterExpression`. There is no OR support in #11. (Justification: scan/query filter is post-fetch; OR rarely reduces I/O. Add when needed.)
- For Query mode, `KeyConditionExpression` is built from the partition key (always `=`) and the optional sort key clause.
- Index typing for key pickers comes from `describe.attribute_definitions` cross-referenced with `describe.key_schema` (and each GSI's / LSI's `key_schema`). The picker enforces `S` / `N` / `B` per the schema; values of other types are rejected client-side before dispatch.
- For free-form filter attributes (not in `attribute_definitions`), the user picks the type explicitly from a `S` / `N` / `BOOL` / `NULL` selector. There is no type inference from sampled data.

The builder also surfaces a small "Preview" disclosure that shows the compiled `FilterExpression` / `KeyConditionExpression` strings and the names/values maps — useful for learning the DSL without forcing the user to write it. This is purely informational.

### 6. Pagination and Count

Pagination uses the AWS `LastEvaluatedKey` returned in `ScanResponse` / `QueryResponse`. The hook stores it; "Load more" appends the next page and updates the key. Scroll-to-load fires "Load more" automatically when the last row enters the viewport and `lastEvaluatedKey != null`. If a load fails, scroll-to-load goes quiet until the user clicks the manual button.

Page size persists per table under `dynamoLimit:<connectionId>:<tableName>` via the existing settings store. Default 100. Bounded to `[1, 1000]` by both the frontend bounds check and the backend validation.

Count is its own button in the toolbar. It is never auto-fired. The implementation calls `dynamo.count_items` (which paginates internally) and reports the aggregate. While in flight, the button shows a spinner and is disabled to avoid duplicate counts. The result is shown inline in the bottom bar: `Count: 12,345 (scanned 50,000)` and stays until the filter or index changes.

### 7. Inspector panel and selection

`src/modules/dynamo/data-view/Inspector.tsx` shows the currently-selected item as a tree. Each leaf renders `attributeName : <typeBadge> : value`. Type badges are `S`, `N`, `B`, `BOOL`, `NULL`, `L`, `M`, `SS`, `NS`, `BS`, matching the AttributeValue tag. PK and SK rows have a subtle accent (matching `DESIGN.md`'s accent treatment — no extra color decisions in this change). Nested `L` / `M` are expandable; sets render their contents but are not editable (#12 lands edit).

Selection is single-row. The Tabla mode selects by row index; JSON mode selects by item id (a stable hash of `pk`+`sk` or, if the table has only PK, just the PK). Selection survives loading more items. Pressing `Esc` clears selection.

Width is resizable, mirroring the Postgres `useInspectorWidth` hook pattern: a horizontal drag handle persists width per tab.

### 8. Activation flow and the placeholder kind retirement

`src/modules/dynamo/tables/openTableTab.ts` (introduced by #10) is updated so that activation creates a tab with `kind: "dynamo-data-view"` instead of `kind: "dynamo-table-placeholder"`. The id remains `dynamotbl:<connectionId>:<tableName>`. The palette commands `argus.dynamo.openTable:<connectionId>:<tableName>` keep the same id and pass the same activation through this helper.

The `dynamo-table-placeholder` kind is removed from the tab-kind registry. Any in-memory persisted state referencing it (Zustand store, session restore) is migrated on read: a tab record with kind `dynamo-table-placeholder` is rewritten to `dynamo-data-view` and its payload's `describe` is preserved. This is a one-way migration; no rollback path is needed because the placeholder offered nothing the new view doesn't already provide.

### 9. Error handling and the credential-expiration contract

All three commands route AWS errors through `dynamo::errors::translate_aws_error`, the same helper used by `connect`, `list_tables`, and `describe_table`. That preserves the existing `ExpiredToken` detection — an expired session token mid-scan flips `needs_credentials = true`, evicts the cached client, and triggers the toast + form re-prompt. The data view tab survives this: when the credentials-refreshed event fires for its connection id, it re-fires the last in-flight request automatically. Throttling errors (`ProvisionedThroughputExceededException`, `ThrottlingException`) surface as a one-shot toast plus an inline retry on the toolbar — no automatic retry to avoid silent ramp-up of charges.

### 10. Read-only flag

This change is read-only in nature. Scan/Query/Count do not write. We deliberately do NOT call `require_writable` in the new commands, even on read-only connections, so that read-only connections can still browse items. The `RO` badge on the connection row remains the user-facing signal.

## Risks / Trade-offs

- **Heterogeneous columns can mislead** → Document in the toolbar that Tabla shows inferred top-N columns and that some attributes might not appear; users always have the JSON mode and the inspector for full fidelity.
- **`Select=COUNT` on large tables is expensive** → Make Count explicit and never automatic; show the consumed capacity if the user opted into return-consumed-capacity at the connection level (out of scope here, but the field is in the response).
- **Activity-log `query_table` kind collision with Postgres** → Acceptable because rows include `connection_id`; if a downstream filter ever needs to disambiguate, the connection's `kind` is available from the connections table without a spec change. Revisit if collision causes a real bug.
- **JSON mode with many CodeMirror instances** → Mitigated by lazy mount via virtualizer with a small look-ahead window; the selected item stays mounted to keep inspector references stable.
- **Tabla column drift as more items load** → Mitigated by stable column order — once shown, a column never moves, only new columns can append on the right before "More…".
- **Choosing Dynamo-specific over shared grid** → If a third source (Mongo, PartiQL view) shows up wanting the same Tabla affordances, we'll likely need to extract a shared primitive. This change documents that explicitly in a Non-Goal and accepts the future refactor cost.
- **The placeholder-kind retirement is a session-state migration** → We rewrite the kind on load. No persisted external references exist (palette commands compute the id on demand). Worst case is a one-time tab reset for users who upgrade with an open placeholder tab; we accept this.

## Migration Plan

There is no production data to migrate. The only state change is the local in-app session: persisted tab records with kind `dynamo-table-placeholder` are rewritten to `dynamo-data-view` on first load after upgrade. No new database tables. No new keychain entries. Two new setting keys are written lazily (`dynamoView:...`, `dynamoLimit:...`) when the user actually changes the mode or page size — defaults work without any settings rows.

Rollback: revert the change. Settings rows that were created (`dynamoView`, `dynamoLimit`) become orphaned but harmless. Persisted tab records with kind `dynamo-data-view` would be unknown to the previous version; the previous version's tab-kind registry falls back to closing unknown tabs, which is acceptable for a hand-rollback scenario.

## Open Questions

- Should the activity-log `kind` for the three new commands be prefixed (`dynamo_scan_table` etc.) to avoid the Postgres `query_table` collision? Current decision: no. Revisit if filtering by kind causes ambiguity in #13 or in a future log-analysis tool.
- Should the JSON mode allow text search inside loaded items? Pragmatic for large pages, but out of scope here. If it lands later, it goes alongside the inspector path-jump affordance.
- Should `count_items` accept an upper bound (e.g., `max_scanned: 100000`) to cap surprise capacity consumption on huge tables? Not in this change; the current safety net is "Count is a button, never automatic". Reopen if a user reports surprise.
