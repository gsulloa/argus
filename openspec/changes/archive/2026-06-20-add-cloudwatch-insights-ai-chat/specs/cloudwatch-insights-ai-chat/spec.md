## ADDED Requirements

### Requirement: Docked AI chat panel in the Logs Insights editor

The CloudWatch Logs Insights editor (`modules/cloudwatch/insights/QueryTab.tsx`) SHALL host a docked, collapsible, resizable AI chat panel (`ChatPanel`) on the right side of the editor area, matching the Athena/Postgres integration. A ✨ toggle button in the Insights toolbar SHALL open and close the panel (never a modal). The panel's open/closed state and width SHALL persist across sessions via the shared `localStorage` keys (`argus.ai.panelOpen`, `argus.ai.panelWidth`), and a draggable splitter SHALL resize it within the shared clamp. The panel SHALL also open in response to the "AI: Focus chat panel" command (the `argus:ai:openPanel` event).

#### Scenario: ✨ toggles the panel

- **GIVEN** a CloudWatch Logs Insights tab with an AI provider configured and the panel closed
- **WHEN** the user clicks the ✨ toolbar button
- **THEN** the chat panel renders to the right of the editor and the editor area shrinks
- **WHEN** the user clicks ✨ again
- **THEN** the panel closes and the editor returns to full width

#### Scenario: Panel width and open state persist

- **GIVEN** the user dragged the splitter to widen the panel and left it open
- **WHEN** the application is reloaded and the Insights tab is reopened
- **THEN** the panel reopens at the persisted width

#### Scenario: Focus command opens the panel

- **WHEN** the user invokes "AI: Focus chat panel" from the command palette
- **THEN** the Insights chat panel opens

### Requirement: Readiness bound to the tab connection, context-folder-optional

The Insights tab SHALL derive AI readiness from its fixed payload `connectionId` (there is no in-editor connection selector). The ✨ button SHALL always render with a status dot reflecting readiness, and SHALL open the panel in any state. Because a CloudWatch connection does not require a context folder, readiness SHALL be `ready` once a provider is configured, regardless of whether a context folder is linked.

#### Scenario: Ready with a provider and no context folder

- **GIVEN** an AI provider is configured and the CloudWatch connection has no linked context folder
- **WHEN** the Insights tab evaluates readiness
- **THEN** readiness SHALL be `ready` and the status dot SHALL signal ready
- **AND** opening the panel SHALL show the chat conversation, not a setup checklist

#### Scenario: Setup needed when no provider

- **GIVEN** no AI provider is configured
- **WHEN** the Insights tab evaluates readiness
- **THEN** the status dot SHALL signal that setup is required
- **AND** opening the panel SHALL show the setup checklist with a configure-provider call-to-action

### Requirement: Generated Logs Insights queries can be applied to the editor

The Insights `QueryEditor` SHALL expose an editor handle that structurally satisfies the chat panel's editor contract — `getSql()`, `getCursor()`, `setCursor(offset)`, and `replaceBody(text)` — implemented as CodeMirror reads and write transactions. The chat panel's **Apply** action SHALL replace the editor buffer with the generated query and move the cursor to the end; **Insert** SHALL insert at the cursor, prefixing a newline when the current line is non-empty.

#### Scenario: Apply replaces the editor buffer

- **GIVEN** the editor contains a query and the assistant emitted a fenced `cwlogs` block
- **WHEN** the user clicks **Apply**
- **THEN** the editor buffer is replaced with exactly the generated query and the cursor sits at the end

#### Scenario: Insert at cursor

- **GIVEN** the editor contains a non-empty query with the cursor at the end
- **WHEN** the user clicks **Insert** on a generated block
- **THEN** the generated query is inserted at the cursor, preceded by a newline

### Requirement: Executed Insights result is attachable as context

When a Logs Insights run has completed with a non-empty rows result, the tab SHALL expose it to the chat panel as an attachable, read-only result (column names + rows + truncated flag), subject to the shared attachment caps. Logs are immutable, so the attached result is context only and never editable.

#### Scenario: Completed result is attachable

- **GIVEN** a Logs Insights query has run and returned at least one row
- **WHEN** the user opens the chat composer
- **THEN** the executed result SHALL be offered as attachable context for the next message

#### Scenario: No result to attach

- **GIVEN** no query has run or the last run returned zero rows
- **WHEN** the user opens the chat composer
- **THEN** no attachable result SHALL be offered
