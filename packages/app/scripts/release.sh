#!/usr/bin/env bash
# release.sh — TAG-DRIVEN release entrypoint for Argus.
#
# Branching model "C":
#   1. Cut a release branch off <from> (default: dev).
#   2. Bump version via bump-version.mjs (writes tauri.conf.json / package.json / Cargo.toml).
#   3. Commit the bump.
#   4. Push the release branch.
#   5. Open ONE PR → master.
#   6. Merge it with a merge commit (NOT squash).
#   7. Push the git tag vX.Y.Z from the master merge commit → triggers CI (release.yml).
#   8. Back-merge master → dev so dev never drifts.
#
# ASCII flow diagram:
#
#   dev ──────────────────────────────────────────────────►
#         \                                    ▲
#          release/vX.Y.Z ──────────►        / (back-merge)
#                                   \       /
#   master ─────────────────────────── merge ─► tag vX.Y.Z ► CI
#
# Safe-failure ordering:
#   - The TAG is pushed only AFTER the master merge commit is confirmed.
#   - A failure before step 7 never leaves a dangling release tag.
#   - A failure during back-merge (step 8) prints recovery commands and exits
#     nonzero, but the release itself has already shipped (tag is live).
#
# Usage:
#   release.sh <major|minor|patch> [--from <branch>] [--yes] [--dry-run]
#   release.sh                      # interactive bump-kind menu
#
# Options:
#   major|minor|patch   Semver bump kind (positional, first arg).
#   --from <branch>     Base branch to cut the release from. Default: dev.
#                       Use --from master for hotfixes.
#   --yes               Skip the "vCURRENT → vNEXT, continue?" confirmation.
#   --dry-run           Print every mutating command via DRY prefix but execute
#                       nothing that mutates state. Read-only commands run normally.
#
# Secrets / prereqs:
#   - git configured with push access to origin.
#   - gh CLI authenticated (gh auth login).
#   - node available (used to run bump-version.mjs).
#   - jq available (used to read the current version).

set -euo pipefail

# ---------- locate repo -------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"   # packages/app

# ---------- color helpers -----------------------------------------------------

c_blue()   { printf '\033[1;34m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[1;32m%s\033[0m\n' "$*"; }
c_red()    { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }
c_yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }
c_dim()    { printf '\033[2m%s\033[0m\n' "$*"; }

step() { c_blue "==> $*"; }
die()  { c_red  "ERROR: $*"; exit 1; }

# ---------- dry-run wrapper ---------------------------------------------------
# All mutating commands are passed through run(). Under --dry-run the command is
# printed (dimmed) but never executed. Read-only inspection commands (git fetch,
# git rev-parse, gh auth status, etc.) may call their underlying tools directly.

DRY=0   # set to 1 by --dry-run; checked by run()

run() {
  if [ "$DRY" = "1" ]; then
    c_dim "DRY: $*"
  else
    eval "$@"
  fi
}

# ---------- argument parsing --------------------------------------------------

KIND=""
FROM_BRANCH="dev"
YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    major|minor|patch)
      KIND="$1"
      ;;
    --from)
      [ $# -ge 2 ] || die "--from requires a branch name argument"
      FROM_BRANCH="$2"
      shift
      ;;
    --from=*)
      FROM_BRANCH="${1#*=}"
      ;;
    --yes|-y)
      YES=1
      ;;
    --dry-run)
      DRY=1
      ;;
    -h|--help)
      sed -n '2,55p' "$0"; exit 0
      ;;
    *)
      die "Unknown argument: $1  (expected: major|minor|patch [--from <branch>] [--yes] [--dry-run])"
      ;;
  esac
  shift
done

# Interactive menu when KIND not supplied as argument.
if [ -z "$KIND" ]; then
  echo ""
  c_yellow "Select bump kind:"
  echo "  1) patch"
  echo "  2) minor"
  echo "  3) major"
  echo ""
  read -r -p "Choice [1/2/3]: " _choice
  case "$_choice" in
    1|patch)  KIND="patch" ;;
    2|minor)  KIND="minor" ;;
    3|major)  KIND="major" ;;
    *) die "Invalid choice: '$_choice'. Expected 1, 2, 3, patch, minor, or major." ;;
  esac
