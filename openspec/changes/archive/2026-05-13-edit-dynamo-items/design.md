## Context

After #11 (`view-dynamo-items`) the data view tab renders Scan/Query results, paginates with `LastEvaluatedKey`, and routes complex-type cells to a read-only inspector. The path to edit is now obvious to the user: double-click a value, change it, hit save — but nothing wires that up. This change builds the first write plane for DynamoDB.

Existing pieces this change builds on:

- `DynamoClientRegistry` (backend, `src-tauri/src/modules/dynamo/client.rs`): already holds the SDK client + a `read_only` snapshot envelope per connection. The new edit commands look up the client here.
- `dynamo-connection`'s `require_writable(connection_id)` helper: the contract is already specified ("every mutating Dynamo command MUST call `require_writable` before dispatching"). This change is the first concrete set of mutating commands — we just plug into the existing contract.
- The `dynamo-data-view` tab kind, its toolbar layout, inspector dock, Tabla/JSON modes, structured query builder, and `LastEvaluatedKey` pagination: all already shipped. We add new affordances inside the same tab without changing those flows.
- The credential-expiration / re-prompt contract: every existing Dynamo backend command funnels AWS errors through `dynamo::errors::translate_aws_error`. The new edit commands obey the same funnel so an `ExpiredToken` during a save flips `needs_credentials = true` and triggers the re-prompt dialog, with the data view tab surviving the refresh and the optimistic-locking state intact.

Constraints from the V2 roadmap that shape this change:

- Each `put` / `update` / `delete` is atomic and commits on its own. No batch buffer like Postgres's edit grid; no `TransactWriteItems`. Errors are per-op and inline.
- The user never types DynamoDB DSL. `UpdateExpression`, `ConditionExpression`, attribute-name / value placeholders are all built by Argus.
- Changing a PK or SK on an existing item is a `delete + put`, not an `update`. We reject in-place edits that would mutate key attributes.
- Sets (`SS`, `NS`, `BS`) and nested complex types render but were already declared "not editable in this change" by the roadmap. The JSON inspector editor can mutate them via free-form JSON, but the inline Tabla cell editor refuses.

## Goals / Non-Goals

**Goals:**

- Implement atomic `put_item`, `update_item`, `delete_item` commands with the same activity-log envelope, credential-expiration funnel, and read-only enforcement that the rest of the Dynamo module already follows.
- Make the Tabla view directly editable on primitive cells (double-click, type, Enter to commit). Each edit fires one `update_item` immediately — no save-all step.
- Provide an "Edit item (JSON)" affordance inside the inspector dock that swaps the read-only tree for a CodeMirror JSON editor. On commit it diffs against the original to produce `set` / `remove` for `update_item`, or routes to `put_item` if the user toggled "replace entire item".
- Provide an Insert modal that requires the key attributes (typed per `KeySchema` + `AttributeDefinitions`), allows arbitrary extra attributes via `name / type / value` rows, and supports a "Paste JSON" alternate input. Dispatches `put_item`.
- Provide multi-row delete via row selection + `⌫`, with one confirmation modal listing every key being removed and a per-row progress bar.
- Provide optional optimistic locking via `ConditionExpression`. The user picks a version attribute per table (persisted setting) and enables a toolbar toggle; subsequent updates carry `attribute_exists(<pk>) AND #version = :prev`. A `ConditionalCheckFailedException` surfaces as an inline error explaining the stale read with a "Reload row" button.
- Gate every edit affordance on `params.read_only` at the frontend, while the backend defends in depth via `require_writable` (defense in depth is non-negotiable; the contract is explicit in `dynamo-connection`).
- Guard against accidental data loss: if a user has unsaved typing in a Tabla cell editor or the inspector JSON editor and tries to switch tab / close the tab, prompt "Discard changes?".

**Non-Goals:**

