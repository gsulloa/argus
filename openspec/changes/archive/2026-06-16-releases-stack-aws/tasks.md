## 1. ReleasesStack — S3 + CloudFront

- [x] 1.1 Create `packages/infra/lib/ReleasesStack/index.ts` exporting an `ArgusReleasesStack` (extends `cdk.Stack`)
- [x] 1.2 Add a private S3 bucket: `blockPublicAccess: BLOCK_ALL`, `enforceSSL: true`, S3-managed encryption, `versioned: true`, `removalPolicy: RETAIN`, `autoDeleteObjects: false`
- [x] 1.3 Create a CloudFront distribution with the S3 bucket as origin via Origin Access Control (OAC); set `viewerProtocolPolicy: redirect-to-https`, HTTP/2+3, compression
- [x] 1.4 Default cache behavior = long-lived/immutable caching (binaries)
- [x] 1.5 Add a dedicated cache behavior for path patterns `latest.json` and `download.json` with min/default TTL 0 (no-cache)
- [x] 1.6 Confirm the generated bucket policy grants `s3:GetObject` only to the distribution (OAC), not public

## 2. ReleasesStack — CI OIDC publish role

- [x] 2.1 Reference or create the GitHub OIDC provider (`token.actions.githubusercontent.com`), guarded against duplicate creation if it already exists in the account
- [x] 2.2 Create an IAM role with a trust policy restricted to `repo:gsulloa/argus` (release branch + tags) and audience `sts.amazonaws.com`
- [x] 2.3 Grant least-privilege policy: `s3:PutObject`/`s3:GetObject`/`s3:ListBucket` on the bucket (+ `/*`) and `cloudfront:CreateInvalidation` on the distribution; no delete, no wildcard admin

## 3. ReleasesStack — outputs

- [x] 3.1 Add `CfnOutput`s for the CloudFront domain, bucket name, distribution id, and publish role ARN
- [x] 3.2 Write SSM parameters under `/Argus/releases/` (cloudfront-domain, bucket-name, distribution-id, publish-role-arn)

## 4. Wire into the CDK app

- [x] 4.1 Instantiate `ArgusReleasesStack` in `packages/infra/bin/infra.ts` with `${PROJECT_NAME}ReleasesStack` and `baseProps`; remove the ReleasesStack TODO and the `void` references it guarded
- [x] 4.2 `pnpm --filter infra build` (tsc) and `pnpm --filter infra cdk synth` succeed with the stack instantiated

## 5. Tests

- [x] 5.1 Replace the placeholder test with `packages/infra/test/ReleasesStack.test.ts` using `aws-cdk-lib/assertions` `Template`
- [x] 5.2 Assert: bucket blocks all public access, versioning enabled, `Retain` deletion policy
- [x] 5.3 Assert: CloudFront distribution exists with OAC and a manifest (no-cache) cache behavior
- [x] 5.4 Assert: IAM role trust uses the GitHub OIDC provider scoped to `gsulloa/argus` and the policy grants put/get/list + `CreateInvalidation` but not delete
- [x] 5.5 Assert: CfnOutputs and SSM parameters for the public domain and role ARN exist
- [x] 5.6 `pnpm --filter infra test` passes

## 6. Deploy and capture outputs (one-time, manual) — BLOCKED: requires AWS account access

- [ ] 6.1 Set `CDK_DEFAULT_ACCOUNT`/`CDK_DEFAULT_REGION`; run `cdk bootstrap` for the target account
- [ ] 6.2 `pnpm --filter infra cdk deploy ArgusReleasesStack`; record the CloudFront domain and publish role ARN
- [ ] 6.3 Add GitHub repo secrets: `AWS_RELEASE_ROLE_ARN`, `AWS_REGION`, `RELEASE_S3_BUCKET`, and set `PUBLIC_URL_BASE` to the CloudFront URL

## 7. Migrate the release workflow

- [x] 7.1 Add `permissions: id-token: write` and replace the "Configure R2 credentials" step with `aws-actions/configure-aws-credentials` using `role-to-assume: ${{ secrets.AWS_RELEASE_ROLE_ARN }}`
- [x] 7.2 Replace the R2 `--endpoint-url ...r2.cloudflarestorage.com` uploads with plain `aws s3 cp` to the release bucket, keeping the same `--cache-control` values for binaries and manifests
- [x] 7.3 Add a `aws cloudfront create-invalidation` step for `/latest.json` and `/download.json` after the manifest upload
- [x] 7.4 Point `PUBLIC_URL_BASE` for `build-manifest.mjs` / `build-download-manifest.mjs` at the CloudFront URL
- [x] 7.5 During the transition window, dual-publish to R2 and S3 (or document the manual dual-publish) so both endpoints serve the same version

## 8. Update app + docs + cutover

- [ ] 8.1 Update `plugins.updater.endpoints` in `packages/app/src-tauri/tauri.conf.json` (and `tauri.beta.conf.json` if present) to the CloudFront `latest.json` URL — BLOCKED: needs the real CloudFront domain (only known after task 6.2 deploy)
- [x] 8.2 Update `.env.release.example` (replace `R2_*` with AWS equivalents)
- [x] 8.3 ~~Rewrite `docs/release-setup.md`~~ — REVERSED per user: doc deleted. Setup is codified instead: `cdk deploy` + `.envrc` resolving `/Argus/releases/*` SSM params via the loaded AWS profile, and rollback via S3 versioning + CloudFront invalidation.
- [x] 8.6 Make `release-local.sh` dual-publish to R2 (Cloudflare) **and** S3 + CloudFront (manifests reference CloudFront base; invalidate `/latest.json` + `/download.json`; S3 ops use the AWS profile, not R2 creds)
- [x] 8.7 Resolve `RELEASE_S3_BUCKET` / `RELEASE_CLOUDFRONT_DISTRIBUTION_ID` / `PUBLIC_URL_BASE` / `AWS_RELEASE_ROLE_ARN` from SSM in both `.envrc` (root) and `packages/app/.envrc` using the loaded AWS profile
- [ ] 8.4 Cut a release whose embedded endpoint is CloudFront; verify via updater logs that clients migrate off the old R2 manifest — BLOCKED: requires deploy + a live release
- [ ] 8.5 After clients have migrated, remove the R2 upload steps, delete `R2_*` secrets, and decommission the R2 bucket — BLOCKED: post-cutover ops follow-up
