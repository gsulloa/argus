## 1. Backfill CHANGELOG.md

- [x] 1.1 Enumerate the desktop-app-facing PRs shipped in `v0.7.6` (`#219`, `#220`, `#221`, `#229`; exclude landing-site-only `#224`/`#225`) and in `v0.8.0` (`#226/#232`, `#227/#235`, `#228/#231`, `#233/#237`; exclude landing-site-only `#234`), reading each PR title/description for accurate wording
- [x] 1.2 Replace the `_No user-facing changes._` body of `## [0.7.6] - 2026-07-02` in `CHANGELOG.md` with grouped `### Added`/`### Changed`/`### Fixed` bullets, each linking its PR, matching the format of the existing `v0.7.x` sections
- [x] 1.3 Replace the `_No user-facing changes._` body of `## [0.8.0] - 2026-07-03` in `CHANGELOG.md` with grouped bullets, each linking its PR
- [x] 1.4 Verify the file still parses cleanly (`## [Unreleased]` stays first and empty; sections remain reverse-chronological; bullets only under Added/Changed/Fixed/Removed)

## 2. Fail-on-empty release promotion

- [x] 2.1 In `packages/app/scripts/bump-version.mjs`, change `promoteUnreleased` to throw a descriptive `Error` (naming the version and instructing the maintainer to record user-facing changes or add an explicit `_No user-facing changes._` line) when the `[Unreleased]` body has no non-blank content, instead of inserting the `["", "_No user-facing changes._"]` placeholder
- [x] 2.2 Keep the promotion path unchanged when the body has content (including a hand-written `_No user-facing changes._` marker): rename `## [Unreleased]` → `## [X.Y.Z] - <date>`, insert a fresh empty `## [Unreleased]` above it, preserve the body verbatim
- [x] 2.3 Reorder `main()` so it computes the promoted changelog text (calling `promoteUnreleased`) BEFORE writing `tauri.conf.json`, `package.json`, `Cargo.toml`, and `Cargo.lock`, so an empty-changelog failure leaves the repo untouched with a non-zero exit and no partial version bump
- [x] 2.4 Confirm `CHANGELOG.md` is still absent-tolerant: if the file does not exist, skip promotion without failing (preserve existing `existsSync` guard behavior)

## 3. Move the changelog host to the connections window

- [x] 3.1 Remove `<ChangelogHost />` from `ShellMain` and delete the now-unused `import { ChangelogHost } from "@/platform/changelog"` in `packages/app/src/app/App.tsx`
- [x] 3.2 Import and mount `<ChangelogHost />` in `packages/app/src/platform/shell/ManagerShell.tsx`, alongside `<Palette />` and `<FeedbackHost />` (outside the scroll container)
- [x] 3.3 Confirm no other component in the workspace tree depends on `ChangelogHost` being mounted there (search for the palette command id `argus.help.showChangelog` and any assumption it is registered in the workspace)

## 4. Tests & verification

- [x] 4.1 Add/adjust unit tests for `promoteUnreleased`: (a) empty `[Unreleased]` throws; (b) `[Unreleased]` with a hand-written `_No user-facing changes._` line promotes and preserves it; (c) `[Unreleased]` with real bullets promotes as before
- [x] 4.2 Add/adjust a test (or manual check) that `bump-version.mjs` writes no version files when promotion throws
- [x] 4.3 Update or remove any existing test/assertion that expects `ChangelogHost` to mount in the workspace window
- [x] 4.4 Verify `release.sh` (and any CI release job) propagates the non-zero exit and surfaces the script's error message so a blocked release is obvious
- [x] 4.5 Manual smoke test in the manager window: the "Help: Show changelog" palette entry is present and opens the viewer; with a lower stored `changelog.lastSeenVersion`, the viewer auto-opens on launch highlighting newer versions; the workspace window no longer auto-opens the changelog
- [x] 4.6 Run `openspec validate fix-changelog-entries-and-window --strict` and the app type-check/lint
