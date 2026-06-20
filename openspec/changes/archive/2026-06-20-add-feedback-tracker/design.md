## Context

Argus is a Tauri 2 desktop app distributed publicly via `argusdb.app`. It
already owns serverless infrastructure on the maintainer's AWS account via CDK
(`packages/infra`): `DnsStack` (hosted zone for `argusdb.app`), `LandingStack`,
`ReleasesStack`, `AnalyticsStack`. The app already performs outbound HTTPS in
Rust (`reqwest`, e.g. `modules/ai/anthropic_api.rs`) and already talks to the
maintainer's cloud for updates (`releases.argusdb.app`).

There is no feedback or telemetry today. The user base is a small known circle;
expected volume is low. The maintainer wants to review feedback **inside Argus
itself** by connecting to the resulting DynamoDB table as an ordinary DynamoDB
connection, and to triage by editing item `status` inline (Argus already
supports DynamoDB browsing + inline edit). Triage output (clean public GitHub
issues) is produced manually with Claude; attachments are fetched out-of-band
with the maintainer's AWS profile.

Two telling signals in the codebase: `NodejsFunctionBuilder` carries
`// TODO: re-add grantDynamoDb once a DatabaseStack exists` and already exposes
`grantBucket(...)` — the conventions for this stack are pre-staged.

## Goals / Non-Goals

**Goals:**
- Low-friction native in-app feedback capture (palette + shell affordance).
- A self-hosted store the maintainer inspects with Argus (DynamoDB), no custom
  dashboard.
- Auto-collected, privacy-safe diagnostic metadata.
- User-chosen image attachments, stored privately in S3.
- Stay idiomatic to the existing CDK conventions.

**Non-Goals:**
- No SES/email notification (maintainer polls on demand).
- No public roadmap / voting board.
- No GitHub Issues in the capture path (triage → GitHub is manual).
- No in-app rendering of attachments (fetched out-of-band via AWS profile).
- No local persistent retry queue for failed submissions in v1.
- No auto window-capture of screenshots.

## Decisions

### Transport lives in Rust (`submit_feedback` Tauri command)
Metadata (app version, OS, arch) is naturally available in Tauri/Rust, the
outbound-HTTPS pattern already lives there (`reqwest`), and keeping the
app-key out of the JS bundle is marginally better. The frontend collects form
input and invokes the command; Rust owns the network.
*Alternative:* POST from the webview with `fetch` — rejected: scatters the
secret into JS and diverges from the existing HTTP pattern.

### Attachments via two-phase presigned PUT, not inline base64
The submit flow is: (1) `POST /feedback` with metadata + an attachment manifest
(filename, content-type, size) → Lambda validates, generates the item ULID,
writes the DynamoDB item (`status=new`), and returns presigned PUT URL(s) keyed
under `attachments/<ulid>/<n>.<ext>`; (2) Rust PUTs each file directly to S3.
The user sees a single "Send"; Rust hides phase 2.
*Why not base64 inline:* API Gateway caps payloads at 10 MB and base64 inflates
~33%, coupling blob size to the JSON endpoint. Presigned is the AWS-idiomatic
pattern and `NodejsFunctionBuilder.grantBucket` already supports it.
*Failure semantics:* the DynamoDB item is written in phase 1, so a failed
upload yields an item with a missing attachment rather than lost feedback.

### DynamoDB schema: single partition, ULID sort key
`pk = "FEEDBACK"`, `sk = <ULID>`. A ULID embeds its creation timestamp in the
high bits, so lexicographic sort = chronological order — a `Query pk=FEEDBACK`
returns newest-last with no separate date key. `createdAt` (ISO) is still stored
as a plain attribute for readability. `status` (`new` → `triaged` →
`done`/`wontfix`) is the maintainer's tracking field, edited inline in Argus;
`githubUrl` is filled when a feedback item is promoted to a public issue.
*Alternative:* date-prefixed SK or a `status` GSI — rejected as over-built for
low volume; scan/query-and-filter in Argus suffices.

### Public write endpoint, proportionate abuse mitigation
The endpoint is on the internet. Mitigations sized to low-value/low-volume:
API Gateway throttling (low rate + burst), a static rotatable **app-key** header
baked into the build, Lambda-side validation (required fields, max message
length, attachment count/size caps, ignore unknown fields), DynamoDB on-demand
billing, and a CloudWatch alarm on Lambda invocations.
*Honesty on the app-key:* it is extractable from the distributed binary — but
unlike a GitHub token it only grants "write one feedback item" (no blast radius
beyond the maintainer's own table) and is rotatable, so it is proportionate
here where a real credential would not be. Hardening (Cognito anonymous / WAF)
is deferred.

### Stable custom domain `feedback.argusdb.app`
A DNS record in `DnsStack` fronts the HTTP API so the app ships a stable URL,
not the volatile `execute-api` hostname.

### Privacy allow/deny list
Auto-captured: app version, OS + version, arch, locale, active engine **type**
(e.g. `"postgres"`, never the connection). Never captured: connection strings,
host names, database/schema/table names, query text, result rows, credentials,
or filesystem paths. Attachments are user-selected only, with on-form guidance
to check for sensitive content.

## Risks / Trade-offs

- **Public endpoint abuse / bill inflation** → throttling + app-key + Lambda
  validation + size caps + on-demand billing + invocation alarm.
- **App-key leakage from the binary** → accepted; low blast radius + rotatable;
  documented as a known limitation, hardening deferred.
- **Screenshot leaks user DB data** → no auto-capture; explicit file pick + form
  warning; attachments land in a private, BlockPublicAccess bucket.
- **Failed attachment upload after item write** → item persists with missing
  attachment (feedback not lost); no retry queue in v1.
- **First DynamoDB use in infra** → re-add `grantDynamoDb` to the builder
  carefully (least-privilege: `PutItem` for the Lambda; maintainer read/write
  is a separate IAM identity used by the Argus connection).

## Migration Plan

1. Deploy infra: add `FeedbackStack`, wire it in `bin/infra.ts`, add DNS record;
   `cdk deploy`. Capture the table name, bucket name, domain, and app-key
   (stored as a secret/SSM, injected at app build time).
2. Ship the app change behind the new palette entry + shell affordance.
3. Maintainer adds a DynamoDB connection in Argus to `ArgusFeedback` and
   verifies browse + inline `status` edit.
4. Rollback: the app feature is additive (remove the affordance / no-op the
   command); the stack can be destroyed independently (DynamoDB `RETAIN` for
   safety, mirroring the analytics bucket policy).

## Open Questions

- Attachment caps: proposed ≤ 5 MB per file, max 3 files — confirm.
- App-key storage/rotation mechanism (SSM SecureString vs Secrets Manager) and
  how it is injected into the app build.
- Exact maintainer IAM identity/policy for the Argus DynamoDB connection and S3
  read of attachments.
