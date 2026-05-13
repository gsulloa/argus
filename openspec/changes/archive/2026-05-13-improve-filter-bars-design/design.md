## Context

Two filter surfaces — `src/modules/postgres/data/filter-bar/FilterBar.tsx` (298 LOC) and `src/modules/dynamo/data-view/QueryBuilder.tsx` — were built ~6 months apart by different sub-features. They are the highest-traffic controls in the app: the user touches them every time they open a table. Both reference `DESIGN.md` tokens that are not declared in `src/styles/global.css`, so styling resolves to fallbacks and the bars look like generic SaaS chrome rather than the "Watchful Precision" instrument `DESIGN.md` describes. Independently, both bars have minor rhythm and density bugs that compound: orphan spacers (`FilterBar.tsx` L170), inconsistent radii (3px vs 5px), missing focus rings on Postgres inputs, mixed background tokens on Dynamo (`--canvas` + `--surface` + `--elevated` interleaved).

The DESIGN.md system is partially built. `global.css` defines `--surface`, `--surface-2`, `--text`, `--border`, `--border-strong`, `--accent` (blue), `--text-subtle`, but is missing `--canvas`, `--elevated`, `--accent-soft`, `--accent-glow`, `--hairline`, the radius scale, the duration scale, and the proper violet accent. The brand mismatch (blue accent in a violet design system) reaches further than the filter bars — but the filter bars are where the cost is most visible, so this change uses them as the forcing function to land the token correction.

## Goals / Non-Goals

**Goals:**
- Postgres filter bar and Dynamo query builder share one visual rhythm, one focus-ring treatment, one set of primitives, and one set of tokens.
- All tokens referenced by either bar resolve in `global.css` (no silent fallbacks).
- Accent palette aligns with `DESIGN.md` (violet, not blue).
- Both bars match `DESIGN.md` for: typography scale, letter spacing on labels, radius scale, spacing scale, motion durations, focus halo, hover surface.
- Preserve every behavioral contract: keyboard shortcuts, draft/applied state, compilation rules, activity-log emission, persistence keys. Behavioral spec scenarios continue to pass without modification.
- Light mode is tuned, not inverted.

**Non-Goals:**
- No new filter capabilities (no operators added, no Saved-Filters UI, no Cmd+F any-column shortcut).
- No font-loading wiring. If Geist is not already loaded, the bars fall back to the system stack; the rhythm is what carries the design, not the font face.
- No restyling of the data grid, results panel, inspector, or surrounding toolbar (those incidentally inherit accent-color updates but layout/density is untouched).
- No animation work beyond honoring `prefers-reduced-motion` and the existing 80ms hover transition.

## Decisions

### D1. Single shared primitive layer at `src/modules/shared/filter-bar/`

**Choice:** Extract `FilterBarShell`, `FilterBarHeader`, `FilterBarBody`, `FilterBarActions`, `FilterSegmentedToggle`, `FilterTypeBadge`, `FilterConnector`, `FilterRowAddButton`, `FilterKeyHint` into a `shared/filter-bar/` directory. Each primitive ships with its own colocated `.module.css`. Both Postgres `FilterBar` and Dynamo `QueryBuilder` are rewritten to compose these primitives.

**Why over alternatives:**
- *Inline duplicate styles in each module:* status quo. Fast to ship, guarantees future drift. Rejected — this change exists specifically to stop the drift.
- *Generalized `FilterBuilder<T>` component that owns the body too:* over-fits. Postgres has AND-root + OR groups + Raw mode; Dynamo has Scan/Query + key pickers + Preview disclosure. The bodies share **no** structural code. Forcing one component to render both bodies would require a render-prop or strategy pattern that obscures more than it shares.
- *Tokens-only unification (no primitives):* loses ~70% of the win. The orphan-spacer / 32px-rhythm / dirty-dot-alignment bugs all live in JSX, not tokens.

The primitive layer owns only chrome (shell, header, action row, segmented control, type badge, connector strip, "+ row" button, key-hint chip). Bodies stay module-owned.

### D2. Land the violet accent app-wide, not just in the filter bars

**Choice:** Replace the blue accent in `global.css` with the `DESIGN.md` violet (`#A855F7` dark / `#7C3AED` light) and add `--accent-soft`, `--accent-glow`, `--accent-hover`. The change ripples to every surface that already uses `--accent`.

**Why:** Local override (filter bars only) means we ship a UI where the filter bars are violet and the rest of the app is blue. That is worse than either state. The mismatch is small in surface area (the accent is used sparingly per `DESIGN.md`: active connection stripe, active tab underline, active row, palette match, primary CTA, focus ring, PK marker) and the violet was always the intended brand. A pure CSS-variable swap is reversible in one commit.

**Risk → Mitigation:** [Visual regression on non-filter surfaces] → screenshot pass over: title bar, sidebar (active connection stripe), tabstrip (active underline), command palette (match highlight + active row), data grid (active row stripe), inspector (PK marker), all primary CTAs. Manual QA only — no test infra for visual regression today.

