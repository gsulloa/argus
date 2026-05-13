## 1. Backend: edit commands skeleton

- [x] 1.1 Create `src-tauri/src/modules/dynamo/edit.rs` with module skeleton and shared `ReturnValues` enum (NONE / ALL_OLD / ALL_NEW / UPDATED_NEW / UPDATED_OLD)
- [x] 1.2 Wire `edit` into `src-tauri/src/modules/dynamo/mod.rs` and register the three new commands in `src-tauri/src/modules/dynamo/commands.rs`
- [x] 1.3 Add helper `cached_key_schema(connection_id, table_name)` that reads the cached describe and, on cache miss, issues a one-off `DescribeTable` and caches it

## 2. Backend: put_item

- [x] 2.1 Define `PutItemRequest` / `PutItemResponse` with serde tagged AttributeValue (re-use the type from view-dynamo-items)
- [x] 2.2 Implement `dynamo.put_item` calling `require_writable` first
- [x] 2.3 Validate `item` contains every KeySchema attribute; reject with `AppError::Validation` naming missing keys
- [x] 2.4 Forward `condition_expression` / names / values verbatim; map `return_values` to AWS SDK enum
- [x] 2.5 Funnel AWS errors through `dynamo::errors::translate_aws_error` so credential-expiration still fires
- [x] 2.6 Emit the `put_item` activity-log event with `params: { table_name, has_condition, num_attributes }`
- [x] 2.7 Unit tests: success, missing-key validation, read-only rejection, `ConditionalCheckFailedException` mapping, ExpiredToken funnel

## 3. Backend: update_item and UpdateExpression compiler

- [x] 3.1 Define `UpdateItemRequest` / `UpdateItemResponse` and `UpdateOps { set?: Map, remove?: Vec<String> }`
- [x] 3.2 Implement pure `compile_update_expression(updates, caller_names, caller_values)` returning `(expression, merged_names, merged_values)` with collision-avoiding `#n<i>` / `:v<i>` allocation
- [x] 3.3 Implement `dynamo.update_item` calling `require_writable` first
- [x] 3.4 Validate key (non-empty, equals KeySchema), updates (non-empty, no set/remove overlap, no KeySchema attribute mutated)
- [x] 3.5 Call the compiler, dispatch AWS UpdateItem with `return_values: ALL_NEW` default
- [x] 3.6 Funnel AWS errors through `translate_aws_error`
- [x] 3.7 Emit the `update_item` activity-log event with `params: { table_name, has_condition, num_set, num_remove }`
- [x] 3.8 Unit tests for compiler: SET-only, REMOVE-only, both, caller-collision avoidance
- [x] 3.9 Unit tests for command: success, each validation rejection, ConditionalCheckFailed, read-only

## 4. Backend: delete_item

- [x] 4.1 Define `DeleteItemRequest` / `DeleteItemResponse`
- [x] 4.2 Implement `dynamo.delete_item` calling `require_writable` first, validating key against KeySchema
- [x] 4.3 Forward condition/names/values verbatim; map `return_values: ALL_OLD` for the returned `attributes`
- [x] 4.4 Funnel AWS errors through `translate_aws_error`
- [x] 4.5 Emit the `delete_item` activity-log event with `params: { table_name, has_condition }`
- [x] 4.6 Unit tests: success, missing-key validation, read-only rejection, ALL_OLD returns prior item

## 5. Frontend: typed AttributeValue helpers

- [x] 5.1 Add `attrValueEquals(a, b)` tag-aware deep equality in `src/modules/dynamo/data-view/edit/attr-equality.ts` (set equality order-insensitive)
- [x] 5.2 Add `diffAttributeMaps(original, edited) -> { set, remove }` returning the inputs for `update_item.updates`
- [x] 5.3 Add `validateTaggedItem(parsed)` that asserts every leaf is a single-tag object with a recognized tag, returning the first offending path or `null`
- [x] 5.4 Unit tests for equality, diff, validation

## 6. Frontend: Tabla cell edit-in-place

- [x] 6.1 In `src/modules/dynamo/data-view/Tabla.tsx`, branch cell rendering: primitives (`S`/`N`/`BOOL`/`NULL`) on non-key columns of writable connections accept double-click; complex tags and key columns refuse
- [x] 6.2 Implement tag-aware `InlineCellEditor` (text / numeric / boolean toggle / NULL switch) with Tab / Enter / blur commit and Escape abort
- [x] 6.3 Wire commit to `dynamo.update_item` with the row's key, `updates.set: { col: new value }`, and the optimistic-locking condition (if enabled)
- [x] 6.4 Spinner + disabled state during in-flight; success updates the cell from response `ALL_NEW`; failure reverts and toasts the AWS error
- [x] 6.5 Component tests: each tag's editor, key-column refusal, complex-cell routing to inspector, read-only refusal, commit success, commit failure revert

## 7. Frontend: Inspector "Edit item" JSON editor

