## ADDED Requirements

### Requirement: Onboarding checklist on the home tab

The Welcome (home) tab SHALL display a "Getting started" checklist containing
exactly three setup items in this order: add a connection, configure an AI
provider, and link a context folder. Each item SHALL show whether it is satisfied
or unsatisfied. Unsatisfied items (that are not locked) SHALL present a direct
call-to-action that opens the corresponding existing flow.

#### Scenario: Checklist renders on the home tab

- **WHEN** the Welcome tab is displayed
- **THEN** a "Getting started" checklist with the three setup items SHALL be rendered

#### Scenario: Each item reflects its satisfied state

- **WHEN** the checklist is displayed
- **THEN** each item SHALL be marked satisfied or unsatisfied based on the current app state

### Requirement: Add-connection item

The "Add a connection" item SHALL be satisfied when at least one connection exists.
While unsatisfied, its call-to-action SHALL open the connection kind picker.

#### Scenario: Unsatisfied with no connections

- **WHEN** no connections exist
- **THEN** the add-connection item SHALL be unsatisfied and present an "Add a connection" call-to-action

#### Scenario: CTA opens the kind picker

- **WHEN** the user activates the add-connection call-to-action
- **THEN** the connection kind picker SHALL open

#### Scenario: Satisfied when a connection exists

- **WHEN** at least one connection exists
- **THEN** the add-connection item SHALL be satisfied

### Requirement: Configure-AI item

The "Configure AI" item SHALL be satisfied when an AI provider is configured —
that is, a global default provider exists OR at least one per-connection override
exists. While unsatisfied, its call-to-action SHALL open the "AI: Configure
providers" settings.

#### Scenario: Unsatisfied with no provider

- **WHEN** no global default provider and no per-connection override exist
- **THEN** the configure-AI item SHALL be unsatisfied and present a call-to-action to configure providers

#### Scenario: CTA opens AI settings

- **WHEN** the user activates the configure-AI call-to-action
- **THEN** the "AI: Configure providers" settings SHALL open

#### Scenario: Satisfied when a provider is configured

- **WHEN** a global default provider OR any per-connection override exists
- **THEN** the configure-AI item SHALL be satisfied

### Requirement: Link-context-folder item

The "Link a context folder" item SHALL be satisfied when at least one connection
has a linked context folder. The item SHALL be locked (no call-to-action, with an
explanatory hint) while no connection exists, since a context folder is linked to a
connection. When unlocked and unsatisfied, its call-to-action SHALL open a
connection's edit form so a context folder can be linked.

#### Scenario: Locked until a connection exists

- **WHEN** no connections exist
- **THEN** the link-context-folder item SHALL be locked and SHALL NOT present a call-to-action

#### Scenario: Unsatisfied and unlocked when a connection exists without a folder

- **WHEN** at least one connection exists AND no connection has a linked context folder
- **THEN** the link-context-folder item SHALL be unsatisfied and present a call-to-action to link a context folder

#### Scenario: CTA opens a connection edit form

- **WHEN** the user activates the link-context-folder call-to-action
- **THEN** the edit form for a connection SHALL open so a context folder can be linked

#### Scenario: Satisfied when a connection has a linked folder

- **WHEN** at least one connection has a linked context folder
- **THEN** the link-context-folder item SHALL be satisfied

### Requirement: Reactive updates

The checklist SHALL recompute and update its items without requiring a manual
refresh when the user completes a step (adds a connection, configures an AI
provider, or links a context folder).

#### Scenario: Item flips to satisfied after completion

- **WHEN** the user completes a setup step while the home tab is displayed
- **THEN** the corresponding item SHALL update to satisfied without a manual refresh

### Requirement: Auto-collapse when complete

When all three items are satisfied, the checklist SHALL collapse to an
unobtrusive completion state (or hide) so that returning users are not prompted to
set up again. The rest of the Welcome content SHALL remain.

#### Scenario: Checklist collapses when all items satisfied

- **WHEN** all three setup items are satisfied
- **THEN** the full checklist SHALL be replaced by an unobtrusive completion state (or hidden)

#### Scenario: Checklist reappears if a prerequisite is lost

- **WHEN** a previously satisfied item becomes unsatisfied (e.g. the last connection is removed)
- **THEN** the checklist SHALL return to its active state showing the unsatisfied item
