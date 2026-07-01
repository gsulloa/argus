## ADDED Requirements

### Requirement: Non-grid copy failures are surfaced to the user

Every non-grid copy-to-clipboard affordance in the app SHALL surface a clipboard write failure to the user via a non-blocking error toast (`useToast().show("Copy failed", "error")`) rather than silently swallowing the error in an empty `catch`, a `console.error`/`console.warn`, or an uncaught promise rejection. The toast MUST use the app toast primitive (`platform/toast`) and MUST NOT block the UI. A failure MUST NOT trigger the site's success affordance (e.g. the transient "Copied" label). This contract applies to all non-grid copy sites: updater logs, Dynamo CLI command, Dynamo table name / ARN, Dynamo metadata values, Postgres / MySQL / MSSQL DDL, query-history SQL, AI code blocks, and CloudWatch Insights results.

#### Scenario: Copy failure shows an error toast

- **WHEN** the user triggers any non-grid copy action and the clipboard write throws
- **THEN** a non-blocking error toast with the message "Copy failed" is shown
- **AND** the error is not silently swallowed
- **AND** the site's success affordance (e.g. a "Copied" label) is not shown

#### Scenario: DDL copy failure is reported

- **WHEN** the user clicks "Copy" in a Postgres, MySQL, or MSSQL table-structure raw/DDL view and the clipboard write fails
- **THEN** a "Copy failed" error toast is shown instead of only logging to the console

#### Scenario: Fire-and-forget copy failure is reported

- **WHEN** the user copies a Dynamo table name, ARN, metadata value, or SSO CLI command and the clipboard write fails
- **THEN** a "Copy failed" error toast is shown instead of the failure being lost from an uncaught promise

### Requirement: Successful non-grid copies stay silent

A successful non-grid clipboard write MUST NOT show any toast. Sites that already show a transient success affordance (a "Copied" label or checkmark) MUST continue to show it unchanged; sites that show no success affordance MUST remain silent on success. The error toast MUST fire only on an actual write failure, never on a successful copy and never on a no-op where there is nothing to copy.

#### Scenario: Successful copy shows no error toast

- **WHEN** the user triggers a non-grid copy action and the clipboard write succeeds
- **THEN** no error toast is shown
- **AND** any existing success affordance for that site is shown as before

#### Scenario: No-op copy shows no toast

- **WHEN** a copy handler runs with nothing to copy (e.g. empty DDL or a missing value) so no clipboard write is attempted
- **THEN** no toast — neither success nor error — is shown

### Requirement: Non-grid copies reuse the shared write helper

Non-grid copy sites SHALL perform the clipboard write through the shared success/failure-reporting write helper (`writeClipboardText` from `platform/grid/gridCopy.ts`, or a shared equivalent promoted from it) introduced by PR #213, rather than calling `navigator.clipboard.writeText` directly with ad-hoc error handling. The helper MUST return whether the write succeeded so the call site can decide whether to show the error toast. The failure message MUST match the grid copy failure message ("Copy failed") for app-wide consistency.

#### Scenario: Sites route writes through the shared helper

- **WHEN** a non-grid copy site writes text to the clipboard
- **THEN** it does so via the shared write helper and branches on the returned success/failure result
- **AND** it does not re-implement its own `navigator.clipboard.writeText` try/catch

#### Scenario: Failure message matches the grid

- **WHEN** a non-grid copy fails and shows its error toast
- **THEN** the message string is the same "Copy failed" text used by the grid copy paths
