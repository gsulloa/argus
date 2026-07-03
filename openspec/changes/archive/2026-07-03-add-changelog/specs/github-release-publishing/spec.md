## MODIFIED Requirements

### Requirement: Release notes come from the changelog with an auto-generated fallback

The Release body SHALL be populated from the `X.Y.Z` section of the root
`CHANGELOG.md` (Keep a Changelog format, section headers of the form
`## [X.Y.Z] - YYYY-MM-DD`) when a matching section exists. The extracted body MUST be
the content between the matching `## [X.Y.Z]` header and the next `## [` header. When
no matching section is found, the workflow MUST fall back to auto-generated notes
describing the commits since the previous `v*` tag. The notes source selection MUST be
deterministic (it MUST NOT depend on runner timing or ordering) so the same tag always
yields the same notes.

#### Scenario: Notes are extracted from the changelog

- **WHEN** the root `CHANGELOG.md` contains a `## [X.Y.Z]` section for the pushed tag
- **THEN** the Release body contains that section's content as the release notes

#### Scenario: Fallback to auto-generated notes

- **WHEN** the root `CHANGELOG.md` has no `## [X.Y.Z]` section matching the pushed tag
- **THEN** the Release body is auto-generated from the commit log since the previous `v*` tag
