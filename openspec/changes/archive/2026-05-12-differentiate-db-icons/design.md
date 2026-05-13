## Context

Both source-kind icons live as small SVG React components:

- `src/modules/postgres/icon.tsx` — current Postgres mark: 4 paths + 1 dot trying to suggest an elephant. At 14px the four overlapping curves read as a tangled squiggle.
- `src/modules/dynamo/icon.tsx` — current Dynamo mark: rounded rectangle + vertical bisector + two short hash marks (a stylised "partition key" motif). At 14px it reads as a generic boxed container.

Both render via `currentColor` at `var(--text-muted)` in the sidebar (14px) and the kind picker (20px). There is no shared `SourceIcon` wrapper; each call site imports the component directly. The render dispatch lives in `ConnectionRow.tsx` (sidebar) and `useKindPicker.tsx` / `ConnectionKindPicker.tsx` (new-connection dialog).

DESIGN.md hard constraints on iconography:
- Hairline strokes (≈1.6 on a 24px viewBox).
- Inherit `currentColor` — never colored circles, never duotone.
- Stay within Lucide's visual language; if Lucide doesn't fit, draw custom hairline SVG matching that weight.

Brand-color differentiation (Postgres blue, DynamoDB orange) would be the obvious knob but is explicitly disallowed. That moves the entire problem to silhouette design.

## Goals / Non-Goals

**Goals:**

- Two icons that a user can tell apart at 14px from across the sidebar, without color, without reading the label.
- Stay inside the existing iconography rules in DESIGN.md (hairline, currentColor, 24px viewBox, no duotone).
- Drop-in replacement: same exports, same props, same `aria-label`s, same default size. No call-site edits.
- Each silhouette commits to a clear, named *shape category* so that future source kinds (CloudWatch and beyond) can be designed against that vocabulary instead of into it.

**Non-Goals:**

- No color, no gradient, no per-kind accent token, no duotone, no AWS iconography, no brand logos.
- No shared `SourceIcon` / `KindIcon` wrapper component. The current per-module exports work fine; abstraction can wait until there are ≥4 kinds and a reason.
- No Lucide swap. Lucide has no good elephant-mammal or stacked-cylinder match at this stroke weight; staying custom is correct.
- No resizing, no spacing changes, no CSS edits to sidebar or picker.
- No new tests harness. Visual review via `design/preview.html` and a quick `pnpm dev` pass is sufficient for a pure SVG diff.

## Decisions

### Decision 1 — Differentiate by silhouette shape category, not by color or stroke weight

Choose two *deliberately different* shape categories and pin each kind to one:

- **Postgres → organic rounded blob with a curving trunk.** Reads as mammalian, recognizably elephant-adjacent, occupies vertical space with a heavier head mass and a thinner curving trunk extending toward the lower edge.
- **DynamoDB → horizontally-banded geometric stack** (the universal "database" cylinder: top ellipse + two stacked layers + side walls). Reads as engineered, layered, container-like.

**Why these two categories:** they sit on opposite axes — organic vs. geometric, vertical/curve-dominant vs. horizontal/band-dominant — which is the single strongest readability signal at 14px once color is off the table. The stacked-cylinder is also the universally-recognized database icon, so it carries semantic load even for users who don't know the Argus icon language yet.

**Alternatives considered:**

- *Brand colors (PG blue / Dynamo orange).* Cleanest readability, but violates DESIGN.md's "inherit `currentColor` — never colored" rule. Rejected.
- *Lucide swap (e.g. `Database` for one, `Server` for the other).* Both Lucide marks are rectangle-stack-like; they look like siblings, not opposites. Defeats the goal. Rejected.
- *Per-kind accent token (e.g. `--source-postgres`, `--source-dynamo`).* Same DESIGN.md violation as brand colors; also drags a new color into the palette. Rejected.
- *Letter monograms (P / D).* Reads as placeholder, not as a designed mark. Rejected.
- *Keep current shapes, scale Postgres to 16px and Dynamo to 14px for asymmetric weight.* Hacky; breaks the row-alignment grid. Rejected.

### Decision 2 — Redraw the Postgres mark as an elephant head-and-trunk profile, not the full body

The current icon attempts a full-body elephant in 16px of pixel budget; with 1.5px hairline strokes there isn't enough room and the four curves overlap into noise. Switching to a **head-and-trunk profile** gives one dominant rounded mass (the head) plus one strong directional line (the trunk curving down). That's two glyphic primitives, well within the 24px viewBox, and recognizable at 14px.

Concrete sketch (24px viewBox, illustrative — implementer fine-tunes the path):

- One rounded path forming the head/forehead curve, sized so the head fills roughly the upper two-thirds of the viewBox.
- One curving path forming the trunk, starting at the lower front of the head and sweeping down toward the bottom edge, ending in a small upward flick (the trunk tip — a recognizability cue).
- One small filled dot (≤1px radius) for the eye, `fill="currentColor"`, kept tiny to preserve hairline language.
- An optional short stroke for the ear edge if the head silhouette needs it for legibility at 14px.

**Alternatives considered:**

