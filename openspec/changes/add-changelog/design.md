## Context

Argus ships continuously (57 tags from `v0.1.1` to `v0.7.5` in ~8 weeks) through a highly automated pipeline: `scripts/release.sh` bumps the version across four files via `bump-version.mjs`, cuts a release branch, waits on CI, tags the merge commit, and `.github/workflows/release.yml` builds/signs/notarizes all four platforms and publishes a GitHub Release. Release notes for that GitHub Release are currently extracted (via `awk`) from `packages/app/CHANGELOG.md`, which is **auto-generated** by the `auto-changelog` npm package from raw commit/PR titles (headers of the form `#### [vX.Y.Z](compare-url)`).

Two problems: (1) that file is machine-generated noise, not curated notes, and lives inside a package folder rather than the repo root where contributors and GitHub expect it; (2) nothing surfaces changes to users — auto-update installs silently and users never learn what's new.

Relevant existing infrastructure the design reuses:
- **Command palette**: `src/platform/command-palette/CommandRegistry.ts` — commands registered via `CommandRegistry.register({ id, label, group, keywords, run })` inside `useEffect`, returning the unregister fn. Palette UI is `cmdk`-based.
- **Version at runtime**: `UpdaterProvider.tsx` already calls `getVersion()` from `@tauri-apps/api/app`; `useUpdater()` exposes `currentVersion`.
- **Modals**: Radix `@radix-ui/react-dialog` + shared `src/platform/shell/Dialog.module.css` (`.overlay` / `.content`, `--radius-xl` container). Full-view alternative: existing panels.
- **Settings persistence**: `src/platform/settings/` localStorage pattern (used for theme, panel state).
- **No markdown renderer exists** anywhere in the frontend — context docs are shown as plaintext `<pre>`. There is no `react-markdown`/`marked`/`markdown-it` dependency.
- **Assets/build**: Vite with `@/assets` alias; SVGs imported as URLs. No `?raw` imports yet.

## Goals / Non-Goals

**Goals:**
- One curated `CHANGELOG.md` at repo root as the single source of truth (Keep a Changelog + SemVer).
- GitHub Releases and the in-app viewer consume that same file — zero content duplication.
- Contributors edit an `[Unreleased]` section in their PRs; the release flow promotes it to a dated version section deterministically.
- An in-app viewer reachable from the command palette, DESIGN.md-compliant, current version highlighted, full history browsable.
- A "What's new" auto-open after an update, gated on a persisted last-seen version, dismissible.
- Backfill recent history so the file is useful on day one.

**Non-Goals:**
- Auto-generating changelog entries from PR labels / conventional commits (entries are hand-written; the old `auto-changelog` automation is retired, not replaced with new automation).
- Reading the changelog from a remote/GitHub at runtime (it is bundled at build time).
- A general-purpose markdown rendering engine for arbitrary docs (we render only our own, strictly-structured changelog).
- Localizing changelog content.
- Rust/backend changes or a new Tauri command.

## Decisions

### D1 — Location: curated `CHANGELOG.md` at repo root, retire the auto-generated one
The issue explicitly asks for a root file, and it is the GitHub convention (auto-linked on the repo page and in Releases). We **replace** `packages/app/CHANGELOG.md` + the `auto-changelog` flow rather than keep both, because "single source of truth" is a hard requirement and two changelogs guarantee drift. The old file's content is folded into the backfill; the file itself is deleted (its history remains in git). The `changelog` npm script and `auto-changelog` devDependency are removed.
- *Alternative considered*: keep the curated file at `packages/app/CHANGELOG.md` where `release.yml` already reads it (smaller diff). Rejected — violates the issue's explicit "raíz del repo" requirement and hides the file from the repo landing page.

### D2 — Format: Keep a Changelog, `## [X.Y.Z] - YYYY-MM-DD` headers, `### Added/Changed/Fixed/Removed`
Exactly the format the issue names. `[Unreleased]` stays pinned at the top. This is both human-friendly and trivially machine-sliceable for release-note extraction.

### D3 — Release-note extraction repointed to the root file (modifies `github-release-publishing`)
`release.yml`'s "Extract release notes" step changes its `CHANGELOG` path to root `CHANGELOG.md` and its `awk` matcher from `#### [vX.Y.Z]` to `## [X.Y.Z]` (header now also carries `- date`). The section body extracted for the tag is everything between that version's `## [` header and the next `## [` header. The existing auto-generated fallback (`generate_release_notes` when no matching section) is preserved for safety. This is the one modified capability.
- *Alternative considered*: a Node extraction script instead of `awk`. Rejected — `awk` already works and the header grammar is regular; keep the change minimal.

### D4 — Release flow promotes `[Unreleased]` → dated section
`bump-version.mjs` already knows the new `X.Y.Z`. Extend it (or a sibling step in `release.sh` invoked right after the bump) to rewrite `CHANGELOG.md`: rename the `## [Unreleased]` heading to `## [X.Y.Z] - <today>` and insert a fresh empty `## [Unreleased]` above it. Date is the release date in UTC (`YYYY-MM-DD`). This runs inside the same commit as the version bump (`chore: release vX.Y.Z`), so tag → file are consistent. If `[Unreleased]` is empty at release time, insert a single `_No user-facing changes._` line so the GitHub Release body is never blank (falls through to the generated-notes fallback otherwise).
- *Alternative considered*: a Git pre-tag hook. Rejected — release flow is script-driven and centralized; keep it in `release.sh`/`bump-version.mjs`.

