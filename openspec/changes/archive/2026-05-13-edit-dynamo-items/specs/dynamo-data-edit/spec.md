## ADDED Requirements

### Requirement: Put item command

The Dynamo module SHALL expose a Tauri command `dynamo.put_item(connectionId, tableName, request, origin?)` that issues an AWS `PutItem`. The `request` payload MUST accept `{ item: AttributeMap, condition_expression?: string, expression_attribute_names?: Map<string, string>, expression_attribute_values?: Map<string, AttributeValue>, return_values?: "NONE" | "ALL_OLD" }`. The command MUST call `require_writable(connectionId)` immediately after deserialization and return that helper's `AppError::Validation { message: "connection is read-only" }` verbatim when the connection's active-client snapshot has `read_only: true`. The command MUST validate before any AWS call that `item` contains every attribute named in the table's `KeySchema`, returning `AppError::Validation` naming the missing keys otherwise. The command MUST forward `condition_expression`, `expression_attribute_names`, and `expression_attribute_values` to AWS verbatim. The response payload MUST be `{ attributes?: AttributeMap, consumed_capacity?: ConsumedCapacity }` where `attributes` is populated only when `return_values: "ALL_OLD"`. The command MUST funnel AWS errors through the credential-expiration contract identically to Scan / Query / Count. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "put_item"`, `connection_id: <id>`, `origin: <origin or "user">`, `sql: null`, `params: { table_name, has_condition: bool, num_attributes: u32 }`, `metric: { kind: "items", value: 1 }` on success (`null` on failure), `status` matching the result, and `duration_ms`.

#### Scenario: Put creates a new item

- **WHEN** the user invokes `dynamo.put_item(id, "events", { item: { pk: { "S": "user-1" }, sk: { "S": "evt-1" }, status: { "S": "ok" } } })` on a writable connection where `KeySchema = [pk HASH, sk RANGE]`
- **THEN** the AWS `PutItem` is issued with the supplied item and the response is `{ attributes: null, consumed_capacity: <…> }`

#### Scenario: Put with ALL_OLD returns prior item

- **WHEN** the user invokes `dynamo.put_item` with `return_values: "ALL_OLD"` against a key that already exists
- **THEN** the response's `attributes` contains the previous item exactly as it was stored

#### Scenario: Put missing a key attribute is rejected

- **WHEN** the user invokes `dynamo.put_item(id, "events", { item: { pk: { "S": "user-1" } } })` on a table whose `KeySchema = [pk HASH, sk RANGE]`
- **THEN** the command returns `AppError::Validation` naming the missing key `sk` and no AWS call is made

#### Scenario: Read-only connection rejects put

- **WHEN** the user invokes `dynamo.put_item` on a connection whose active-client snapshot has `read_only: true`
- **THEN** the command returns `AppError::Validation { message: "connection is read-only" }` and no AWS call is made

#### Scenario: Put with condition_expression forwards verbatim

- **WHEN** the user invokes `dynamo.put_item` with `condition_expression: "attribute_not_exists(#pk)"`, `expression_attribute_names: { "#pk": "pk" }`
- **THEN** the AWS request carries `ConditionExpression` and `ExpressionAttributeNames` exactly as supplied

#### Scenario: ConditionalCheckFailed surfaced

- **WHEN** the conditional put fails because the item already exists
- **THEN** the command returns `AppError::Aws` with `code: "ConditionalCheckFailedException"` and the AWS message verbatim
- **AND** the activity-log event has `status: "err"`

#### Scenario: Expired access-keys session token triggers re-prompt

- **WHEN** `dynamo.put_item` fails with `ExpiredToken` on a connection in access-keys mode with a session token
- **THEN** the command returns `AppError::Aws` with the matching code
- **AND** the Dynamo module marks `params.needs_credentials = true` and evicts the cached client per the existing credential-expiration contract

#### Scenario: Put emits activity-log