- A diff-preview-and-commit batch flow like Postgres. Dynamo edits commit per op; the per-op confirmation lives in the existing buttons (Tab/Enter commits inline edits without modal; Insert/Delete each have their own confirmation surface).
- `TransactWriteItems` (multi-item transactional commit). The roadmap defers this until a real use case appears.
- A rich visual editor for `L` / `M` / sets (tree-drag-drop). We mutate them only through JSON in the inspector. This is documented as a Non-Goal in the roadmap.
- Bulk import or export. Crossroads.
- Mutating key attributes in place. Rejected client-side; the user has to delete + insert explicitly.
- Detecting and resolving conflicts beyond the `ConditionalCheckFailedException` surfaced from AWS. We do not poll, snapshot, or auto-merge.

## Decisions

### 1. Backend command shape

Three commands in `src-tauri/src/modules/dynamo/edit.rs`, registered via `commands.rs` and `mod.rs`. All three call `require_writable(connection_id)` as the first action after argument validation; all three funnel AWS errors through `dynamo::errors::translate_aws_error`; all three emit exactly one `argus:activity-log` event before returning.

```rust
// dynamo.put_item
pub struct PutItemRequest {
  connection_id: Uuid,
  table_name: String,
  item: HashMap<String, AttrValue>,           // full item, including key attrs
  condition_expression: Option<String>,
  expression_attribute_names: Option<HashMap<String, String>>,
  expression_attribute_values: Option<HashMap<String, AttrValue>>,
  return_values: Option<ReturnValues>,        // NONE (default) | ALL_OLD
  origin: Option<Origin>,                     // "user" | "auto", default "user"
}
pub struct PutItemResponse {
  attributes: Option<HashMap<String, AttrValue>>,   // populated if return_values=ALL_OLD
  consumed_capacity: Option<ConsumedCapacity>,
}

// dynamo.update_item
pub struct UpdateItemRequest {
  connection_id: Uuid,
  table_name: String,
  key: HashMap<String, AttrValue>,             // must contain all KeySchema attrs, no more
  updates: UpdateOps,                          // { set?: {name: AttrValue}, remove?: [name] }
  condition_expression: Option<String>,
  expression_attribute_names: Option<HashMap<String, String>>,
  expression_attribute_values: Option<HashMap<String, AttrValue>>,
  return_values: Option<ReturnValues>,        // NONE | ALL_NEW (default) | UPDATED_NEW | ALL_OLD | UPDATED_OLD
  origin: Option<Origin>,
}
pub struct UpdateItemResponse {
  attributes: Option<HashMap<String, AttrValue>>,   // refreshed item per return_values
  consumed_capacity: Option<ConsumedCapacity>,
}

// dynamo.delete_item
pub struct DeleteItemRequest {
  connection_id: Uuid,
  table_name: String,
  key: HashMap<String, AttrValue>,
  condition_expression: Option<String>,
  expression_attribute_names: Option<HashMap<String, String>>,
  expression_attribute_values: Option<HashMap<String, AttrValue>>,
  origin: Option<Origin>,
}
pub struct DeleteItemResponse {
  attributes: Option<HashMap<String, AttrValue>>,   // ALL_OLD when supplied
  consumed_capacity: Option<ConsumedCapacity>,
}
```

Validation, all before any AWS call (`AppError::Validation`):

- `update_item.key` and `delete_item.key` MUST be non-empty.
- `update_item.updates`: at least one of `set` or `remove` MUST be non-empty.
- `update_item.updates.set` keys MUST NOT overlap with `updates.remove` (the user cannot SET and REMOVE the same attribute in the same call).
- `update_item.updates.set` keys MUST NOT include any attribute named in the table's `KeySchema`. Same for `remove`. (Changing a key is delete + put, not update.)
- `put_item.item` MUST contain every attribute named in the table's `KeySchema`. (Without the key, AWS would error anyway; we surface it earlier with a clearer message.)
- For all three: user-supplied `condition_expression` is forwarded verbatim; `expression_attribute_names` / `expression_attribute_values` are forwarded verbatim. The backend does NOT parse or rewrite them.

The new commands defer the `KeySchema` lookup needed for validation to a single `dynamo.describeTable` cached result: the active connection already caches table describes per #10, and the validation path reads the cached `KeySchema` from the registry rather than re-calling AWS. If no describe is cached (cold path), the backend issues a one-off `DescribeTable` before validation — slow but correct on the first edit per session.

