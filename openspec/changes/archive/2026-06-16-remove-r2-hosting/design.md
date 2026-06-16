## Context

Release hosting was migrated from Cloudflare R2 to AWS (S3 bucket + CloudFront distribution served at `releases.argusdb.app`) in the archived `releases-stack-aws` change. That migration deliberately left R2 in place as a *dual-publish* safety net so already-installed clients — whose embedded updater endpoint still pointed at the R2 `r2.dev` manifest — would keep receiving updates while they organically migrated to CloudFront on their next build/install.

Current state:
- **CI (`release.yml`)** already authenticates via the GitHub OIDC publish role, uploads to S3, and invalidates CloudFront. It *also* runs an explicitly-labeled `TRANSITION` step that re-uploads the two manifests to R2.
- **`release-local.sh`** uploads to both R2 and S3, fetches the base manifest from R2 (to merge per-platform entries), and falls back to `R2_PUBLIC_URL` when `PUBLIC_URL_BASE` is unset.
- **`tauri.conf.json`** (production updater config) still embeds the R2 `r2.dev` endpoint. (The beta config already uses CloudFront.)
- **`.envrc` / `.env.release.example`** still carry R2 credentials, marked transitional.
- The migration's own tracking task (`releases-stack-aws` task 8.5) names "remove the dual-publish after cutover" as the trigger for this work.

The AWS infrastructure is fully provisioned and proven; this change is a *removal*, not a build-out.

## Goals / Non-Goals

**Goals:**
- Make every release/update code path reference AWS (S3 + CloudFront) exclusively.
- Point the production updater endpoint at `https://releases.argusdb.app/latest.json`.
- Delete R2 credentials, env vars, upload steps, and fallbacks from code, CI, and local env files.
- Keep `release-local.sh`'s base-manifest merge behavior intact, sourced from S3 instead of R2.

**Non-Goals:**
- Creating or modifying any AWS resource (bucket, distribution, OIDC role, SSM params already exist).
- Deprovisioning the R2 bucket/account itself (a manual ops follow-up, noted but out of scope for code).
- Changing the manifest schema, signing, or cache-control semantics.

## Decisions

### 1. Repoint the production updater endpoint rather than leave it dangling
`tauri.conf.json` currently lists the R2 `r2.dev` URL in `plugins.updater.endpoints`. Change it to `https://releases.argusdb.app/latest.json` (matching the beta config). Newly-built apps then check CloudFront directly.
- **Alternative considered:** leave the endpoint and only kill R2 hosting. Rejected — that silently breaks update checks for every freshly-built client and contradicts "reference only AWS."

### 2. Base-manifest fetch reads from the S3 bucket using the AWS profile
`release-local.sh` merges this build's platform entries onto a base manifest so single-platform local releases don't clobber other platforms. Today that base is fetched from R2 via `--endpoint-url`. Rewrite `fetch_base` to `aws s3 cp s3://$RELEASE_S3_BUCKET/<key>` using the loaded AWS profile (the same mechanism `S3_AWS` already uses for upload). Drop the `HAVE_R2_READ` gate and the R2-specific `AWS_ACCESS_KEY_ID/SECRET/REGION/ENDPOINT` exports — those existed only to point the AWS CLI at R2.
- **Alternative considered:** read the base from the public CloudFront URL with `curl`. Rejected — S3 read via the already-authenticated profile is simpler, avoids cache-staleness, and keeps a single auth path.

### 3. `PUBLIC_URL_BASE` becomes required, fallback removed
`MANIFEST_URL_BASE="${PUBLIC_URL_BASE:-$R2_PUBLIC_URL}"` collapses to `MANIFEST_URL_BASE="$PUBLIC_URL_BASE"`. `.envrc` already resolves `PUBLIC_URL_BASE=https://releases.argusdb.app`. No new `require_env` is strictly needed since `.envrc` guarantees it, but the R2 fallback must go.

### 4. Remove R2 secrets from all three `.envrc` copies and the example file
The R2 exports exist in the workspace root `.envrc`, `packages/app/.envrc`, and the original repo `~/dev/freelance/argus/.envrc`. All three lose the five `R2_*` exports. `.env.release.example` loses its `TRANSITION` R2 block. Comments/examples in `build-manifest.mjs` / `build-download-manifest.mjs` that show an `r2.dev` sample URL switch to the CloudFront domain (cosmetic, but keeps docs honest).

### 5. CI loses only the transition step
`release.yml` already does the AWS publish correctly. The change deletes the single `Upload manifests to R2 (transition dual-publish)` step. The R2 GitHub secrets become unused; deprovisioning them is an ops note, not a code change.

## Risks / Trade-offs

- **[Clients still pointed at R2 stop updating once R2 is decommissioned]** → The dual-publish has been live since the AWS cutover, so active clients have already pulled a CloudFront-pointing manifest or been rebuilt. Risk is limited to long-dormant installs; acceptable and inherent to retiring the old host. Decommissioning the R2 bucket is intentionally left as a *later* manual step so this code change is reversible by re-deploying without touching infra.
- **[`release-local.sh` base-manifest fetch needs S3 read permission]** → The local AWS profile (`Argus`) is an admin/dev profile with S3 read; verified working when fetching SSM. Low risk. If a future least-privilege profile lacks `s3:GetObject`, the fetch fails soft (emits manifest from scratch) exactly as the R2 path did.
- **[Stale R2 secrets left in GitHub]** → Not a functional risk but a hygiene one; captured as a post-merge ops task.

## Migration Plan

1. Land code/CI/spec changes (this change).
2. Verify the next CI release publishes to S3 + CloudFront only and a freshly-built app updates from `releases.argusdb.app`.
3. **Ops follow-up (out of band):** delete the four R2 GitHub Actions secrets, then decommission the R2 bucket/API token once metrics show no traffic to the `r2.dev` manifest.

**Rollback:** revert the commit. R2 infra is untouched by this change, so re-adding the dual-publish step and endpoint restores the prior behavior immediately.

## Open Questions

- None blocking. The R2 bucket teardown timing is an ops judgment call (watch `r2.dev` manifest request volume), deliberately decoupled from this code change.