- **WHEN** `dynamo.put_item` succeeds with a 4-attribute item
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "put_item"`, `status: "ok"`, `metric: { kind: "items", value: 1 }`, `params.has_condition: false`, `params.num_attributes: 4`

### Requirement: Update item command

The Dynamo module SHALL expose a Tauri command `dynamo.update_item(connectionId, tableName, request, origin?)` that issues an AWS `UpdateItem`. The `request` payload MUST accept `{ key: AttributeMap, updates: { set?: AttributeMap, remove?: string[] }, condition_expression?: string, expression_attribute_names?: Map<string, string>, expression_attribute_values?: Map<string, AttributeValue>, return_values?: "NONE" | "ALL_NEW" | "UPDATED_NEW" | "ALL_OLD" | "UPDATED_OLD" }`. `return_values` MUST default to `"ALL_NEW"`. The command MUST call `require_writable(connectionId)` immediately after deserialization. The command MUST validate before any AWS call: `key` is non-empty AND matches every attribute in the table's `KeySchema`; at least one of `updates.set` or `updates.remove` is non-empty; `updates.set` keys and `updates.remove` entries do NOT overlap; and neither `updates.set` keys nor `updates.remove` entries name any attribute in the table's `KeySchema`. Each validation failure MUST return `AppError::Validation` with a message naming the offending field. The command MUST compile `updates` into a canonical `UpdateExpression` of the form `SET #n0 = :v0, #n1 = :v1 ... REMOVE #n2, #n3 ...` using auto-generated placeholders that do NOT collide with caller-supplied `expression_attribute_names` / `expression_attribute_values`. The auto-generated names and values MUST be merged into the caller's maps and passed to AWS as a single `UpdateExpression`, `ExpressionAttributeNames`, and `ExpressionAttributeValues` triple. The response payload MUST be `{ attributes?: AttributeMap, consumed_capacity?: ConsumedCapacity }` where `attributes` is the refreshed item per `return_values`. The command MUST funnel AWS errors through the credential-expiration contract. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "update_item"`, `connection_id: <id>`, `origin: <origin or "user">`, `sql: null`, `params: { table_name, has_condition: bool, num_set: u32, num_remove: u32 }`, `metric: { kind: "items", value: 1 }` on success (`null` on failure), `status` matching the result, and `duration_ms`.

#### Scenario: Update sets two attributes

- **WHEN** the user invokes `dynamo.update_item(id, "events", { key: { pk: { "S": "user-1" }, sk: { "S": "evt-1" } }, updates: { set: { status: { "S": "ok" }, count: { "N": "5" } } } })`
- **THEN** the AWS request's `UpdateExpression` is `SET #n0 = :v0, #n1 = :v1` (or an equivalent permutation), `ExpressionAttributeNames` maps each `#nX` to `status` / `count`, `ExpressionAttributeValues` maps `:vX` to the supplied tagged values
- **AND** the response's `attributes` reflects the post-update item (default `return_values: "ALL_NEW"`)

#### Scenario: Update removes an attribute

- **WHEN** the user invokes `dynamo.update_item(id, "events", { key, updates: { remove: ["archived"] } })`
- **THEN** the AWS request's `UpdateExpression` is `REMOVE #n0` with `ExpressionAttributeNames: { "#n0": "archived" }` and no `ExpressionAttributeValues` for that placeholder

#### Scenario: Update with both set and remove

- **WHEN** the user invokes `dynamo.update_item` with `updates: { set: { status: { "S": "ok" } }, remove: ["archived"] }`
- **THEN** the AWS request's `UpdateExpression` is `SET #n0 = :v0 REMOVE #n1` with names/values populated accordingly

#### Scenario: Empty updates is rejected

- **WHEN** the user invokes `dynamo.update_item` with `updates: { set: {}, remove: [] }` (or both omitted)
- **THEN** the command returns `AppError::Validation` and no AWS call is made

#### Scenario: Overlapping set and remove is rejected

- **WHEN** the user invokes `dynamo.update_item` with `updates: { set: { status: { "S": "ok" } }, remove: ["status"] }`
- **THEN** the command returns `AppError::Validation` naming the offending attribute and no AWS call is made

#### Scenario: Updating a key attribute is rejected