### 2. `UpdateExpression` compilation

The `update_item` request takes `{ set?: {name: AttrValue}, remove?: [name] }` and the backend compiles it to:

```
SET #n0 = :v0, #n1 = :v1, ... REMOVE #n2, #n3, ...
```

with auto-generated placeholders (`#n<i>` for names, `:v<i>` for values). Placeholders are merged into the caller-supplied `expression_attribute_names` / `expression_attribute_values` maps; if a placeholder name collides with a caller-supplied one (e.g., the caller already used `#n0` in a `ConditionExpression`), the compiler shifts the auto-generated indices upward to avoid collision. The compiled `UpdateExpression`, names, and values are passed to the AWS SDK as one string and two maps.

Why this shape rather than letting the caller send a raw `UpdateExpression`? Three reasons:

- The user never writes DDB DSL in this UI. The frontend computes a diff (`{ set, remove }`) from the JSON editor or sends a single-attribute `{ set: { col: v } }` from a Tabla cell edit. Surfacing a raw string would force the frontend to build the same compiler.
- Type-safe placeholders are easier to test than string concatenation. The compiler is a pure function returning `(expression, names_to_merge, values_to_merge, AppResult<()>)`.
- The `ConditionExpression` path stays caller-supplied because optimistic locking conditions are short, hand-written ("attribute_exists(pk) AND #version = :prev"), and the frontend's locking toggle owns that string.

### 3. Tabla cell edit-in-place

Double-clicking a Tabla cell whose AttributeValue tag is one of `S` / `N` / `BOOL` / `NULL` AND whose column is NOT a `KeySchema` attribute opens an inline editor. The editor is tag-aware:

- `S` → single-line `<input>` typed as text.
- `N` → single-line `<input>` with `inputmode="decimal"`, validated as a numeric string (AWS requires `N` to serialize as string).
- `BOOL` → a tiny toggle (Switch) that commits on toggle.
- `NULL` → a "Set to NULL" / "Set to value" segmented switch; flipping back to "value" exits the inline editor and waits for the user to pick a new type via the inspector. (Changing type inline is explicit, never inferred.)

Commit (Tab / Enter / blur) fires `dynamo.update_item({ key: <row PK/SK>, updates: { set: { <col>: <new value> } } })` immediately. The cell shows a brief spinner; on success the value updates to the value returned from `return_values: ALL_NEW`; on failure the cell reverts to the original and a toast surfaces the AWS error message. There is no "save all" affordance — each cell commits on its own.

Pressing `Escape` aborts the in-flight typing (no commit). Clicking another cell commits the current one before opening the next editor.

Cells with complex tags (`L` / `M` / `B` / `SS` / `NS` / `BS`) reject double-click and instead select the row and focus the inspector with an "Edit item (JSON)" hint visible — the user has to mutate complex values via the JSON path.

### 4. Inspector JSON editor

The inspector dock already shows the selected item as a read-only tree (per `dynamo-data-view`). This change adds an "Edit item" button at the top of the inspector. Activating it swaps the tree for a CodeMirror editor (`language-json`) preloaded with the item serialized in the same `{ "S": ... } / { "N": ... } / ...` tag form the rest of the module uses. The user types JSON. On commit (the "Save" button next to the editor, or `⌘S` while the editor has focus):

1. Strict `JSON.parse` of the textarea contents. On failure, the editor stays open with a danger border and inline error, identical to the Postgres pattern.
2. Schema check: every top-level key whose value is an object MUST have a single key from the AttributeValue tag set (`S`/`N`/`B`/`BOOL`/`NULL`/`L`/`M`/`SS`/`NS`/`BS`); otherwise reject with an inline message naming the offending path. (We do NOT auto-promote raw scalars into `{ "S": ... }` — explicit tags only, matching what the rest of the module emits.)
3. Key attributes (`KeySchema`) MUST match the originally-loaded item. If the user changed the PK or SK, surface "Changing the primary key is a delete + insert, not an edit" and reject. The user has to delete the row and insert a new one.
4. Compute the diff between the parsed item and the original:
   - Attributes present in both with different tagged values → `set`.
   - Attributes present in original but absent in edited → `remove`.
   - Attributes present in edited but absent in original → `set` (with the new value).
   - Attributes equal → skip.