### D5 — App consumes the changelog bundled at build time via a synced copy + Vite `?raw`
The app lives in `packages/app`; importing a file above the Vite root is awkward and fragile. Instead a tiny prebuild step (`scripts/sync-changelog.mjs`) copies root `CHANGELOG.md` → `packages/app/src/generated/changelog.md` (gitignored), wired into both the `dev` and `build` npm scripts. The viewer imports it with `import changelogRaw from "@/generated/changelog.md?raw"`. This guarantees the changelog bundled in a binary matches exactly what shipped in that version, with no runtime network/filesystem dependency.
- *Alternatives considered*: (a) Vite `server.fs.allow` + deep relative import of the root file — brittle across dev/build, ugly path. (b) Fetch from GitHub at runtime — network dependency, rate limits, and can show notes that don't match the installed binary. Both rejected.

### D6 — Parse into structured data rather than add a markdown renderer
No markdown renderer exists, DESIGN.md demands tight control (Geist type scale, violet-only accent, hairlines, specific radii), and our content is a strict Keep a Changelog subset. A ~focused parser (`parseChangelog(raw)`) turns the file into typed data — `{ version, date, groups: { Added: string[], Changed: [...], ... } }[]` plus an `unreleased` bucket — with inline `[text](url)` links preserved as a small render token. The viewer renders that model with our own components, which also makes the current-version highlight and the "since last seen" diff trivial (compare parsed versions by SemVer). The parser is pure and unit-tested (Vitest).
- *Alternative considered*: add `react-markdown` (+ `remark-gfm`). Rejected for v1 — extra dependency and bundle weight, weaker design control, and no need for general markdown. Documented as the fallback if we later want to render arbitrary markdown docs.

### D7 — Viewer surface: Radix Dialog modal reusing `Dialog.module.css`, `--radius-xl`
A modal (not a full tab) matches "What's new" affordances and the existing dialog vocabulary. Layout: title "What's new" / "Changelog", the running app version shown via `useUpdater().currentVersion` as a mono pill, a scrollable list of version blocks (most recent first), each with date and grouped change lists. The current version's block gets the accent left-edge stripe + `--accent-soft` tint (same treatment as active rows). Reduced-motion respected; palette open uses `--duration-medium`.

### D8 — Command palette entries under a "Help" group
Register in a `useChangelogCommands()` hook (mirrors `useDynamoCommands()` etc.), mounted in the shell:
- `argus.help.showChangelog` — label "Help: Show changelog", keywords `["changelog","release","notes","what's new","updates","version"]`.
- Optional alias `argus.help.whatsNew` — label "Help: What's new" pointing at the same open action. One command with rich keywords is enough; a second is only added if discoverability testing wants it.

### D9 — "What's new" on update, gated on persisted last-seen version
Persist `changelog.lastSeenVersion` via the existing `platform/settings` localStorage store. On app mount, once `currentVersion` resolves: if no stored value, seed it to the current version silently (don't nag existing users on first rollout). If stored `<` current (SemVer compare), auto-open the viewer highlighting versions newer than the stored one, then write `lastSeenVersion = currentVersion`. Manual open from the palette does not change gating. Auto-open is suppressed in non-Tauri (web/dev) runtime where `getVersion()` is unavailable, matching `UpdaterProvider`'s guard.

## Risks / Trade-offs

- **Backfill accuracy** → The existing `packages/app/CHANGELOG.md` maps commits→versions but not into Added/Changed/Fixed buckets. Mitigation: backfill is a best-effort editorial pass; recent `v0.7.x` gets careful curation, older versions may be terser. Accept imperfect history; the value is forward-looking.
- **Parser brittleness on malformed entries** → A contributor writes a heading the parser doesn't expect. Mitigation: parser is lenient (unknown `###` groups render under their literal name; non-list lines render as paragraph text), never throws, and has unit tests over the real file. A CI lint (optional) can validate the `[Unreleased]` shape.
- **Sync step forgotten** → If `sync-changelog.mjs` isn't wired into a build path, the app ships a stale/absent changelog. Mitigation: wire into both `dev` and `build` scripts; the import fails the build loudly if the generated file is missing, and the generated file is gitignored so it can't drift silently.
- **Release-note extraction regression** → Repointing `awk` could yield empty notes and silently fall back to generated notes. Mitigation: keep the deterministic fallback, and add a `release:dry` check that prints the sliced section for the pending version before tagging.
- **Empty `[Unreleased]` at release** → blank GitHub Release body. Mitigation: D4 inserts a placeholder line; fallback still covers it.

## Migration Plan

1. Add root `CHANGELOG.md` (Keep a Changelog skeleton + backfill). 
2. Add `sync-changelog.mjs` + wire `dev`/`build`; add `src/generated/` to `.gitignore`.
3. Build the parser + viewer + command registration + settings gating (behind nothing — safe to ship inert until the palette entry is used).
4. Update `release.yml` extraction (path + header regex), keeping the fallback.
5. Update `bump-version.mjs`/`release.sh` to promote `[Unreleased]`.
6. Remove `packages/app/CHANGELOG.md`, the `changelog` npm script, and the `auto-changelog` devDependency.
7. Update `README.md` release section + `/ship` skill notes.

**Rollback**: the change is additive on the app side (viewer does nothing harmful if the file is empty). If release-note extraction misbehaves, revert the `release.yml` step to the old path/regex and restore `packages/app/CHANGELOG.md` — both are isolated commits.

## Open Questions

- **Backfill depth**: full history back to `v0.1.1`, or only from a cutoff (e.g. `v0.7.0`) with older versions collapsed under a single "Earlier releases — see git history" note? Recommendation: curate `v0.7.x`, terse-backfill the rest.
- **Second palette command**: ship both "Show changelog" and "What's new" labels, or one with keywords? Recommendation: one command, rich keywords; revisit if QA finds discoverability gaps.
- **Optional CI lint** validating `[Unreleased]` structure on PRs — include now or defer? Recommendation: defer to a follow-up; not required for the single-source goal.
