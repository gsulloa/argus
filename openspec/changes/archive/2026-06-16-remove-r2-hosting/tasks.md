## 1. Updater endpoint

- [x] 1.1 In `packages/app/src-tauri/tauri.conf.json`, replace the R2 `r2.dev` URL in `plugins.updater.endpoints` with `https://releases.argusdb.app/latest.json`
- [x] 1.2 Confirm no other `r2.dev` or `r2.cloudflarestorage` URL remains in `src-tauri/` config files (`grep -rn r2 src-tauri`)

## 2. release-local.sh — strip R2

- [x] 2.1 Remove the five `require_env R2_*` calls (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL`) from the upload preflight block
- [x] 2.2 Remove the `HAVE_R2_READ` gate and the R2 credential/endpoint export block (`ENDPOINT=...r2.cloudflarestorage.com`, `AWS_ACCESS_KEY_ID/SECRET/REGION/EC2_METADATA_DISABLED` set from R2)
- [x] 2.3 Rewrite `fetch_base` to `aws s3 cp s3://$RELEASE_S3_BUCKET/<key>` using the loaded AWS profile (no `--endpoint-url`); update its dim/green log messages to say S3 instead of R2; preserve the "emit from scratch" soft-fail behavior
- [x] 2.4 Collapse `MANIFEST_URL_BASE="${PUBLIC_URL_BASE:-$R2_PUBLIC_URL}"` to `MANIFEST_URL_BASE="$PUBLIC_URL_BASE"`
- [x] 2.5 Delete the entire R2 upload block (`step "Uploading to R2"` … the `aws s3 cp ... --endpoint-url '$ENDPOINT'` loop and manifest uploads)
- [x] 2.6 Remove the `echo "  R2 bucket   : $R2_BUCKET"` line from the summary output
- [x] 2.7 Update header comments / `--help` text / deprecated-flag message that mention R2 (lines describing "upload to R2", "downloads manifests from R2", "merging with R2", "no upload (R2 + S3)")
- [x] 2.8 Verify: `bash -n release-local.sh` parses and `grep -in r2 release-local.sh` returns nothing

## 3. CI workflow

- [x] 3.1 Remove the `Upload manifests to R2 (transition dual-publish)` step from `.github/workflows/release.yml` (the block with R2 env vars and the two `aws s3 cp --endpoint-url` commands)
- [x] 3.2 Verify no remaining `R2_` secret reference in `.github/workflows/release.yml`

## 4. Env files

- [x] 4.1 Remove the five `R2_*` exports from the workspace root `.envrc`
- [x] 4.2 Remove the five `R2_*` exports from `packages/app/.envrc`
- [x] 4.3 Remove the five `R2_*` exports from the original repo `.envrc` at `/Users/gabrielulloa/dev/freelance/argus/.envrc`
- [x] 4.4 Remove the R2 `TRANSITION` block from `.env.release.example`
- [x] 4.5 Verify each `.envrc` still sources cleanly and exports `RELEASE_S3_BUCKET`, `RELEASE_CLOUDFRONT_DISTRIBUTION_ID`, `PUBLIC_URL_BASE`

## 5. Manifest scripts (cosmetic)

- [x] 5.1 In `packages/app/scripts/build-manifest.mjs`, update the `PUBLIC_URL_BASE` comment example from the `r2.dev` URL to `https://releases.argusdb.app`
- [x] 5.2 In `packages/app/scripts/build-download-manifest.mjs`, make the same comment update

## 6. Documentation

- [x] 6.1 In `README.md`, update the release-setup line to drop "R2 bucket" from the one-time setup list
- [x] 6.2 In `packages/infra/README.md`, change the `ReleasesStack` description from "Migrate Cloudflare R2 … to AWS" to an AWS-only description

## 7. Verification

- [x] 7.1 Repo-wide sweep: `grep -rniE '\bR2\b|r2_|r2\.dev|cloudflarestorage' --include='*.ts' --include='*.tsx' --include='*.sh' --include='*.mjs' --include='*.yml' --include='*.json' --include='*.md' .` (excluding `node_modules`, lockfiles, and `openspec/changes/archive/**`) returns no actionable references
- [x] 7.2 Run `release-local.sh --dry-run` (or `--no-upload`) and confirm it plans an S3-only publish with the CloudFront manifest URL and no R2 mentions
- [x] 7.3 `openspec validate remove-r2-hosting` passes

## 8. Ops follow-up (manual, post-merge — out of code scope)

- [ ] 8.1 After merge and a verified CI release, delete the GitHub Actions R2 secrets (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`)
- [ ] 8.2 Once `r2.dev` manifest traffic drops to zero, decommission the R2 bucket and API token
