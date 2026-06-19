## ADDED Requirements

### Requirement: PR validation workflow runs typecheck, lint, and tests on PRs to dev and master

The repository SHALL include a GitHub Actions workflow at `.github/workflows/ci.yml` triggered on `pull_request` events targeting the `dev` and `master` branches. The workflow MUST run on `ubuntu-latest` and execute these steps in order, failing the job on the first non-zero exit:

1. Check out the PR head.
2. Set up pnpm via `pnpm/action-setup` (the workflow MUST NOT pin a pnpm version inline; the version is resolved from the root `package.json` `packageManager` field, currently `pnpm@10.33.0`).
3. Set up Node 22 via `actions/setup-node` with `cache: pnpm` (matching `release.yml`).
4. Install dependencies with `pnpm install --frozen-lockfile`.
5. Run `pnpm typecheck`.
6. Run `pnpm lint`.
7. Run `pnpm test:run`.

The workflow MUST NOT build Rust/Tauri artifacts, sign, notarize, or publish anything — it validates the JS/TS workspace only. The job MUST report a single, stable check name so it can be referenced as a required status check in branch protection.

#### Scenario: PR with passing checks is green

- **WHEN** a contributor opens or updates a pull request targeting `dev` or `master` and the workspace passes `pnpm typecheck`, `pnpm lint`, and `pnpm test:run`
- **THEN** the `ci.yml` workflow runs on `ubuntu-latest`, completes successfully, and reports a passing status check on the PR

#### Scenario: A type error fails the PR check

- **WHEN** a pull request introduces a TypeScript type error that makes `pnpm typecheck` exit non-zero
- **THEN** the workflow fails at the typecheck step, does not run lint or tests, and reports a failing status check on the PR

#### Scenario: A lint or test failure fails the PR check

- **WHEN** a pull request passes typecheck but `pnpm lint` or `pnpm test:run` exits non-zero
- **THEN** the workflow fails at the corresponding step and reports a failing status check on the PR

#### Scenario: Workflow does not trigger outside dev/master PRs

- **WHEN** a pull request targets a branch other than `dev` or `master`, or a push occurs without an associated PR to those branches
- **THEN** the `ci.yml` workflow does not run

#### Scenario: Dependency install uses the frozen lockfile

- **WHEN** a pull request changes `package.json` without updating `pnpm-lock.yaml`
- **THEN** `pnpm install --frozen-lockfile` fails the job, surfacing the lockfile drift before merge

### Requirement: Release script waits for green PR checks before merging to master

`packages/app/scripts/release.sh` SHALL, after opening the release pull request to `master`, block until that PR's CI checks complete and merge only on success — it MUST NOT merge immediately and unconditionally. The script MUST: (1) poll until at least one check is registered on the PR (bounded retries, to absorb the post-creation registration race), failing with a clear message if none appear; (2) wait for the checks to finish via `gh pr checks "$RELEASE_BRANCH" --watch --fail-fast`; (3) on success, merge synchronously with `gh pr merge --merge --delete-branch` (preserving the merge-commit-not-squash behavior) and continue to the existing resolve-SHA → tag → back-merge steps. The script MUST NOT use `gh pr merge --auto`, because that returns before the merge completes and would cause the script to tag the pre-merge `master` HEAD. The whole wait+merge block MUST be skipped under `--dry-run` (printing the intended commands instead). On any failed check or a failed merge, the script MUST abort with a clear message, leave the release branch and PR open, and MUST NOT push a tag.

#### Scenario: Release PR merges once CI is green

- **WHEN** `release.sh` opens the release PR to `master` and the `ci.yml` checks subsequently pass
- **THEN** `gh pr checks --watch` exits successfully, the script merges the PR as a merge commit and deletes the branch, then resolves the real merge commit SHA, tags it, and pushes the tag

#### Scenario: Release PR with failing CI does not merge or tag

- **WHEN** `release.sh` opens the release PR to `master` but a `ci.yml` check fails
- **THEN** `gh pr checks --watch --fail-fast` exits non-zero, the script aborts, no merge happens, no tag is pushed (so `release.yml` never fires), and the release branch and PR remain open for investigation

#### Scenario: Checks never register on the PR

- **WHEN** `release.sh` opens the release PR but no CI check appears within the bounded retry window
- **THEN** the script aborts with a clear message, pushes no tag, and leaves the release branch and PR open

#### Scenario: Dry run does not poll or merge

- **WHEN** `release.sh` is run with `--dry-run`
- **THEN** the wait-for-checks and merge commands are printed but not executed, and no GitHub API calls are made against a (nonexistent) PR
