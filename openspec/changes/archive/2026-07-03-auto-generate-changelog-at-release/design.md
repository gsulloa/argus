## Context

`release.sh` runs **locally** on the maintainer's machine (branching model "C"): it cuts a `release/vX.Y.Z` branch off `dev`, runs `node scripts/bump-version.mjs <kind>`, commits the bump (explicitly staging root `CHANGELOG.md`, `release.sh:270`), pushes, opens one PR to `master`, merges with a merge commit, tags `vX.Y.Z`, and back-merges to `dev`. Because it runs locally off a full clone, the entire git history and all tags are available at bump time — no CI `fetch-depth` concern.

`bump-version.mjs` already owns changelog promotion via the pure function `promoteUnreleased(text, version, date)` and is unit-tested (`__tests__/bump-version.smoke.mjs`). The `fix-changelog-entries-and-window` change (landing first) makes `promoteUnreleased` throw on an empty `## [Unreleased]`. This change replaces that throw with auto-derivation + an internal-only fallback.

PR titles in this repo are Conventional Commits with a trailing PR number, e.g. `feat(postgres): stream SQL results incrementally (#233)`, `fix(saved-queries): reliably surface tab when opening a saved query (#220)`. On a release branch cut from `dev`, the commits in `<lastTag>..HEAD` are the squash-merges from `dev`, each carrying a single `(#NNNN)` (the second number like `(#237)` only appears after the master merge, which happens later). Non-app work uses distinct types/scopes: `chore:`, `ci(rust):`, `feat(landing):`, plus `chore: back-merge …` and `chore: release …` commits.

## Goals / Non-Goals

**Goals:**
- At release, populate `## [Unreleased]` automatically from merged-PR titles so a forgotten hand-written entry is captured, not lost.
- Preserve hand-written entries verbatim and never duplicate a PR that is already documented.
- Emit only user-facing, correctly grouped entries; keep the whole thing a pure, unit-testable Node transformation.

**Non-Goals:**
- No rewriting of past released sections (only `## [Unreleased]` at promotion time).
- No CI bot, no write-back to `dev`, no changes to the merge/PR flow (the injection point is release-time only).
- No natural-language rewriting of PR titles — generated text is the title's description as-is. Prose quality comes from the hand-written override path.
- No support for non-Conventional-Commit titles beyond safely ignoring them.

## Decisions

### Decision 1: Generate at release inside `bump-version.mjs`, not at PR/merge time

The injection point is `bump-version.mjs`. Alternatives considered: (a) a GitHub Action that appends to `CHANGELOG.md` when each PR merges to `dev` — rejected: requires a write-back commit to `dev` with a privileged token and `[skip ci]`, races with concurrent merges and back-merges, and adds bot-commit noise; (b) a merge-commit git hook — rejected: not enforceable across contributors/CI. Generating at release keeps one deterministic, local, unit-testable transformation in the script that already owns promotion, and the `release/vX` → `master` PR is a natural human review window before anything is tagged.

### Decision 2: Derivation is a set of pure functions; only the git read is impure

