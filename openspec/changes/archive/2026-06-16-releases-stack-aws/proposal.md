## Why

The Tauri auto-updater binaries and manifests (`latest.json`, `download.json`)
are hosted on Cloudflare R2 today, but the rest of the project is moving to an
AWS CDK monorepo (`packages/infra`). The infra package currently ships only a
skeleton — `bin/infra.ts` instantiates no stacks. We want release hosting to be
the first real, reproducible stack so artifact hosting stops depending on a
hand-provisioned Cloudflare bucket and long-lived R2 access keys.

## What Changes

- Add a CDK `ArgusReleasesStack` to `packages/infra/lib/ReleasesStack/`:
  - Private S3 bucket for release artifacts (immutable binaries + `no-cache` manifests).
  - CloudFront distribution in front of the bucket via Origin Access Control (OAC),
    encoding the cache policy the workflow applies today (binaries `immutable`,
    `latest.json` / `download.json` not cached).
  - A GitHub Actions **OIDC** IAM role (no stored access keys) scoped to publish
    objects to the bucket and create CloudFront invalidations for the manifests.
  - The public base URL (CloudFront domain) exported via SSM Parameter Store and `CfnOutput`.
- Instantiate `ArgusReleasesStack` in `bin/infra.ts` (remove its TODO).
- Add Jest synth tests for the stack under `packages/infra/test/`.
- **BREAKING (ops):** Migrate the release pipeline off R2:
  - `.github/workflows/release.yml` authenticates to AWS via OIDC role assumption
    and uploads to the S3 bucket (with the same cache-control headers), then
    invalidates the manifest paths on CloudFront — replacing the R2 credentials
    file and `--endpoint-url` S3-compatible calls.
  - `PUBLIC_URL_BASE` for the manifest builders becomes the CloudFront URL.
  - The Tauri updater endpoint in `packages/app/src-tauri/tauri.conf.json`
    (and the beta override) points at the CloudFront `latest.json`.
  - `docs/release-setup.md` documents the AWS bootstrap (account/region, OIDC
    provider, `cdk deploy`, GitHub secrets) instead of the Cloudflare R2 setup,
    including the rollback runbook against S3.

Out of scope (deferred): `LandingStack` (React + Vite landing) and a custom
domain + ACM certificate. This change uses the raw `*.cloudfront.net` domain.

## Capabilities

### New Capabilities
- `release-artifact-hosting`: AWS infrastructure-as-code (CDK) that hosts Tauri
  release artifacts and serves the updater manifests — the S3 bucket, CloudFront
  distribution + cache policy, the GitHub OIDC publish role, and the exported
  public base URL.

### Modified Capabilities
- `release-pipeline`: The CI workflow publishes artifacts and manifests to AWS
  (S3 + CloudFront via OIDC) instead of Cloudflare R2; manifest URLs and the
  updater endpoint resolve to CloudFront; the manual setup doc covers AWS.

## Impact

- **New code:** `packages/infra/lib/ReleasesStack/`, `packages/infra/bin/infra.ts`
  (uncomment/instantiate), `packages/infra/test/`.
- **Modified code/config:** `.github/workflows/release.yml`,
  `packages/app/src-tauri/tauri.conf.json` (+ `tauri.beta.conf.json` if present),
  `docs/release-setup.md`, `.env.release.example`.
- **AWS resources:** S3 bucket, CloudFront distribution + OAC, IAM OIDC provider +
  role, SSM parameter. Requires `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION` and a
  one-time `cdk bootstrap` + `cdk deploy`.
- **GitHub secrets:** Remove `R2_*` secrets; add the OIDC role ARN (and region).
- **Dependencies:** No new app deps; CDK already pinned in `packages/infra`.
- **Migration:** Existing installed apps point at the old R2 `latest.json`. To
  avoid stranding them, the old R2 manifest must keep redirecting/serving until
  every client has updated to a build that embeds the new CloudFront endpoint
  (cutover risk addressed in design.md).
