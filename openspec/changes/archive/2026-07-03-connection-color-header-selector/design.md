## Context

Connection colors already exist end-to-end: an 8-key palette (`violet`, `blue`, `green`, `amber`, `red`, `teal`, `pink`, `gray`) defined in `platform/connection-registry/colors.ts`, exposed as `--conn-color-*` CSS vars (light/dark) in `styles/global.css`, with helpers `connectionColorVar(key)` and `isConnectionColor(value)`. Today the color surfaces only as (a) the environment indicator dot in the connection rail and (b) an 8×8px swatch in `ConnectionRow`. It is not present in the workspace header, so once a view is open there is no persistent per-connection signal in the work area.

The connection identity header is `ConnectionIdentityHeader` in `platform/shell/WorkspaceShell.tsx` (~L299–365, styles in `WorkspaceShell.module.css` ~L31–119). It already resolves the **focused connection** via the `connectionId` prop (from `useFocusedConnection()`) and looks up the full record with `useConnections()`, so `connection.color` is available where the header renders. This header sits above every engine's tree/tab content and re-renders when the focused connection changes — making it the single, engine-agnostic place to reflect the active connection's color (no per-engine changes needed).

`DESIGN.md` reserves the violet `--accent` for a fixed set of loud affordances and restricts the connection palette to "small dots/swatches only — never row backgrounds, never large fills." Any header/selector treatment must respect this: hairline stripes, borders, and soft tints only.

## Goals / Non-Goals

**Goals:**
- Reflect the focused connection's color as a restrained accent on the shared identity header, driven by `connection.color`.
- Update the header instantly when the focused connection changes (already reactive via `useFocusedConnection()`).
- Keep current header styling exactly when the connection has no color.
- Make the connection color read more prominently in the selector (rail dot + sidebar swatch) without violating `DESIGN.md` restraint.
- Work in both light and dark themes without hurting contrast.

**Non-Goals:**
- No changes to the color palette, keys, helpers, or data model / backend.
- No per-engine header rewrites — the shared identity header carries the signal for all engines.
- Not painting the tab strip underline per-connection-color (the accent underline is a separate `DESIGN.md` affordance reserved for violet); can be revisited later.
- No full-background color fills anywhere.

## Decisions

### Decision 1: Reflect color via a header accent stripe/border, not a background fill
Apply the connection color as a **top accent stripe** (or left border) on `.identityHeader`, plus an optional very-soft tint if contrast allows. Drive it with a CSS custom property set inline from `connectionColorVar(connection.color)` (mirroring the existing swatch pattern: `style={{ "--header-accent": connectionColorVar(color) }}`), gated behind a `data-colored` attribute so the stripe only renders when a color is set.

- **Why**: A hairline stripe is the least-invasive persistent signal, matches the "small dots/swatches, no large fills" rule, and preserves text contrast in both themes since the `--conn-color-*` vars already carry theme-appropriate shades.
- **Alternatives considered**: (a) Full tinted background — rejected, degrades legibility and violates restraint. (b) Recoloring the engine icon — too subtle and conflicts with engine identity. (c) Coloring the connection name text — hurts readability, especially for light shades.

### Decision 2: Gate all header color on `isConnectionColor(connection.color)`
When `connection.color` is `null`/absent, render `.identityHeader` exactly as today (no stripe, no attribute). Use the existing `isConnectionColor()` guard so an unexpected stored value never leaks into inline styles.

- **Why**: The acceptance criteria require zero visual change for uncolored connections, and the guard is the established pattern in `ConnectionRow`.

### Decision 3: Reactivity comes for free from the focused-connection flow
The header already re-renders on focus change (the tree column remounts the subtree and `useFocusedConnection()` updates). Because the accent is derived purely from `connection.color` on each render, switching connections/tabs recolors the header with no extra wiring.

- **Why**: Avoids introducing new state or effects; keeps the change to presentation only.

### Decision 4: Increase selector prominence within restraint
Strengthen the two selector surfaces:
- **Sidebar row swatch** (`ConnectionRow` + `Sidebar.module.css` `.colorSwatch`): enlarge slightly and/or move to a more scannable position (e.g., a left edge marker on the row) so a column of connections is distinguishable at a glance. Keep it a marker/swatch, not a fill.
- **Rail indicator dot**: ensure the colored dot is unmistakably the connection color when set (already spec'd), with sufficient size/contrast.

- **Why**: Directly answers the added request ("que se note más el color en el selector"). Kept to swatch/stripe/dot so it stays inside `DESIGN.md` bounds.
- **Alternative considered**: Tinting the whole row background — rejected per restraint rules.

## Risks / Trade-offs

- **[Contrast on light shades in dark theme, or vice versa]** → Use only the existing theme-aware `--conn-color-*` vars (which already encode light/dark shades) for stripes/borders; never place body text on a colored fill. Verify amber/gray legibility in both themes during QA.
- **[Accent proliferation vs. `DESIGN.md`]** The connection palette introduces color alongside the reserved violet accent → Limit the header to a hairline stripe/border and keep the selector to swatches/dots; do not add tinted backgrounds that compete with the reserved accent affordances.
- **[Header layout shift when stripe appears/disappears]** → Implement the stripe as a border/box-shadow/pseudo-element that does not change the header's content box, so colored and uncolored headers keep identical height and alignment.
- **[Regression to uncolored default]** → Everything is gated by `isConnectionColor`; snapshot/story coverage for the no-color case guards against drift.

## Migration Plan

Presentation-only change; no data migration. Ship behind normal review. Rollback is a straightforward revert of the header/selector CSS + markup — no persisted state or schema is touched.

## Open Questions

- Exact selector treatment: keep the enlarged swatch inline by the engine icon, or promote it to a full-height left edge marker on the row? Resolve during design review against `design/preview.html`.
- Whether to add a matching color cue to the tab strip later (out of scope here; noted as a follow-up).