- *Postgres-foundation logo simplified (the trunk-up "tusker" mark).* Risk of looking like a knockoff of the official logo and visually heavier. Rejected in favor of an Argus-original profile.
- *Full elephant body silhouette (legs, tail).* Too much detail for 14px; this is what we're moving away from. Rejected.

### Decision 3 — Redraw the Dynamo mark as a stacked-cylinder database glyph, not a partition-key abstraction

The "partition key" metaphor in the current icon is conceptually clever but visually generic — a rounded rectangle with marks reads as "a panel", not "a database". The stacked cylinder is the most widely-understood database glyph in software UI; using it for the NoSQL kind is fine (the glyph is conceptual, not relational-vs-NoSQL). It also gives a fundamentally different silhouette from the Postgres blob: horizontal bands vs. organic curves.

Concrete sketch (24px viewBox, illustrative — implementer fine-tunes):

- Top ellipse (a flat ellipse near the top of the viewBox) — the cylinder's top face.
- Two horizontal "layer" arcs at roughly 1/3 and 2/3 height — the disc layers, drawn as bottom-half arcs only so the cylinder looks layered rather than fully hatched.
- Two vertical side lines connecting the top ellipse's ends down to a final bottom arc — the cylinder's side walls and bottom face.

That gives three horizontal bands plus two vertical edges — a strongly horizontal-banded silhouette that cannot be confused with the elephant profile.

**Alternatives considered:**

- *Hexagon with bisector (partition-style geometric).* Visually distinct from the Postgres blob, but reads as "node" or "graph", not "database". Less semantic load. Rejected.
- *Lightning bolt motif (evoking AWS speed / DynamoDB).* Strays into AWS iconography territory and reads as "energy/zap", not "data". Rejected.
- *Keep the current partition-key rect and just thicken it.* Doesn't solve the readability problem and creates an anti-pattern (DESIGN.md forbids ≥2px borders). Rejected.

### Decision 4 — Keep all other surfaces untouched

No edits to:

- The component prop contract (`{ size?, className? }`, default 16).
- The `role="img"` + `aria-label` attributes (kept as `"Postgres"` and `"DynamoDB"`).
- The `currentColor` strategy and the `var(--text-muted)` parent color.
- Call sites (`ConnectionRow.tsx`, `ConnectionKindPicker.tsx`, `useKindPicker.tsx`).
- Sidebar CSS, picker CSS, sizes (14px / 20px).
- The export surfaces (`src/modules/postgres/index.ts`, `src/modules/dynamo/index.ts`).

This keeps the blast radius to two SVG files.

### Decision 5 — Verify visually at the two real sizes, not in isolation

The icons exist at exactly two rendered sizes: 14px (sidebar) and 20px (kind picker card). A mark that looks great at 64px in Figma can fall apart at 14px when 1.5px strokes start to merge. The QA step MUST render the new icons in both real contexts, side by side (a Postgres row immediately followed by a Dynamo row in the sidebar, and both cards visible in the picker dialog), in both dark and light mode.

`design/preview.html` already mounts the real shell against the real tokens — re-render it after the icon swap and inspect at 100% zoom. No automated visual diff is added; manual review is appropriate for a two-icon change.

## Risks / Trade-offs

- **Risk:** The new Postgres elephant-profile path doesn't read as an elephant at 14px and just looks like a curl. **Mitigation:** keep the head mass dominant and the trunk curve clearly directional (downward sweep with a tip flick); if it still fails at 14px, fall back to a simpler "mammal profile" (rounded head + short snout) — the rule we're enforcing is shape *category*, not species recognition.
- **Risk:** The stacked-cylinder Dynamo glyph could be misread as "Postgres" by users used to the historic database-cylinder = relational-DB convention. **Mitigation:** Argus shows the connection name next to the icon at all times; the icon's job is to distinguish from siblings, not to identify the engine in absolute terms. We can revisit if a third relational kind ever lands.
- **Risk:** The new SVGs render at slightly different optical weight than each other and the row feels unbalanced. **Mitigation:** keep `stroke-width="1.5"` on both, draw both inside the same 24px viewBox at roughly the same bounding-box mass (≈16×16 of the 24px frame), and eyeball at 14px before merging.
- **Risk:** Light-mode rendering against the warm off-white canvas reads differently (less contrast). **Mitigation:** the icons already inherit `--text-muted`, which is tuned per mode; the QA step explicitly checks both modes.
- **Trade-off:** giving up the cleverness of the partition-key motif for legibility. Acceptable — clever-but-unreadable is worse than canonical-but-instant.

## Migration Plan

This is a pure visual replacement of two leaf SVG components. No deploy steps, no rollback strategy beyond `git revert` on the two files. Existing connections, settings, and data are unaffected. There is no caching layer that holds an icon snapshot — the SVGs are React component source.

## Open Questions

- Should we also update `design/preview.html` to dedicate a row to "source kind icons at real render sizes" so the preview surface explicitly documents the elephant/cylinder vocabulary? **Recommendation:** yes if the preview already has an iconography section; skip if it would mean adding a brand-new section just for two icons. Defer to the implementer's read of the preview file.
- Is the `aria-label` "DynamoDB" still right when the visual mark is a generic stacked cylinder? **Recommendation:** yes — the label names the *kind*, not the *shape*. Screen-reader semantics shouldn't shift just because we picked a more readable silhouette.