fi

# Validate kind (in case someone passes something weird that matched no case above).
case "$KIND" in
  major|minor|patch) ;;
  *) die "Invalid bump kind: '$KIND'. Expected major, minor, or patch." ;;
esac

# ---------- read current version (before any mutation) ------------------------

TAURI_CONF="$ROOT/src-tauri/tauri.conf.json"
[ -f "$TAURI_CONF" ] || die "Cannot find $TAURI_CONF"
CURRENT="$(jq -r .version "$TAURI_CONF")"
[ -n "$CURRENT" ] && [ "$CURRENT" != "null" ] || die "Cannot read current version from $TAURI_CONF"

# ---------- preflight ---------------------------------------------------------

step "Preflight"

# 1. Working tree must be clean.
if ! git -C "$ROOT" diff --quiet || ! git -C "$ROOT" diff --cached --quiet; then
  die "Working tree is not clean. Commit or stash your changes before releasing."
fi
c_dim "  Working tree: clean"

# 2. gh must be installed and authenticated.
if ! command -v gh >/dev/null 2>&1; then
  die "'gh' CLI not found. Install it and run 'gh auth login' before releasing."
fi
if ! gh auth status >/dev/null 2>&1; then
  die "'gh' is not authenticated. Run 'gh auth login' and retry."
fi
c_dim "  gh CLI: authenticated"

# 3. node must be available for bump-version.mjs.
if ! command -v node >/dev/null 2>&1; then
  die "'node' not found. Install Node.js before releasing."
fi
c_dim "  node: $(node --version)"

# 4. jq must be available.
if ! command -v jq >/dev/null 2>&1; then
  die "'jq' not found. Install jq before releasing."
fi
c_dim "  jq: $(jq --version)"

# 5. Fetch origin and verify the base branch exists remotely.
step "Fetching origin (prune stale refs)"
git fetch origin --prune

if ! git ls-remote --exit-code --heads origin "$FROM_BRANCH" >/dev/null 2>&1; then
  die "Base branch '$FROM_BRANCH' does not exist on origin. Check --from value."
fi
c_dim "  Base branch: origin/$FROM_BRANCH exists"

c_green "Preflight OK"

# ---------- create release branch + bump version ------------------------------
# Strategy: create a temp branch off origin/<from>, run bump-version.mjs to
# learn the NEXT version (it writes the files and prints the version to stdout),
# then rename the branch to release/vNEXT.

TEMP_BRANCH="release/tmp-$$"

step "Creating temporary release branch off origin/$FROM_BRANCH"
run "git switch -c '$TEMP_BRANCH' 'origin/$FROM_BRANCH'"