### D3. Layout rhythm: 32 / body / 32

**Choice:** Both bars use a 32px header (mode toggle + collapse), a flexible body (`--space-xs` 8px vertical gap, `--space-sm` 12px horizontal padding), and a 32px action row (Reset / Open in SQL Editor / Apply for Postgres; Reset / Run for Dynamo). Header and action row are separated from the body by 1px `--border` hairlines. The body's first and last rows have no extra padding past the body padding — the hairlines own the visual separation.

**Why over alternatives:**
- *Compact 28px rows:* tested mentally against `DESIGN.md` spacing tokens. 28 isn't on the grid (4/8/12/16/24…). 32 is `--space-xl` and matches the existing tab-strip height — the filter bar header docking under the tab strip reads as one continuous chrome strip.
- *Padded 40px header:* breathes too much; this is a power tool, not a marketing page.

### D4. Segmented control = single primitive, two consumers

**Choice:** `FilterSegmentedToggle` accepts `options: Array<{ id, label, badge? }>` and `value`/`onChange`. Renders as:
- Inline-flex container, 1px `--border-strong`, `--radius-md` (5px), `overflow: hidden`, height 24px.
- Each option: `padding: 3px 10px`, `font-size: 11px`, `font-weight: 500`, `font-family: var(--font-stack)`, `letter-spacing: 0`.
- Inactive: `color: var(--text-muted)`, transparent bg.
- Hover (inactive): bg `var(--surface-2)`, color `var(--text)`.
- Active: bg `var(--accent-soft)`, color `var(--accent)`, no inset border (the segmented border owns the divider).
- Focus-visible on any option: 3px `var(--accent-glow)` halo using `box-shadow` (not `outline`) inset by 1px so it pops outside the segmented border.
- Dividers between options: 1px `var(--border-strong)` (matches container border) — already implicit in current Dynamo impl, missing in Postgres.

**Why:** Today Postgres uses `--radius-sm` (3px), Dynamo uses `--radius-md` (5px), they pick different font-weights, and Postgres has no inter-option divider. One primitive eliminates the question.

### D5. Focus halo = `box-shadow`, not `outline`

**Choice:** Every interactive child uses `box-shadow: 0 0 0 3px var(--accent-glow)` paired with `border-color: var(--accent)` on focus-visible.

**Why over `outline`:**
- `outline` doesn't follow `border-radius` cleanly on older Safari (which is the WebView Tauri uses on macOS — relevant). `box-shadow` does.
- `outline` paints outside the element; in a dense bar with `gap: 6px`, the 3px outline overlaps the neighbor and creates moire. `box-shadow` with the same neighbor-padding looks fine because it composites against the surface below.
- Reduced-motion users keep the halo; we only drop the 80ms transition.

### D6. Dirty indicator: violet pip, baseline-aligned, not a "● " glyph

**Choice:** Today the dirty dot is a 6px `border-radius:999` span set inline before the "Apply" text inside the button (`FilterBar.module.css` `.dirtyDot`). Change to a 4px (`--space-2xs`) pip rendered as a `::before` pseudo on the Apply button, absolutely positioned at the top-right of the button (offset −2 / −2), with a 2px ring of `--accent` against the button face. Reads as a "notification badge" on the primary action, which is the universal idiom and survives smaller button widths.

**Why:** The inline dot pushes the "Apply" text by 12px when present, so the button width changes between clean and dirty states. The right-edge pip is layout-stable and more visually conventional.

### D7. Empty state, not orphan whitespace

**Choice:** When the Postgres body has zero conditions and zero OR groups, render:

```
No filters · + AND row · + OR group
```

as a single 24px row with `color: var(--text-subtle)`, `font-size: 11px`, the two add-row buttons rendered inline (not as a separate "actions" row below). When the Dynamo filter section has zero filter rows, render `No filters · + Filter` similarly. The Dynamo key-section has its own empty state already (placeholder text in the PK input) and is left alone.

**Why:** Today an empty Postgres bar is a 6px-gap flex column with `.empty` rendering "No conditions added" in italics and then the two add buttons live in a separate row below — two rows of whitespace where one row of intent would do.

### D8. Keyboard hint chips

**Choice:** Render `⌘↵` next to the Apply button (Postgres) and the Run button (Dynamo), `⎋` next to Reset, `⌘⇧R` next to Dynamo Reset. Chips: `padding: 1px 5px`, `font-family: var(--font-mono)`, `font-size: 10px`, `letter-spacing: 0.16em`, `border: 1px solid var(--border)`, `border-radius: var(--radius-sm)` (3px), `color: var(--text-subtle)`, no background. Reserved type, never violet.

**Why:** Both bars already bind these shortcuts but only document them in tooltips or not at all. Inline chips raise discoverability with minimal real estate (the action row already has spacer room).

