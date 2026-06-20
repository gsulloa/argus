## Why

The landing page ships a hardcoded `FALLBACK` manifest (version `0.1.39` with
fully-formed installer URLs) that renders as real, clickable download buttons on
first paint and whenever the live manifest fetch fails. Those embedded links
silently rot: every release leaves them pointing at a stale version, and a failed
fetch hands visitors a wrong-version (or eventually dead) installer instead of an
honest "not ready yet" state. We want the page to never advertise a download URL
it can't currently confirm.

## What Changes

- **BREAKING** (spec-level): Remove the embedded `FALLBACK` manifest with real
  installer URLs. The page no longer renders any download link from baked-in data.
- While the live manifest from `releases.argusdb.app/download.json` is in flight,
  the hero CTA and the download cards render as **skeleton/loader** placeholders
  (design-system shimmer, no real `href`), so the layout is stable and nothing is
  clickable until a verified URL exists.
- On a successful fetch, skeletons are replaced by the real platform-aware
  download controls (unchanged behavior from there).
- On a failed/blocked/timed-out fetch, the page shows a non-broken **unavailable**
  state (e.g. retry affordance / "downloads loading…" message) instead of a
  fabricated default installer — never a dead or stale link.
- Version, build date, and any other manifest-derived chrome (nav pill, footer)
  render skeleton placeholders until the manifest resolves rather than showing the
  stale embedded version number.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `landing-page`: The "Manifest freshness with embedded fallback" and "Core
  content renders without network access" requirements change — the page must
  source every download URL from the live manifest only, present a skeleton/loader
  while the manifest loads, and degrade to an explicit unavailable state (never a
  hardcoded installer) when the fetch fails.

## Impact

- `packages/infra/lib/LandingStack/app/src/App.tsx` — remove `FALLBACK`, introduce
  a `loading | ready | error` manifest state, skeleton components for the hero CTA,
  download cards, version pill, and build-date line.
- Landing CSS (skeleton/shimmer styles) must be added in line with `DESIGN.md`
  (hairline borders, no decorative gradients, `prefers-reduced-motion` disables the
  shimmer).
- `openspec/specs/landing-page/spec.md` — requirements updated via delta.
- No backend/infra change; the runtime fetch URL and manifest schema are unchanged.
