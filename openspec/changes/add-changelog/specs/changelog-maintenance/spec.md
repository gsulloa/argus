## ADDED Requirements

### Requirement: A single curated changelog exists at the repository root

The repository SHALL contain exactly one curated changelog file at the repository root, `CHANGELOG.md`, that is the single source of truth for human-readable release notes. Release notes MUST NOT be duplicated in any other maintained file; the previously auto-generated `packages/app/CHANGELOG.md` and its generation tooling SHALL be removed.

#### Scenario: Root changelog is the source of truth

- **WHEN** a maintainer or automated process needs the release notes for a version
- **THEN** they read them from the root `CHANGELOG.md` and from no other maintained changelog file

#### Scenario: Auto-generated changelog is retired

- **WHEN** the change is applied
- **THEN** `packages/app/CHANGELOG.md`, the `changelog` npm script, and the `auto-changelog` dev dependency no longer exist in the repository

### Requirement: The changelog follows Keep a Changelog and SemVer

The `CHANGELOG.md` file SHALL follow the Keep a Changelog format over SemVer versions. It MUST begin with a pinned `## [Unreleased]` section, followed by one `## [X.Y.Z] - YYYY-MM-DD` section per released version in reverse-chronological order. Within any section, changes MUST be grouped under `### Added`, `### Changed`, `### Fixed`, and/or `### Removed` subheadings, each containing a bulleted list. Dates MUST be UTC calendar dates in `YYYY-MM-DD` form.

#### Scenario: Version sections are well-formed

- **WHEN** the changelog is inspected for a released version `X.Y.Z`
- **THEN** it contains a `## [X.Y.Z] - YYYY-MM-DD` header whose bullets are grouped only under `Added`, `Changed`, `Fixed`, or `Removed`

#### Scenario: Unreleased section is always present

- **WHEN** the changelog is read at any time
- **THEN** the first version section is `## [Unreleased]`, holding changes not yet shipped

### Requirement: Recent version history is backfilled

The changelog SHALL include backfilled entries for recent releases so it is useful immediately. At minimum the current minor line (the `v0.7.x` versions) MUST be present with curated, grouped entries; older versions MAY be terser but MUST at least appear as dated version headers.

#### Scenario: Current minor line is curated

- **WHEN** the backfilled changelog is reviewed
- **THEN** every `v0.7.x` release has a dated section with grouped, human-readable entries

### Requirement: Contributors edit the Unreleased section

Contributors SHALL record user-facing changes by adding bullets under the appropriate group within the `## [Unreleased]` section in the same pull request that makes the change. Entries MUST be written by hand; the project MUST NOT auto-generate changelog entries from commit messages or PR labels.

#### Scenario: A change is documented in its PR

- **WHEN** a pull request introduces a user-facing change
- **THEN** it adds a corresponding bullet under `Added`/`Changed`/`Fixed`/`Removed` in `## [Unreleased]`

### Requirement: The release flow promotes Unreleased into a dated version

The version-bump step of the release flow SHALL, in the same commit that bumps the version to `X.Y.Z`, rewrite `CHANGELOG.md` by renaming the `## [Unreleased]` heading to `## [X.Y.Z] - <release-date>` and inserting a fresh empty `## [Unreleased]` section above it. The release date MUST be the UTC calendar date of the release. If the `[Unreleased]` section has no entries at promotion time, the promoted section MUST contain a placeholder line so the section body is never empty.

#### Scenario: Unreleased is promoted on version bump

- **WHEN** the release flow bumps the version to `X.Y.Z`
- **THEN** the prior `## [Unreleased]` content becomes `## [X.Y.Z] - YYYY-MM-DD` and a new empty `## [Unreleased]` is inserted above it, within the same release commit

#### Scenario: Empty Unreleased yields a non-empty section

- **WHEN** the version is bumped while `## [Unreleased]` has no change bullets
- **THEN** the promoted `## [X.Y.Z]` section contains a placeholder line indicating no user-facing changes
