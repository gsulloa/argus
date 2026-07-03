## Why

Argus lets each connection carry a color, but that color is only surfaced as a small dot in the rail and an 8×8px swatch in the sidebar row — easy to miss when several connections against different environments (prod vs. staging) are open. Users cannot tell at a glance which connection the active workspace view belongs to, which risks running edits or queries against the wrong environment. The color should be a persistent signal in the work area, and it should read more clearly in the place where connections are selected.

## What Changes

- The active view/tab **header** (the connection identity header at the top of the workspace tree column, shared by SQL editor, data/table viewer, and schema/object views) SHALL take on the focused connection's color as a restrained accent — a top stripe / left accent / border tint — reusing `--conn-color-*` and `connectionColorVar()`.
- When the focused connection has no color, the header keeps its current styling (no change).
- The header updates immediately when the focused connection changes (switching connections/tabs), with no reload.
- The header accent respects light/dark theme and MUST NOT degrade legibility — accent stripe/border/tint only, never a saturated full-background fill.
- The **connection selector** (connection rail dot and sidebar row swatch) SHALL render the color more prominently so the active/colored connection is identifiable at a glance, while staying within `DESIGN.md` restraint (no full-item background fills).

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `connection-colors`: Adds a requirement that the active-view header reflects the focused connection's color; strengthens the rail and sidebar-row requirements so the color reads more prominently in the connection selector.

## Impact

- **Header rendering**: `packages/app/src/platform/shell/WorkspaceShell.tsx` (`ConnectionIdentityHeader`, ~L299–365) and `WorkspaceShell.module.css` (`.identityHeader`, ~L31–119).
- **Selector prominence**: connection rail indicator dot and `ConnectionRow` swatch (`packages/app/src/platform/shell/ConnectionRow.tsx` ~L526–534, `Sidebar.module.css` `.colorSwatch` ~L364–372).
- **Reuse only** (no changes): color palette + helpers in `platform/connection-registry/colors.ts` and `--conn-color-*` vars in `styles/global.css`.
- **Design**: must conform to `DESIGN.md` accent-restraint rules; no new dependencies, no data-model or backend changes.
