## Why

The repo is moving to a `dev` + `master` flow with a tag-driven release pipeline, but **no PR checks exist today** — the only workflow is `release.yml`, which runs on tag push. Because nothing validates a PR, `release.sh` merges its release PR to `master` immediately (`gh pr merge --merge`), making the "review gate" cosmetic and letting broken code reach the protected `master` line. A real PR check (typecheck + lint + test) catches breakage before it lands, protects `dev` from red integrations, and lets the release script wait for green instead of merging blind.

## What Changes

- Add a new `.github/workflows/ci.yml` triggered on `pull_request` targeting `dev` and `master`.
- The workflow sets up pnpm + Node (matching `release.yml`: pnpm 10.33.0, Node 22), runs `pnpm install --frozen-lockfile`, then runs `pnpm typecheck`, `pnpm lint`, and `pnpm test:run`.
- Update `packages/app/scripts/release.sh` so the release PR waits for the CI checks to pass before merging: poll until checks register, `gh pr checks --watch --fail-fast`, then a synchronous `gh pr merge --merge`. (NOT `gh pr merge --auto` — that returns before the merge happens and would break the script's downstream resolve-SHA → tag → back-merge steps.) On a failed check the script aborts, leaving the PR open and pushing no tag.
- Document (in the design) that adding the new CI job to `master` branch-protection required status checks is recommended defense-in-depth (so humans can't merge red either) but is NOT required for the script to gate — configuring branch protection is a one-time manual GitHub setting, out of code scope.

## Capabilities

### New Capabilities
- `ci-pr-validation`: A GitHub Actions workflow that validates every pull request to `dev` and `master` by running typecheck, lint, and tests; and a release script that waits on those green checks before merging to `master`.

### Modified Capabilities
<!-- No existing spec requirement changes. The release.sh merge tweak is folded into the new ci-pr-validation capability since no current spec governs release.sh's merge command. -->

## Impact

- **New file**: `.github/workflows/ci.yml`.
- **Modified file**: `packages/app/scripts/release.sh` (merge step → `--auto --merge`).
- **Scripts relied on** (already in root `package.json`): `typecheck`, `lint`, `test:run` — all delegate to `pnpm --filter argus …`.
- **Manual follow-up** (not code): add the CI job as a required status check in `master` (and optionally `dev`) branch protection so the gate is enforced.
- **No app/runtime code changes**; this is CI/infra only and carries no risk to the shipped product.
