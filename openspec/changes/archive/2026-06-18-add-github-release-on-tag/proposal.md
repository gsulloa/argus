## Why

Today the tag-triggered `publish` job in `release.yml` only uploads installers and
manifests to S3 + CloudFront (`latest.json` / `download.json`). A `vX.Y.Z` tag
produces no GitHub Release, so there is no human-readable record of "what shipped
here" and no canonical place to find release notes or attached installers. Now that
releases are tag-driven and the pipeline completes green end-to-end (#117/#118),
the tag is the natural trigger to also create a GitHub Release.

## What Changes

- Add a step to the tag-triggered `publish` job in `.github/workflows/release.yml`
  that creates a GitHub Release for the pushed `vX.Y.Z` tag.
- The Release MUST carry **release notes** sourced from the matching `vX.Y.Z`
  section of `packages/app/CHANGELOG.md`, with a deterministic fallback to
  auto-generated notes (commits since the previous tag) when no section is found.
- The Release MUST attach the four platform **end-user installers** already staged
  in the `publish` job (`.dmg` ×2, `.AppImage`, `.msi`) as downloadable assets.
- The Release creation MUST run only **after** the existing "Verify all four
  bundles present" gate passes, so a Release is never created for an incomplete set.
- The job MUST be **idempotent**: re-running the workflow for an existing tag
  updates the existing Release instead of failing.

## Capabilities

### New Capabilities
- `github-release-publishing`: On every `vX.Y.Z` tag, the release pipeline publishes
  a GitHub Release with notes derived from the changelog (or auto-generated as a
  fallback) and the four platform installers attached as assets, idempotently.

### Modified Capabilities
<!-- None. release-pipeline / release-artifact-hosting specs describe S3/CloudFront
     manifest publishing; this adds a separate GitHub-Release behavior and does not
     change any existing requirement. -->

## Impact

- **Workflow**: `.github/workflows/release.yml` — new step(s) in the `publish` job
  (or a sibling job gated on the same `build`/verify success).
- **Permissions**: the `publish` job needs `contents: write` (currently
  `contents: read`) to create a Release via `GITHUB_TOKEN`.
- **Source of notes**: `packages/app/CHANGELOG.md` (already exists; section header
  format `#### [vX.Y.Z]...`).
- **No app/runtime code changes**; CI-only.
