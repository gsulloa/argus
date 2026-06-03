## ADDED Requirements

### Requirement: Plain Enter in filter value input runs the query

While the query builder's filter section is visible AND focus is inside a filter row's value editor (text or number; the boolean toggle and `attribute_exists` / `attribute_not_exists` unary operators have no value editor), pressing `Enter` with no modifier key MUST call `handleRun()` — the same action triggered by clicking the primary `Run` button.

The handler MUST call `preventDefault()` on the keyboard event. The handler MUST NOT fire when:
- focus is inside the partition-key or sort-key value input (those keys form part of the `KeyConditionExpression` and already trigger `handleRun()` via the existing ⌘R shortcut at the tab level — no separate filter-row handler is needed there); OR
- focus is inside a `BETWEEN` min/max editor where another min/max input on the same row is empty (Enter MUST first allow the user to fill the second input; for v1, the simplest implementation MAY still call `handleRun()` and let the builder's existing dirty-and-invalid validation surface the error — implementations SHOULD prefer the "run anyway, surface error" path for consistency with the Run button).

Plain `Enter` MUST mark `lastRunStateRef.current` to the normalized builder state (so the dirty pip clears), identical to clicking Run.

#### Scenario: Plain Enter in a text filter value runs the builder

- **WHEN** the user is in `Scan` mode, has added a filter row `status = "ok"`, focus is in that row's text value editor, and presses `Enter`
- **THEN** `handleRun()` is invoked
- **AND** `dynamo.scan` is dispatched with the compiled `FilterExpression` `#n0 = :v0`
- **AND** the Run button's dirty pip clears

#### Scenario: Plain Enter in a number filter value runs the builder

- **WHEN** the user has a filter row `count >= 5`, focus is in the number value editor, and presses `Enter`
- **THEN** `handleRun()` is invoked
- **AND** the compiled `FilterExpression` contains `#n0 >= :v0` with `":v0": { "N": "5" }`

#### Scenario: Plain Enter on a unary filter row is a no-op

- **WHEN** the user has a filter row `archived attribute_not_exists` (no value editor rendered), focus is somewhere else in the row, and presses `Enter`
- **THEN** the filter row's own onKeyDown does NOT fire (there is no value editor on that row to attach to)
- **AND** any ambient handler (e.g. the tab-level ⌘R only on Cmd) does NOT mis-handle plain Enter

#### Scenario: Plain Enter does not modify the filter combinator

- **WHEN** `filterCombinator === "OR"` and the user presses `Enter` from a filter value editor
- **THEN** `handleRun()` is invoked
- **AND** `filterCombinator` remains `"OR"`
- **AND** the compiled `FilterExpression` joins rows with `OR`
