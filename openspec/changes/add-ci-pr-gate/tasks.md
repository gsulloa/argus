## 1. CI workflow

- [x] 1.1 Create `.github/workflows/ci.yml` triggered on `pull_request` to `dev` and `master`
- [x] 1.2 Add a single `validate` job on `ubuntu-latest` with a stable check name
- [x] 1.3 Add steps: `actions/checkout@v4`, `pnpm/action-setup@v4` (no inline version — resolved from `packageManager`), `actions/setup-node@v4` with `node-version: 22` and `cache: pnpm`
- [x] 1.4 Add `pnpm install --frozen-lockfile`
- [x] 1.5 Add sequential, fail-fast steps: `pnpm typecheck`, then `pnpm lint`, then `pnpm test:run`

## 2. Release script

- [x] 2.1 In `packages/app/scripts/release.sh`, before the merge step, add a check-registration poll: loop with bounded retries on `gh pr view '$RELEASE_BRANCH' --json statusCheckRollup -q '.statusCheckRollup | length'` until > 0; `die` (PR/branch open, no tag) if none appear
- [x] 2.2 Add a wait step: `gh pr checks '$RELEASE_BRANCH' --watch --fail-fast`; on non-zero `die` (CI failed, PR/branch open, no tag pushed)
- [x] 2.3 Change the merge to a synchronous `gh pr merge '$RELEASE_BRANCH' --merge --delete-branch` (NOT `--auto`) so the existing resolve-SHA → tag → back-merge steps still see the completed merge
- [x] 2.4 Guard the whole wait+merge block with `if [ "$DRY" = "0" ]` (print intended commands via `c_dim` under `--dry-run`), mirroring the existing `MERGE_SHA` block; update the section comment/`step` labels accordingly

## 3. Verification

- [ ] 3.1 Open a throwaway PR to `dev` and confirm the workflow triggers and runs all three steps to green
- [ ] 3.2 Push an intentional type error on that PR and confirm the workflow goes red at the typecheck step (and skips lint/test)
- [ ] 3.3 Confirm `pnpm install --frozen-lockfile` fails when `package.json` and `pnpm-lock.yaml` are out of sync
- [ ] 3.4 Close the throwaway PR

## 4. Repo configuration (manual, document in PR description)

- [ ] 4.1 (Recommended, not required by the script) Add the `validate` check to `master` (and optionally `dev`) branch-protection required status checks, so humans can't merge a red PR either
- [ ] 4.2 On next release, confirm `release.sh` waits for the PR checks, then merges and pushes the tag only on green (and aborts cleanly with no tag if a check fails)
