# feedback-backend Specification

## Purpose
TBD - created by syncing change add-feedback-tracker. Update Purpose after sync.

## Requirements
### Requirement: FeedbackStack with custom-domain HTTP API

The infra SHALL define a `FeedbackStack` exposing an HTTP API behind the stable
custom domain `feedback.argusdb.app`, with the DNS record managed in `DnsStack`.
The stack SHALL be wired into the CDK app entrypoint.

#### Scenario: Endpoint resolves at custom domain

- **WHEN** the stack is deployed
- **THEN** the feedback API is reachable over HTTPS at `feedback.argusdb.app`

### Requirement: Feedback intake Lambda

The HTTP API SHALL invoke a Lambda that validates the request, generates a
ULID for the item, writes the feedback record to DynamoDB with `status=new`,
and returns presigned PUT URLs for any declared attachments. The Lambda SHALL
require the app-key header and SHALL reject requests lacking a valid key.

#### Scenario: Valid request stored

- **WHEN** the Lambda receives a valid request with the app-key header
- **THEN** it writes a DynamoDB item with a new ULID and `status=new`
- **AND** it returns presigned PUT URLs for each declared attachment

#### Scenario: Missing app-key rejected

- **WHEN** a request arrives without a valid app-key header
- **THEN** the Lambda rejects it and writes no item

#### Scenario: Validation of payload

- **WHEN** a request has an empty message, an oversized message, or attachment
  declarations beyond the size/count caps
- **THEN** the Lambda rejects the request and writes no item

### Requirement: ArgusFeedback DynamoDB schema

The stack SHALL provision a DynamoDB table `ArgusFeedback` with partition key
`pk` fixed to `"FEEDBACK"` and sort key `sk` set to the item's ULID, so a query
on the partition returns items in chronological order. Each item SHALL carry
`createdAt` (ISO), `status`, `message`, optional `category`, optional `email`,
the diagnostic metadata, and an `attachments` list of S3 object keys. The table
SHALL use on-demand billing and a `RETAIN` removal policy.

#### Scenario: Chronological browse

- **WHEN** the maintainer queries the partition `pk = "FEEDBACK"`
- **THEN** items are returned ordered by ULID, i.e. by creation time

#### Scenario: Status lifecycle editable

- **WHEN** the maintainer edits an item's `status` to `triaged`, `done`, or
  `wontfix`
- **THEN** the change persists and is reflected on subsequent reads

### Requirement: Private attachments bucket

The stack SHALL provision a private S3 bucket for attachments with all public
access blocked. The intake Lambda SHALL be granted only the permission needed to
mint presigned PUT URLs for that bucket. Stored objects SHALL be keyed under
`attachments/<ulid>/`.

#### Scenario: Bucket blocks public access

- **WHEN** the bucket is provisioned
- **THEN** public access is fully blocked and objects are not publicly readable

#### Scenario: Attachment keyed under item ULID

- **WHEN** an attachment is uploaded for a feedback item
- **THEN** its S3 key is under `attachments/<ulid>/`

### Requirement: Abuse mitigation on the public endpoint

The stack SHALL apply API Gateway throttling (bounded rate and burst) and SHALL
provision a CloudWatch alarm on the intake Lambda's invocation count to surface
abnormal traffic. The app-key SHALL be rotatable without redeploying the table.

#### Scenario: Throttle excess traffic

- **WHEN** request volume exceeds the configured rate/burst
- **THEN** the API throttles the excess requests

#### Scenario: Alarm on abnormal volume

- **WHEN** invocation count crosses the configured threshold
- **THEN** the CloudWatch alarm enters ALARM state
