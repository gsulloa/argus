## 1. Active view header accent

- [x] 1.1 In `platform/shell/WorkspaceShell.tsx` `ConnectionIdentityHeader`, derive the accent from `connection.color`: gate on `isConnectionColor(connection.color)`, and when set, apply a `data-colored` attribute and an inline CSS var (e.g. `style={{ "--header-accent": connectionColorVar(connection.color) }}`) on `.identityHeader`.
- [x] 1.2 In `WorkspaceShell.module.css`, render the accent as a hairline top stripe / left border (and optional soft tint) driven by `--header-accent`, scoped to `.identityHeader[data-colored]`; implement it so it does not change the header's content box (use border/box-shadow/pseudo-element) — colored and uncolored headers keep identical height and alignment.
- [x] 1.3 Confirm no accent and no layout change render when `connection.color` is `null`/absent (uncolored path untouched).
- [x] 1.4 Verify the header recolors immediately when the focused connection changes (no reload) — no new state/effects needed since the header re-renders on focus change.

## 2. Selector prominence

- [x] 2.1 Increase the sidebar `ConnectionRow` color marker prominence in `ConnectionRow.tsx` + `Sidebar.module.css` (`.colorSwatch`): enlarge the swatch and/or add a left-edge stripe so a colored row is identifiable at a glance, keeping it within `DESIGN.md` restraint (no full-row fill) and not obscuring the engine icon, connected dot, or focused-row stripe.
- [x] 2.2 Ensure the connection rail indicator dot renders the connection color with sufficient size/contrast in both themes when a color is set, retaining the name-based env heuristic fallback when no color is set.

## 3. Theme + design conformance

- [ ] 3.1 Use only theme-aware `--conn-color-*` vars for stripes/borders/dots; verify legibility and contrast for all 8 colors (esp. amber/gray) in both light and dark themes against `design/preview.html`.
- [x] 3.2 Re-read `DESIGN.md` and confirm header + selector treatments stay within accent-restraint rules (no large fills, hairline borders only).

## 4. Tests / stories

- [x] 4.1 Add coverage for the header: colored connection shows the accent, uncolored connection shows no accent, and switching the focused connection changes the accent color.
- [x] 4.2 Add/adjust coverage for the selector: colored connection shows the prominent marker/dot; uncolored connection shows none and keeps current layout.

## 5. Verification

- [ ] 5.1 Manually verify acceptance criteria: an `amber` connection accents its tabs' header amber; a `blue` connection accents blue; switching between connections of different colors updates the header without reload; uncolored/no-connection tabs are unchanged.
- [ ] 5.2 Run the app and QA in both themes; run lint/typecheck and the test suite.
