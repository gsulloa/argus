# landing-page Specification

## Purpose
TBD - created by syncing change add-landing-page. Update Purpose after sync.
## Requirements
### Requirement: Public landing page served at the apex domain

The `LandingStack` SHALL deploy a single-page web app that is served at the apex
domain (`argusdb.app`) and its `www` subdomain over HTTPS via CloudFront. The app
MUST be built from `packages/infra/lib/LandingStack/app/` using the existing
`landing:build` script, and its built assets MUST be the content deployed to the
landing S3 bucket. The page MUST render its core content (heading, product
description, and at least one working download link) without depending on any
runtime network request.

#### Scenario: Page loads over HTTPS at the apex domain

- **WHEN** a visitor requests `https://argusdb.app`
- **THEN** the landing page is served and renders its hero, product sections, and
  a download call-to-action

#### Scenario: Core content renders without network access

- **WHEN** the page loads and the runtime manifest fetch fails or is blocked
- **THEN** the hero, product description, and download links still render using
  embedded data

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

### Requirement: Manifest freshness with embedded fallback

The page MUST fetch the live release manifest from
`https://releases.argusdb.app/download.json` at runtime so the displayed version
and installer metadata stay current without redeploying the landing page. The
page MUST ship with an embedded snapshot of the manifest used as the initial and
fallback state, and that snapshot MUST include the macOS, Windows, and Linux
installers so cross-platform download coverage survives a failed fetch. When the
runtime fetch succeeds with a valid manifest, the page MUST replace the embedded
values with the fetched ones; when it fails, the embedded snapshot MUST remain in
effect with no broken or empty download controls.

#### Scenario: Live manifest supersedes the embedded snapshot

- **WHEN** the runtime fetch returns a newer valid manifest
- **THEN** the page displays the fetched version and installer metadata instead
  of the embedded snapshot

#### Scenario: Failed fetch falls back gracefully with all platforms

- **WHEN** the runtime fetch errors, times out, or is blocked
- **THEN** the page continues to display the embedded snapshot and the macOS,
  Windows, and Linux download controls all remain functional
