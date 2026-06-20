## Why

Argus has no way for users to report bugs or ideas, and the maintainer has no
channel to collect and triage that signal. The user base is a small known
circle and volume is expected to be low, so the goal is a low-friction native
form inside the app feeding a self-hosted store the maintainer already has the
tools to inspect — Argus itself, pointed at a DynamoDB table.

## What Changes

- Add a **native feedback form** inside Argus, reachable from both the
  command palette ("Send feedback") and a persistent affordance in the app
  shell. Single free-text message plus an optional category (bug / idea /
  other) and optional reply email.
- Auto-attach **safe diagnostic metadata** (app version, OS + version, arch,
  locale, active engine type). **Never** capture connection details, database/
  schema/table names, query text, result data, credentials, or paths.
- Support **user-chosen image attachments** (screenshots) uploaded directly to
  S3 via presigned PUT. No auto window-capture (would risk leaking on-screen
  data); the user explicitly picks files and is warned to check for sensitive
  content.
- Add a **`submit_feedback` Tauri command** (Rust) that gathers metadata, calls
  the backend, performs presigned uploads, and carries a static app-key header.
  On failure it surfaces an error and preserves the draft (no local queue in v1).
- Add a **`FeedbackStack` (CDK)**: HTTP API at `feedback.argusdb.app` →
  Lambda (validate + PutItem + mint presigned URLs) → DynamoDB table
  `ArgusFeedback` + private S3 attachments bucket, with API Gateway throttling.
  This is the first stack to use DynamoDB, re-introducing `grantDynamoDb` on
  `NodejsFunctionBuilder`.
- **No email/SES notification** in v1 — the maintainer reviews feedback on
  demand by browsing the DynamoDB table in Argus and editing item `status`
  inline; attachments are fetched out-of-band via the maintainer's AWS profile.

## Capabilities

### New Capabilities
- `feedback-form`: The in-app native UI — palette entry + shell affordance, the
  form fields, attachment picker with privacy guidance, metadata collection, and
  submit/error UX.
- `feedback-submission`: The Rust transport — `submit_feedback` Tauri command,
  request payload + app-key header, the two-phase presigned upload of
  attachments, and offline/error handling contract.
- `feedback-backend`: The `FeedbackStack` infra — HTTP API + custom domain,
  Lambda validation rules, the `ArgusFeedback` DynamoDB schema (ULID sort key,
  `status` lifecycle), the attachments S3 bucket, and abuse mitigation.

### Modified Capabilities
<!-- None — no existing spec's requirements change. -->

## Impact

- **Frontend** (`packages/app/src`): new feedback module/UI, command-palette
  registration, shell affordance.
- **Tauri backend** (`packages/app/src-tauri/src`): new `submit_feedback`
  command using the existing `reqwest` outbound-HTTP pattern; build-time
  injection of the endpoint URL + app-key.
- **Infra** (`packages/infra`): new `FeedbackStack` wired in `bin/infra.ts`;
  new constants (table name, bucket name, domain, app-key SSM/secret);
  `grantDynamoDb` re-added to `NodejsFunctionBuilder`; DNS record in `DnsStack`.
- **External**: new public write endpoint on the internet — mitigated by
  API Gateway throttling, a rotatable app-key header, Lambda-side validation,
  size caps, and DynamoDB on-demand billing.
- **Privacy**: explicit allow/deny list for captured metadata; user-controlled
  attachments only.
