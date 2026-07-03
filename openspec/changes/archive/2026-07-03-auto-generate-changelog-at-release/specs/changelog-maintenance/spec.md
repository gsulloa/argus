## MODIFIED Requirements

### Requirement: Contributors edit the Unreleased section

Contributors MAY record user-facing changes by adding bullets under the appropriate group within the `## [Unreleased]` section in the same pull request that makes the change; doing so is encouraged when the change deserves better prose than its PR title. Hand-written entries take precedence over auto-generation. The project SHALL auto-generate changelog entries from merged-PR Conventional-Commit titles at release time (see "The release flow promotes Unreleased into a dated version"); a contributor omitting a hand-written entry MUST NOT cause the change to be lost from the changelog.

#### Scenario: A change is documented by hand in its PR

- **WHEN** a pull request introduces a user-facing change and adds a corresponding bullet under `Added`/`Changed`/`Fixed`/`Removed` in `## [Unreleased]`
- **THEN** that hand-written bullet is preserved verbatim through release promotion and is not duplicated by an auto-generated entry for the same PR

#### Scenario: A change with no hand-written entry is still captured

- **WHEN** a pull request introduces a user-facing change (a `feat`/`fix`/`perf` Conventional-Commit PR) but adds no bullet to `## [Unreleased]`
- **THEN** the release flow auto-generates an entry for it from the PR title so the change appears in the changelog

### Requirement: The release flow promotes Unreleased into a dated version

The version-bump step of the release flow SHALL, in the same commit that bumps the version to `X.Y.Z`, rewrite `CHANGELOG.md` by renaming the `## [Unreleased]` heading to `## [X.Y.Z] - <release-date>` and inserting a fresh empty `## [Unreleased]` section above it. The release date MUST be the UTC calendar date of the release. Before promoting, the step SHALL auto-derive entries from the Conventional-Commit titles of the commits merged since the previous release tag and merge them into `## [Unreleased]`:

- It MUST consider the subject lines of commits in the range `<previous-tag>..HEAD` (previous tag resolved via `git describe --tags --abbrev=0`).
- It MUST parse subjects of the form `type(scope): description (#NNNN)`, generating entries only for the allowed types (`feat` → `Added`, `fix` → `Fixed`, `perf` → `Changed`) and MUST exclude all other types (`chore`, `ci`, `docs`, `test`, `refactor`, `build`, `style`), merge/back-merge/release commits, and any subject whose scope is in the configured non-user-facing denylist (e.g. `landing`).
- It MUST NOT add an auto-generated entry for a PR whose `#NNNN` already appears anywhere in the current `## [Unreleased]` body (dedup by PR number), so hand-written entries are never duplicated.
- Auto-generated entries MUST be placed under the group implied by their type, rendered as a bullet containing the description and a Markdown link to the PR.

If, after merging auto-derived entries with any hand-written entries, `## [Unreleased]` still contains no change bullets, the promoted `## [X.Y.Z]` section MUST contain a placeholder line indicating no user-facing changes, so the section body is never empty and the release is not blocked.

#### Scenario: Unreleased is promoted with auto-derived and hand-written entries

- **WHEN** the release flow bumps the version to `X.Y.Z` and `feat`/`fix`/`perf` PRs merged since the previous tag
- **THEN** the prior `## [Unreleased]` content becomes `## [X.Y.Z] - YYYY-MM-DD` containing the hand-written bullets plus auto-generated bullets for every qualifying PR not already listed, grouped by type, and a fresh empty `## [Unreleased]` is inserted above it — all within the same release commit

#### Scenario: A PR already documented by hand is not duplicated

- **WHEN** `## [Unreleased]` already contains a hand-written bullet linking PR `#NNNN` and that same PR appears in the commit range
- **THEN** the promoted section contains only the hand-written bullet for `#NNNN`, with no auto-generated duplicate

#### Scenario: Non-user-facing commits are excluded

- **WHEN** the commit range contains only `chore`/`ci`/`docs`/`refactor`/merge/release commits or `landing`-scoped commits
- **THEN** none of them produce changelog entries

#### Scenario: Genuinely internal release falls back to a placeholder

- **WHEN** the version is bumped and, after auto-derivation, `## [Unreleased]` has no qualifying change bullets
- **THEN** the promoted `## [X.Y.Z]` section contains a placeholder line indicating no user-facing changes, and the release is not blocked
