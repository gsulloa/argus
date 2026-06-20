## 1. Infra — FeedbackStack foundation

- [x] 1.1 Add feedback constants to `packages/infra/constants.ts` (table name `ArgusFeedback`, attachments bucket id, `feedback.argusdb.app` domain, app-key SSM/secret path, attachment size/count caps)
- [x] 1.2 Re-add `grantDynamoDb` (least-privilege `PutItem`) to `NodejsFunctionBuilder`, removing the existing TODO
- [x] 1.3 Create `packages/infra/lib/FeedbackStack/index.ts` with the `ArgusFeedback` DynamoDB table (pk `FEEDBACK`, sk ULID, on-demand billing, `RETAIN` removal policy)
- [x] 1.4 Add the private attachments S3 bucket (BlockPublicAccess ALL, enforce SSL) to the stack
- [x] 1.5 Wire `FeedbackStack` into `bin/infra.ts` with a dependency on `DnsStack`

## 2. Infra — intake Lambda + API

- [x] 2.1 Write the intake Lambda handler: validate app-key header, validate payload (non-empty/max message, attachment caps), generate ULID, `PutItem` with `status=new`, return presigned PUT URLs
- [x] 2.2 Define the Lambda via `NodejsFunctionBuilder` with `grantDynamoDb` + `grantBucket` (write) for presign
- [x] 2.3 Create the HTTP API, route `POST /feedback` → Lambda, and apply throttling (bounded rate + burst)
- [x] 2.4 Add the `feedback.argusdb.app` custom domain mapping and the DNS record in `DnsStack`
- [x] 2.5 Provision the app-key secret/SSM parameter (rotatable, independent of the table) and a CloudWatch alarm on Lambda invocation count

## 3. App — Tauri command (transport)

- [x] 3.1 Add a `submit_feedback` Tauri command accepting message, optional category, optional email, metadata, and attachment manifest
- [x] 3.2 Collect safe metadata in Rust (app version, OS + version, arch, locale, active engine type); enforce the privacy deny-list
- [x] 3.3 Implement phase-1 metadata POST with the app-key header via `reqwest`, returning presigned URLs
- [x] 3.4 Implement phase-2 direct PUT of each attachment's bytes to its presigned URL
- [x] 3.5 Inject the endpoint URL + app-key at build time (not committed to source); return structured success/error to the frontend
- [x] 3.6 Register the command in the Tauri command/module wiring

## 4. App — feedback form UI

- [x] 4.1 Build the feedback form module (message textarea, category select bug/idea/other, optional reply email) per `DESIGN.md`
- [x] 4.2 Add the attachment picker (file dialog), enforce per-file size + total-count caps, and show the "check for sensitive data" guidance; no auto window-capture
- [x] 4.3 Validate required non-empty message and email format before enabling submit
- [x] 4.4 Wire submit to `submit_feedback`; show progress, success confirmation, and on failure surface an error while preserving the draft + attachments
- [x] 4.5 Register the "Send feedback" command-palette entry
- [x] 4.6 Add the persistent feedback affordance in the app shell

## 5. Verification

- [ ] 5.1 Deploy `FeedbackStack` (`cdk deploy`) and verify the endpoint resolves at `feedback.argusdb.app`
- [ ] 5.2 Submit feedback with and without attachments from the app; confirm the DynamoDB item (ULID-ordered, `status=new`) and S3 objects under `attachments/<ulid>/`
- [ ] 5.3 Verify app-key rejection, payload validation, and throttling on the endpoint
- [ ] 5.4 In Argus, add a DynamoDB connection to `ArgusFeedback`; confirm chronological browse and inline `status` edit persist
- [ ] 5.5 Confirm metadata privacy: no connection/host/db/table/query data present in stored items
