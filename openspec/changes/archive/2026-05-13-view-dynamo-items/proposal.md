## Why

After change #10 (`browse-dynamo-tables`), clicking a table opens an explicit placeholder tab that only shows metadata. Argus still can't actually look at the items inside a DynamoDB table — the central reason a user opens the app. Item #11 of the V2.1 roadmap turns that placeholder into a real data view: Scan/Query against the table (and its indexes) with paginated, virtualized rendering in either a Tabla mode (column-inferred grid) or a JSON mode (one block per item), plus a side inspector and a simple, DSL-less query builder. This is the change that makes the Dynamo module useful day-to-day before edit (#12) and PartiQL (#13) land on top.

## What Changes

- Add backend Tauri commands in the Dynamo module: `dynamo.scan`, `dynamo.query`, and `dynamo.countItems`, all paginated via `LastEvaluatedKey` and routed through the existing `DynamoClientRegistry`. All three are read-only — they do not call `require_writable`. Each emits exactly one `argus:activity-log` event with the existing Dynamo activity-log conventions (`kind`, `connection_id`, `origin`, `sql: null`, `metric: { kind: "items", value: <count> }`, etc.).
- Add a new tab kind `dynamo-data-view` that replaces the role of the `dynamo-table-placeholder` tab introduced by #10. The placeholder semantics become a `Metadata` sub-tab inside the new data view; activating a table leaf from the sidebar now opens this real view instead of the placeholder.
- Tab body layout: top toolbar (mode toggle Tabla/JSON, Run/Reset, Consistent read, Reverse order, "Load more"), query-builder panel (Scan vs Query, index dropdown, partition/sort key pickers for Query, structured filter rows for Scan and Query), results panel (Tabla via TanStack Table + virtualizer with inferred columns including a final "More…" column, or JSON via a virtualized list of CodeMirror read-only blocks), and a side inspector showing the selected item with per-attribute DynamoDB type badges.
- Query builder is structured and DSL-less: filter rows compile to `FilterExpression` + `ExpressionAttributeNames` / `ExpressionAttributeValues`; Query key pickers compile to `KeyConditionExpression`. Operators surfaced: `=`, `<`, `<=`, `>`, `>=`, `between`, `begins_with`, plus filter-only `<>`, `contains`, `attribute_exists`, `attribute_not_exists`, `attribute_type`. Values are typed (`S` / `N` / `BOOL` / `NULL`); typing follows the index's `AttributeDefinitions` for keys.
- Pagination: scroll-to-load using `LastEvaluatedKey` with a "Load more" button fallback; barra inferior shows `X items loaded`. Default page size 100, persisted per table under setting key `dynamoLimit:<connectionId>:<tableName>`. The mode toggle (Tabla/JSON) is persisted per table under setting key `dynamoView:<connectionId>:<tableName>` (as already defined transversally in the roadmap).
- Tabla column inference: PK first, SK second (if present), then top-N atributos (default 10) ordered by frequency of appearance across the currently loaded sample, then a fixed "More…" column. Tipos complejos (`L`, `M`, `B`, `SS`, `NS`, `BS`) render como un resumen tipo `[3 items]` / `{ 4 keys }` / `<binary 128B>` y abren el inspector. Selección de fila enfoca el inspector.
- Count: an explicit "Count" affordance in the toolbar that calls `dynamo.countItems` with the current filter/index/consistency, paginates internally with `Select=COUNT`, and reports the total + scanned count. Never auto-fired.
- Keyboard: `⌘R` runs the current query, `⌘⇧R` resets the builder to defaults, `Esc` clears row selection in the inspector.
- Read-only handling for this change is trivial — Scan/Query/Count are non-mutating. The `RO` badge from `dynamo-connection` continues to show on the connection row; no UI gating is added by this change.
- Activity-log: every Scan/Query/Count call emits an event with `origin: "user"` for direct user actions (Run, Load more, Count, Reset) and `origin: "auto"` only for the initial sample fetched on first open of the data view tab.

## Capabilities

### New Capabilities

- `dynamo-data-view`: covers the Scan/Query/Count backend contract, the new `dynamo-data-view` tab kind, the Tabla/JSON modes, the structured query builder, pagination via `LastEvaluatedKey`, the inspector panel, the per-table view/limit settings, palette commands for the data view, and the shared data-grid extraction needed to render Tabla mode without duplicating Postgres's grid.

### Modified Capabilities

- `dynamo-table-browser`: activating a table leaf now opens a `dynamo-data-view` tab (id `dynamotbl:<connectionId>:<tableName>`) instead of the `dynamo-table-placeholder` tab introduced by #10. The placeholder kind is retired in this change; the metadata view it offered becomes a `Metadata` sub-tab inside the data view. Palette commands registered per cached table (`argus.dynamo.openTable:<connectionId>:<tableName>`) keep the same id and behavior — they now open the data view.

(`app-shell` is intentionally not modified: its center tab system is already designed for module-specific tab kinds registered via the kind registry; adding `dynamo-data-view` and removing the internal `dynamo-table-placeholder` kind happens entirely within the Dynamo module without changing any app-shell requirement.)

## Impact

- Code:
  - Frontend new: `src/modules/dynamo/data-view/` containing the tab component, toolbar, query-builder panel, Tabla/JSON renderers, inspector, item-cache hook, and tests.
  - Frontend new shared primitive: `src/components/data-grid/` extracted from `src/modules/postgres/grid/` with a source-agnostic API (rows, columns, virtualizer, selection). This extraction is a prerequisite of Tabla mode and is part of this change. Postgres call sites switch to the shared primitive in the same change.
  - Frontend modified: `src/modules/dynamo/tables/` (activation now opens the data view), palette command wiring for table opens, tab kind registry in `src/app-shell/`.
  - Backend new: `src-tauri/src/modules/dynamo/items.rs` (commands `scan`, `query`, `count_items`) wired into `commands.rs` and `mod.rs`.
  - Backend modified: `src-tauri/src/modules/dynamo/commands.rs` to register the new commands.
- APIs: three new Tauri commands; no changes to existing Dynamo commands. The `dynamo-table-placeholder` tab kind is removed (internal API; no external consumers).
- Dependencies: no new crates (the data plane uses the already-pinned `aws-sdk-dynamodb`). No new npm dependencies — TanStack Table, virtualizer, and CodeMirror are already used by the Postgres module.
- Postgres module: **does not change behavior**. The grid extraction moves code from `src/modules/postgres/grid/` into `src/components/data-grid/`; the Postgres data view continues to render through the same component, just imported from the new location.
- Settings: two new setting keys (`dynamoView:<connectionId>:<table>`, `dynamoLimit:<connectionId>:<table>`).
- Activity log: three new `kind` values used by Dynamo (`scan_table`, `query_table`, `count_table`) — the `activity-log` capability accepts free-form `kind` strings already, so no spec change is needed there.