- **WHEN** the user invokes `dynamo.update_item` against a table with `KeySchema = [pk HASH, sk RANGE]` and `updates.set` contains an entry for `pk` or `sk`
- **THEN** the command returns `AppError::Validation` with a message indicating that key attributes cannot be mutated in place

#### Scenario: Key missing a schema attribute is rejected

- **WHEN** the user invokes `dynamo.update_item` against a table with `KeySchema = [pk HASH, sk RANGE]` and `key = { pk: { "S": "user-1" } }`
- **THEN** the command returns `AppError::Validation` naming the missing `sk`

#### Scenario: Auto-placeholders avoid caller collisions

- **WHEN** the user invokes `dynamo.update_item` with `updates: { set: { status: { "S": "ok" } } }` AND `expression_attribute_names: { "#n0": "version" }`, `expression_attribute_values: { ":v0": { "N": "3" } }`, `condition_expression: "#n0 = :v0"`
- **THEN** the compiled `UpdateExpression` MUST use placeholders that do not collide with the caller's `#n0` / `:v0` (e.g. `#n1` / `:v1`), and the final `ExpressionAttributeNames` / `ExpressionAttributeValues` contain both the caller-supplied entries and the auto-generated entries with no key conflicts

#### Scenario: Read-only connection rejects update

- **WHEN** the user invokes `dynamo.update_item` on a connection whose active-client snapshot has `read_only: true`
- **THEN** the command returns `AppError::Validation { message: "connection is read-only" }` and no AWS call is made

#### Scenario: ConditionalCheckFailed surfaced for optimistic locking

- **WHEN** the user invokes `dynamo.update_item` with `condition_expression: "#v = :prev"` and the current value of the version attribute differs
- **THEN** the command returns `AppError::Aws` with `code: "ConditionalCheckFailedException"`
- **AND** the activity-log event has `status: "err"`

#### Scenario: Update emits activity-log

- **WHEN** `dynamo.update_item` succeeds with two set entries and one remove entry
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "update_item"`, `status: "ok"`, `metric: { kind: "items", value: 1 }`, `params.num_set: 2`, `params.num_remove: 1`

### Requirement: Delete item command

The Dynamo module SHALL expose a Tauri command `dynamo.delete_item(connectionId, tableName, request, origin?)` that issues an AWS `DeleteItem`. The `request` payload MUST accept `{ key: AttributeMap, condition_expression?: string, expression_attribute_names?: Map<string, string>, expression_attribute_values?: Map<string, AttributeValue>, return_values?: "NONE" | "ALL_OLD" }`. The command MUST call `require_writable(connectionId)` immediately after deserialization. The command MUST validate before any AWS call that `key` is non-empty AND matches every attribute in the table's `KeySchema`, returning `AppError::Validation` naming missing keys otherwise. The command MUST forward `condition_expression`, `expression_attribute_names`, and `expression_attribute_values` to AWS verbatim. The response payload MUST be `{ attributes?: AttributeMap, consumed_capacity?: ConsumedCapacity }` where `attributes` is populated only when `return_values: "ALL_OLD"`. The command MUST funnel AWS errors through the credential-expiration contract. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "delete_item"`, `connection_id: <id>`, `origin: <origin or "user">`, `sql: null`, `params: { table_name, has_condition: bool }`, `metric: { kind: "items", value: 1 }` on success (`null` on failure), `status` matching the result, and `duration_ms`.

#### Scenario: Delete removes an item

- **WHEN** the user invokes `dynamo.delete_item(id, "events", { key: { pk: { "S": "user-1" }, sk: { "S": "evt-1" } } })` on a writable connection
- **THEN** the AWS `DeleteItem` is issued and the response is `{ attributes: null, consumed_capacity: <…> }`

#### Scenario: Delete with ALL_OLD returns the removed item

- **WHEN** the user invokes `dynamo.delete_item` with `return_values: "ALL_OLD"`
- **THEN** the response's `attributes` is the item exactly as it was just before deletion

#### Scenario: Key missing a schema attribute is rejected

