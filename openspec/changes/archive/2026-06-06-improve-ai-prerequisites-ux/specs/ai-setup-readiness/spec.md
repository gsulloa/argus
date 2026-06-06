## ADDED Requirements

### Requirement: AI readiness state

The system SHALL derive a single AI readiness state for the active connection
from two prerequisites — a configured AI provider and an available context
folder — exposing exactly one of three values: `not-configured` (no provider),
`needs-context` (provider configured but no linked context folder, or a context
folder that is linked but unavailable on disk), or `ready` (provider configured
and context folder linked and available).

A provider is considered configured when a global default provider exists OR a
per-connection override exists for the active connection. A context folder is
considered available when it is linked AND its objects can be listed; a folder
that is linked but missing/unreadable on disk SHALL be treated as unavailable.

#### Scenario: No provider configured

- **WHEN** no global default provider and no per-connection override exist for the active connection
- **THEN** the readiness state SHALL be `not-configured`

#### Scenario: Provider configured but no context folder

- **WHEN** a provider is configured AND no context folder is linked to the active connection
- **THEN** the readiness state SHALL be `needs-context`

#### Scenario: Provider configured but context folder missing on disk

- **WHEN** a provider is configured AND a context folder is linked but unavailable on disk
- **THEN** the readiness state SHALL be `needs-context`

#### Scenario: All prerequisites met

- **WHEN** a provider is configured AND a context folder is linked and available on disk
- **THEN** the readiness state SHALL be `ready`

#### Scenario: Readiness updates reactively

- **WHEN** the user configures a provider or links a context folder while the readiness is being displayed
- **THEN** the readiness state SHALL recompute and update its consumers without requiring a manual refresh

### Requirement: Always-visible AI entry point

The system SHALL always render the ✨ AI button in the Postgres SQL editor
toolbar for every connection, regardless of readiness state. Clicking the button
SHALL open the docked AI panel.

#### Scenario: Button visible when not configured

- **WHEN** the readiness state is `not-configured`
- **THEN** the ✨ button SHALL be rendered and clickable

#### Scenario: Button opens panel in any state

- **WHEN** the user clicks the ✨ button in any readiness state
- **THEN** the docked AI panel SHALL open

### Requirement: AI entry point status indicator

The ✨ button SHALL display a status indicator (a status dot) reflecting the
current readiness state so the user can tell at a glance whether AI is ready or
needs setup. The indicator SHALL distinguish `ready` from the unmet states
(`not-configured`, `needs-context`).

#### Scenario: Indicator shows setup needed

- **WHEN** the readiness state is `not-configured` or `needs-context`
- **THEN** the status indicator SHALL signal that setup is required

#### Scenario: Indicator shows ready

- **WHEN** the readiness state is `ready`
- **THEN** the status indicator SHALL signal that AI is ready

### Requirement: Setup checklist in the AI panel

When the readiness state is not `ready`, the AI panel SHALL render a setup
checklist instead of the chat conversation. The checklist SHALL list both
prerequisites — AI provider and context folder — each marked as satisfied or
unsatisfied, and each unsatisfied item SHALL present a direct call-to-action to
complete it.

The provider CTA SHALL open the "AI: Configure providers" settings. The context
folder CTA SHALL open the connection form where the context folder can be linked.

#### Scenario: Checklist shown when provider missing

- **WHEN** the readiness state is `not-configured` and the user opens the AI panel
- **THEN** the panel SHALL show the setup checklist with the provider item unsatisfied and a CTA to configure providers

#### Scenario: Checklist shown when context missing

- **WHEN** the readiness state is `needs-context` and the user opens the AI panel
- **THEN** the panel SHALL show the setup checklist with the provider item satisfied, the context folder item unsatisfied, and a CTA to link a context folder

#### Scenario: Provider CTA opens settings

- **WHEN** the user activates the provider CTA in the checklist
- **THEN** the "AI: Configure providers" settings SHALL open

#### Scenario: Context CTA opens connection form

- **WHEN** the user activates the context folder CTA in the checklist
- **THEN** the connection form for the active connection SHALL open so a context folder can be linked

#### Scenario: Panel transitions to chat when ready

- **WHEN** the readiness state becomes `ready` while the setup checklist is displayed
- **THEN** the panel SHALL replace the checklist with the chat conversation interface

### Requirement: Chat gated on prerequisites

The system SHALL allow AI chat usage only when the readiness state is `ready`.
Chat input SHALL be unavailable (hidden or disabled) while the readiness state is
`not-configured` or `needs-context`, and no chat session SHALL be created until
the readiness state is `ready`.

#### Scenario: Chat input unavailable when not ready

- **WHEN** the readiness state is `not-configured` or `needs-context`
- **THEN** the chat input SHALL be unavailable and no message can be sent

#### Scenario: No session created before ready

- **WHEN** the AI panel is open and the readiness state is not `ready`
- **THEN** no chat session SHALL be created

#### Scenario: Chat usable when ready

- **WHEN** the readiness state is `ready` and the AI panel is open
- **THEN** the chat input SHALL be available and the user can send a message

### Requirement: Removal of degraded no-context chat mode

The system SHALL NOT run AI chat in a degraded mode when no context folder is
available. The prior behaviour of opening chat with an empty or temp-directory
payload, signalled only by a tooltip, SHALL be removed in favour of the blocking
setup checklist.

#### Scenario: No degraded chat without context

- **WHEN** a provider is configured but no context folder is available
- **THEN** the panel SHALL show the setup checklist and SHALL NOT permit chatting with an empty/degraded payload
