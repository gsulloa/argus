## MODIFIED Requirements

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