- **WHEN** the user invokes `dynamo.delete_item` against a table with `KeySchema = [pk HASH, sk RANGE]` and `key = { pk: { "S": "user-1" } }`
- **THEN** the command returns `AppError::Validation` naming the missing `sk` and no AWS call is made

#### Scenario: Read-only connection rejects delete

- **WHEN** the user invokes `dynamo.delete_item` on a connection whose active-client snapshot has `read_only: true`
- **THEN** the command returns `AppError::Validation { message: "connection is read-only" }` and no AWS call is made

#### Scenario: Delete emits activity-log

- **WHEN** `dynamo.delete_item` succeeds
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "delete_item"`, `status: "ok"`, `metric: { kind: "items", value: 1 }`, `params.has_condition: false`

### Requirement: Tabla cell edit-in-place

The data view's Tabla mode SHALL allow edit-in-place on cells whose AttributeValue tag is one of `S`, `N`, `BOOL`, `NULL` AND whose column is NOT a `KeySchema` attribute of the active index (primary or selected GSI / LSI), provided the connection's `params.read_only` is `false`. Double-clicking such a cell MUST open a tag-aware inline editor: `S` renders a text input; `N` renders a numeric input validated as a finite numeric string; `BOOL` renders a toggle that commits on flip; `NULL` renders a "Set to NULL" / "Set to value" segmented control. Pressing `Tab`, `Enter`, or clicking outside the cell MUST commit the edit by dispatching `dynamo.update_item({ key: <row's key attributes>, updates: { set: { <column>: <new tagged value> } }, return_values: "ALL_NEW", condition_expression?, ... })` exactly once. Pressing `Escape` MUST abort without commit. While the call is in flight, the cell MUST display a spinner and MUST NOT accept further input. On success the cell's displayed value MUST update from the response's `attributes`. On failure the cell MUST revert to the original value AND a toast MUST surface the AWS error message verbatim. Cells whose tag is `L`, `M`, `B`, `SS`, `NS`, or `BS` MUST refuse double-click and MUST instead select the row and focus the inspector with an "Edit item (JSON)" hint visible. PK / SK cells of existing rows MUST refuse double-click on every connection (even writable).

#### Scenario: Double-click on a string cell opens an editor

- **WHEN** the user double-clicks a non-PK `S` cell on a writable connection
- **THEN** an inline text input appears with the current value pre-filled and selected

#### Scenario: Tab commits the edit

- **WHEN** the user types a new value and presses Tab
- **THEN** `dynamo.update_item` is invoked exactly once with `updates.set: { <column>: { "S": <new value> } }`, the row's key, and `return_values: "ALL_NEW"`
- **AND** the cell shows a spinner until the response arrives
- **AND** on success the cell's displayed value matches the response's `attributes[<column>]`

#### Scenario: Escape aborts without commit

- **WHEN** the user types a new value and presses Escape
- **THEN** the cell exits edit mode showing the original value and no `dynamo.update_item` call is made

#### Scenario: Numeric input rejects non-numeric

- **WHEN** the user opens the editor on an `N` cell and types `"abc"`
- **THEN** the input shows a validation error and the commit affordances (Tab / Enter / blur) refuse to fire `dynamo.update_item`

#### Scenario: Complex cells route to inspector

- **WHEN** the user double-clicks a cell whose AttributeValue tag is `L`, `M`, `SS`, `NS`, `BS`, or `B`
- **THEN** no inline editor opens; instead the row is selected, the inspector focuses, and the inspector displays a visible "Edit item (JSON)" affordance

#### Scenario: Key columns are not editable

- **WHEN** the user double-clicks a cell in a column that is the partition key or sort key of the active index
- **THEN** no inline editor opens regardless of connection writability

#### Scenario: Read-only connection disables Tabla edit

- **WHEN** the user double-clicks any cell on a connection whose `params.read_only` is `true`
- **THEN** no inline editor opens and no `dynamo.update_item` call is made

#### Scenario: Failed commit reverts and toasts

- **WHEN** the dispatched `dynamo.update_item` fails with `AppError::Aws { code: "ValidationException", message }`
- **THEN** the cell reverts to its original value and a toast surfaces the message verbatim

### Requirement: Inspector JSON editor

The inspector dock SHALL include an "Edit item" affordance that, when activated, swaps its read-only tree for a CodeMirror editor (`language-json`) preloaded with `JSON.stringify(item, null, 2)` where every leaf is in the tagged AttributeValue shape (`{ "S": "…" }`, `{ "N": "…" }`, etc.). The editor MUST include a "Save" button and a "Cancel" button, plus a "Replace entire item" toggle whose default is OFF. The editor MUST be hidden when the connection's `params.read_only` is `true`. Pressing `⌘S` with focus inside the editor MUST trigger Save. Pressing Escape MUST trigger Cancel. The Save flow MUST:

1. Trim and `JSON.parse` the editor contents. On parse failure the editor MUST stay open with `border-color: var(--danger)` and an inline error showing the parse message; no AWS call MUST be made.
2. Validate that every attribute value is a single-key object whose key is one of `S | N | B | BOOL | NULL | L | M | SS | NS | BS`. On failure, the editor stays open with an inline error naming the offending attribute path.
3. Validate that every `KeySchema` attribute of the active index is present in the parsed item AND its tagged value is byte-for-byte equal to the originally loaded item's key attribute. If a key attribute differs or is missing, the editor stays open with an inline error reading "Changing the primary key is a delete + insert, not an edit".
4. When the "Replace entire item" toggle is OFF: compute the AttributeValue diff between the parsed item and the original. Attributes present in both with non-equal tagged values become `set`; attributes present in original but absent in parsed become `remove`; attributes new in parsed become `set`; equal attributes are skipped. If the diff is empty, the editor closes with a "No changes" toast and no AWS call is made. Otherwise dispatch `dynamo.update_item({ key, updates: { set, remove }, condition_expression?, ... })` exactly once.
5. When the "Replace entire item" toggle is ON: dispatch `dynamo.put_item({ item: <parsed>, condition_expression?, ... })` exactly once.
6. On success, the editor closes, the inspector switches back to the tree showing the refreshed item, and the underlying data view row updates to the refreshed item.
7. On AWS failure, the editor stays open with an inline error showing the AWS code and message; for `code: "ConditionalCheckFailedException"`, the inline error MUST include a "Reload row" button that re-fetches the affected row and re-loads the original side of the diff while preserving the user's draft.

AttributeValue equality MUST be tag-aware: `S` / `N` / `B` / `BOOL` / `NULL` use structural equality; `L` uses element-wise ordered equality; `M` uses key-set equality plus recursive equality on values; `SS` / `NS` / `BS` use set equality (order-insensitive).

#### Scenario: Edit item button swaps the tree for an editor

- **WHEN** the user selects a row in Tabla mode and clicks "Edit item" in the inspector on a writable connection
- **THEN** the inspector's tree is replaced by a CodeMirror JSON editor preloaded with the item in tagged form

#### Scenario: Save with no changes is a no-op

- **WHEN** the user opens the editor and clicks Save without modifying the content
- **THEN** the editor closes with a "No changes" toast and no AWS call is made

#### Scenario: Save dispatches update_item with computed diff

- **WHEN** the user changes `status` from `{ "S": "pending" }` to `{ "S": "ok" }` and removes the `archived` attribute and clicks Save with "Replace entire item" OFF
- **THEN** `dynamo.update_item` is invoked exactly once with `updates.set: { status: { "S": "ok" } }` and `updates.remove: ["archived"]`

#### Scenario: Replace entire item dispatches put_item

- **WHEN** the user enables "Replace entire item" and clicks Save
- **THEN** `dynamo.put_item` is invoked exactly once with the parsed item

#### Scenario: Invalid JSON keeps editor open

- **WHEN** the user clicks Save with malformed JSON
- **THEN** the editor stays open with a danger border and an inline parse error and no AWS call is made

#### Scenario: Untagged value rejected

- **WHEN** the user clicks Save with an attribute value like `"status": "ok"` (raw string, not `{ "S": "ok" }`)
- **THEN** the editor stays open with an inline error naming the offending attribute path

#### Scenario: Changing a key attribute is rejected

- **WHEN** the user edits the partition-key attribute's value and clicks Save
- **THEN** the editor stays open with the message "Changing the primary key is a delete + insert, not an edit"

#### Scenario: ConditionalCheckFailed offers Reload row

- **WHEN** Save dispatches `dynamo.update_item` and AWS returns `ConditionalCheckFailedException`
- **THEN** the editor stays open with an inline error AND a "Reload row" button
- **AND** clicking "Reload row" re-fetches the affected row, updates the diff's "original" side, and preserves the user's draft

#### Scenario: Read-only connection hides Edit item

- **WHEN** the inspector renders on a connection whose `params.read_only` is `true`
- **THEN** the "Edit item" button is not rendered

#### Scenario: Set equality is order-insensitive

- **WHEN** the original item has `tags: { "SS": ["a", "b"] }` and the user re-saves with `tags: { "SS": ["b", "a"] }` and no other changes
- **THEN** the diff is empty and no AWS call is made

### Requirement: Insert modal

The data view SHALL include a `+` button in its toolbar that, when activated, opens an Insert modal. The `+` button MUST be hidden when the connection's `params.read_only` is `true`. The modal MUST offer two views toggleable by a tab control: a Form view and a Paste JSON view. The Form view MUST render one typed input per attribute in the active index's `KeySchema` (the picker's type MUST match `attribute_definitions` — `S` / `N` / `B`), all required; below the keys, an "Add attribute" affordance MUST allow zero or more rows of `name / type / value` where `type` is one of `S | N | BOOL | NULL`. The Paste JSON view MUST render a CodeMirror editor accepting a full tagged item, validated identically to the inspector JSON editor's parse + tag + key-presence rules. The modal MUST render a live JSON preview of the canonical item it would dispatch. The modal MUST render an "Allow overwrite" checkbox in its footer, default OFF. Activating Confirm on the modal MUST dispatch `dynamo.put_item({ item, condition_expression?, expression_attribute_names? })` exactly once, where `condition_expression` is `attribute_not_exists(#pk)` (with `#pk` mapped to the partition-key attribute name) when "Allow overwrite" is OFF, and is omitted when "Allow overwrite" is ON. On success the modal MUST close, a toast MUST surface, and the data view MUST re-fire the most recent Scan / Query exactly once with `origin: "user"` so the new row appears. On AWS failure the modal MUST stay open with an inline error showing the AWS code and message. The keyboard shortcut `⌘N` while focus is inside the data view tab MUST open the same modal.

#### Scenario: Plus button opens modal

- **WHEN** the user clicks `+` in the toolbar on a writable connection
- **THEN** the Insert modal opens with the Form view active and the Key fields focused

#### Scenario: ⌘N opens modal

- **WHEN** the user presses `⌘N` with focus inside the data view tab on a writable connection
- **THEN** the same Insert modal opens

#### Scenario: Form view requires key attributes

- **WHEN** the user attempts to Confirm without filling every `KeySchema` attribute
- **THEN** the Confirm button is disabled and inline messages mark the empty key fields

#### Scenario: Paste JSON view rejects untagged values

- **WHEN** the user enters `{ "pk": "user-1", "status": "ok" }` (raw scalars) in Paste JSON and clicks Confirm
- **THEN** the modal stays open with a tag-validation error naming the offending attributes

#### Scenario: Default condition prevents overwrite

- **WHEN** the user confirms with "Allow overwrite" OFF on a table whose partition key is `pk`
- **THEN** the dispatched `dynamo.put_item` carries `condition_expression: "attribute_not_exists(#n0)"` with `expression_attribute_names: { "#n0": "pk" }` (or an equivalent placeholder mapping)

#### Scenario: Allow overwrite removes the condition

- **WHEN** the user toggles "Allow overwrite" ON and confirms
- **THEN** the dispatched `dynamo.put_item` omits `condition_expression`

#### Scenario: Successful insert re-fires the current query

- **WHEN** the dispatched `dynamo.put_item` succeeds
- **THEN** the modal closes, a toast surfaces, and the data view re-fires the most recent Scan or Query with `origin: "user"` exactly once

#### Scenario: ConditionalCheckFailed on insert shows inline error

- **WHEN** `dynamo.put_item` returns `ConditionalCheckFailedException` because an item with the same key already exists
- **THEN** the modal stays open with an inline error explaining the conflict and the "Allow overwrite" toggle visibly highlighted as the resolution

#### Scenario: Read-only connection hides plus button

- **WHEN** the toolbar renders on a connection whose `params.read_only` is `true`
- **THEN** the `+` button is not rendered AND `⌘N` is a no-op

### Requirement: Multi-row delete

The data view's Tabla mode SHALL support multi-row selection via shift-click and `⌘click` row gestures. Pressing `⌫` while one or more rows are selected AND no inline editor is active AND the connection's `params.read_only` is `false` MUST open a confirmation modal listing the key(s) of every selected row in the form `[<pk>=<value>, <sk>=<value>]` per row. Activating Confirm on the modal MUST dispatch `dynamo.delete_item` once per selected row, sequentially (NOT in parallel), with a per-row progress indicator in the modal. Rows that succeed MUST be removed from the local item list immediately. Rows that fail MUST remain in the local item list and MUST be listed at the end of the modal with their AWS code and message verbatim. After the sequential dispatch completes, the modal MUST display a summary `"<X> of <Y> deleted"` and a Close button. Pressing Escape during the dispatch MUST be disabled (the user cannot abort a sequential delete). On a read-only connection, `⌫` MUST be a no-op even with rows selected.

#### Scenario: Backspace on selection opens confirmation

- **WHEN** the user has 3 rows selected and presses `⌫` on a writable connection with no inline editor active
- **THEN** a confirmation modal opens listing all 3 rows' keys

#### Scenario: Confirm dispatches sequentially

- **WHEN** the user confirms a 3-row delete
- **THEN** exactly 3 sequential `dynamo.delete_item` calls are dispatched (one starts only after the previous resolves)

#### Scenario: Successful rows removed from the list

- **WHEN** all 3 deletes succeed
- **THEN** all 3 rows are removed from the data view's local item list and the modal shows `"3 of 3 deleted"`

#### Scenario: Failed rows kept in the list with errors

- **WHEN** the 2nd of 3 deletes fails with `AppError::Aws { code: "ProvisionedThroughputExceededException", message }`
- **THEN** the 1st row is removed from the list, the 2nd and 3rd remain, and the modal summary shows `"2 of 3 deleted"` plus an inline error entry for row 2 with the AWS code and message verbatim

#### Scenario: Read-only connection disables Backspace

- **WHEN** the user presses `⌫` on a connection whose `params.read_only` is `true`
- **THEN** no modal opens and no AWS call is made

#### Scenario: Backspace ignored while an inline editor is open

- **WHEN** the user presses `⌫` while a Tabla cell's inline editor or the inspector's JSON editor has focus
- **THEN** no delete modal opens (Backspace is handled by the active editor)

### Requirement: Optimistic locking

The data view SHALL persist per (connection, table) a version-attribute name under the setting key `dynamoVersionAttr:<connectionId>:<tableName>` (string, default empty). The data view's toolbar MUST expose a "Use ConditionExpression on update" toggle (default OFF, persisted only in component state, not in settings). When the setting is non-empty AND the toggle is ON, every `dynamo.update_item` dispatched from the data view (Tabla inline cell commit, inspector JSON editor Save with diff path) MUST automatically append `attribute_exists(#pk) AND #<version> = :prev` to its `condition_expression`, with `:prev` bound to the value of the version attribute as loaded into the local item state at the time the user started editing. The version attribute MUST NOT be auto-incremented by Argus; the user (or the application writing items) owns advancement of that value. `dynamo.put_item` and `dynamo.delete_item` are NOT affected by this toggle. The "Optimistic locking" config dialog MUST be reachable from a settings menu in the data view toolbar AND MUST contain exactly one input (the version attribute name) and a hint explaining the contract.

#### Scenario: Toggle defaults off

- **WHEN** the user opens a data view tab for the first time on a writable connection
- **THEN** the "Use ConditionExpression on update" toggle is OFF and `dynamo.update_item` calls carry only the caller-supplied `condition_expression` (or none)

#### Scenario: Toggle without version attribute is a no-op

- **WHEN** the toggle is ON but the setting `dynamoVersionAttr:<connectionId>:<tableName>` is empty
- **THEN** no automatic `condition_expression` is appended to `dynamo.update_item` calls

#### Scenario: Toggle with version attribute appends condition

- **WHEN** the setting is `"version"`, the toggle is ON, and the user commits a Tabla cell edit on a row whose loaded `version` was `{ "N": "3" }`
- **THEN** the dispatched `dynamo.update_item` carries `condition_expression` containing `attribute_exists(#<pk>) AND #<version> = :prev` (or an equivalent placeholder mapping) and `expression_attribute_values` binding `:prev` to `{ "N": "3" }`

#### Scenario: Stale version surfaces inline conflict

- **WHEN** the optimistic-locking condition fails and the command returns `AppError::Aws { code: "ConditionalCheckFailedException" }`
- **THEN** the originating editor (Tabla cell or inspector) renders an inline conflict UI with a "Reload row" button as defined by their respective requirements

#### Scenario: Locking does not affect insert

- **WHEN** the toggle is ON and the user confirms the Insert modal
- **THEN** the dispatched `dynamo.put_item` is unchanged by the optimistic-locking toggle (it carries only the modal's own `attribute_not_exists` condition or none)

#### Scenario: Locking does not affect delete

- **WHEN** the toggle is ON and the user confirms a multi-row delete
- **THEN** each dispatched `dynamo.delete_item` is unchanged by the optimistic-locking toggle

#### Scenario: Setting persists per (connection, table)

- **WHEN** the user sets the version attribute name to `"updated_at"` for table A, closes the tab, and re-opens it
- **THEN** the config dialog reads `"updated_at"` for table A and the same toggle behavior applies

### Requirement: Unsaved-draft guard

The data view SHALL track a derived "has unsaved draft" boolean that is `true` whenever any of the following hold: a Tabla inline cell editor has a draft value distinct from the cell's original value, the inspector JSON editor has draft content distinct from the original item's serialization, or the Insert modal's Form / Paste JSON has any non-default content. When "has unsaved draft" is `true` AND the user attempts to (a) close the data view tab, (b) switch to a different tab in the center area, or (c) select a different row in Tabla mode while the inspector JSON editor is open, the system MUST surface a confirmation dialog reading "Discard changes?" with Confirm and Cancel buttons. Cancel MUST cancel the navigation and leave the draft untouched. Confirm MUST discard the draft and complete the navigation. The guard MUST NOT fire on background events: when `dynamo:credentials-refreshed` fires for the data view's connection or when the connection enters `needs_credentials` state, drafts MUST be preserved silently and any in-flight save MUST be retried automatically once credentials refresh.

#### Scenario: Closing tab with draft prompts confirmation

- **WHEN** the user has typed into a Tabla cell editor and attempts to close the data view tab
- **THEN** a "Discard changes?" dialog appears
- **AND** Cancel keeps the tab open with the draft intact
- **AND** Confirm closes the tab and discards the draft

#### Scenario: Switching rows with inspector draft prompts confirmation

- **WHEN** the inspector JSON editor has unsaved content and the user clicks a different Tabla row
- **THEN** a "Discard changes?" dialog appears before the row selection changes

#### Scenario: Switching center tab prompts confirmation

- **WHEN** any draft is unsaved and the user activates another center-area tab
- **THEN** a "Discard changes?" dialog appears

#### Scenario: Credential refresh preserves draft silently

- **WHEN** the user is mid-edit and `dynamo:credentials-refreshed` fires for the data view's connection
- **THEN** the draft is preserved without any confirmation dialog
- **AND** an in-flight save (if any) is retried automatically

#### Scenario: Insert modal dismissal prompts confirmation

- **WHEN** the Insert modal has any non-default content and the user presses Escape or clicks outside the modal
- **THEN** a "Discard changes?" dialog appears before the modal closes
