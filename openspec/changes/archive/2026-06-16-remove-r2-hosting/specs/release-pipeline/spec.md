## MODIFIED Requirements

### Requirement: Release infrastructure is codified, not hand-documented

The bootstrap of release hosting SHALL be reproducible from code rather than a
standalone setup document. `ArgusReleasesStack` MUST be deployable with
`pnpm --filter infra cdk deploy ArgusReleasesStack`, and the resulting resource
identifiers (S3 bucket name, CloudFront distribution id, CloudFront domain,
publish-role ARN) MUST be discoverable at runtime from SSM Parameter Store under
`/Argus/releases/`. Local tooling MUST resolve these from SSM using the loaded
AWS profile and export them as environment variables (via `.envrc`), so neither
`release-local.sh` nor a human needs to hardcode bucket/distribution names. The
rollback procedure MUST rely on S3 object versioning (restore a prior
`latest.json` by copying a previous version forward) plus a CloudFront
invalidation; no separate `docs/release-setup.md` is required.

Release hosting SHALL reference AWS exclusively. `release-local.sh` and the CI
workflow MUST NOT upload to, fetch from, or carry credentials for Cloudflare R2.
The base manifest that `release-local.sh` merges per-platform entries onto MUST
be fetched from the S3 release bucket using the loaded AWS profile, and the
published manifest base URL MUST be `PUBLIC_URL_BASE` (the CloudFront custom
domain) with no R2 fallback.

#### Scenario: Resource names resolve from SSM into the environment

- **WHEN** a developer with the AWS profile loaded enters the repo (direnv evaluates `.envrc`) after `ArgusReleasesStack` has been deployed
- **THEN** `RELEASE_S3_BUCKET`, `RELEASE_CLOUDFRONT_DISTRIBUTION_ID`, and `PUBLIC_URL_BASE` are populated from the `/Argus/releases/` SSM parameters without any hardcoded values

#### Scenario: Local release publishes only to S3 and CloudFront

- **WHEN** `release-local.sh` runs with the resolved `RELEASE_S3_BUCKET` and `PUBLIC_URL_BASE` present
- **THEN** binaries and manifests are uploaded to the S3 bucket (and only that bucket), the base manifest is fetched from S3 to preserve other platforms' entries, the CloudFront manifest paths are invalidated, and the published manifests reference the CloudFront base URL — no R2 upload or fetch occurs

#### Scenario: No R2 credentials are required or referenced

- **WHEN** `release-local.sh` runs in an environment with no `R2_*` variables set
- **THEN** the script completes its upload and manifest-merge steps without error, because no code path reads `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, or `R2_PUBLIC_URL`

#### Scenario: Rollback restores a known good version

- **WHEN** a release breaks the app and a prior `latest.json` object version is copied forward on S3 and CloudFront is invalidated for `/latest.json`
- **THEN** all running team apps detect the "downgrade" on their next 4-hour check, and on the next quit they return to that version
