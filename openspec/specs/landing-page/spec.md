# landing-page Specification

## Purpose
TBD - created by syncing change add-landing-page. Update Purpose after sync.
## Requirements
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

### Requirement: Page presents the product and conforms to the design system

The landing page MUST communicate what Argus is: the supported data sources
(PostgreSQL, MySQL/MariaDB, SQL Server, DynamoDB, CloudWatch Logs, Athena), a
visual representation of the three-pane console, and key product capabilities.
All visual treatment MUST conform to `DESIGN.md`: Geist / Geist Mono typography,
a single violet accent (`#A855F7`) used sparingly, hairline borders, the compact
radius scale, and no decorative gradients beyond the brand mark. The page MUST
honor `prefers-reduced-motion: reduce` by disabling non-essential animation
(including the Scan flourish and scroll reveals).

#### Scenario: Supported sources are listed

- **WHEN** the page is viewed
- **THEN** all six supported sources are presented with a short description each

#### Scenario: Reduced motion is respected

- **WHEN** the visitor's OS requests reduced motion
- **THEN** the Scan flourish and scroll-reveal animations are disabled and all
  content is visible without motion

### Requirement: Platform-aware download CTA driven by the release manifest

The page MUST present download links derived from the release manifest's
`installers` map. For each installer present in the manifest — the macOS
architectures (`darwin-aarch64`, `darwin-x86_64`), Windows (`windows-x86_64`),
and Linux (`linux-x86_64`) — the page MUST show the installer's real download
URL, filename, and human-readable file size, plus the manifest `version`. The
page MUST make a best-effort detection of the visitor's operating system (macOS,
Windows, or Linux) and, on macOS, of the architecture, and present the matching
installer as the primary/recommended choice, while still offering the other
installers. A download control MUST link directly to the installer's `url`. When
the manifest omits an installer for a platform, that platform's control MUST NOT
appear (or MUST render as unavailable) rather than linking to a broken URL.

#### Scenario: All available installers are offered with real metadata

- **WHEN** the manifest contains `darwin-aarch64`, `darwin-x86_64`,
  `windows-x86_64`, and `linux-x86_64` installers
- **THEN** the page renders a download option for each, each showing the
  manifest-provided URL, filename, and size

#### Scenario: Detected OS is recommended

- **WHEN** OS detection indicates the visitor is on Windows
- **THEN** the Windows installer is marked as recommended and the primary hero
  CTA links to it, with its label reflecting Windows; the other installers
  remain available

#### Scenario: macOS architecture is recommended on macOS

- **WHEN** OS detection indicates macOS and architecture detection indicates
  Apple Silicon
- **THEN** the Apple Silicon installer is marked as recommended and the primary
  CTA links to it; the Intel, Windows, and Linux installers remain available

#### Scenario: Missing platform installer does not break the page

- **WHEN** the manifest omits the `linux-x86_64` installer
- **THEN** the page does not present a broken Linux download link, and all other
  installer controls remain functional

#### Scenario: Download link targets the real installer

- **WHEN** the visitor activates a download control
- **THEN** the browser navigates to the installer `url` from the manifest

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

### Requirement: Landing distribution emits CloudFront standard access logs

The `LandingStack` CloudFront distribution MUST have standard access logging
enabled, delivering logs to the shared analytics log bucket (imported by name
from SSM) under the `landing/` prefix. Logging MUST NOT introduce any
client-side tracking, cookie, or analytics script into the landing bundle — the
page remains free of runtime analytics. The stack MUST depend on
`AnalyticsStack` so the log bucket exists before logging is enabled.

#### Scenario: Distribution is configured for standard logging

- **WHEN** `cdk synth` runs for `ArgusLandingStack`
- **THEN** the `AWS::CloudFront::Distribution` has logging enabled with the bucket
  set to the imported analytics log bucket and a `landing/` log file prefix

#### Scenario: No analytics script is added to the page

- **WHEN** the landing page is built and loaded
- **THEN** no GA4 / gtag / third-party analytics script and no tracking cookie is
  present; only server-side CloudFront logs capture the visit