5. If the diff has at least one entry, dispatch `dynamo.update_item({ key, updates: { set, remove }, condition_expression?, ... })`. If the diff is empty (the user opened, didn't change anything, hit Save), the editor closes without a network call and a "No changes" toast surfaces.

A "Replace entire item" mode is exposed as a less-prominent toggle inside the inspector editor footer. When enabled, the editor's commit fires `dynamo.put_item({ item: <parsed>, condition_expression?, ... })` instead of computing a diff. This is the only path that can change the tagged type of an existing attribute (`update_item` cannot SET an attribute to NULL via a different tag and then back; replace gives the user a clean slate). It is also the only path that can re-create an entire complex value (`L` / `M`) without an unmanageable number of nested `SET` paths.

### 5. Insert modal

The toolbar gains a `+` button. Activating it opens a modal with two views:

- **Form**: required inputs for every attribute in the table's `KeySchema`, typed per the index's `AttributeDefinitions`. Below the keys, a row builder lets the user add arbitrary attributes via `name / type / value` (type dropdown: `S` / `N` / `BOOL` / `NULL` for inline editing — complex types are added via the Paste JSON path). A live preview pane on the right shows the JSON that will be sent.
- **Paste JSON**: a CodeMirror editor accepting the full tagged item. Validated identically to the inspector JSON path (strict parse, tag check, key check).

The user can toggle between Form and Paste JSON; switching synchronizes the two views from the canonical state (the JSON view always reflects the form's current draft and vice versa where round-trippable).

On commit, the modal dispatches `dynamo.put_item({ item, condition_expression: "attribute_not_exists(#pk)", ... })` by default — this prevents accidentally overwriting an existing item with the same key. The user can opt out via an "Allow overwrite" checkbox in the modal footer; when checked, `condition_expression` is omitted and existing items at the same key are clobbered. On success the modal closes, a toast confirms, and the data view re-fires the most recent Scan/Query so the new row appears.

### 6. Multi-row delete

Row selection in Tabla mode (introduced by `dynamo-data-view` for the inspector) is extended to multi-row with shift-click and `⌘click`. Pressing `⌫` while one or more rows are selected AND no inline editor is active opens a confirmation modal listing every key being removed: `Delete 3 items? [pk=user-1, sk=a], [pk=user-1, sk=b], [pk=user-2, sk=a]`. The user confirms once for all of them; the backend then dispatches `dynamo.delete_item` per row, sequentially, with a progress bar in the modal. Failures are listed at the end with their AWS error messages; successful deletes are removed from the local item list immediately.

Why sequential rather than parallel? Two reasons:

- We never exceed the per-region per-account write throughput silently. Sequential calls keep the user's burn-rate predictable; for huge deletes the crossroad `dynamo-batch-operations` (`BatchWriteItem`) is the right fix and is explicitly future-scope.
- Error reporting is simpler. The modal can show "3 of 5 deleted, 2 failed" with per-row messages instead of trying to disentangle parallel failures.

### 7. Optimistic locking

Three pieces:

1. A per-table setting `dynamoVersionAttr:<connectionId>:<tableName>` (string, default empty). Edited via a small "Optimistic locking" config dialog reachable from the data view toolbar's settings menu. The dialog has one input ("Version attribute name") and a hint explaining the contract ("Argus will add `attribute_exists(<pk>) AND #version = :prev` to every UPDATE when this is set and the toggle below is on").
2. A toolbar toggle "Use ConditionExpression on update" (off by default), persisted per session in component state rather than settings. Persisting per session keeps the cost-of-mistake low: opening a stale tab tomorrow does not silently break edits.
3. When both the setting is non-empty AND the toggle is on, every `update_item` dispatched by the data view automatically appends `attribute_exists(#pk) AND #<version> = :prev` to its `condition_expression`, with `:prev` bound to the value of the version attribute that was loaded into the local item state at the time the user started editing.

`put_item` and `delete_item` are NOT version-checked automatically; the contract only applies to `update_item`. Insertions are gated by `attribute_not_exists(#pk)` (the modal's default condition) which provides a different kind of safety; deletes are not gated because the user has explicitly selected the row and confirmed.

On `ConditionalCheckFailedException`, the inline cell editor (or the inspector editor) shows a red banner with "Item changed since you loaded it" and a "Reload row" button. Reload re-fetches just the affected key via a one-shot `GetItem` (a fourth read command? no — we reuse `dynamo.query` with `key_condition_expression: "#pk = :pk AND #sk = :sk"` against the primary key, which is one row and is already wired). The user's typed edit is preserved in the editor; they can re-apply it against the refreshed value or discard.

### 8. Read-only enforcement

Three layers:

- **Backend**: each new command calls `require_writable(connection_id)` immediately after deserialization. A read-only connection short-circuits to `AppError::Validation { message: "connection is read-only" }` with no AWS call.
- **Frontend**: the data view tab reads the connection's `params.read_only` snapshot via the existing connections store. When `true`: the toolbar shows a "Read-only" badge with the existing `RO` styling from `dynamo-connection`'s connection-row pattern; the `+` button is hidden; double-click on Tabla cells is a no-op; the inspector "Edit item" button is hidden; `⌘N` and `⌫` keyboard handlers are no-ops.
- **Spec-level**: `dynamo-connection`'s `require_writable` requirement is modified to explicitly name `put_item`, `update_item`, and `delete_item` as obligated callers. This is documentation/contract — the helper's behavior does not change.

### 9. Unsaved-draft guard

Three drafts exist concurrently:

- The current Tabla inline cell editor (only one at a time per data view).
- The inspector JSON editor (one at a time per data view).
- The Insert modal's Form / Paste JSON draft (modal is exclusive; closing dismisses).

The data view tracks "has unsaved draft" as a derived boolean across the three. When the user attempts to switch tabs, close the tab, or navigate away from the row (selecting a different row in Tabla mode while the inspector editor is open), the system prompts "Discard changes?" with the standard confirm dialog. The Insert modal handles its own dismissal confirmation since it is modal — pressing Escape with dirty content shows the same prompt.

The guard does NOT prompt on background events like credential expiration: when `dynamo:credentials-refreshed` fires, the in-flight save (if any) retries automatically; the editor's draft survives the refresh untouched.

### 10. Activity-log envelope

Three new `kind` values: `put_item`, `update_item`, `delete_item`. Each event carries:

- `kind`: one of the three.
- `connection_id`: the id.
- `origin`: from the request, defaulting to `"user"` since the only callers are user gestures (cell commit, modal confirm, key press).
- `sql`: `null`.
- `params`: a compact envelope with `{ table_name, has_condition: bool, has_version_check: bool, num_set?: u32, num_remove?: u32, multi_delete_size?: u32 }`. We do NOT log the user's actual attribute names or values (avoid leaking secrets / PII into the activity log; the user can replay via the inspector if they need it).
- `metric`: `{ kind: "items", value: 1 }` on success; `null` on failure. For multi-row delete, the activity-log emits one event per row (matching the per-row dispatch); the modal's progress bar is a UI affordance, not a backend batch.
- `duration_ms`: per-call wall-clock.
- `status`: `ok` / `err`.

### 11. AttributeValue equality for diff

The diff computation in the inspector editor needs to know when two AttributeValues are "equal". The implementation is straightforward tag-by-tag:

- `S`, `N`, `BOOL`, `NULL`: structural equality of the JSON.
- `B`: byte-string equality.
- `L`: element-wise equality (order matters — Dynamo lists are ordered).
- `M`: key-set equality + recursive AttributeValue equality on each key.
- `SS`, `NS`, `BS`: set equality (order does not matter).

A naive `JSON.stringify` deep-equal would treat `SS: ["a", "b"]` and `SS: ["b", "a"]` as different and produce a no-op `set` round-trip on the AWS side. The custom comparator avoids that.

### 12. `ConditionalCheckFailedException` error variant

The existing `AppError::Aws { code, message }` variant already supports arbitrary AWS error codes. The frontend layer adds explicit handling: a thrown `AppError::Aws { code: "ConditionalCheckFailedException" }` is intercepted in the data view's edit flows and rendered as a recoverable optimistic-locking conflict (the "Reload row" affordance described above). All other AWS errors continue to surface as toasts.

The backend explicitly does NOT introduce a new variant; this is a pure frontend-side branch on `code`. Reason: introducing a typed error variant for one AWS code in one frontend flow leaks abstraction. The variant gates the behavior on a stable AWS-defined string.

## Risks / Trade-offs

- **Per-cell commit is chatty on networks** → A user editing five fields on a row fires five `update_item` calls. Mitigation: this matches the roadmap's atomic-per-op rule; bulk batching is `dynamo-batch-operations` (crossroad). The inspector JSON editor is the alternative for users who want one round-trip.
- **No diff-preview means "did I really save?"** → Mitigation: every successful commit toasts and immediately updates the cell value from `ALL_NEW`; every failure reverts the cell and toasts the error. Activity log is the audit trail.
- **Default `attribute_not_exists(#pk)` on insert** can confuse a user who actually wants upsert → Mitigation: "Allow overwrite" checkbox in the modal footer, off by default. Off-by-default is correct because the cost of accidental overwrite of a real item is higher than the cost of one extra checkbox click.
- **Optimistic locking depends on the user setting a version attribute name correctly** → Mitigation: settings dialog explains the contract; toggle is off by default; we never auto-detect a version column (that path was rejected for the same reason Postgres edit doesn't infer enums beyond the catalog).
- **Sequential multi-delete is slow on large selections** → Acceptable in this change. The roadmap explicitly defers `BatchWriteItem` to `dynamo-batch-operations`.
- **Re-fetching after insert via Scan/Query is expensive on large tables** → Mitigation: the insert modal optimistically prepends the new item to the local list and only re-fires the existing query in the background. If the background refresh fails, the local item stays visible with a subtle "Pending refresh" badge until the next manual run.
- **Sets remain editable only through the JSON path** → Acceptable trade-off. Building a rich set editor for one change scope-creeps the change. The JSON inspector covers the use case.
- **Backend `KeySchema` lookup adds a cold-path describe call** → Mitigated by the existing describe cache from #10; cold path is a single one-off `DescribeTable` per (connection, table) per session.

## Migration Plan

There is no production data to migrate. The change adds three Tauri commands and a setting key (`dynamoVersionAttr:<connectionId>:<tableName>`) that is written lazily when the user opens the optimistic-locking config dialog. No new database tables. No new keychain entries. No changes to existing setting keys. No changes to the persisted tab kind.

Rollback: revert the change. The new setting rows become orphaned but harmless. No tab kind retirement or state migration is needed — the data view tab kind is unchanged.

## Open Questions

- Should `update_item` accept a `return_values: "NONE"` to skip the refresh payload on slow connections? Current default is `ALL_NEW` because the Tabla cell needs the post-write value. We can make this configurable later if a user reports latency complaints; not in this change.
- Should the activity-log `params` envelope carry the key values (so the audit trail tells you which row was edited) at the cost of leaking key data into the local activity log? Current decision: no — the rest of the Dynamo module follows the same minimal-envelope rule. Revisit if support cases need the keys.
- Should the "Replace entire item" toggle in the inspector editor be on by default for items that contain complex types where a precise diff is expensive? Current decision: off by default; users explicitly opt in. Keeping the default as diff-`update_item` matches user expectations from spreadsheet-style edit UX.
- Should we render a per-row "dirty" indicator on Tabla rows whose inspector JSON draft is open but uncommitted? Currently no — the dirty state is implicit in the inspector being open. Worth revisiting if users report losing track of where they were editing.
