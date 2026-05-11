## ADDED Requirements

### Requirement: Query tab result and editor state survive tab switches

A `postgres-query` tab SHALL retain the following in-memory state across any sequence of tab activations and deactivations within the same app session:

- The CodeMirror editor document (already covered by the existing `pgQueryBuffer:<tabId>` persistence requirement, but MUST also be preserved without a settings round-trip on activation).
- The editor's caret position, selection range, scroll position, and undo history.
- The last query result(s) — rows, affected counts, multi-statement sub-tabs, the active sub-tab — for as long as the tab is open.
- Error blocks (SQLSTATE, position, server message) from the most recent failed run.
- The live elapsed-time indicator state for any in-flight run.
- Read-only banner visibility (derived from connection state — must remain consistent on return).

Switching away from a query tab and back MUST NOT re-execute the last query, MUST NOT clear the result, and MUST NOT reset the editor selection or scroll position.

A query tab MAY re-execute only in response to the user explicitly running it (the Run shortcut, the Run button, or the statement-under-cursor action).

Closing a query tab MUST discard the retained result and editor state. The existing `Tab close discards buffer without confirm` requirement applies unchanged.

#### Scenario: Query result persists across tab switch

- **WHEN** the user runs `SELECT * FROM users LIMIT 10` in a query tab, observes the result panel, switches to another tab, then returns
- **THEN** the result panel still shows the same 10 rows
- **AND** no `postgres_run_sql` (or equivalent run command) is dispatched as a result of the activation
- **AND** the editor caret is in the same position as before

#### Scenario: Multi-statement sub-tab choice persists

- **WHEN** the user runs three statements and clicks the second result sub-tab, then switches tabs and returns
- **THEN** the second result sub-tab is still active

#### Scenario: Error block persists across tab switch

- **WHEN** the user runs a statement that produces a SQLSTATE error, switches tabs, and returns
- **THEN** the same error block (code, position, server message) is still rendered
- **AND** no automatic re-run occurs

#### Scenario: In-flight run continues while tab is hidden

- **WHEN** the user runs a long query and switches to another tab before it completes
- **THEN** the query continues to execute in the background
- **AND** when the user returns to the query tab, the result is already rendered (or the elapsed-time indicator continues if still running)

#### Scenario: Closing the tab drops the retained result

- **WHEN** the user closes a query tab that had a result rendered
- **THEN** the retained result is released along with the tab's renderer
- **AND** reopening "New Query" creates a fresh tab with an empty editor and no result
