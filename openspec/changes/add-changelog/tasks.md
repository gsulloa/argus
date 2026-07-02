## 1. Curated root changelog

- [x] 1.1 Create `/CHANGELOG.md` at the repo root with the Keep a Changelog skeleton: intro line, a pinned `## [Unreleased]` section, and the `### Added/Changed/Fixed/Removed` group convention documented at the top.
- [x] 1.2 Backfill the `v0.7.x` releases as curated, grouped, dated `## [X.Y.Z] - YYYY-MM-DD` sections, sourcing content from tags/PRs and the existing `packages/app/CHANGELOG.md`.
- [x] 1.3 Backfill older releases (`v0.1.x`–`v0.6.x`) at least as dated version headers (terser entries acceptable per design decision on backfill depth).

## 2. Bundle the changelog into the app

- [x] 2.1 Add `packages/app/scripts/sync-changelog.mjs` that copies root `CHANGELOG.md` → `packages/app/src/generated/changelog.md`.
- [x] 2.2 Wire the sync step into both `dev` and `build` npm scripts in `packages/app/package.json`.
- [x] 2.3 Add `packages/app/src/generated/` to `.gitignore`.
- [x] 2.4 Add a Vite `?raw` type declaration (if needed) and verify `import changelogRaw from "@/generated/changelog.md?raw"` resolves in dev and build.

## 3. Changelog parser

- [x] 3.1 Implement `parseChangelog(raw)` producing typed data: an `unreleased` bucket plus an ordered list of `{ version, date, groups: { Added, Changed, Fixed, Removed, ...unknown } }`, preserving inline `[text](url)` links as render tokens.
- [x] 3.2 Make the parser lenient — never throw; unknown `###` groups render under their literal name, non-list lines become text.
- [x] 3.3 Add Vitest unit tests covering the real bundled file, an empty `[Unreleased]`, and a malformed heading.

## 4. Changelog viewer UI

- [x] 4.1 Build the viewer as a Radix Dialog reusing `src/platform/shell/Dialog.module.css` (`--radius-xl`), rendering parsed versions newest-first with grouped change lists, per DESIGN.md (Geist scale, violet-only accent, hairlines, motion tokens).
- [x] 4.2 Show the running app version (via `useUpdater().currentVersion` / `getVersion()`) as a mono pill and highlight the matching version section with the active-surface accent treatment (left stripe + `--accent-soft`).
- [x] 4.3 Render inline links; respect `prefers-reduced-motion`; open with `--duration-medium`.

## 5. Command palette + "What's new" gating

- [x] 5.1 Add a `useChangelogCommands()` hook registering `argus.help.showChangelog` ("Help: Show changelog") with keywords `changelog, release, notes, what's new, version`; mount it in the shell.
- [x] 5.2 Persist `changelog.lastSeenVersion` via the `platform/settings` localStorage store.
- [x] 5.3 On mount, after `currentVersion` resolves: seed last-seen silently if unset; if stored `<` current (SemVer compare), auto-open the viewer highlighting versions newer than last-seen, then update last-seen. Suppress auto-open in non-Tauri runtime. Manual palette open must not mutate last-seen.

## 6. Release flow integration

- [x] 6.1 Extend `packages/app/scripts/bump-version.mjs` (or a sibling step invoked from `release.sh`) to promote `## [Unreleased]` → `## [X.Y.Z] - <UTC date>` and insert a fresh empty `## [Unreleased]` above it, within the release commit.
- [x] 6.2 Insert a placeholder line (e.g. `_No user-facing changes._`) when `[Unreleased]` is empty at promotion time.
- [x] 6.3 Update `.github/workflows/release.yml` "Extract release notes" step: point `CHANGELOG` at root `CHANGELOG.md` and change the `awk` matcher to the `## [X.Y.Z]` header grammar, slicing until the next `## [`; keep the auto-generated fallback.
- [x] 6.4 Verify extraction with `release:dry` (print the sliced section for a sample version).

## 7. Retire the auto-generated changelog

- [x] 7.1 Remove `packages/app/CHANGELOG.md`.
- [x] 7.2 Remove the `changelog` npm script and the `auto-changelog` dev dependency from `packages/app/package.json`.

## 8. Docs

- [x] 8.1 Update `README.md` release section to describe the single-source root `CHANGELOG.md` flow and the in-app viewer.
- [x] 8.2 Note the `[Unreleased]`-editing convention where contributors will see it (README and/or `/ship` skill notes).

## 9. Verify

- [x] 9.1 `pnpm --filter argus typecheck`, `lint`, and `test:run` pass.
- [ ] 9.2 Manual: open the viewer from the palette; confirm current-version highlight; simulate a stale `lastSeenVersion` and confirm auto-open + highlight of new versions; confirm design conformance against DESIGN.md.
- [x] 9.3 Confirm a production build bundles the current changelog and no runtime fetch occurs.
