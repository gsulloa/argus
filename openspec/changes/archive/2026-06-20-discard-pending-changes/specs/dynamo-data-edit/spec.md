## MODIFIED Requirements

### Requirement: Unsaved-draft guard

The data view SHALL track a derived "has unsaved draft" boolean that is `true` whenever any of the following hold: a Tabla inline cell editor has a draft value distinct from the cell's original value, the inspector JSON editor has draft content distinct from the original item's serialization, or the Insert modal's Form / Paste JSON has any non-default content. When "has unsaved draft" is `true` AND the user attempts to (a) close the data view tab, (b) switch to a different tab in the center area, (c) select a different row in Tabla mode while the inspector JSON editor is open, or (d) refresh the data view — via the `⌘R` (soft refresh) or `⌘⇧R` (hard refresh) shortcut, or the reload button — the system MUST surface a confirmation dialog reading "Discard changes?" with Confirm and Cancel buttons. Cancel MUST cancel the navigation or refresh and leave the draft untouched. Confirm MUST discard the draft and complete the navigation or refresh. The guard MUST NOT fire on background events: when `dynamo:credentials-refreshed` fires for the data view's connection or when the connection enters `needs_credentials` state, drafts MUST be preserved silently and any in-flight save MUST be retried automatically once credentials refresh.

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

#### Scenario: Refresh with draft prompts confirmation

- **WHEN** any draft is unsaved and the user presses `⌘R` (or `⌘⇧R`, or clicks the reload button)
- **THEN** a "Discard changes?" dialog appears before the data view refreshes
- **AND** Cancel leaves the draft intact and does not refresh
- **AND** Confirm discards the draft and refreshes the data view

#### Scenario: Clean state refreshes without a dialog

- **WHEN** there is no unsaved draft and the user presses `⌘R`
- **THEN** the data view refreshes immediately with no confirmation dialog

#### Scenario: Credential refresh preserves draft silently

- **WHEN** the user is mid-edit and `dynamo:credentials-refreshed` fires for the data view's connection
- **THEN** the draft is preserved without any confirmation dialog
- **AND** an in-flight save (if any) is retried automatically

#### Scenario: Insert modal dismissal prompts confirmation

- **WHEN** the Insert modal has any non-default content and the user presses Escape or clicks outside the modal
- **THEN** a "Discard changes?" dialog appears before the modal closes
