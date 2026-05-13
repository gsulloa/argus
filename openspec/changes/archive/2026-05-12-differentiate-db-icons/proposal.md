## Why

In the sidebar's Connections list and in the "New connection" kind picker, the Postgres and DynamoDB icons render at the same size, in the same neutral `var(--text-muted)` color, with similarly chunky 14×14 silhouettes — the Postgres "elephant" reads as a tangled squiggle and the Dynamo "partition rect" reads as a generic rounded container. A user scanning a sidebar with both kinds present cannot tell at a glance which row is which without reading the connection name. As more sources arrive (CloudWatch in V3+), distinguishable icons become the only fast way to recognize a row's kind, so this is the right moment to set the bar.

The design system forbids brand colors and duotone fills on icons (`DESIGN.md` → Iconography: "Inherit `currentColor` — never colored circles, never duotone"), so the differentiation must come from **silhouette**, not color.

## What Changes

- Redraw `PostgresIcon` (`src/modules/postgres/icon.tsx`) with a recognizable elephant **head-and-trunk profile** — a rounded organic silhouette with a clear curving trunk, distinct from any rectangular shape. Same hairline stroke (1.5px), same 24px viewBox, same `currentColor`.
- Redraw `DynamoIcon` (`src/modules/dynamo/icon.tsx`) as a **stacked layered cylinder** (the canonical "database" mark: top ellipse + two stacked layers) — a horizontally-banded geometric silhouette, deliberately *unlike* the Postgres organic shape. Same hairline stroke, same viewBox, same `currentColor`.
- Update the `design/preview.html` shell preview (if it renders these icons) so the new marks are visible in context.
- No changes to call sites, sizes, exports, or color tokens. The icons remain drop-in replacements of the existing components.

This is a **visual-only** change: no API, no behavior, no data shape, no new dependency.

## Capabilities

### New Capabilities

_None._ The icons already exist; this change re-skins them.

### Modified Capabilities

- `postgres-connection`: add a requirement that the Postgres icon SHALL render as an organic, rounded silhouette (elephant head-and-trunk profile) so it is unambiguously distinguishable from other source-kind icons at 14px.
- `dynamo-connection`: add a requirement that the Dynamo icon SHALL render as a horizontally-banded geometric silhouette (stacked-cylinder database mark) so it is unambiguously distinguishable from the Postgres icon at 14px.

## Impact

- **Code:** `src/modules/postgres/icon.tsx`, `src/modules/dynamo/icon.tsx`. Both are leaf components with no internal logic; only the `<path>` / `<rect>` / `<line>` children change.
- **Call sites (no edits required):** `src/platform/shell/ConnectionRow.tsx` (sidebar, 14px), `src/platform/shell/ConnectionKindPicker.tsx` (kind-picker card, 20px), `src/platform/shell/useKindPicker.tsx` (kind registry).
- **Specs:** delta files added under `postgres-connection` and `dynamo-connection`.
- **Design system:** no token, no rule, no anti-pattern is touched. The change strengthens compliance with the existing "hairline strokes, inherit currentColor" rule by giving each icon a more deliberate silhouette inside those constraints.
- **Visual preview:** if `design/preview.html` embeds these marks, it picks up the new shapes automatically (icons are imported as React components).
- **Tests / lint / types:** no surface change; existing typecheck and lint cover the SVG components.
- **Out of scope:** no brand colors, no duotone, no per-kind accent token, no `SourceIcon` wrapper, no Lucide swap, no resizing.