- [x] 7.1 In `src/modules/dynamo/data-view/Inspector.tsx`, add the "Edit item" button (hidden on read-only) that swaps the read-only tree for an `InspectorJsonEditor`
- [x] 7.2 Build `InspectorJsonEditor` with CodeMirror `language-json`, the "Replace entire item" toggle (default off), Save/Cancel buttons, and `⌘S` keybinding
- [x] 7.3 Save flow: parse → tag validation → key-attribute equality check → diff or replace → dispatch `dynamo.update_item` or `dynamo.put_item`
- [x] 7.4 ConditionalCheckFailed inline UI with "Reload row" button that re-fetches the row (via `dynamo.query` on the row's key) and updates the "original" side of the diff while preserving the draft
- [x] 7.5 No-change Save shows toast "No changes" and closes the editor without an AWS call
- [x] 7.6 Component tests: parse failure, untagged value rejection, key-change rejection, diff path, replace path, ConditionalCheckFailed reload, no-change toast

## 8. Frontend: Insert modal

- [x] 8.1 Build `src/modules/dynamo/data-view/edit/InsertModal.tsx` with Form / Paste JSON tabs sharing a canonical draft state
- [x] 8.2 Form view: typed inputs for every KeySchema attribute (per AttributeDefinitions), plus `name / type / value` add-attribute rows for `S | N | BOOL | NULL`
- [x] 8.3 Paste JSON view: CodeMirror editor with tag validation and key-presence check on every keystroke (for live preview validity)
- [x] 8.4 Live JSON preview pane that always reflects the canonical draft
- [x] 8.5 "Allow overwrite" footer checkbox (default OFF); Confirm dispatches `dynamo.put_item` with `condition_expression: "attribute_not_exists(#pk)"` (off) or no condition (on)
- [x] 8.6 On success: close, toast, re-fire the data view's most recent Scan/Query with `origin: "user"`
- [x] 8.7 On `ConditionalCheckFailedException`: stay open with inline conflict message highlighting the "Allow overwrite" toggle
- [x] 8.8 Wire toolbar `+` button and `⌘N` keyboard handler in `src/modules/dynamo/data-view/DataViewTab.tsx` (both hidden / no-op on read-only)
- [x] 8.9 Component tests: form validation, paste-json validation, default condition, allow-overwrite, success refresh, conflict UI

## 9. Frontend: multi-row delete

- [x] 9.1 Extend Tabla row selection to multi-row via shift-click and `⌘click`
- [x] 9.2 Wire `⌫` keyboard handler in `TabView.tsx`: no-op on read-only, no-op while an inline editor is active, otherwise open `DeleteConfirmationModal`
- [x] 9.3 Build `DeleteConfirmationModal` listing every selected row's keys, dispatching `dynamo.delete_item` sequentially with a per-row progress indicator
- [x] 9.4 Remove successful rows from the local item list immediately; keep failed rows with their AWS code+message; render `"X of Y deleted"` summary
- [x] 9.5 Disable Escape during the sequential dispatch
- [x] 9.6 Component tests: confirmation list, sequential dispatch order, partial failure summary, read-only no-op, editor-active no-op

## 10. Frontend: optimistic locking

- [x] 10.1 Add `dynamoVersionAttr:<connectionId>:<tableName>` setting accessor with getter / setter helpers
- [x] 10.2 Build the "Optimistic locking" config dialog reachable from a toolbar settings menu (single input + hint text)
- [x] 10.3 Add the "Use ConditionExpression on update" toolbar toggle (component state, not persisted)
- [x] 10.4 Implement `buildLockingCondition(versionAttr, prevValue, pkAttr)` that composes `attribute_exists(#pk) AND #v = :prev` with merged names/values
- [x] 10.5 Wire the helper into both the Tabla inline commit path and the inspector JSON-editor diff path so dispatched `dynamo.update_item` carries the augmented condition when both setting and toggle are active
- [x] 10.6 Component tests: toggle off → no condition; toggle on + empty setting → no condition; toggle on + setting + edit → condition present with correct `:prev`; ConditionalCheckFailed routes to the editor's reload affordance

## 11. Frontend: unsaved-draft guard

- [x] 11.1 Add a `useUnsavedDraft(tabId)` hook that aggregates Tabla cell editor state, inspector editor state, and Insert modal state into a single boolean
- [x] 11.2 Hook into tab close, center-tab switch, and row selection change; surface "Discard changes?" dialog on Cancel / Confirm
- [x] 11.3 Bypass the guard on `dynamo:credentials-refreshed` and on `needs_credentials` entering — drafts persist silently and in-flight saves retry automatically
- [x] 11.4 Component tests: tab close prompt, tab switch prompt, row switch prompt with inspector open, credential refresh silent path

## 12. Frontend: Read-only badge and visibility wiring

- [x] 12.1 Render the "Read-only" badge in the toolbar of `TabView.tsx` only when the connection's `params.read_only` is `true`
- [x] 12.2 Hide the toolbar `+` Insert button and the inspector "Edit item" button on read-only connections
- [x] 12.3 Make `⌘N`, `⌫`, and Tabla cell double-click no-ops on read-only connections (defense-in-depth alongside the backend `require_writable`)
- [x] 12.4 Component tests: badge visibility, affordance hiding, keyboard no-ops

## 13. Integration and end-to-end verification

- [x] 13.1 Manual: run a put / update / delete against DynamoDB Local (`endpoint_url: http://localhost:8000`) covering every Tabla inline tag editor
- [x] 13.2 Manual: run the inspector JSON editor through diff path, replace path, parse-failure, untagged-value, key-change, ConditionalCheckFailed reload
- [x] 13.3 Manual: run the Insert modal through Form + Paste JSON, default condition rejecting existing key, "Allow overwrite" allowing it
- [x] 13.4 Manual: run multi-row delete with 3 rows, force one failure via a `ConditionExpression`, verify summary and remaining rows
- [x] 13.5 Manual: toggle the connection's `read_only` to true; confirm every edit affordance disappears and the backend rejects direct command invocations
- [x] 13.6 Verify `DESIGN.md` compliance for every new surface (badges, buttons, modal, inline errors) — flag and fix any drift
- [x] 13.7 Verify the activity-log event count: each successful edit emits exactly one event; multi-row delete emits one event per row
