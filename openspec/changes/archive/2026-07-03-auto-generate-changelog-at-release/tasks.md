## 1. Config surface

- [x] 1.1 In `packages/app/scripts/bump-version.mjs`, add exported constants near the top: `ALLOWED_TYPES` (map `feat`→`Added`, `fix`→`Fixed`, `perf`→`Changed`), `DENIED_SCOPES` (`["landing"]`), `REPO_URL` (`https://github.com/gsulloa/argus`), and the skip patterns for merge/back-merge/release subjects (`/^Merge /`, `/^chore:\s*(back-merge|release)\b/`)

## 2. Pure derivation helpers (unit-testable, no git)

- [x] 2.1 Add and export `parseCommitSubject(subject)` → `{ type, scope, description, breaking, prNumbers: number[] } | null`; parse `type(scope)!: description (#N) (#M)` capturing all trailing `(#N)` groups; return `null` on no match
- [x] 2.2 Add and export `existingPrNumbers(unreleasedBody)` → `Set<number>` parsing every `#NNNN` occurrence in the given `## [Unreleased]` body text
- [x] 2.3 Add and export `deriveEntries(subjects, { allowedTypes, deniedScopes, skipPatterns, repoUrl })` → `{ Added: string[], Changed: string[], Fixed: string[], ... }` of rendered bullets, each `- <description> ([#N](repoUrl/pull/N))` (no link when no PR number); skip subjects that are unparseable, matched by a skip pattern, of a non-allowed type, or a denied scope; carry each entry's `prNumber` so 3.x can dedup
- [x] 2.4 Add and export `mergeUnreleased(handWrittenBody, derivedGroups, existingPrs)` → the merged `## [Unreleased]` body: keep hand-written lines first within each group, append auto entries whose `prNumber ∉ existingPrs`, omit empty groups, order groups `Added, Changed, Fixed, Removed`

## 3. Wire derivation into promotion

- [x] 3.1 Add an impure `readCommitSubjectsSinceLastTag()` using `node:child_process execFileSync`: `git describe --tags --abbrev=0` then `git log <tag>..HEAD --format=%s`; on any git error (incl. no tag) return `[]` and warn, so the bump never crashes and falls back to hand-written-only
- [x] 3.2 Update `promoteUnreleased` (or a wrapper) to: extract the current `[Unreleased]` body, compute `existingPrs`, derive entries from the provided subjects, merge, then promote the merged body. Remove the fail-on-empty `throw` introduced by `fix-changelog-entries-and-window`
- [x] 3.3 If the merged body has no bullets in any group, promote with the `_No user-facing changes._` placeholder instead of throwing (internal-only fallback)
- [x] 3.4 In `main()`, read the subjects (3.1) and pass them into promotion; keep promotion computed BEFORE writing version files (preserve the no-partial-bump ordering from `fix-changelog-entries-and-window`)

## 4. Tests

- [x] 4.1 `parseCommitSubject`: real repo subjects (`feat(postgres): … (#233)`, `fix(saved-queries): … (#220)`, `chore: back-merge …`, `Merge pull request …`, `feat(landing): … (#224)`, a `feat!:` breaking subject, and a non-conforming line)
- [x] 4.2 `deriveEntries`: correct type→group mapping; excludes `chore`/`ci`/`docs`/`refactor`/merge/release and `landing` scope; renders PR links; handles a subject with no PR number
- [x] 4.3 `existingPrNumbers`: parses `[#229](…)` and bare `(#221)` forms; empty body → empty set
- [x] 4.4 `mergeUnreleased`: hand-written entry for `#229` present → no duplicate auto entry for `#229`; auto entries for un-listed PRs appended under correct groups; group ordering and empty-group omission
- [x] 4.5 End-to-end `promoteUnreleased` with injected subjects: (a) hand-written + auto merge and promote; (b) only chores/landing → internal-only placeholder, no throw; (c) hand-written only, no subjects → unchanged behavior
- [x] 4.6 Confirm the previously-added fail-on-empty test is replaced by the internal-only-fallback test

## 5. Docs & validation

- [x] 5.1 Update the "Contributing" note at the top of `CHANGELOG.md` (and any README/spec text) to describe the new model: entries are auto-generated from PR titles at release; hand-write a bullet under `## [Unreleased]` only when you want better prose than the title
- [x] 5.2 Read `release.sh` to confirm the generated `CHANGELOG.md` is staged/committed on the release branch (line ~270) and thus visible in the `release/vX` → master PR for review; note any gap
- [x] 5.3 Run `openspec validate auto-generate-changelog-at-release --strict`, plus `pnpm typecheck` and the bump-version unit tests; fix anything introduced
