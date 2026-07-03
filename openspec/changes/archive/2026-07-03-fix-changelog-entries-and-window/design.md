## Context

The changelog subsystem (shipped by the `add-changelog` change) has three moving parts:

- **Source of truth**: root `CHANGELOG.md`, Keep a Changelog format, edited by hand.
- **Release promotion**: `packages/app/scripts/bump-version.mjs` → `promoteUnreleased(text, version, date)` renames `## [Unreleased]` to a dated section and inserts a fresh empty `## [Unreleased]`. Today, when the `[Unreleased]` body has no non-blank line, it inserts `["", "_No user-facing changes._"]` so the GitHub release body is never empty (`bump-version.mjs:137`).
- **In-app viewer**: `ChangelogHost` (`packages/app/src/platform/changelog/ChangelogHost.tsx`) registers the palette command, resolves the running version via `useUpdater`, persists `changelog.lastSeenVersion` via `useSetting`, and auto-opens `ChangelogViewer` after an update. It is currently mounted in `ShellMain` (`App.tsx:77`), which only renders in the **workspace** window.

Two failures fall out of this:

1. `v0.7.6` and `v0.8.0` were bumped with an empty `[Unreleased]` (contributors didn't add entries), so both got the silent placeholder — even though both shipped real user-facing work (SQL streaming `#233/#237`, dynamic AI model discovery `#227/#235`, per-conversation AI provider/model selector `#226/#232`, active-connection color in header `#228/#231`, per-connection Context Queries `#229`, Postgres SQL row copy `#221`, interval/oid/inet/xid cell rendering fix `#219`, saved-query tab surfacing fix `#220`).
2. The `manager` (connections) window is the surface shown on launch and after an auto-update, but it never mounts `ChangelogHost` — the host lives only in the workspace, which opens on-demand after a connection is picked. So the after-update "What's new" prompt is easy to miss.

Both windows already wrap their shell in the same `AppProviders` pyramid (`ManagerApp.tsx`, `WorkspaceApp.tsx`), which includes `UpdaterProvider` and `PaletteProvider`. `ChangelogHost`'s dependencies (`useUpdater`, `useSetting`, `CommandRegistry`) are therefore satisfied in the manager window without any provider change.

## Goals / Non-Goals

**Goals:**
- Correct the `v0.7.6` and `v0.8.0` changelog sections with accurate, grouped entries.
- Make a forgotten changelog edit fail the release loudly instead of producing a misleading "No user-facing changes." note.
- Keep an explicit, low-friction path for genuinely internal-only releases.
- Move the changelog host to the connections (manager) window so the palette entry and the after-update prompt appear on the launch surface.

**Non-Goals:**
- No auto-generation of changelog text from commit messages or PR labels — entries remain hand-written (existing project rule stands).
- No changes to `ChangelogViewer` rendering, the parser, or the last-seen persistence semantics.
- No re-tagging or re-release of `v0.7.6` / `v0.8.0`; we only correct `CHANGELOG.md` going forward (the next build bundles the corrected file).
- No new marker syntax — the existing `_No user-facing changes._` line, when written by hand, is the opt-in.

## Decisions

### Decision 1: Fail on empty `[Unreleased]`; reuse the existing placeholder line as the explicit opt-in

`promoteUnreleased` currently auto-inserts the placeholder when the body is empty. We remove that branch: when the `[Unreleased]` body has no non-blank line, the function throws a descriptive error and `bump-version.mjs` exits non-zero without writing any files. Because `hasContent` already treats any non-blank line as content, a maintainer who genuinely has nothing user-facing simply writes `_No user-facing changes._` under `## [Unreleased]` themselves — it then counts as content and is promoted verbatim. This keeps the opt-in explicit and intentional with zero new syntax.

- **Why over alternatives**: A boolean CLI flag (`--allow-empty-changelog`) was considered, but a flag is invisible in the repo history, whereas a hand-written marker line is a reviewable, auditable artifact in the same commit. Auto-deriving entries from `git log` was rejected — it violates the standing "no auto-generation" rule and is exactly the kind of plausible-but-wrong output that caused this bug.

### Decision 2: Validate the changelog before mutating any version file

`main()` writes `tauri.conf.json`, `package.json`, `Cargo.toml`, and `Cargo.lock` before touching `CHANGELOG.md`. If promotion throws after those writes, the repo is left in a half-bumped state. We reorder `main()` to compute the promoted changelog text **first** (calling `promoteUnreleased`, which now throws on empty), and only proceed to write the version files and the changelog once promotion succeeds. On failure, nothing is written and the process exits non-zero. `promoteUnreleased` stays a pure function (throws instead of returning), so its unit tests stay simple.

- **Why**: Fail-fast with no partial mutation is the least surprising behavior for a release script and avoids leaving a dirty tree the maintainer must manually revert.

### Decision 3: Move `<ChangelogHost />` from `ShellMain` to `ManagerShell`

Remove `<ChangelogHost />` (and its import) from `ShellMain` in `App.tsx`, and mount it in `ManagerShell.tsx` alongside the already-present `<Palette />` and `<FeedbackHost />`. No change to `ChangelogHost.tsx` itself. This puts the palette command and the after-update auto-open in the window that exists at launch. It also removes a latent double-mount risk: had the workspace opened during the same session, two hosts would have shared the `changelog.lastSeenVersion` setting and could have raced on the gating effect.

- **Why over conditional rendering by window label**: Mounting in `ManagerShell` is the codebase's existing idiom for "manager-only concern" (compare `ManagerShortcuts`), and it's clearer than a `windowLabel === "manager"` guard inside a shared component.

### Decision 4: Curate the backfill from merged PRs, excluding landing-site-only changes

The bundled changelog is the desktop app's changelog. Landing/marketing-site PRs (`#224`, `#225`, `#234` — privacy/terms pages, open-source status on the site) are not app-facing and are omitted from the app changelog. The backfilled `v0.7.6` / `v0.8.0` entries cover the desktop-app-facing PRs listed in Context, grouped under Added/Changed/Fixed. Exact wording is finalized during implementation (tasks.md) using each PR title/description.

- **Why**: Users reading the in-app "What's new" care about app behavior; site changes would be noise. This matches how existing sections (e.g. `v0.7.x`) are curated.

## Risks / Trade-offs

- **[A release could now be blocked at an inconvenient moment]** → The unblock is a one-line edit (`_No user-facing changes._`) the maintainer can add in seconds; the error message states exactly this. Net safer than shipping a wrong note.
- **[CI/release wrappers that call `bump-version.mjs` may not surface the non-zero exit clearly]** → Verify `release.sh` / any CI job propagates the failure and prints the script's stderr; covered as a task.
- **[`useSetting`/`useUpdater` behave differently in the manager window]** → Both providers are in the shared `AppProviders` pyramid and the settings backend is window-agnostic; low risk, but a manual smoke test (launch → manager shows palette entry; simulate lower last-seen → auto-open) is included.
- **[Backfill wording drifts from what actually shipped]** → Derive each bullet from the specific PR (numbers enumerated in Context) and link the PR, matching the format of existing sections.

## Migration Plan

1. Land the code + tooling change and the `CHANGELOG.md` backfill together.
2. The next build's `sync-changelog.mjs` prebuild bundles the corrected `CHANGELOG.md`; no runtime migration, no data reset. `changelog.lastSeenVersion` semantics are unchanged.
3. Rollback is a plain revert — no persisted state or schema is affected.

## Open Questions

- Should the internal-only marker be standardized to a single canonical string (e.g. exactly `_No user-facing changes._`) that the script recognizes explicitly, rather than "any non-blank line counts"? Current design keeps "any non-blank content = intentional," which is simplest; tighten only if maintainers want a stricter guard.
