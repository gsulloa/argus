## ADDED Requirements

### Requirement: Feedback form presented in a dedicated window

The feedback form SHALL be presented in a dedicated native window (label `feedback`), not as an in-window dialog overlay. At most one `feedback` window SHALL exist at a time; triggering feedback while the window already exists MUST reuse and focus the existing window rather than creating a second one. The window MUST NOT render the form as an overlay inside the Manager or Workspace window.

#### Scenario: Feedback opens in its own window

- **WHEN** the user activates a feedback entry point
- **THEN** a `feedback` window opens showing the feedback form
- **AND** no feedback dialog overlay is rendered inside the Manager or Workspace window

#### Scenario: Re-trigger focuses the existing window

- **WHEN** a `feedback` window is already open and the user activates a feedback entry point again
- **THEN** no second `feedback` window is created
- **AND** the existing window is shown and focused

### Requirement: Submission outcome coordinated across windows

On successful submission the feedback window SHALL confirm success, clear the draft, notify the opener via an event so any pending host state is reset, and close. On failure the window SHALL remain open, show the error, and preserve the entered message and attachments for retry (the app SHALL NOT silently drop a failed submission).

#### Scenario: Successful submission closes the window

- **WHEN** the feedback submission succeeds
- **THEN** the window confirms success, clears the draft, notifies the opener, and closes

#### Scenario: Failed submission keeps the window open

- **WHEN** the feedback submission fails (e.g. the device is offline)
- **THEN** the window stays open and shows the error
- **AND** the message and attachments remain intact for retry

## MODIFIED Requirements

### Requirement: Feedback entry points

The app SHALL expose the feedback form from both the command palette and a
persistent affordance in the app shell. Activating either entry point SHALL open (or focus) the dedicated `feedback` window rather than an embedded dialog.

#### Scenario: Open from command palette

- **WHEN** the user opens the command palette and selects "Send feedback"
- **THEN** the `feedback` window opens (or is focused if already open) showing the feedback form

#### Scenario: Open from shell affordance

- **WHEN** the user activates the persistent feedback affordance in the app shell
- **THEN** the `feedback` window opens (or is focused if already open) showing the feedback form

### Requirement: Automatic diagnostic metadata

The form SHALL attach safe diagnostic metadata automatically — app version,
OS name and version, CPU architecture, locale, and the active engine **type**.
Because the feedback window has no ambient connection state of its own, the active engine type SHALL be supplied to the window at open time by the opener. The form MUST NOT capture connection details, host names, database/schema/table
names, query text, result data, credentials, or filesystem paths.

#### Scenario: Metadata attached on submit

- **WHEN** the user submits feedback while a Postgres connection is active in the opener
- **THEN** the submission includes app version, OS, arch, locale, and engine
  type `postgres`
- **AND** the submission includes no connection string, host, database name, or
  query text

#### Scenario: Engine type supplied at open time

- **WHEN** the feedback window is opened from a context with an active Postgres connection
- **THEN** the active engine type `postgres` is provided to the window so it can be attached on submit
