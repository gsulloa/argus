## ADDED Requirements

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
pipeline and future consumers can discover them without hardcoding.

#### Scenario: Outputs are present after synth

- **WHEN** `cdk synth` runs for `ArgusReleasesStack`
- **THEN** the template includes `CfnOutput`s for the CloudFront domain and the
  publish role ARN, and `AWS::SSM::Parameter` resources under
  `/Argus/releases/`

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
