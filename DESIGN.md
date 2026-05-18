# Design System — Argus

## Product Context
- **What this is:** A desktop tool for inspecting and editing data across multiple sources. Built on Tauri 2 (Rust + React).
- **Who it's for:** Engineers and data-aware operators who live in databases day-to-day — running queries, debugging production, auditing rows, comparing schemas.
- **Space/industry:** Database tooling and data inspection. Adjacent to TablePlus, Postico, Beekeeper Studio, DataGrip, DBeaver.
- **Project type:** Native desktop app (web tech in Tauri webview), three-pane shell, command-palette driven.

## Aesthetic Direction
- **Direction:** Watchful Precision — Linear meets observatory equipment. Refined, dark-first, geometric.
- **Decoration level:** Minimal-to-intentional. No decorative gradients except the logo itself. Subtle radial glow only on active focus points.
- **Mood:** The product should feel like a precision instrument that is paying attention. Quiet, technical, opinionated, mythologically grounded (Argus, the hundred-eyed watchman).
- **Reference sites:** linear.app, raycast.com, vercel.com (Geist family), tableplus.com (as the polished-but-generic baseline to surpass).

## Typography

Single family, two faces. No Inter, no SF Pro, no Söhne.

- **UI / Headings / Data:** Geist (Vercel, OFL, free). Geometric grotesque, tabular numerals built in.
- **Code / Mono / IDs / Timestamps:** Geist Mono (matched companion).
- **Loading:** Google Fonts (`https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap`) or self-host via `@fontsource/geist` / `@fontsource/geist-mono` for offline-first Tauri shipping.

### Scale (compact, app-not-marketing)

| Token | px | Use |
|-------|----|-----|
| `--text-xs` | 11 | Section labels (uppercase 0.14em), table headers, status bar |
| `--text-sm` | 12 | Table cells, dense inputs, sidebar items |
| `--text-md` | 13 | Default body, buttons, labels, palette rows |
| `--text-lg` | 14 | Editor/code, alerts, inspector body |
| `--text-xl` | 16 | Panel titles, palette input |
| `--text-2xl` | 20 | Subheaders inside views |
| `--text-3xl` | 28 | Page-level titles (rare in-app) |

### Letter spacing

- Display (≥20px): `-0.02em`
- Body (13–16px): `0`
- All-caps labels (11px): `+0.14em`
- All-caps tiny labels (10px): `+0.16em`

### Font features

- Always on: `"tnum" on, "ss01" on` for Geist (tabular nums + stylistic alternate)
- Mono: `"zero" on` for slashed zeros in IDs

## Color

**Approach:** restrained. Single accent. Semantic colors are desaturated and never compete with the brand violet.

### Dark mode (primary)

| Token | Hex | Use |
|-------|-----|-----|
| `--canvas` | `#0B0B0F` | App background, table background |
| `--elevated` | `#15151B` | Cards, mockup frame, palette surface |
| `--surface` | `#1C1C24` | Title bar, tabstrip, table header, statusbar |
| `--surface-2` | `#23232C` | Hover surface, neutral pills |
| `--text` | `#F2F3F7` | Primary text |
| `--text-muted` | `#A0A2AD` | Secondary text, results meta |
| `--text-subtle` | `#6B6E7B` | Tertiary text, line numbers, breadcrumb separators |
| `--border` | `#23232C` | Standard 1px hairline |
| `--border-strong` | `#2E2F3A` | Input borders, button borders |
| `--hairline` | `rgba(255,255,255,0.04)` | Sub-cell dividers in dense tables |
| `--accent` | `#A855F7` | **Argus violet.** Primary CTA, focus ring, active row, palette match, tab underline. |
| `--accent-hover` | `#C084FC` | Primary hover |
| `--accent-soft` | `rgba(168,85,247,0.12)` | Active row tint, palette active row tint |
| `--accent-glow` | `rgba(168,85,247,0.18)` | Soft glow under accent stripes |
| `--success` | `#4ADE80` | Connected state, paid pill |
| `--success-soft` | `rgba(74,222,128,0.12)` | Filter row "applied" tint (input background) |
| `--warning` | `#FBBF24` | Replication lag, pending pill, nullable column flag |
| `--danger` | `#F87171` | Errors, refunded pill, destructive buttons |
| `--info` | `#60A5FA` | Read-only notice, shipped pill |

### Light mode (supported, not primary)

Light mode is a **redesign**, not an inversion. Surfaces are warm off-white, not cold pure white.

| Token | Hex |
|-------|-----|
| `--canvas` | `#FAFAF9` |
| `--elevated` | `#FFFFFF` |
| `--surface` | `#FFFFFF` |
| `--surface-2` | `#F4F4F3` |
| `--text` | `#0F0F12` |
| `--text-muted` | `#5B5D68` |
| `--text-subtle` | `#8D8F9B` |
| `--border` | `#E7E7E4` |
| `--border-strong` | `#D4D4D0` |
| `--accent` | `#7C3AED` (shifts darker for AA contrast on white) |
| `--success` | `#16A34A` |
| `--success-soft` | `rgba(22,163,74,0.12)` |
| `--warning` | `#D97706` |
| `--danger` | `#DC2626` |
| `--info` | `#2563EB` |

### Syntax highlighting (SQL editor)

| Token | Dark | Light |
|-------|------|-------|
| Keyword | `#C084FC` | `#7C3AED` |
| String | `#86EFAC` | `#15803D` |
| Number | `#F2F3F7` | `#0F0F12` |
| Comment | `#6B6E7B` | `#8D8F9B` |
| Function | `#93C5FD` | `#2563EB` |

### Where the accent is allowed to be loud

The violet earns its weight by being rare. Only these surfaces use it at full strength:

