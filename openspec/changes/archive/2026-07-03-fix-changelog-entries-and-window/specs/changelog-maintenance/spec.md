## MODIFIED Requirements

### Requirement: The release flow promotes Unreleased into a dated version

The version-bump step of the release flow SHALL, in the same commit that bumps the version to `X.Y.Z`, rewrite `CHANGELOG.md` by renaming the `## [Unreleased]` heading to `## [X.Y.Z] - <release-date>` and inserting a fresh empty `## [Unreleased]` section above it. The release date MUST be the UTC calendar date of the release. If the `## [Unreleased]` section contains no change bullets and no explicit internal-only marker at promotion time, the version-bump step MUST fail with a non-zero exit and an error message telling the maintainer to record the release's user-facing changes; it MUST NOT silently insert a "no user-facing changes" placeholder. A release that genuinely has no user-facing changes MUST be recorded by the maintainer writing an explicit internal-only marker line under `## [Unreleased]` before bumping; when that marker is present the step promotes the section normally and preserves the marker as the promoted section's body.

#### Scenario: Unreleased is promoted on version bump

- **WHEN** the release flow bumps the version to `X.Y.Z` while `## [Unreleased]` has change bullets
- **THEN** the prior `## [Unreleased]` content becomes `## [X.Y.Z] - YYYY-MM-DD` and a new empty `## [Unreleased]` is inserted above it, within the same release commit

#### Scenario: Empty Unreleased fails the release

- **WHEN** the version is bumped while `## [Unreleased]` has no change bullets and no explicit internal-only marker
- **THEN** the version-bump step exits non-zero with an error instructing the maintainer to record the release's user-facing changes, and `CHANGELOG.md` is left unchanged

#### Scenario: Intentional internal-only release is recorded explicitly

- **WHEN** a maintainer intends to release with no user-facing changes and writes the explicit internal-only marker under `## [Unreleased]` before bumping
- **THEN** the step promotes the section to `## [X.Y.Z] - YYYY-MM-DD` preserving that marker as the section body, without failing

## ADDED Requirements

### Requirement: Recent releases with user-facing changes are documented accurately

Every released version whose PRs delivered user-facing behavior SHALL have a `## [X.Y.Z]` section containing grouped, human-readable entries for that behavior; it MUST NOT carry a "no user-facing changes" placeholder. In particular, the `v0.7.6` and `v0.8.0` sections MUST list the user-facing changes those releases shipped, grouped under `Added`/`Changed`/`Fixed`/`Removed`, replacing the previously stored `_No user-facing changes._` placeholder.

#### Scenario: v0.7.6 and v0.8.0 carry real entries

- **WHEN** the changelog is inspected for `v0.7.6` and `v0.8.0`
- **THEN** each section lists the user-facing changes that release shipped, grouped under the appropriate headings, and neither contains a "no user-facing changes" placeholder
