## ADDED Requirements

### Requirement: Refresh confirmation when the edit buffer is dirty

When the user triggers a table refresh/reload — via the `⌘R` keyboard shortcut, a hard-refresh shortcut, or the reload button in the data-grid toolbar — AND the edit buffer `hasDirty` is `true`, the viewer MUST surface a confirmation dialog reading "Discard N changes and refresh?" (where N is the total of `dirtyCounts.updates + inserts + deletes`) with Confirm and Cancel actions, instead of refreshing immediately. Cancel MUST leave the buffer intact and abort the refresh. Confirm MUST call `buffer.clear()` and then perform the refresh. When `hasDirty` is `false`, the refresh MUST proceed immediately with no dialog.

#### Scenario: Refresh with pending edits prompts confirmation

- **WHEN** the buffer has 2 pending updates and the user presses `⌘R`
- **THEN** a "Discard 2 changes and refresh?" confirmation dialog appears
- **AND** the table is NOT refreshed yet

#### Scenario: Cancel keeps the pending edits

- **WHEN** the refresh-confirmation dialog is open and the user clicks Cancel
- **THEN** the dialog closes, the buffer is unchanged, and the table is not refreshed

#### Scenario: Confirm discards then refreshes

- **WHEN** the refresh-confirmation dialog is open and the user clicks Confirm
- **THEN** the buffer is cleared and the viewer re-fetches the first page

#### Scenario: Clean buffer refreshes without a dialog

- **WHEN** the buffer has no pending edits and the user presses `⌘R`
- **THEN** the table refreshes immediately with no confirmation dialog

### Requirement: Visible pending-edit count and Discard affordance

The data-grid toolbar MUST display a pending-edit count and an explicit **Discard** control whenever the edit buffer `hasDirty` is `true`, and MUST hide both when the buffer is clean. Activating Discard MUST open the same confirmation dialog; on Confirm it MUST call `buffer.clear()` (returning the grid to server values), and on Cancel it MUST leave the buffer intact. The Discard control MUST NOT require closing the tab.

#### Scenario: Pending count appears when buffer is dirty

- **WHEN** the user edits a cell so the buffer has 1 pending change
- **THEN** the toolbar shows a pending-edit count reflecting 1 change and a Discard control

#### Scenario: Discard control clears the buffer after confirmation

- **WHEN** the buffer is dirty and the user activates Discard and confirms
- **THEN** the buffer is cleared and the grid shows the server values again

#### Scenario: Affordance hidden when clean

- **WHEN** the buffer has no pending edits
- **THEN** the toolbar shows neither a pending-edit count nor a Discard control