1. Active connection indicator (left edge stripe + soft glow)
2. Active tab underline (1px line + glow)
3. Active row in data table (left edge stripe + tinted background)
4. Command palette match highlight (text color) and active row stripe
5. Primary CTA (Run query, Connect, Save)
6. Focus ring on inputs (border + 3px soft halo)
7. PK column marker in inspector

Everything else is neutrals + hairlines. If a surface looks dull, that's the system working.

## Spacing

**Base unit:** 4px. **Density:** compact.

| Token | px |
|-------|----|
| `--space-2xs` | 4 |
| `--space-xs` | 8 |
| `--space-sm` | 12 |
| `--space-md` | 16 |
| `--space-lg` | 24 |
| `--space-xl` | 32 |
| `--space-2xl` | 48 |
| `--space-3xl` | 64 |

Component padding defaults: button `6px 12px`, input `6px 10px`, table cell `5px 12px`, panel header `12px 14px`, alert `10px 14px`.

### Table column widths

Column widths in every data grid have a type-derived base (boolean 88px, numeric 120px, date 168px, uuid 280px, text 200px, json 240px, binary 140px, other 180px) plus +16px for partition/sort key markers. Users can drag the right edge of any header to resize a column; the drag handle is invisible at idle and reveals a 1px `--accent` line at 50% opacity within `--duration-instant` on hover. Double-click on the handle resets the column to its type-derived default. Widths persist per relation (Postgres) or per table (DynamoDB); ad-hoc SQL result grids hold widths in memory only. Full contract lives in the `column-width-preferences` spec.

## Layout

- **Approach:** grid-disciplined.
- **Shell:** keep the existing three-pane shell (`Sidebar | Main | Inspector`) plus title bar and status bar. This is correct architecture.
- **Sidebar width:** 220px default. Inspector width: 280px default. Both resizable, both collapsible.
- **Tab strip height:** 32px. Status bar height: 24px. Title bar height: 36px.
- **Max content width:** none — apps fill the viewport.
- **Border radius scale:**

| Token | px | Use |
|-------|----|-----|
| `--radius-sm` | 3 | Swatch chips, small icon buttons |
| `--radius-md` | 5 | Buttons, inputs, alerts, status pills (non-capsule) |
| `--radius-lg` | 8 | Cards, panels, specimen blocks |
| `--radius-xl` | 12 | Mockup frame, modal containers |
| `--radius-full` | 999 | Status pills only (paid/pending/refunded etc) |

## Motion

**Approach:** minimal-functional. Power tools should feel responsive, not animated.

| Token | ms | Use |
|-------|----|-----|
| `--duration-instant` | 80 | Hover state changes |
| `--duration-short` | 120 | Tab switch, theme switch |
| `--duration-medium` | 180 | Inspector slide, palette open |
| `--duration-long` | 300 | Panel collapse |
| `--duration-flourish` | 600 | Scan signature (see below) |

Easing: `ease-out` for enter, `ease-in` for exit, `ease-in-out` for move-in-place.

### Signature flourish: the Scan

Once at app launch, and once on successful connection-test, a single faint violet line travels across the active surface (left to right, 600ms, ease-out). Subtle. Disable when `prefers-reduced-motion: reduce`. This is the only animation that exists for personality rather than function.

## Iconography

- Hairline strokes (1.6 stroke-width on a 24px viewBox).
- Inherit `currentColor` — never colored circles, never duotone.
- Use `lucide-react` (already a dep) and stay within its visual language. If a Lucide icon doesn't fit, draw a custom hairline SVG that matches the stroke weight.

## Anti-patterns (do not ship)

- Purple gradients used as decoration. The logo gradient is the only gradient.
- 3-column feature grids with icons in colored circles.
- Centered hero with "Built for X" copy patterns.
- Bubbly border-radius on every element.
- Inter or SF Pro as the primary UI font.
- Multiple accent colors competing for attention.
- Thick (≥2px) borders. Hairlines only.
- Animations beyond the Scan that don't aid comprehension.

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-28 | Initial design system created | Created by `/design-consultation`. Synthesized from competitive landscape (TablePlus, Postico, Beekeeper, DataGrip) plus aspirational targets (Linear, Raycast). Three deliberate departures from category norms: violet-not-blue accent (ties to existing logo), Geist-not-Inter typography, single-family discipline. |
| 2026-05-13 | Filter-bar visual unification + accent correction | Postgres `FilterBar` and Dynamo `QueryBuilder` rebuilt onto a single primitive layer at `src/modules/shared/filter-bar/`. Shared 32/body/32 rhythm, segmented mode toggle with `--radius-md`, dirty-pip on primary CTA, empty-state row, keyboard-hint chips. App-wide accent swap from blue (`#3b82f6`/`#2563eb`) to Argus violet (`#A855F7` dark / `#7C3AED` light) per the original color spec. See `openspec/changes/improve-filter-bars-design/`. |
| 2026-05-14 | Root combinator toggle + per-row Apply + Cmd+F shortcut on filter bars | Added `RootCombinatorToggle` (AND/OR segmented control) and `RowApplyButton` (▶ per-row apply) to the shared filter-bar primitive layer. The combinator toggle reuses the exact segmented-toggle visual treatment established by the Structured/Raw mode switch — same `--radius-md` border, `--accent-soft` active background, `--accent-glow` focus halo, `--border-strong` dividers. Connectors between rows now reflect the active root combinator (AND vs OR) so the inter-row pills update live. Cmd+F wired on both `TableViewerTab` (Postgres) and `DataViewTab` (Dynamo) to focus the filter bar, skipping the shortcut when focus is inside a CodeMirror editor. See `openspec/changes/improve-filter-bar-shortcuts-combinator/`. |
