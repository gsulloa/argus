# release-pipeline Specification

## Purpose
TBD - created by archiving change ship-beta-auto-update. Update Purpose after archive.
## Requirements
### Requirement: Beta build configuration is separate from production

The repository SHALL maintain two Tauri configuration files: `src-tauri/tauri.conf.json` (the future production config, unchanged) and `src-tauri/tauri.beta.conf.json` (the beta override file). Beta builds MUST be produced exclusively by invoking `tauri build --config tauri.beta.conf.json`. The beta config MUST override `productName` to `"Argus Beta"`, `identifier` to `"com.argus.beta.app"`, `bundle.icon` paths to `src-tauri/icons-beta/*`, and `plugins.updater.endpoints` to the CloudFront manifest URL served by `ArgusReleasesStack` (the `latest.json` object behind the distribution domain).

#### Scenario: Default build produces production config

- **WHEN** a developer runs `pnpm tauri:build` locally with no extra flags
- **THEN** the resulting bundle has identifier `com.argus.app` and productName `Argus`

#### Scenario: Beta build produces beta config

- **WHEN** the CI workflow runs `pnpm tauri build --config src-tauri/tauri.beta.conf.json`
- **THEN** the resulting bundle has identifier `com.argus.beta.app`, productName `Argus Beta`, the orange-tinted icon set, and an embedded updater pubkey + CloudFront endpoint

#### Scenario: Beta and production apps coexist on disk

- **WHEN** a user has both `Argus.app` (prod) and `Argus Beta.app` installed
- **THEN** they appear as distinct entries in the dock and Applications folder, store data under separate `app_data_dir` paths derived from their respective identifiers, and update independently

### Requirement: CI workflow builds, signs, and publishes on every merge to master

The repository SHALL include a GitHub Actions workflow that triggers on `push` to `master`. The workflow MUST execute the following steps in order, failing fast on any error:

1. Bump the patch version across `tauri.conf.json`, `tauri.beta.conf.json`, `package.json`, and `src-tauri/Cargo.toml` to the next patch number.
2. Commit the bump with message starting with `chore: bump version to v` and `[skip ci]` to prevent recursion, then push and tag.
3. Build a matrix of two macOS targets: `aarch64-apple-darwin` (on `macos-latest`) and `x86_64-apple-darwin` (on `macos-13` or `macos-latest` with explicit target).
4. Code-sign each bundle with the `Developer ID Application` certificate loaded from `APPLE_CERTIFICATE` (base64) using `APPLE_CERTIFICATE_PASSWORD`.
5. Submit each bundle to Apple notarization via `notarytool` using `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`. Staple the ticket on success.
6. Sign each bundle archive (`.app.tar.gz`) with the Ed25519 updater private key loaded from `TAURI_UPDATER_PRIVATE_KEY` and `TAURI_UPDATER_KEY_PASSWORD`, producing `.sig` files.
7. Authenticate to AWS by assuming the `ArgusReleasesStack` GitHub OIDC publish role (via `role-to-assume` with `id-token: write` permission — no long-lived access keys), then upload all artifacts (`.dmg`, `.app.tar.gz`, `.sig`) plus the generated `latest.json` and `download.json` to the release S3 bucket with the same cache-control semantics (binaries `public, max-age=31536000, immutable`; manifests `no-cache, max-age=0`), and create a CloudFront invalidation for `/latest.json` and `/download.json`.

#### Scenario: Successful merge produces a new beta release

- **WHEN** a PR merges to `master` and the workflow completes without errors
- **THEN** the release S3 bucket contains `latest.json` pointing to the new version (served via CloudFront), both architecture archives with valid `.sig` files, and `.dmg` installers for new team members

#### Scenario: Bump step is idempotent against its own commit

- **WHEN** the workflow's bump commit triggers another `push: master` event
- **THEN** the bump step detects that the head commit already starts with `chore: bump version to v` and exits early without bumping again or starting a build

#### Scenario: Notarization transient failure retries

- **WHEN** `notarytool submit` fails with a transient network or Apple-server error
- **THEN** the step retries up to 3 times with backoff before failing the workflow

#### Scenario: CI authenticates without stored AWS keys

- **WHEN** the publish step runs
- **THEN** it obtains temporary credentials by assuming the OIDC role scoped to `gsulloa/argus`, and no AWS access-key secrets are written to disk or used

#### Scenario: Build failure leaves previous release intact

- **WHEN** any step (build, sign, notarize, upload) fails
- **THEN** CloudFront still serves the previous `latest.json` and the team's installed apps continue to receive that previous version on their next update check

### Requirement: Manifest is signed and contains per-architecture entries

The `latest.json` published to the release S3 bucket (served via CloudFront) MUST follow the Tauri v2 updater manifest schema with one `platforms` entry per supported architecture (at minimum `darwin-aarch64` and `darwin-x86_64`). Each entry MUST contain a `signature` field generated by the Ed25519 updater key over the corresponding `.app.tar.gz` content, the `url` of that archive on the CloudFront distribution, and the `version` field at the top level MUST match the tag without the leading `v`.

#### Scenario: Manifest validates against installed app pubkey

- **WHEN** the installed app (which embeds the public Ed25519 key) fetches `latest.json` and a target archive from CloudFront
- **THEN** the signature in the manifest validates against the archive bytes using the embedded public key, and the update proceeds

#### Scenario: Tampered archive is rejected

- **WHEN** the archive at the URL has been modified after publication and the signature in `latest.json` no longer matches
- **THEN** the updater plugin refuses to apply the update and surfaces an error in the app log

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

#### Scenario: Resource names resolve from SSM into the environment

- **WHEN** a developer with the AWS profile loaded enters the repo (direnv evaluates `.envrc`) after `ArgusReleasesStack` has been deployed
- **THEN** `RELEASE_S3_BUCKET`, `RELEASE_CLOUDFRONT_DISTRIBUTION_ID`, and `PUBLIC_URL_BASE` are populated from the `/Argus/releases/` SSM parameters without any hardcoded values

#### Scenario: Local release dual-publishes to R2 and S3

- **WHEN** `release-local.sh` runs with both R2 secrets and the resolved `RELEASE_S3_BUCKET` present
- **THEN** binaries and manifests are uploaded to both R2 (Cloudflare) and the S3 bucket, the CloudFront manifest paths are invalidated, and the published manifests reference the CloudFront base URL

#### Scenario: Rollback restores a known good version

- **WHEN** a release breaks the app and a prior `latest.json` object version is copied forward on S3 and CloudFront is invalidated for `/latest.json`
- **THEN** all running team apps detect the "downgrade" on their next 4-hour check, and on the next quit they return to that version

### Requirement: Beta has a dedicated icon variant

The repository SHALL contain `src-tauri/icons-beta/` with a complete icon set (32x32.png, 128x128.png, 128x128@2x.png, icon.icns, icon.ico) that is visually distinct from the production icons, using an orange tint or badge so that team members can identify Argus Beta at a glance in the macOS dock and Applications folder. The icon dimensions MUST match `src-tauri/icons/` exactly so beta and prod can swap configurations without resolution drift.

#### Scenario: Beta icon is recognizable in the dock

- **WHEN** a user has both Argus and Argus Beta open
- **THEN** the dock icons are visually distinguishable without zooming in (different color signal)

#### Scenario: Icon dimensions match production

- **WHEN** the `icons-beta/` set is inspected
- **THEN** every file has the same pixel dimensions as its `icons/` counterpart

