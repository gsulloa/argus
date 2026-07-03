## Why

Even after making an empty `## [Unreleased]` fail the release (the `fix-changelog-entries-and-window` change), the changelog still depends entirely on contributors remembering to hand-write an entry in every PR. That discipline already failed twice (`v0.7.6`, `v0.8.0` shipped real features with no notes), and a hard failure at release time only surfaces the omission when the author's context is gone — someone then has to reconstruct the notes from `git log` by hand. The release should assemble the changelog automatically from the PRs that actually merged, so a forgotten entry is captured instead of lost, while still letting maintainers write better prose when they want to.

## What Changes

- **Auto-generate `## [Unreleased]` entries at release time** inside `bump-version.mjs`, derived from the Conventional-Commit PR titles merged since the previous release tag (`git log <lastTag>..HEAD`).
- **Hand-written entries win.** Any bullet a contributor already wrote under `## [Unreleased]` is preserved verbatim; auto-generation only fills gaps.
- **Dedup by PR number.** A PR whose `#NNNN` already appears in `## [Unreleased]` is never auto-added, so curated prose is never duplicated by a generated line.
- **Noise filtering.** Only `feat` → `Added`, `fix` → `Fixed`, `perf` → `Changed` are generated; `chore`/`ci`/`docs`/`test`/`refactor`/`build`/`style`, merge/back-merge/release commits, and configured non-app scopes (e.g. `landing`) are excluded.
- **BREAKING (policy reversal):** the existing rule "entries MUST be written by hand; the project MUST NOT auto-generate changelog entries from commit messages" is reversed. Auto-generation from commit messages becomes the default, with hand-written entries as the higher-precedence override.
- **Fallback:** if, after auto-generation, `## [Unreleased]` still has no qualifying entries, the release is treated as genuinely internal-only and the section is promoted with an explicit "no user-facing changes" marker rather than failing. This supersedes the fail-on-empty behavior introduced by `fix-changelog-entries-and-window`.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `changelog-maintenance`: reverse the "no auto-generation" rule; the release/version-bump step MUST derive `## [Unreleased]` entries from merged-PR Conventional-Commit titles since the last tag, preserving hand-written entries, deduping by PR number, filtering non-user-facing types/scopes, and falling back to an internal-only marker when nothing qualifies.

## Impact

- **Release tooling**: `packages/app/scripts/bump-version.mjs` — new pure helpers (parse Conventional-Commit subjects, derive/group/format entries, dedup vs existing PR numbers) plus a git-history read (`git describe --tags` + `git log`); `promoteUnreleased` gains a "merge auto-derived with hand-written" step. `release.sh` already stages `CHANGELOG.md`, so the generated entries are committed on the release branch and reviewable in the `release/vX` → master PR before merge.
- **Depends on / supersedes**: `fix-changelog-entries-and-window` (this replaces its fail-on-empty promotion behavior with auto-fill + internal-only fallback). That change should land first.
- **Tests**: unit tests for the new Conventional-Commit parser, the type/scope filter, the group mapping, the dedup-by-PR-number merge, and the internal-only fallback. A small config surface (allowed types, denied scopes, repo URL for PR links) needs a home in the script.
- **Docs**: `CHANGELOG.md` "Contributing" note and any README/spec text that currently tells contributors entries are hand-written-only must be updated to describe the new "auto-generated, hand-editable" model.
