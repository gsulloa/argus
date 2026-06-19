## ADDED Requirements

### Requirement: Shared private log bucket receives CloudFront standard logs

The `packages/infra` CDK app SHALL define an analytics stack named
`${PROJECT_NAME}AnalyticsStack` (`ArgusAnalyticsStack`) under `lib/AnalyticsStack/`,
instantiated in `bin/infra.ts`. The stack MUST create a single S3 bucket that
receives CloudFront standard access logs for both the landing and releases
distributions. The bucket MUST block all public access, enforce SSL, enable
default encryption, and use a `RETAIN` removal policy. Because legacy CloudFront
standard logging delivers objects via an ACL grant to the log-delivery
canonical user, the bucket MUST have object ownership set so that ACLs are
enabled (`BUCKET_OWNER_PREFERRED`); a bucket with ACLs disabled MUST NOT be used.
The bucket MUST carry a lifecycle rule that expires log objects after a bounded
retention window (default 90 days) to cap storage cost. The bucket name MUST be
published to SSM so other stacks can import it.

#### Scenario: Synthesized log bucket is private, ACL-enabled, and retained

- **WHEN** `cdk synth` runs for `ArgusAnalyticsStack`
- **THEN** the template contains an `AWS::S3::Bucket` with all four public-access
  settings blocked, an ownership control enabling ACLs, a lifecycle rule with an
  expiration, and a `Retain` deletion policy

#### Scenario: Log bucket name is exported for cross-stack import

- **WHEN** the analytics stack is synthesized
- **THEN** an SSM parameter (e.g. `/Argus/analytics/log-bucket-name`) holds the
  log bucket name for `LandingStack` and `ReleasesStack` to import

### Requirement: Glue database and external tables expose the access logs to Athena

The analytics stack MUST create a Glue database and two external tables — one for
the landing log prefix and one for the releases log prefix — describing the
CloudFront standard access-log format (tab-delimited fields, the standard
CloudFront column set, header lines skipped). Each table's location MUST point at
the corresponding prefix in the shared log bucket. The tables MUST be queryable
without any manual `CREATE TABLE` step after deployment.

#### Scenario: Tables resolve over the log prefixes

- **WHEN** the analytics stack is synthesized
- **THEN** the template defines a Glue database and two `AWS::Glue::Table`
  resources whose storage locations are the `landing/` and `releases/` prefixes of
  the log bucket and whose columns match the CloudFront standard-log schema

#### Scenario: Logs are queryable immediately after deploy

- **WHEN** the stack is deployed and CloudFront has delivered at least one log file
- **THEN** an Athena `SELECT` against the landing or releases table returns rows
  without the operator first running DDL

### Requirement: Athena workgroup enforces a results location and a per-query scan cap

The analytics stack MUST create an Athena workgroup configured with an enforced
query results output location (in the log bucket or a dedicated results bucket)
and a per-query bytes-scanned cutoff that bounds the cost of any single query.

#### Scenario: Workgroup pins results location and scan cap

- **WHEN** the analytics stack is synthesized
- **THEN** the template defines an `AWS::Athena::WorkGroup` with
  `EnforceWorkGroupConfiguration` true, an output location set, and a
  `BytesScannedCutoffPerQuery` value

### Requirement: Reporting queries return visits and real downloads

The analytics stack MUST ship two saved (named) Athena queries bound to the
workgroup and Glue database. The **visits** query MUST return landing page visits
grouped by day, counting successful HTML document requests and reporting an
approximate unique-visitor count by distinct client IP. The **downloads** query
MUST return installer downloads grouped by platform (installer key) and manifest
version, counting only successful/partial responses (`200`/`206`) to URIs ending
in a known installer extension (`.dmg`, `.msi`, `.AppImage`).

#### Scenario: Visits-per-day query is available

- **WHEN** the operator opens the analytics workgroup's saved queries in Argus's
  Athena connection
- **THEN** a "visits per day" named query exists that returns a per-day visit
  count and an approximate distinct-IP count from the landing table

#### Scenario: Downloads-by-platform query reflects real file fetches

- **WHEN** the operator runs the "downloads by platform & version" named query
- **THEN** it returns counts grouped by installer key and version, derived from
  releases-log requests to installer files with success/partial status — i.e.
  actual downloads, not landing-page clicks
