## Why

The last two releases (`v0.7.6`, `v0.8.0`) show `_No user-facing changes._` in the changelog even though both shipped clearly user-facing work — incremental SQL streaming, a per-conversation AI provider/model selector, dynamic AI model discovery, active-connection color in the header, per-connection Context Queries, and Postgres cell/value fixes. The placeholder is misleading: it tells users nothing changed when a lot did. The root cause is that the release flow silently promotes an empty `## [Unreleased]` section into a placeholder, so a forgotten changelog edit produces a plausible-looking but wrong release note instead of failing loudly.

Separately, the "What's new" changelog viewer is mounted in the **workspace** window. The workspace only opens after a user selects a connection, so the post-update prompt can be missed entirely. The **connections (manager)** window is the first surface shown on launch and after an update — that is where the changelog belongs.

## What Changes

- **Backfill the missing release notes.** Replace the `_No user-facing changes._` placeholders for `v0.7.6` and `v0.8.0` in `CHANGELOG.md` with curated, grouped entries derived from the PRs that actually shipped in each release.
- **Make an empty `[Unreleased]` fail the release instead of emitting a silent placeholder.** The version-bump step will refuse to promote an empty `## [Unreleased]` section, forcing the maintainer to record entries. A genuinely internal-only release stays possible only via an explicit, intentional opt-in (an explicit "no user-facing changes" marker the maintainer writes, not an automatic default).
- **Move the changelog viewer/host to the connections (manager) window.** `<ChangelogHost />` moves out of the workspace `ShellMain` and into `ManagerShell`, so the palette entry and the auto-open-after-update prompt live in the window that is actually shown on launch.
- No auto-generation of changelog text from commit messages is introduced — entries remain hand-written, per the existing project rule.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `changelog-maintenance`: the release flow MUST fail when `## [Unreleased]` is empty rather than auto-inserting a "no user-facing changes" placeholder; an internal-only release requires an explicit maintainer-authored marker. Also adds the requirement that `v0.7.6` and `v0.8.0` carry accurate backfilled entries.
- `changelog-viewer`: the command-palette entry, the current-version highlight, and the after-update "What's new" auto-open MUST be hosted in the connections (manager) window rather than the workspace window.

## Impact

- **Docs / data**: `CHANGELOG.md` (backfill `v0.7.6`, `v0.8.0`).
- **Release tooling**: `packages/app/scripts/bump-version.mjs` (`promoteUnreleased` — replace silent placeholder with fail-on-empty + explicit opt-in). Any release script/CI wrapper that calls it must surface the new failure clearly.
- **Frontend**: `packages/app/src/app/App.tsx` (remove `<ChangelogHost />` from `ShellMain`), `packages/app/src/platform/shell/ManagerShell.tsx` (mount `<ChangelogHost />`). No change to `ChangelogHost.tsx` / `ChangelogViewer.tsx` internals expected.
- **Tests**: unit tests for `promoteUnreleased` (new fail-on-empty behavior); any test asserting the changelog host mounts in the workspace.
