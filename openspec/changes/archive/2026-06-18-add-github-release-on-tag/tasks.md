## 1. Permissions

- [x] 1.1 In `.github/workflows/release.yml`, change the `publish` job `permissions` from `contents: read` to `contents: write` (keep `id-token: write`).

## 2. Release notes

- [x] 2.1 Add a "Extract release notes" step in the `publish` job (after "Verify all four bundles present") that slices the `vX.Y.Z` section out of `packages/app/CHANGELOG.md` (from the matching `#### [vX.Y.Z]` header to the next `####` header) into `RELEASE_NOTES.md`.
- [x] 2.2 Emit a step output (e.g. `has_notes=true|false`) indicating whether the slice produced non-empty content, so the next step can choose between `body_path` and auto-generated notes.

## 3. Create the GitHub Release

- [x] 3.1 Add a `softprops/action-gh-release@v2` (pinned) step after the notes step, gated on the verify gate having passed, with `tag_name: ${{ github.ref_name }}` and `name: ${{ github.ref_name }}`.
- [x] 3.2 Wire notes: use `body_path: RELEASE_NOTES.md` when `has_notes == true`, otherwise set `generate_release_notes: true`.
- [x] 3.3 Attach the four installers via `files:` — `staging/Argus_*_aarch64.dmg`, `staging/Argus_*_x64.dmg`, `staging/Argus_*_x64.AppImage`, `staging/Argus_*_x64.msi` — and confirm no `.sig`/`.tar.gz`/`.msi.zip` is included.
- [x] 3.4 Set `prerelease` based on the tag: `true` when `github.ref_name` contains `-`, else `false`.
- [x] 3.5 Confirm `action-gh-release` updates an existing Release for the tag instead of failing (idempotency — default behavior; verify the version pinned supports it).

## 4. Validation

- [x] 4.1 Run `actionlint` / a YAML lint on `release.yml` to confirm the workflow is syntactically valid.
- [x] 4.2 Push a throwaway pre-release tag (e.g. `v0.0.0-relnotes1`) and confirm a GitHub Release appears with the four installer assets and a non-empty body. _(verified manually)_
- [x] 4.3 Re-run the workflow for the same test tag and confirm it updates the existing Release (no duplicate, job stays green). _(verified manually)_
- [x] 4.4 Delete the test Release and tag; confirm the S3/CloudFront publish path was unaffected. _(verified manually)_
- [x] 4.5 Update issue #113 with the verification result and close it. _(linked via PR — auto-closes on merge)_
