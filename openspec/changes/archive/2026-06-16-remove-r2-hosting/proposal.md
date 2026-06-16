## Why

The migration from Cloudflare R2 to AWS (S3 + CloudFront at `releases.argusdb.app`) is complete and live: CI authenticates via the GitHub OIDC publish role, uploads to the S3 bucket, and invalidates CloudFront. R2 now survives only as transition scaffolding — a dual-publish step in CI, a fallback in `release-local.sh`, plaintext R2 secrets in `.envrc`, and an R2 `r2.dev` endpoint still embedded in the production updater config. Keeping it means installed clients can still be pointed at R2, secrets sit unused on disk, and the codebase lies about where releases live. Now that the cutover is proven, R2 should be removed entirely.

## What Changes

- **BREAKING (updater):** Repoint the production updater endpoint in `src-tauri/tauri.conf.json` from the R2 `r2.dev` URL to `https://releases.argusdb.app/latest.json`. Clients still checking the R2 manifest stop receiving updates once R2 is decommissioned — acceptable because the dual-publish migration has already moved active clients to CloudFront.
- Remove the R2 dual-publish transition step from `.github/workflows/release.yml`.
- Strip all R2 logic from `release-local.sh`: drop the `R2_*` `require_env` checks, the R2 credential/endpoint export block, the R2 upload block, and the `R2_PUBLIC_URL` manifest-base fallback. Rewrite the base-manifest fetch to read from the S3 bucket (`RELEASE_S3_BUCKET`) using the AWS profile, and remove the R2 line from the summary output.
- Remove the R2 `TRANSITION` block from `.env.release.example` and the five `R2_*` exports from `.envrc` (root, `packages/app`, and the original repo copy).
- Update R2-flavored comments/examples in `build-manifest.mjs` and `build-download-manifest.mjs` to the CloudFront base.
- Update documentation: `README.md` setup line, `packages/infra/README.md` `ReleasesStack` description.
- Update specs: replace the R2/S3 dual-publish scenario in `release-pipeline` with an S3-only scenario, and degeneralize the "5xx from R2" wording in `app-updater`.

## Capabilities

### New Capabilities
<!-- None — this change removes infrastructure, it does not introduce capabilities. -->

### Modified Capabilities
- `release-pipeline`: The local release now publishes only to S3 + CloudFront; the R2/S3 dual-publish requirement is removed.
- `app-updater`: Download-failure wording no longer names R2 as the storage backend (generic updater endpoint).

## Impact

- **Code:** `packages/app/scripts/release-local.sh`, `packages/app/scripts/build-manifest.mjs`, `packages/app/scripts/build-download-manifest.mjs`, `packages/app/src-tauri/tauri.conf.json`, `.github/workflows/release.yml`, `.env.release.example`, `.envrc` (3 copies).
- **Docs:** `README.md`, `packages/infra/README.md`.
- **Specs:** `openspec/specs/release-pipeline/spec.md`, `openspec/specs/app-updater/spec.md`.
- **Secrets/CI:** R2 GitHub Actions secrets (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`) and the R2 bucket/credentials become unused and can be deprovisioned after merge.
- **No new AWS resources** — the S3 bucket, CloudFront distribution, OIDC role, and SSM parameters already exist and are unchanged.