Add pure helpers so the logic is testable without a repo:
- `parseCommitSubject(subject)` → `{ type, scope, description, prNumbers: number[] } | null` (null when it doesn't match `^(feat|fix|perf|chore|ci|docs|test|refactor|build|style|revert)(\(([^)]+)\))?(!)?:\s*(.+)$`). PR numbers are extracted from all trailing `(#NNNN)` groups.
- `deriveEntries(subjects, config)` → grouped map `{ Added: [...], Changed: [...], Fixed: [...] }`, applying the type→group map and the type/scope filters, skipping unparseable/merge/release subjects. Each entry keeps its `prNumber` for dedup and a rendered bullet string.
- `existingPrNumbers(unreleasedBody)` → `Set<number>` parsed from `[#NNNN](…)` / `(#NNNN)` occurrences in the current `## [Unreleased]` text.
- `mergeUnreleased(handWrittenBody, derivedGroups, existingPrs)` → the final `## [Unreleased]` body: hand-written lines kept as-is and first within each group, then auto entries whose `prNumber ∉ existingPrs` appended under their group; groups ordered `Added, Changed, Fixed, Removed`.

The only impure part is reading git: `git describe --tags --abbrev=0` and `git log <tag>..HEAD --format=%s`, wrapped in one function using `node:child_process execFileSync`. `promoteUnreleased` gains a parameter (the derived/merged body) or calls the merge helper; it stays otherwise pure so existing tests hold.

- **Type→group map:** `feat → Added`, `fix → Fixed`, `perf → Changed`. Everything else is dropped. Rationale: this is the smallest safe mapping; `feat` occasionally is really a "Changed" but Added is an acceptable default and the hand-written override exists for the exceptions.

### Decision 3: Config lives as named constants at the top of the script

`ALLOWED_TYPES` (map to groups), `DENIED_SCOPES` (`["landing"]` initially), `REPO_URL` (`https://github.com/gsulloa/argus`), and the merge/release subject patterns (`/^Merge /`, `/^chore: (back-merge|release)/`). Keeping them as exported constants makes them test-visible and easy to tune without touching logic. Alternative — an external config file — is overkill for a handful of values.

### Decision 4: PR-number selection and links

When a subject carries multiple `(#NNNN)` groups, use the **first** (the feature PR on `dev`), matching how the existing hand-curated entries link (`#229`, `#221`). At release-from-`dev` time there is typically only one number anyway. Bullets render as `- <description> ([#NNNN](REPO_URL/pull/NNNN))`, matching the existing changelog style. Subjects with no PR number still generate an entry (no link) rather than being dropped, so a direct-to-dev commit isn't silently lost.

### Decision 5: Replace fail-on-empty with an internal-only fallback

After merge, if `## [Unreleased]` has no bullets in any group, promote with the placeholder `_No user-facing changes._` instead of throwing. Rationale: once entries are auto-derived, an empty section is a *reliable* signal that the release genuinely has no user-facing PRs (only chores/CI), so blocking adds friction with no safety benefit. This intentionally supersedes the `fix-changelog-entries-and-window` fail-on-empty decision.

## Risks / Trade-offs

- **[Auto-generated bullets read as terse/dev-facing]** → Hand-written entries take precedence per group; maintainers upgrade any bullet during the `release/vX` PR review, and the generated text is only the fallback. The dedup key is the PR number, so a hand-written line fully replaces the auto one.
- **[A `feat` that is really a breaking/Changed lands under Added]** → Acceptable default; the maintainer can correct it by hand (dedup keeps it from reappearing). Not worth encoding `!`/`BREAKING CHANGE` handling in v1, though `parseCommitSubject` captures the `!` marker for a future enhancement.
- **[Tags unavailable / first release with no prior tag]** → `git describe --tags` fails when no tag exists; wrap it and fall back to "all history" (or the repo root) so the first run still works, and never let the git read crash the bump — on any git error, log a warning and fall back to hand-written-only promotion.
- **[Range includes merge/back-merge/release commits on the release branch]** → Explicitly filtered by subject pattern; unit-tested with representative noisy subjects from this repo's history.
- **[Scope denylist drift]** → `landing` is the only known non-app scope today; documented as a constant to extend. If a new non-app area appears, add its scope.

## Migration Plan

1. Land `fix-changelog-entries-and-window` first (backfill + window move + fail-on-empty).
2. Land this change: `bump-version.mjs` gains derivation + fallback; the fail-on-empty throw is removed. Update `CHANGELOG.md` "Contributing" note and any README/spec text describing hand-written-only entries.
3. First real release after this lands: verify in the `release/vX` PR diff that `## [Unreleased]` was populated correctly before merging; adjust `DENIED_SCOPES`/mapping if needed. Rollback is a plain revert — behavior returns to promote-what's-there.

## Open Questions

- Should `perf` map to `Changed`, or should we add a `Performance` group? Keep `Changed` for v1 (fewer groups, matches current usage).
- Should a `feat!:` / `BREAKING CHANGE` produce a `Removed`/`**BREAKING**`-marked entry automatically? Deferred — `parseCommitSubject` captures `!` so this can be added later without reworking the parser.
- Do we ever want to auto-include `landing` in a *separate* site changelog? Out of scope here (this changelog is the desktop app's).
