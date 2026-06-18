## ADDED Requirements

### Requirement: Each version tag publishes a GitHub Release

The tag-triggered release pipeline (`.github/workflows/release.yml`) SHALL create a
GitHub Release for the pushed `vX.Y.Z` tag as part of the `publish` job. The Release
creation step MUST run only **after** the existing "Verify all four bundles present"
gate succeeds, so a Release is never created when the four platform installers are
incomplete. The Release tag name MUST be exactly the pushed git tag (`vX.Y.Z`) and
the Release title MUST be the same tag. The `publish` job MUST be granted
`contents: write` permission so the workflow `GITHUB_TOKEN` can create the Release.

#### Scenario: Release is created after the bundle verification passes

- **WHEN** a `vX.Y.Z` tag is pushed and all four platform bundles pass the "Verify all four bundles present" step
- **THEN** the workflow creates a GitHub Release named `vX.Y.Z` against that tag

#### Scenario: No Release when bundles are incomplete

- **WHEN** the "Verify all four bundles present" step fails because one or more installers are missing
- **THEN** the publish job aborts before the Release step and no GitHub Release is created for the tag

### Requirement: Release notes come from the changelog with an auto-generated fallback

The Release body SHALL be populated from the `vX.Y.Z` section of
`packages/app/CHANGELOG.md` when a matching section exists. When no matching section
is found, the workflow MUST fall back to auto-generated notes describing the commits
since the previous `v*` tag. The notes source selection MUST be deterministic (it
MUST NOT depend on runner timing or ordering) so the same tag always yields the same
notes.

#### Scenario: Notes are extracted from the changelog

- **WHEN** `packages/app/CHANGELOG.md` contains a section for `vX.Y.Z`
- **THEN** the Release body contains that section's content as the release notes

#### Scenario: Fallback to auto-generated notes

- **WHEN** `packages/app/CHANGELOG.md` has no section matching the pushed tag
- **THEN** the Release body is auto-generated from the commit log since the previous `v*` tag

### Requirement: The four platform installers are attached as Release assets

The Release SHALL have the four end-user installers attached as downloadable assets:
both macOS `.dmg` files, the Linux `.AppImage`, and the Windows `.msi`, using the
canonical `Argus_${VERSION}_${ARCH}.<ext>` filenames already staged by the `publish`
job. The Release MUST NOT attach updater archives (`.app.tar.gz` / `.AppImage` updater
sigs / `.msi.zip`) or `.sig` files as primary download assets.

#### Scenario: Installers are downloadable from the Release page

- **WHEN** a user opens the GitHub Release for `vX.Y.Z`
- **THEN** the assets include `Argus_${VERSION}_aarch64.dmg`, `Argus_${VERSION}_x64.dmg`, `Argus_${VERSION}_x64.AppImage`, and `Argus_${VERSION}_x64.msi`

#### Scenario: Updater archives and signatures are not attached as installers

- **WHEN** the Release assets for `vX.Y.Z` are listed
- **THEN** none of the four installer assets is an `.app.tar.gz`, `.msi.zip`, or `.sig` file

### Requirement: Release creation is idempotent for an existing tag

Re-running the release workflow for a tag that already has a GitHub Release MUST
update the existing Release (notes and assets) rather than failing the job or
creating a duplicate Release.

#### Scenario: Re-run updates instead of failing

- **WHEN** the workflow runs for `vX.Y.Z` and a GitHub Release already exists for that tag
- **THEN** the step updates the existing Release's notes and assets and the job succeeds without creating a second Release