step "Bumping version ($KIND)"
if [ "$DRY" = "1" ]; then
  # Compute what the bump would produce without writing any files.
  NEXT="$(node -e "
    const v='$CURRENT'.split('.');
    const [maj, min, pat] = [Number(v[0]), Number(v[1]), Number(v[2])];
    switch ('$KIND') {
      case 'patch': process.stdout.write(\`\${maj}.\${min}.\${pat + 1}\`); break;
      case 'minor': process.stdout.write(\`\${maj}.\${min + 1}.0\`); break;
      case 'major': process.stdout.write(\`\${maj + 1}.0.0\`); break;
    }
  ")"
  c_dim "DRY: (cd '$ROOT' && node scripts/bump-version.mjs '$KIND')  # would produce $NEXT"
else
  NEXT="$(cd "$ROOT" && node scripts/bump-version.mjs "$KIND")"
fi
[ -n "$NEXT" ] || die "bump-version.mjs returned an empty version string"
c_dim "  Version: $CURRENT → $NEXT"

# Rename temp branch to the real release branch name.
RELEASE_BRANCH="release/v$NEXT"
run "git branch -m '$TEMP_BRANCH' '$RELEASE_BRANCH'"

# ---------- tag-existence guard -----------------------------------------------
# Check AFTER we know NEXT but BEFORE we push anything. If tag exists, abort.
# (If --dry-run, we still run these read-only checks.)

step "Checking tag v$NEXT does not already exist"

if git rev-parse -q --verify "refs/tags/v$NEXT" >/dev/null 2>&1; then
  # Under dry-run we landed on the temp branch and bumped nothing — still clean.
  if [ "$DRY" = "0" ]; then
    # Clean up: delete the local branch we just created before aborting.
    git switch --detach HEAD 2>/dev/null || true
    git branch -D "$RELEASE_BRANCH" 2>/dev/null || true
  fi
  die "Tag v$NEXT already exists locally. Bump the version manually or investigate."
fi

if git ls-remote --tags origin "refs/tags/v$NEXT" 2>/dev/null | grep -q "refs/tags/v$NEXT"; then
  if [ "$DRY" = "0" ]; then
    git switch --detach HEAD 2>/dev/null || true
    git branch -D "$RELEASE_BRANCH" 2>/dev/null || true
  fi
  die "Tag v$NEXT already exists on origin. Cannot re-release the same version."
fi
c_dim "  Tag v$NEXT: not found (safe to create)"

# ---------- confirmation prompt -----------------------------------------------

if [ "$YES" = "0" ]; then
  echo ""
  c_yellow "  v$CURRENT → v$NEXT  (kind: $KIND, from: $FROM_BRANCH)"
  echo ""
  read -r -p "Continue? [y/N] " _ans
  case "$_ans" in
    y|Y) ;;
    *)
      # Clean up local branch before aborting.
      if [ "$DRY" = "0" ]; then
        git switch --detach HEAD 2>/dev/null || true
        git branch -D "$RELEASE_BRANCH" 2>/dev/null || true
      fi
      die "Aborted by user."
      ;;
  esac
fi

# ---------- commit the bump ---------------------------------------------------

step "Committing version bump"
run "git -C '$ROOT' commit -am 'chore: release v$NEXT'"

# ---------- push release branch -----------------------------------------------

step "Pushing release branch $RELEASE_BRANCH"
run "git push -u origin '$RELEASE_BRANCH'"

# ---------- open PR to master -------------------------------------------------

step "Opening PR: $RELEASE_BRANCH → master"
run "gh pr create \
  --base master \
  --head '$RELEASE_BRANCH' \
  --title 'Release v$NEXT' \
  --body 'Automated release v$NEXT.'"

# ---------- wait for CI checks, then merge PR (merge commit, not squash) -------
# We must merge SYNCHRONOUSLY (not `gh pr merge --auto`): the steps below resolve
# the merge commit on origin/master and tag it, so the merge has to be complete
# before we continue. We block on the PR's CI checks and only merge on green.
# On a failed check we abort: PR + branch stay open, and NO tag is pushed (so the
# release pipeline in release.yml never fires). Skipped entirely under --dry-run.

if [ "$DRY" = "0" ]; then
  step "Waiting for CI checks to register on PR"
  CHECKS_READY=0
  for _ in $(seq 1 24); do
    N_CHECKS="$(gh pr view "$RELEASE_BRANCH" --json statusCheckRollup -q '.statusCheckRollup | length' 2>/dev/null || echo 0)"
    case "$N_CHECKS" in ''|*[!0-9]*) N_CHECKS=0 ;; esac
    if [ "$N_CHECKS" -gt 0 ]; then
      CHECKS_READY=1
      break
    fi
    sleep 5
  done
  [ "$CHECKS_READY" = "1" ] || die "No CI checks registered on the release PR after waiting. Is .github/workflows/ci.yml present and triggering on PRs to master? The branch '$RELEASE_BRANCH' and PR are still open — investigate. No tag has been pushed yet."

  step "Waiting for CI checks to pass (gh pr checks --watch)"
  if ! gh pr checks "$RELEASE_BRANCH" --watch --fail-fast; then
    die "CI checks failed on the release PR. The branch '$RELEASE_BRANCH' and PR are still open — fix the failure (push to the release branch) and re-run. No tag has been pushed yet."
  fi

  step "Merging PR into master (merge commit, admin override)"
  # --admin bypasses the base-branch protection rule (e.g. "merge through a PR"
  # / required-status gates) so the synchronous merge always lands once our own
  # CI-check wait above has passed. Requires admin rights on the repo.
  if ! gh pr merge "$RELEASE_BRANCH" --merge --admin --delete-branch; then
    die "PR merge failed even though checks passed. The branch '$RELEASE_BRANCH' and PR are still open — investigate and finish manually. No tag has been pushed yet."
  fi
else
  c_dim "DRY: poll gh pr view '$RELEASE_BRANCH' --json statusCheckRollup until checks register"
  c_dim "DRY: gh pr checks '$RELEASE_BRANCH' --watch --fail-fast"
  c_dim "DRY: gh pr merge '$RELEASE_BRANCH' --merge --admin --delete-branch"
fi

# ---------- resolve merge commit on master ------------------------------------

step "Resolving merge commit SHA on origin/master"
run "git fetch origin master"
MERGE_SHA=""
if [ "$DRY" = "0" ]; then
  MERGE_SHA="$(git rev-parse origin/master)"
  c_dim "  Merge commit: $MERGE_SHA"
else
  c_dim "DRY: MERGE_SHA=\$(git rev-parse origin/master)"
fi

# ---------- tag the merge commit and push (triggers CI) -----------------------

step "Tagging merge commit v$NEXT and pushing (this triggers CI)"
run "git tag 'v$NEXT' '${MERGE_SHA:-<MERGE_SHA>}'"
run "git push origin 'v$NEXT'"

c_green "Tag v$NEXT pushed. CI release pipeline triggered."

# ---------- back-merge master into dev ----------------------------------------
# Always targets 'dev', even for hotfixes from master.

step "Back-merging master into dev"

DEV_BRANCH="dev"

# Switch to (or create tracking branch for) dev.
if git show-ref --verify --quiet "refs/heads/$DEV_BRANCH"; then
  run "git switch '$DEV_BRANCH'"
  run "git pull --ff-only origin '$DEV_BRANCH'"
else
  run "git switch -c '$DEV_BRANCH' 'origin/$DEV_BRANCH'"
fi

# Merge master into dev (no-ff to always produce a merge commit).
BACK_MERGE_OK=1
if [ "$DRY" = "1" ]; then
  run "git merge --no-ff origin/master -m 'chore: back-merge v$NEXT into dev'"
  run "git push origin '$DEV_BRANCH'"
else
  if git merge --no-ff origin/master -m "chore: back-merge v$NEXT into dev"; then
    if ! git push origin "$DEV_BRANCH"; then
      BACK_MERGE_OK=0
    fi
  else
    BACK_MERGE_OK=0
  fi
fi

if [ "$BACK_MERGE_OK" = "0" ]; then
  echo "" >&2
  c_red "Back-merge into dev encountered a problem."
  c_red "The release v$NEXT has ALREADY SHIPPED (tag v$NEXT is live on origin)."
  c_red "You only need to finish the back-merge manually:"
  echo "" >&2
  echo "  # Resolve any merge conflicts, then:" >&2
  echo "  git switch $DEV_BRANCH" >&2
  echo "  git pull --ff-only origin $DEV_BRANCH        # sync with origin" >&2
  echo "  git merge --no-ff origin/master -m 'chore: back-merge v$NEXT into dev'" >&2
  echo "  # (resolve conflicts if any, then: git add . && git commit)" >&2
  echo "  git push origin $DEV_BRANCH" >&2
  echo "" >&2
  exit 1
fi

# ---------- success summary ---------------------------------------------------

echo ""
c_green "========================================================"
c_green " Release v$NEXT complete!"
c_green "========================================================"
echo ""
echo "  Version   : v$NEXT  (bumped from v$CURRENT)"
echo "  Tag       : v$NEXT  (pushed to origin — CI triggered)"
echo "  Base      : $FROM_BRANCH → release/v$NEXT → master"
echo "  Back-merge: master → $DEV_BRANCH (done)"
echo ""
echo "  Monitor CI:"
echo "    gh run watch \$(gh run list --workflow=release.yml --limit=1 --json databaseId -q '.[0].databaseId')"
echo "    https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo '<owner>/<repo>')/actions"
echo ""
