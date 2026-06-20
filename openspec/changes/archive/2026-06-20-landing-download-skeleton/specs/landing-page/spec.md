## MODIFIED Requirements

### Requirement: Public landing page served at the apex domain

The `LandingStack` SHALL deploy a single-page web app that is served at the apex
domain (`argusdb.app`) and its `www` subdomain over HTTPS via CloudFront. The app
MUST be built from `packages/infra/lib/LandingStack/app/` using the existing
`landing:build` script, and its built assets MUST be the content deployed to the
landing S3 bucket. The page MUST render its core content (heading and product
description) without depending on any runtime network request. Download controls
and manifest-derived metadata (version, build date) MAY depend on the runtime
manifest fetch and MUST render as skeleton placeholders until it resolves.

#### Scenario: Page loads over HTTPS at the apex domain

- **WHEN** a visitor requests `https://argusdb.app`
- **THEN** the landing page is served and renders its hero, product sections, and
  a download call-to-action area

#### Scenario: Core content renders without network access

- **WHEN** the page loads and the runtime manifest fetch fails or is blocked
- **THEN** the hero heading and product description still render, and the download
  controls render as a non-clickable unavailable state rather than a broken or
  fabricated download link

### Requirement: Manifest freshness without embedded download URLs

The page MUST fetch the live release manifest from
`https://releases.argusdb.app/download.json` at runtime and MUST source every
download URL, filename, file size, version, and build date exclusively from that
fetched manifest. The page MUST NOT ship any embedded installer URL or hardcoded
fallback manifest used to render a download link. The page MUST distinguish three
manifest states — loading, ready, and error — and MUST never present a download
control that links to a URL it has not received from a successful fetch.

#### Scenario: No download link before the manifest resolves

- **WHEN** the page first loads and the manifest fetch has not yet completed
- **THEN** the page renders skeleton/loader placeholders for the hero CTA, the
  download cards, the version pill, and the build-date line, and none of those
  placeholders is a clickable link to an installer

#### Scenario: Live manifest populates the download controls

- **WHEN** the runtime fetch returns a valid manifest
- **THEN** the skeleton placeholders are replaced by the real platform-aware
  download controls showing the fetched URL, filename, size, version, and build
  date

#### Scenario: Failed fetch shows an explicit unavailable state, never a stale link

- **WHEN** the runtime fetch errors, times out, or is blocked
- **THEN** the page presents an explicit unavailable state (e.g. a retry
  affordance or "downloads loading…" message) and MUST NOT render any download
  control linking to a hardcoded or stale installer URL

## ADDED Requirements

### Requirement: Download skeleton conforms to the design system

The skeleton/loader state for the download area MUST conform to `DESIGN.md`: it
MUST preserve the layout footprint of the resolved controls (no layout shift when
the manifest arrives), use hairline borders and the compact radius scale, use no
decorative gradients beyond the brand mark, and use only the approved violet
accent if any accent is used. The skeleton shimmer animation MUST be disabled when
the visitor requests reduced motion.

#### Scenario: Skeleton preserves layout footprint

- **WHEN** the page transitions from the loading state to the ready state
- **THEN** the hero CTA and download cards occupy the same footprint before and
  after, with no visible layout shift

#### Scenario: Skeleton respects reduced motion

- **WHEN** the visitor's OS requests reduced motion and the manifest is still
  loading
- **THEN** the skeleton placeholders are shown without the shimmer animation