### D9. Token additions, not token replacements

**Choice:** Add to `global.css`:

```css
:root[data-theme="dark"] {
  --canvas: #0B0B0F;
  --elevated: #15151B;
  /* surface, surface-2 already exist; align surface = #1C1C24, surface-2 = #23232C */
  --hairline: rgba(255,255,255,0.04);
  --accent: #A855F7;            /* was #3b82f6 */
  --accent-hover: #C084FC;
  --accent-soft: rgba(168,85,247,0.12);
  --accent-glow: rgba(168,85,247,0.18);
  --accent-text: #FFFFFF;       /* keep */
  --radius-sm: 3px;
  --radius-md: 5px;
  --radius-lg: 8px;
  --radius-xl: 12px;
  --radius-full: 999px;
  --space-2xs: 4px;
  --space-xs: 8px;
  --space-sm: 12px;
  --space-md: 16px;
  --space-lg: 24px;
  --duration-instant: 80ms;
  --duration-short: 120ms;
  --duration-medium: 180ms;
}
:root[data-theme="light"] {
  /* warm off-white treatment per DESIGN.md */
  --canvas: #FAFAF9;
  --elevated: #FFFFFF;
  --hairline: rgba(0,0,0,0.04);
  --accent: #7C3AED;
  --accent-hover: #6D28D9;
  --accent-soft: rgba(124,58,237,0.10);
  --accent-glow: rgba(124,58,237,0.16);
  /* radius/space/duration shared across themes */
}
```

Tokens already in `global.css` and used today (`--surface`, `--surface-2`, `--text`, `--text-muted`, `--text-subtle`, `--border`, `--border-strong`, `--bg-hover`, `--font-stack`, `--font-mono`) keep their names. `--surface` and `--surface-2` get re-tuned in dark to match `DESIGN.md` (#1C1C24 / #23232C) — minor shift from current #1f1f23 / #26262b.

**Why not rename:** every consumer in the app uses the existing names. A rename is mechanical and noisy. Re-tuning the hex inside existing names is one-line and invisible to call sites.

### D10. Body refactor strategy: rewrite, not refactor

**Choice:** Replace `FilterBar.module.css` and `QueryBuilder.module.css` wholesale rather than incrementally edit them. Both files are ≤465 LOC and full of orphan classes from earlier iterations. A clean rewrite is shorter than the diff to patch them.

**Why:** Trying to land the rhythm/radius/focus changes via `Edit` ends up touching every selector and risks leaving dead class names behind. Wholesale rewrite is auditable and lets us delete fully.

## Risks / Trade-offs

- **[App-wide violet swap may surprise users on next launch]** → Mitigation: include in the change's release-notes entry. Reversible with one revert if pushback. No data is migrated; this is purely visual.
- **[Shared primitive layer adds an indirection for future filter-bar work]** → Mitigation: keep the primitives dumb (no business logic, no state, just chrome). Anyone editing a bar can copy a primitive's CSS verbatim if the abstraction stops fitting; primitives are deletable.
- **[`box-shadow` focus halo composites with `overflow: hidden` containers]** → Mitigation: the segmented-control container uses `overflow: hidden` so the per-option halo is clipped. Solved by switching the container to `overflow: visible` and moving the rounded corners to the segmented buttons themselves at the ends (first-child / last-child).
- **[Light-mode contrast on `--accent-soft` over `--canvas` (`#FAFAF9`) is faint]** → Mitigation: use `rgba(124,58,237,0.10)` (vs 0.12 in dark) and verify against WCAG AA for the "active mode" segmented state. Acceptable because it's a state indicator paired with the violet text color, not a sole signal.
- **[Geist not loaded → mono chips look identical to body text]** → Mitigation: `--font-mono` already falls back to `ui-monospace, SFMono-Regular, Menlo, …` in `global.css`. Acceptable until the Geist-loading change lands.
- **[`prefers-reduced-motion` users still want hover feedback]** → Mitigation: keep the color change, drop only the `transition` declaration. Test by toggling System Preferences → Accessibility → Display → Reduce motion.

## Migration Plan

Single PR, no flag, no staged rollout. Manual screenshot QA pass over the surfaces listed in D2 before merge. Rollback is `git revert` of the single commit — no data migration, no user-visible state to preserve.

## Open Questions

- Should the segmented control gain a slim 1px violet underline on the active option (in addition to `--accent-soft` bg + `--accent` text), echoing the active-tab underline elsewhere in the app? Leaning **no** — the tab strip already owns that motif and a second instance dilutes it. Confirm during design-review.
- Should the keyboard-hint chips suppress themselves on touch devices? The Tauri build is desktop-only today; deferring this question until/unless a touch target appears.
- Does `design/preview.html` need to be regenerated as part of this change or as a follow-up? Including in this change's scope — the preview is the source of truth for "how the system reads in context" per `CLAUDE.md`.
