## Context

Release artifacts (Tauri updater archives, `.dmg`/`.msi`/`.AppImage` installers,
`latest.json`, `download.json`) are served from a Cloudflare R2 public bucket
(`https://pub-a0e9bc730a484bc69ed64b7691cee240.r2.dev`). The release workflow
(`.github/workflows/release.yml`) writes a `~/.aws/credentials` file from R2
secrets and uploads via the S3-compatible API with `--endpoint-url`, applying
`public, max-age=31536000, immutable` to binaries and `no-cache, max-age=0` to
the two manifests.

The monorepo now has `packages/infra` (CDK 2.215.0, ts-node app via `cdk.json`,
`PROJECT_NAME = "Argus"` in `packages/infra/constants.ts`, stack-per-directory
under `lib/`, SSM-getter pattern documented). `bin/infra.ts` has a TODO for
`ReleasesStack` and a TODO for `FrontendStack`. The `NodejsFunctionBuilder` is
not needed here (no Lambdas in this stack).

Decisions already taken with the user: CI auth via **GitHub OIDC role** (no
stored keys); **no custom domain yet** (raw `*.cloudfront.net`); the landing
stack is deferred and will be named **`LandingStack`** when built; scope of this
change is **ReleasesStack only**.

## Goals / Non-Goals

**Goals:**
- A reproducible `ArgusReleasesStack` that provisions S3 + CloudFront (OAC) + a
  GitHub OIDC publish role, with the public base URL exported via SSM + CfnOutput.
- The release workflow publishes to AWS via OIDC with identical cache semantics
  and serves the updater manifest over CloudFront.
- A safe cutover that does not strand already-installed apps still pointing at R2.
- Synth tests guarding the bucket privacy, CloudFront behaviors, and OIDC trust.

**Non-Goals:**
- `LandingStack` / landing React app, custom domain, ACM cert (deferred).
- Re-adding `grantDynamoDb` to `NodejsFunctionBuilder` (no DB stack here).
- Changing the manifest schema, signing, or the build/notarize steps.
- Multi-region or geo-routing of artifacts.

## Decisions

