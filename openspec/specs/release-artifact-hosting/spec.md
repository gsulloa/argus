# release-artifact-hosting Specification

## Purpose
TBD - created by syncing change releases-stack-aws. Update Purpose after sync.
## Requirements
### Requirement: ReleasesStack provisions a private S3 bucket for release artifacts

The `packages/infra` CDK app SHALL define a stack named
`${PROJECT_NAME}ReleasesStack` (`ArgusReleasesStack`) under
`lib/ReleasesStack/`, instantiated in `bin/infra.ts`. The stack MUST create an
S3 bucket that holds Tauri release artifacts (updater archives, installers) and
the manifests `latest.json` and `download.json`. The bucket MUST block all
public access, enforce SSL, enable default encryption, enable versioning, and use
a `RETAIN` removal policy so artifacts survive a stack teardown. The bucket MUST
NOT be directly internet-readable; access is only via CloudFront.

#### Scenario: Synthesized bucket is private and retained

- **WHEN** `cdk synth` runs for `ArgusReleasesStack`
- **THEN** the template contains an `AWS::S3::Bucket` with PublicAccessBlock
  blocking all four public-access settings, versioning enabled, and a `Retain`
  deletion policy

#### Scenario: Direct S3 access is denied

- **WHEN** an unauthenticated client requests an object via the S3 REST endpoint
- **THEN** the request is denied because public access is blocked and no public
  bucket policy is attached

### Requirement: CloudFront serves artifacts via OAC with manifest-aware caching

The stack MUST place a CloudFront distribution in front of the S3 bucket using
Origin Access Control (OAC) so only CloudFront can read the bucket. The default
cache behavior MUST treat artifacts as long-lived/immutable. A dedicated cache
behavior MUST apply to the manifest paths `latest.json` and `download.json` such
that they are effectively not cached (min/default TTL 0), so a newly published
manifest is served immediately. The viewer protocol policy MUST redirect HTTP to
HTTPS.

#### Scenario: Distribution uses OAC over the S3 origin

- **WHEN** `cdk synth` runs for `ArgusReleasesStack`
- **THEN** the template contains an `AWS::CloudFront::Distribution` whose S3
  origin is associated with an `AWS::CloudFront::OriginAccessControl`, and the
  bucket policy grants `s3:GetObject` only to that distribution

#### Scenario: Manifests bypass the cache

- **WHEN** a new `latest.json` is uploaded and fetched through CloudFront
- **THEN** the response reflects the latest content (the manifest behavior does
  not serve a stale cached copy)

#### Scenario: Binaries are cached long-term

- **WHEN** a versioned binary artifact is fetched through CloudFront
- **THEN** the default behavior allows long-lived caching of that immutable object

### Requirement: GitHub Actions publishes via an OIDC-assumed IAM role

The stack MUST create an IAM role assumable by GitHub Actions through the
`token.actions.githubusercontent.com` OIDC provider, with NO long-lived access
keys. The trust policy MUST restrict the subject to the `gsulloa/argus`
repository (the release branch/tags) and audience `sts.amazonaws.com`. The role's
permissions MUST be least-privilege: write/read objects in the release bucket and
create CloudFront invalidations for the distribution; it MUST NOT grant delete or
account-wide access.

#### Scenario: Role trusts only the release repository via OIDC

- **WHEN** `cdk synth` runs for `ArgusReleasesStack`
- **THEN** the template contains an `AWS::IAM::Role` whose
  `AssumeRolePolicyDocument` uses the GitHub OIDC provider, conditions on the
  `gsulloa/argus` repo subject, and sets the `sts.amazonaws.com` audience

#### Scenario: Role can publish and invalidate but not delete

- **WHEN** the role's inline/managed policy is inspected
- **THEN** it allows `s3:PutObject`, `s3:GetObject`, and `s3:ListBucket` on the
  bucket and `cloudfront:CreateInvalidation` on the distribution, and does NOT
  allow `s3:DeleteObject` or wildcard resource administration

### Requirement: Public base URL and identifiers are exported

The stack MUST expose the CloudFront public domain, the bucket name, the
distribution id, and the publish role ARN as `CfnOutput`s and as SSM Parameter
Store parameters under a `/${PROJECT_NAME}/releases/` namespace, so the release
pipeline and future consumers can discover them without hardcoding. The
**canonical custom base URL `https://releases.argusdb.app`** is owned and
exported by `ArgusDnsStack` at `/${PROJECT_NAME}/DnsStack/releases-public-url`
(not under `/releases/`), and is the value consumed by the release pipeline
(`PUBLIC_URL_BASE`) and the Tauri updater endpoint.

#### Scenario: Outputs are present after synth

- **WHEN** `cdk synth` runs for `ArgusReleasesStack`
- **THEN** the template includes `CfnOutput`s for the CloudFront domain and the
  publish role ARN, and `AWS::SSM::Parameter` resources under `/Argus/releases/`
  for the bucket name, distribution id, CloudFront domain, and publish role ARN

### Requirement: Artifacts are served over a custom release domain

