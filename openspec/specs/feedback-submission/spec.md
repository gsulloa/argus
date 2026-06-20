# feedback-submission Specification

## Purpose
TBD - created by syncing change add-feedback-tracker. Update Purpose after sync.

## Requirements
### Requirement: submit_feedback Tauri command

The Tauri backend SHALL expose a `submit_feedback` command that accepts the form
message, optional category, optional reply email, collected metadata, and an
attachment manifest, and performs the network submission. The frontend SHALL NOT
issue the feedback HTTP request directly.

#### Scenario: Command invoked from the form

- **WHEN** the frontend invokes `submit_feedback` with a valid payload
- **THEN** the command sends the request to the feedback backend and returns the
  outcome to the frontend

### Requirement: Authenticated request with app-key

The command SHALL send the request over HTTPS to the configured feedback
endpoint and SHALL include the static app-key in a request header. The endpoint
URL and app-key SHALL be injected at build time, not hard-coded in the
committed frontend source.

#### Scenario: App-key header present

- **WHEN** the command sends the feedback request
- **THEN** the request targets the configured HTTPS endpoint and carries the
  app-key header

### Requirement: Two-phase attachment upload

When attachments are present, the command SHALL first POST the metadata and
attachment manifest to obtain presigned PUT URLs, then upload each file's bytes
directly to the returned URL. The user-facing action SHALL remain a single
"Send".

#### Scenario: Upload attachments after metadata

- **WHEN** the user submits feedback with one or more attachments
- **THEN** the command first sends metadata and receives presigned URL(s)
- **AND** the command uploads each attachment's bytes to its presigned URL

#### Scenario: Submit without attachments

- **WHEN** the user submits feedback with no attachments
- **THEN** the command completes the submission without an upload phase

### Requirement: Failure handling without local queue

If any phase fails, the command SHALL return an error to the frontend. The
command MUST NOT persist a local retry queue in v1. A failure after the metadata
record is written SHALL NOT discard the already-recorded feedback.

#### Scenario: Network failure returns error

- **WHEN** the metadata request fails
- **THEN** the command returns an error and records nothing

#### Scenario: Upload failure after record written

- **WHEN** the metadata record is written but an attachment upload fails
- **THEN** the command returns an error
- **AND** the feedback record remains stored without that attachment
