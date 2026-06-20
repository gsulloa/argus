## Context

`App.tsx` (the landing SPA) currently initializes its `manifest` state to a
hardcoded `FALLBACK` constant — version `0.1.39` with four real installer URLs.
Because the component renders the same UI for "initial" and "fetched" state, the
hero CTA and download cards are immediately clickable with baked-in URLs. After a
release those URLs are stale; if `fetch(MANIFEST_URL)` fails they stay stale and
the visitor downloads the wrong (eventually missing) installer.

The existing landing-page spec actively *requires* this fallback ("Manifest
freshness with embedded fallback", "Core content renders without network access"),
so removing it is a deliberate spec change, captured in the specs delta.

Styling is governed by `DESIGN.md` (Geist/Geist Mono, single violet `#A855F7`
accent, hairline borders, compact radii, no decorative gradients, honor
`prefers-reduced-motion`). The landing CSS lives alongside the app under
`packages/infra/lib/LandingStack/app/`.

## Goals / Non-Goals

**Goals:**
- No installer URL ever rendered from baked-in data.
- A stable, on-brand skeleton/loader for the download area (hero CTA + cards +
  version pill + build-date) while the manifest is in flight.
- Zero layout shift when the manifest resolves.
- An explicit, non-broken error state when the fetch fails — never a fake default.

**Non-Goals:**
- Changing the manifest URL, schema, or the CloudFront/S3 infra.
- Changing OS/arch detection or the platform-selection logic.
- Adding a build-time manifest injection step (considered and rejected below).
- Redesigning the page beyond the download area.

## Decisions

**1. Model manifest as a discriminated state, not a pre-filled object.**
Replace `useState<Manifest>(FALLBACK)` with
`useState<{ status: "loading" | "ready" | "error"; manifest?: Manifest }>`
initialized to `{ status: "loading" }`. The render branches on `status`. This
makes "no URL yet" unrepresentable-as-a-link by construction.
- *Alternative — keep `Manifest | null`*: workable but conflates "failed" and
  "still loading", which the spec now distinguishes (skeleton vs. error message).
  Rejected for clarity.

**2. Skeleton mirrors the resolved DOM, swapping content for placeholder blocks.**
Each download-dependent element gets a sibling skeleton with identical box
metrics: the hero `btn-download`, each of the four `dl-card`s, the `version-pill`,
and the `cta-note` / `dl-foot` version+date spans. Skeletons render fixed-count
card placeholders (4) so the grid footprint matches the common case. This
guarantees the "no layout shift" scenario.
- *Alternative — spinner overlay*: simpler but causes a flash/reflow when real
  cards mount, violating the no-layout-shift requirement. Rejected.

**3. Skeleton styling: a single `.skeleton` utility class.**
A neutral fill at low opacity over the surface token, hairline border to match
cards, compact radius. Shimmer via a `@keyframes` translating a faint
highlight; the whole animation is wrapped in
`@media (prefers-reduced-motion: no-preference)` so reduced-motion users get a
static block. No gradient beyond the subtle shimmer highlight (a low-alpha sweep,
not a decorative color gradient), staying within `DESIGN.md`.

**4. Error state = honest copy + retry.**
On `catch`, set `status: "error"`. The download section renders a short
"Downloads are loading — please refresh" line with a retry control that re-runs
the fetch. The hero CTA renders disabled (no `href`), styled like the skeleton but
static. No installer link is ever produced.

**5. Detection stays as-is.** `detectOS()` / `prefersAppleSilicon()` run in the
same effect and feed `pickPrimary` only once the manifest is `ready`; they don't
need the manifest, so the recommended-platform label is correct on first paint of
the ready state.

## Risks / Trade-offs

- [Slower perceived first paint of downloads — visitors see skeletons for the
  fetch duration instead of an instant (stale) button] → The manifest is a small
  JSON on CloudFront; latency is low. Honest availability outweighs a sub-second
  shimmer. A perpetual-skeleton risk is bounded by the error transition.
- [Manifest fetch blocked by aggressive privacy extensions/network] → handled by
  the explicit error state with retry; no broken link is shown, which is the
  intended behavior.
- [Skeleton/real footprint drift over time] → mitigate by deriving skeleton
  dimensions from the same CSS classes as the real controls where possible, so
  card/button sizing stays coupled.

## Migration Plan

1. Implement the state machine + skeleton/error UI in `App.tsx` and the CSS.
2. Build the landing app (`landing:build`) and visually verify loading → ready
   and loading → error (throttle/block the manifest request) with reduced motion
   on and off.
3. Deploy via the normal `LandingStack` pipeline. Rollback is a revert of the
   single SPA change; no infra/state migration involved.

## Open Questions

- Error-state copy and whether to surface a GitHub releases link as a manual
  escape hatch (still a real, current URL — not a stale installer). Defaulting to
  retry-only unless the user prefers the GitHub link.
