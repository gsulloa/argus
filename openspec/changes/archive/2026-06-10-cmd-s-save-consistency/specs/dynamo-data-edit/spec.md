## ADDED Requirements

### Requirement: Cmd-S commits the active inline editor

Because DynamoDB has no batched dirty buffer — every cell edit commits immediately — `⌘S` MUST behave as a "commit what I'm editing" shortcut rather than a buffer flush. The inline cell editor's text editors (the `S` and `N` tag editors, which hold an uncommitted local draft) MUST treat `⌘S` (`metaKey || ctrlKey` + `s`) identically to `Enter` / `Tab`: `preventDefault` and commit the current draft through the same path (dispatching `dynamo.update_item` exactly once, with `N` still subject to the finite-number validation that blocks an invalid commit). The `BOOL` and `NULL` editors already commit on click and need no `⌘S` handling.

The inspector's JSON editor's existing `⌘S` → Save behavior MUST remain unchanged. When no inline cell editor is open and focus is not in the inspector editor, `⌘S` has no dedicated handler in the data view (no-op).

#### Scenario: Cmd-S commits the open S-cell editor

- **WHEN** the user is editing an `S` cell with a changed draft and presses `⌘S`
- **THEN** `dynamo.update_item` is dispatched exactly once with the cell's new `S` value, identical to confirming with `Enter`

#### Scenario: Cmd-S commits the open N-cell editor

- **WHEN** the user is editing an `N` cell with a valid changed draft and presses `⌘S`
- **THEN** `dynamo.update_item` is dispatched exactly once with the cell's new `N` value

#### Scenario: Cmd-S on an invalid N draft does not commit

- **WHEN** the user is editing an `N` cell whose draft is not a finite number and presses `⌘S`
- **THEN** the editor shows the validation error and does NOT dispatch `dynamo.update_item`

#### Scenario: Cmd-S still saves the inspector JSON editor

- **WHEN** focus is inside the inspector's JSON editor and the user presses `⌘S`
- **THEN** the inspector editor's Save is triggered as before

#### Scenario: Cmd-S is a no-op when nothing is being edited

- **WHEN** no inline cell editor is open, focus is not in the inspector editor, and the user presses `⌘S`
- **THEN** no `dynamo.update_item` is dispatched
