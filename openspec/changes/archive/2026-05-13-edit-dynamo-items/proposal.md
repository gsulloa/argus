## Why

After change #11 (`view-dynamo-items`), the Dynamo data view can Scan/Query items but is read-only — the user still has to drop into NoSQL Workbench or the AWS console to fix a value, kill a stuck record, or insert a seed item. Item #12 of the V2.1 roadmap closes that loop with atomic `PutItem` / `UpdateItem` / `DeleteItem` so Argus stops being "look only" for the second source it supports. Per the V2 roadmap, each op commits independently (no diff-preview batch, no `TransactWriteItems`), which keeps the change small, matches Dynamo's actual API surface, and avoids importing Postgres's batch buffer model where it doesn't fit.

## What Changes

- Add three backend Tauri commands in the Dynamo module — `dynamo.put_item`, `dynamo.update_item`, `dynamo.delete_item` — each commits a single atomic op against AWS. All three call the `require_writable` helper from `dynamo-connection` before any AWS call, so read-only connections are rejected uniformly with `AppError::Validation { message: "connection is read-only" }`. Each emits exactly one `argus:activity-log` event (`kind: "put_item" | "update_item" | "delete_item"`, `metric: { kind: "items", value: 1 }` on success).
- `update_item` accepts a structured payload `{ set?: AttributeMap, remove?: string[] }` that the backend compiles into a canonical `UpdateExpression` (`SET #n0 = :v0, #n1 = :v1 REMOVE #n2, #n3`) with `ExpressionAttributeNames` / `ExpressionAttributeValues`. The user-facing edit flow never types DynamoDB DSL — values and removals are typed and routed through placeholders.
- All three commands accept an optional `condition_expression` + `expression_attribute_values` / `expression_attribute_names` pair, forwarded verbatim, so the frontend can opt into optimistic locking. A `ConditionalCheckFailedException` from AWS is surfaced as a distinct `AppError::Aws` variant the frontend can recognize and explain inline ("Item changed since you loaded it").
- Add a new capability `dynamo-data-edit` covering: edit-in-place in Tabla mode, full-item JSON edit in the inspector dock, an Insert modal, multi-row delete with confirmation, an optimistic-locking toggle persisted per table, the read-only frontend gating, and the "unsaved changes" guard when navigating away from a draft.
- Modify `dynamo-data-view`: the Tabla cell renderer gains edit-on-double-click for primitive types (`S` / `N` / `BOOL` / `NULL`) on non-key columns; complex-type cells (`L` / `M` / `B` / sets) route to a JSON editor inside the inspector dock instead. The inspector dock gains an "Edit item (JSON)" affordance that swaps the read-only tree for a CodeMirror JSON editor with type-tag preservation. The data view registers `⌘N` (new item) and `⌫` (delete selected) keyboard handlers. All edit affordances are hidden when the connection's `params.read_only` is `true`; the Tabla toolbar shows a "Read-only" badge in that mode.
- Modify `dynamo-connection`: extend the `read_only` enforcement contract so that the three new commands are explicitly named callers of `require_writable`. No behavioral change — the helper already exists; this is a spec-level statement that the new commands obey it. The Tabla view's "Read-only connection — edits disabled" banner mirrors the Postgres pattern.
- Add a per-table setting `dynamoVersionAttr:<connectionId>:<tableName>` storing the user-chosen attribute name used for optimistic-locking `ConditionExpression`s (e.g., `version`, `updated_at`). The setting is empty by default; when empty, optimistic locking is disabled even if the toggle is on.

## Capabilities

### New Capabilities

- `dynamo-data-edit`: the put/update/delete backend contract, the JSON Tabla edit-in-place affordance and complex-cell routing, the inspector JSON editor, the Insert modal, the multi-row Delete confirmation, optimistic locking via `ConditionExpression`, the unsaved-draft guard, and the per-table version-attribute setting.

### Modified Capabilities

- `dynamo-data-view`: Tabla cells in non-PK / non-SK columns become editable on double-click for primitive types; complex-type cells route to the inspector's JSON editor; the inspector dock acquires an "Edit item" affordance; the toolbar acquires a "+" (Insert) button and a Read-only badge; `⌘N` and `⌫` keyboard handlers register on the data view tab. Existing scan/query/count behavior is unchanged.
- `dynamo-connection`: the existing `require_writable` requirement gains an explicit clause that `dynamo.put_item`, `dynamo.update_item`, and `dynamo.delete_item` are obligated callers. The helper itself is unchanged.

## Impact

- Code:
  - Backend new: `src-tauri/src/modules/dynamo/edit.rs` (commands `put_item`, `update_item`, `delete_item`, plus the `compile_update_expression` builder), wired into `commands.rs` and `mod.rs`.
  - Backend modified: `src-tauri/src/modules/dynamo/errors.rs` to map `ConditionalCheckFailedException` to a distinct error variant.
  - Frontend new: `src/modules/dynamo/data-view/edit/` containing the Tabla cell editor, the inspector JSON editor, the Insert modal, the Delete confirmation, the unsaved-draft guard hook, the version-attribute settings dialog, and tests.
  - Frontend modified: `src/modules/dynamo/data-view/TabView.tsx` (registers `⌘N`/`⌫`, toolbar "+" button, Read-only badge), `src/modules/dynamo/data-view/Tabla.tsx` (cell rendering branches into edit affordance), `src/modules/dynamo/data-view/Inspector.tsx` (gains "Edit item" affordance).
- APIs: three new Tauri commands. No changes to existing Dynamo commands. The `AppError::Aws` variant gains a `code: "ConditionalCheckFailedException"` consumer at the frontend layer (the variant itself already supports arbitrary codes).
- Dependencies: no new crates and no new npm packages. CodeMirror, TanStack Table, and the virtualizer are already used by `view-dynamo-items`.
- Postgres module: **does not change behavior**. No file under `src/modules/postgres/` or `src-tauri/src/modules/postgres/` is touched.
- Settings: one new setting key (`dynamoVersionAttr:<connectionId>:<tableName>`). Existing `dynamoView:` and `dynamoLimit:` keys are unchanged.
- Activity log: three new `kind` values (`put_item`, `update_item`, `delete_item`). The `activity-log` capability already accepts arbitrary `kind` strings — no spec change there.