### S3 bucket: private, CloudFront-only, immutable artifacts
- Private bucket (`blockPublicAccess: BLOCK_ALL`, S3-managed encryption,
  `enforceSSL`). Objects are reached only through CloudFront OAC. No bucket
  website hosting (we don't need SPA routing — that's LandingStack's concern).
- `versioned: true` so a bad overwrite of a manifest can be rolled back, and so
  the rollback runbook can restore a prior `latest.json` by copying an old
  version forward.
- `removalPolicy: RETAIN` (artifacts must survive a stack teardown);
  `autoDeleteObjects: false`. **Alternative considered:** DESTROY for easy
  cleanup — rejected, releases are durable history.

### CloudFront with Origin Access Control (OAC), cache policy mirrors today
- Single distribution, S3 origin via **OAC** (not legacy OAI — OAC is the current
  AWS recommendation and supports SSE-KMS if ever needed).
- Default behavior: long-cache, treat as immutable (binaries). A dedicated cache
  behavior for `latest.json` and `download.json` (path patterns) with a
  **no-cache / min TTL 0** policy so manifest updates are visible immediately;
  this replaces the `cache-control` header reliance and means the CI invalidation
  is belt-and-suspenders rather than load-bearing.
- `viewerProtocolPolicy: redirect-to-https`, HTTP/2+3, compression on.
- **Alternative considered:** rely solely on object `Cache-Control` headers (as
  R2 does today) with one default behavior. Rejected: encoding the manifest
  no-cache as a CloudFront behavior is more robust and self-documenting.

### CI auth: GitHub OIDC role (no long-lived keys)
- Reference the account's GitHub OIDC provider
  (`token.actions.githubusercontent.com`). The stack will look it up if it exists
  or create it (decision in Open Questions — default: create if absent, guarded by
  a context flag to avoid duplicate-provider errors across stacks).
- An IAM role with a trust policy restricted to
  `repo:gsulloa/argus:ref:refs/heads/master` (and tags, since the pipeline tags
  releases) and `aud = sts.amazonaws.com`.
- Permissions: `s3:PutObject`/`s3:GetObject`/`s3:ListBucket` on the bucket ARN +
  `/*`, and `cloudfront:CreateInvalidation` on the distribution ARN. Least
  privilege; no delete.
- **Alternative considered:** IAM user + access keys (closest to R2). Rejected by
  the user in favor of OIDC.

### Cross-stack / consumer exposure via SSM + CfnOutput
- Export the CloudFront domain (and bucket name, distribution id, role ARN) as
  SSM parameters under a `/<PROJECT_NAME>/releases/...` namespace and as
  `CfnOutput`s. The workflow reads the role ARN from a GitHub secret (set once
  after first deploy); the manifest builders read the public base URL from the
  `PUBLIC_URL_BASE` env (sourced from the CfnOutput / a secret). SSM keeps the
  pattern consistent with the documented infra convention and lets a future
  `LandingStack` or scripts discover these without hardcoding.

### Workflow rewrite (minimal, surgical)
- Replace "Configure R2 credentials" with `aws-actions/configure-aws-credentials`
  using `role-to-assume` (OIDC) + `permissions: id-token: write`.
- Replace `--endpoint-url ... .r2.cloudflarestorage.com` with plain
  `aws s3 cp` to the S3 bucket; keep the same `--cache-control` values.
- Add a `cloudfront create-invalidation` for `/latest.json` and `/download.json`
  after the manifest upload.
- `PUBLIC_URL_BASE` becomes the CloudFront URL; `MANIFEST_MODE=ci` unchanged.

## Risks / Trade-offs

- [Installed apps pinned to the old R2 `latest.json` would never see new releases
  once CI stops writing to R2] → **Cutover plan:** keep publishing to *both* R2
  and S3 for a transition window (one or two releases), or leave the final R2
  `latest.json` pointing at a build whose embedded endpoint is already the
  CloudFront URL, so the next update check migrates the client. Stop R2 writes
  only after telemetry/logs show clients on the new endpoint. Detailed in
  Migration Plan.
- [OIDC provider may already exist in the account; creating a second fails] →
  Make creation conditional (context flag / lookup); document the one-time check.
- [CloudFront cache serving a stale manifest after a release] → no-cache behavior
  + explicit invalidation; manifest objects also carry `no-cache` headers.
- [Public artifacts are world-readable via CloudFront] → acceptable and required
  (the updater is unauthenticated); integrity is guaranteed by Ed25519 signatures
  in `latest.json`, unchanged by this migration.
- [First deploy needs `cdk bootstrap` + a human to wire the role ARN secret] →
  documented as one-time steps in `docs/release-setup.md`.
- [CloudFront distribution creation/propagation is slow (~minutes)] → one-time
  cost at deploy, not per-release.

## Migration Plan

1. Set `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`; `cdk bootstrap` the account.
2. `pnpm --filter infra cdk deploy ArgusReleasesStack`. Capture CfnOutputs
   (CloudFront domain, role ARN).
3. Add GitHub repo secrets: `AWS_RELEASE_ROLE_ARN`, `AWS_REGION`, and set
   `PUBLIC_URL_BASE`/release-S3 bucket secret to the new values.
4. Transition window: update `release.yml` to upload to S3 **in addition to** R2
   (or run one manual dual-publish) so both endpoints serve the same version.
5. Cut a release whose embedded updater endpoint (`tauri.conf.json`) is the
   CloudFront `latest.json`. Existing clients fetch the *old* R2 `latest.json`,
   update to this build, and thereafter check CloudFront.
6. After clients have migrated (verify via updater logs), remove the R2 upload
   steps, delete `R2_*` secrets, and decommission the R2 bucket.
7. Rollback runbook (replaces the R2 one in `docs/release-setup.md`): restore a
   prior `latest.json` by copying a previous S3 object version forward and
   invalidating `/latest.json` on CloudFront.

## Open Questions

- **OIDC provider:** create-if-absent in this stack, or assume a shared provider
  exists and only create the role? Default chosen: create-if-absent behind a
  context flag; revisit if the account already has the provider.
- **Bucket/secret naming:** exact GitHub secret names for the role ARN and bucket
  (`AWS_RELEASE_ROLE_ARN`, `RELEASE_S3_BUCKET`) — finalize during apply.
- **Dual-publish duration:** how many releases to keep writing to R2 before
  cutover — depends on team update cadence (4-hour check interval).