The `ArgusReleasesStack` MUST serve release artifacts and manifests over the
custom subdomain `releases.argusdb.app`, in addition to the raw CloudFront
hostname (the alias is additive — the raw hostname keeps working). The stack
MUST obtain the wildcard ACM certificate and the hosted zone from
`ArgusDnsStack` (via `DnsStack.getCertificate(this)` and
`DnsStack.getHostedZone(this)`) — it MUST NOT create its own certificate or
hosted zone. The CloudFront distribution MUST declare `releases.argusdb.app` in
its `domainNames` and use that wildcard certificate as its viewer certificate.
The stack MUST create a Route53 alias record set (A and AAAA)
`releases.argusdb.app` → the CloudFront distribution in the imported hosted
zone. `ArgusReleasesStack` MUST declare an explicit dependency on
`ArgusDnsStack`.

#### Scenario: Distribution carries the custom alias and imported certificate

- **WHEN** `cdk synth` runs for `ArgusReleasesStack`
- **THEN** the `AWS::CloudFront::Distribution` lists `releases.argusdb.app` in
  its `Aliases` and its `ViewerCertificate` references the wildcard ACM
  certificate ARN imported from `ArgusDnsStack` (the stack synthesizes no
  `AWS::CertificateManager::Certificate` of its own)

#### Scenario: Route53 alias points the subdomain at CloudFront

- **WHEN** `cdk synth` runs for `ArgusReleasesStack`
- **THEN** the template contains `AWS::Route53::RecordSet` alias records (A and
  AAAA) named `releases.argusdb.app` targeting the CloudFront distribution

#### Scenario: Subdomain serves the manifest over HTTPS

- **WHEN** a client requests `https://releases.argusdb.app/latest.json` after
  deployment
- **THEN** CloudFront serves the manifest with a valid certificate for
  `releases.argusdb.app` and the same no-cache behavior as the raw hostname

### Requirement: Stack has synth tests

The repository MUST include Jest tests under `packages/infra/test/` that
synthesize `ArgusReleasesStack` and assert the bucket privacy, the CloudFront
OAC behavior set, the OIDC role trust/permissions, and the presence of the
exported outputs. `pnpm --filter infra cdk synth` MUST succeed with the stack
instantiated.

#### Scenario: Tests assert security-critical properties

- **WHEN** `pnpm --filter infra test` runs
- **THEN** assertions confirm public access is blocked, the OIDC role is scoped
  to the repo, and the manifest cache behavior exists, and all tests pass

### Requirement: Manifests serve CORS headers for the landing origin

The manifest cache behaviors MUST serve CORS headers permitting cross-origin reads from the landing origins. Concretely, the CloudFront cache behaviors for the manifest paths `download.json` and `latest.json` MUST attach a response-headers policy that returns CORS headers for the landing origins (`https://argusdb.app` and `https://www.argusdb.app`). The policy MUST allow the `GET` and `HEAD` methods and MUST NOT allow credentials. This enables the landing page, served from the apex domain, to fetch the manifest from `releases.argusdb.app` at runtime. The existing OAC origin protection and manifest-aware (no-cache) behavior for these paths MUST remain unchanged.

#### Scenario: Manifest response includes CORS headers for the landing origin

- **WHEN** a browser on `https://argusdb.app` fetches
  `https://releases.argusdb.app/download.json`
- **THEN** the response includes `Access-Control-Allow-Origin` for the landing
  origin and the fetch succeeds without a CORS error

#### Scenario: CORS policy is applied only to manifest behaviors

- **WHEN** `cdk synth` runs for `ArgusReleasesStack`
- **THEN** the `download.json` and `latest.json` cache behaviors reference a
  `ResponseHeadersPolicy` with a CORS config allowing `GET`/`HEAD` from the
  landing origins, while the default binary behavior does not

#### Scenario: Existing origin protection is preserved

- **WHEN** the CORS policy is added
- **THEN** the manifests are still served only via CloudFront OAC and still
  bypass the cache, with no change to the binary caching behavior

### Requirement: Releases distribution emits CloudFront standard access logs

The `ReleasesStack` CloudFront distribution MUST have standard access logging
enabled, delivering logs to the shared analytics log bucket (imported by name
from SSM) under the `releases/` prefix, so that real installer downloads (the
file GET) are recorded. The stack MUST depend on `AnalyticsStack` so the log
bucket exists before logging is enabled. Enabling logging MUST NOT change the
existing OAC origin access, the manifest caching behaviors, or the GitHub OIDC
publish role.

#### Scenario: Distribution is configured for standard logging

- **WHEN** `cdk synth` runs for `ArgusReleasesStack`
- **THEN** the `AWS::CloudFront::Distribution` has logging enabled with the bucket
  set to the imported analytics log bucket and a `releases/` log file prefix

#### Scenario: Existing artifact-serving behavior is unchanged

- **WHEN** the stack is synthesized with logging enabled
- **THEN** the OAC S3 origin, the no-cache `latest.json` / `download.json`
  behaviors, and the publish role policy remain as previously specified

