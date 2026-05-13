## Why

The Postgres filter bar (`src/modules/postgres/data/filter-bar/`) and the Dynamo query builder (`src/modules/dynamo/data-view/QueryBuilder.tsx`) were built independently and look it: different paddings, different border radii (3px vs 5px), different background tokens (`--surface` vs `--canvas`), different focus-ring behavior, no shared rhythm. Worse, both reference design tokens that **do not exist** in `src/styles/global.css` — `--accent-soft`, `--accent-glow`, `--canvas`, `--elevated`, `--font-mono` — so styling falls back silently and the bars render duller and flatter than `DESIGN.md` prescribes. The current implementation also uses the blue accent from `global.css` (`#3b82f6`) instead of the **Argus violet** (`#A855F7`) mandated by `DESIGN.md`. This change redesigns both filter bars onto a single visual system grounded in `DESIGN.md` — the most-touched control surfaces in the app, and the loudest mismatch against the brand.

## What Changes

- Add the missing `DESIGN.md` tokens to `global.css` (violet accent, `--accent-soft`, `--accent-glow`, `--canvas`, `--elevated`, `--hairline`, radius scale, motion-duration scale, mono-font fallback) so token references in the filter bars resolve.
- **BREAKING (visual only):** Swap the accent palette from blue to **Argus violet** across the app. Affects every surface using `--accent`/`--accent-hover`/`--accent-soft`, not just the filter bars — but this is the right scope because the inconsistency is app-wide.
- Redesign the Postgres `FilterBar` surface: header, body, and action row share one rhythm (32px header / 32px action row, `--space-xs` vertical gap inside body, `--space-sm` horizontal padding). Mode toggle becomes a true segmented control with `--radius-md`. Apply gets the 3px accent halo on focus. Dirty dot becomes a `--space-2xs` (4px) violet pip aligned to the baseline of "Apply".
- Redesign the Dynamo `QueryBuilder` surface to match the same rhythm: same segmented control, same labels (uppercase 10px monospace with `+0.16em` tracking), same focus halo, same key-section / filter-section / preview layout treatment, same Run / Reset action row anchored at the bottom — so Postgres and Dynamo filter bars are visually interchangeable except for their bodies.
- Extract a small shared visual primitive layer: `FilterBarShell`, `FilterBarHeader`, `FilterBarBody`, `FilterBarActions`, `FilterSegmentedToggle`, `FilterTypeBadge`, `FilterConnector`, `FilterRowAddButton`. Both Postgres and Dynamo bodies plug into the same shell. CSS modules colocated next to the primitives.
- Add an empty state to both bars ("No filters — `+ AND row` or type `⌘F`" for Postgres; "No filters — Run scans everything" for Dynamo) instead of orphan whitespace.
- Add keyboard-hint chips (`⌘↵`, `⎋`) next to Apply/Reset, hairline-bordered, monospace, never primary-colored.
- Both bars: focus rings switch from the current border-only treatment to the `DESIGN.md` 3px violet glow on every focusable child (selects, inputs, buttons, segmented control). Hover surfaces unify on `--surface-2`.
- Both bars: respect `prefers-reduced-motion` — drop the 80ms transitions when reduced.
- Light-mode pass: filter bars currently look acceptable in dark and chalky in light. Re-tune surface and border tokens against the warm off-white spec in `DESIGN.md`.

Non-goals:
- No changes to filter semantics, operator sets, compilation, persistence, activity-log behavior, keyboard shortcuts, or any Tauri command shape.
- No changes to the data grid, results panel, inspector, or toolbar (except where they share tokens with the filter bars and benefit incidentally).

## Capabilities

### New Capabilities
- `filter-bar-visual-system`: A cross-module visual contract that defines the tokens, layout rhythm, focus-ring treatment, segmented-control behavior, empty/dirty/loading states, and keyboard-hint affordance that both the Postgres filter bar and the Dynamo query builder MUST implement. Owns the shared primitive components.

### Modified Capabilities
- `postgres-data-grid`: The "Filter bar surface" requirement gains an explicit conformance clause to `filter-bar-visual-system`. No behavioral scenarios change; new visual scenarios are added.
- `dynamo-data-view`: The "Structured query builder" requirement gains the same conformance clause. No behavioral scenarios change.

## Impact

- **Code:** `src/styles/global.css` (token additions, accent palette swap); new `src/modules/shared/filter-bar/` primitive layer; `src/modules/postgres/data/filter-bar/FilterBar.tsx` + `FilterBar.module.css` (refactor to consume primitives); `src/modules/dynamo/data-view/QueryBuilder.tsx` + `QueryBuilder.module.css` (same); minor token consumers across the app inherit the violet accent.
- **Visual regression risk:** every surface using `--accent*` will shift hue (blue → violet). Mitigated by manual screenshot pass on each tab kind before merge. No layout shifts expected.
- **Dependencies:** none new. Geist is still loaded only if already wired (no font-loader added in this change — falls back to the system stack until a separate font-setup change lands; the visual rhythm holds either way).
- **Tests:** existing Vitest unit tests for `FilterBar`, `QueryBuilder`, and their children must keep passing without modification (props/behavior unchanged). Add light snapshot tests for the new shared primitives.
- **Docs:** `DESIGN.md` decisions log gets a 2026-05-13 entry noting the filter-bar unification; `design/preview.html` gets a new section rendering both bars side-by-side at default + dirty + empty states.
