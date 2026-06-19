## Context

The repo uses a `dev` + `master` branching model with a tag-driven release pipeline. The only CI today is `.github/workflows/release.yml`, which triggers on `v*` tag pushes and builds/signs/publishes the four-platform Tauri bundles. Nothing validates a PR. As a result `packages/app/scripts/release.sh` (line 286) calls `gh pr merge "$RELEASE_BRANCH" --merge --delete-branch`, which merges the release PR to the protected `master` line immediately and unconditionally — the "review gate" is cosmetic.

The root `package.json` already exposes the three validation scripts, each delegating into the app workspace:

- `typecheck` → `pnpm --filter argus typecheck`
- `lint` → `pnpm --filter argus lint`
- `test:run` → `pnpm --filter argus test:run`

Package manager is `pnpm@10.33.0` (pinned via `packageManager`); `release.yml` already standardizes on `pnpm/action-setup@v4` + `actions/setup-node@v4` with Node 22 and `cache: pnpm`.

## Goals / Non-Goals

**Goals:**
- A fast PR gate that runs typecheck + lint + tests on every PR to `dev` and `master`.
- Reuse the exact toolchain setup `release.yml` already uses, so there is one way to set up pnpm/Node in CI.
- Make `release.sh` wait for that gate to pass before the release PR merges to `master`.

**Non-Goals:**
- No Rust/Tauri build, sign, notarize, or publish in the PR gate — those belong to the tag-driven `release.yml`. The gate validates the JS/TS workspace only.
- No changes to branch-protection settings via code. Marking the check "required" is a one-time manual GitHub setting documented here, not automated.
- No new lint/test/typecheck rules, no test additions — only wiring existing scripts into CI.
- No matrix across OSes; a single `ubuntu-latest` runner is sufficient for JS/TS checks.

## Decisions

**Single Ubuntu runner, no OS matrix.** Typecheck/lint/test are platform-agnostic for this workspace; a matrix would multiply minutes for no signal. Alternative (matrix) rejected as wasteful.

**Run the three checks as sequential steps, fail-fast.** Separate steps (`pnpm typecheck`, then `pnpm lint`, then `pnpm test:run`) rather than one `&&` chain, so the GitHub UI shows exactly which stage failed. Fail-fast (default step behavior) is desired: a type error need not also wait for tests.

**Reuse `release.yml`'s setup actions and versions.** `pnpm/action-setup@v4` (version resolved from `packageManager`, not pinned inline) + `actions/setup-node@v4` with `node-version: 22` and `cache: pnpm`. Keeps one canonical setup and gets dependency caching for free.

**Stable check name as the required-status anchor.** The job name is the string branch protection will reference. Pick a clear, stable `name:` (e.g. job `validate`) and do not rename it casually, since renaming silently detaches the branch-protection requirement.

**`release.sh`: wait-for-green then synchronous merge (NOT `gh pr merge --auto`).** Issue #112 suggested `gh pr merge --auto --merge`, but `--auto` is fire-and-forget — it returns the moment auto-merge is *enabled*, before the PR actually merges. `release.sh` cannot use that, because the very next steps resolve the merge commit SHA off `origin/master`, tag it, and back-merge — all of which assume the merge already happened. With `--auto` the script would tag the **pre-merge** `master` HEAD and ship stale code while the real merge lands minutes later. Rejected.

Instead the script blocks synchronously: poll until the PR's checks register, then `gh pr checks "$RELEASE_BRANCH" --watch --fail-fast` to wait for them to finish, then a plain `gh pr merge --merge --delete-branch`. This keeps the existing resolve-SHA → tag → back-merge flow intact and unchanged.

- **Checks pass** → `gh pr checks` exits 0, the script merges, resolves the real merge commit, tags, and back-merges as before.
- **A check fails** → `gh pr checks --watch --fail-fast` exits non-zero; the script `die`s, leaving the branch and PR open and pushing **no tag** (so `release.yml` never fires). The release simply does not ship. This matches the script's existing failure contract.

Because we do a normal synchronous merge (not `--auto`), the flow does **not** depend on the repo's "Allow auto-merge" setting or on branch protection being configured — it works as soon as `ci.yml` exists. Branch protection's required-check setting remains a recommended defense (so a human can't merge a red PR either), not a dependency.

The whole wait+merge block is guarded by `if [ "$DRY" = "0" ]` (printing the intended commands via `c_dim` under `--dry-run`), mirroring the existing `MERGE_SHA` resolution block, since there is no real PR to poll in a dry run.

## Risks / Trade-offs

- **`release.sh` could block on a never-finishing check.** `gh pr checks --watch` blocks while checks are pending; a hung/queued check makes the script wait. → `--fail-fast` exits the moment any check fails; the operator can Ctrl-C (the script has pushed no tag yet, so aborting is safe and leaves the PR open). A check-registration poll with a bounded retry guards the initial "no checks yet" race right after PR creation, failing with a clear message if checks never appear.
- **`gh pr checks` "no checks reported" race.** Immediately after PR creation the workflow run may not be registered yet, so `gh pr checks` would exit non-zero with "no checks." → Poll `gh pr view --json statusCheckRollup` until at least one check appears (bounded retries) before invoking `--watch`.
- **`--frozen-lockfile` will fail PRs that change deps without updating the lockfile.** This is intended (catches drift), but contributors must update `pnpm-lock.yaml`. → Documented behavior, surfaced as a clear install failure.
- **CI minutes on every PR.** Marginal; single Ubuntu runner with pnpm cache keeps runs short.

## Migration Plan

1. Land `.github/workflows/ci.yml` and the `release.sh` change together.
2. Open a throwaway PR to `dev` to confirm the workflow triggers, runs all three steps, and reports a status check; confirm it goes red on an intentional type error.
3. (Recommended, not required by the script) In branch protection for `master` (and optionally `dev`): add the CI job's check name to **Require status checks to pass before merging**, so a human cannot merge a red PR either.
4. On the next release, confirm `release.sh` waits for the PR checks (`gh pr checks --watch`), then merges and pushes the tag only on green.

Rollback: revert the `release.sh` wait+merge block to the prior immediate `gh pr merge --merge`; deleting `ci.yml` removes the gate entirely. No runtime/product impact either way.

## Open Questions

- Job/check name string to standardize on for the required-status reference (proposed: `validate`). Confirm before enabling branch protection so the name is stable from day one.
- Whether to also require the check on `dev` (recommended) or only `master` (minimum to make `release.sh` auto-merge meaningful).
