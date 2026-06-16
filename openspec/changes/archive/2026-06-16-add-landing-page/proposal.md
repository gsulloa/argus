## Why

Argus ships installers via `releases.argusdb.app` but has no public page where a
prospective user can understand what Argus is and download it. The `LandingStack`
infrastructure (S3 + CloudFront on `argusdb.app`) was provisioned but served only
a placeholder. This change delivers the actual landing page: a single,
on-brand marketing page whose primary job is to get the right installer onto a
visitor's Mac, sourcing real download links from the published release manifest.

## What Changes

- Build the public landing page as the Vite + React app served by `LandingStack`
  at `argusdb.app` / `www.argusdb.app`, replacing the placeholder.
- The page presents the product (supported sources, the three-pane console, key
  features) and is fully aligned with `DESIGN.md` (Geist typography, the single
  violet accent, hairlines, the Scan flourish, reduced-motion support).
- A **platform-aware download CTA** is the page's central action: it reads the
  release manifest (`download.json`) to render real installer links, filenames,
  and sizes for both macOS architectures (Apple Silicon `darwin-aarch64`, Intel
  `darwin-x86_64`), and highlights the architecture detected for the visitor.
- The page fetches the manifest **at runtime** so the displayed version stays
  current without a redeploy, and falls back to an **embedded manifest snapshot**
  so the download CTA is never empty if the fetch fails.
- The release manifest endpoint serves **CORS headers** for the landing origin so
  the cross-origin runtime fetch from `argusdb.app` to `releases.argusdb.app`
  succeeds.

## Capabilities

### New Capabilities
- `landing-page`: The public landing site served by `LandingStack` — its content
  structure, design-system conformance, resilience, and the platform-aware
  download CTA driven by the release manifest with an embedded fallback.

### Modified Capabilities
- `release-artifact-hosting`: The CloudFront manifest behaviors
  (`download.json`, `latest.json`) gain a CORS response-headers policy that
  allows cross-origin reads from the landing origins.

## Impact

- **New code**: `packages/infra/lib/LandingStack/app/` — `src/App.tsx`,
  `src/styles.css`, `src/main.tsx`, `index.html`. Built via the existing
  `landing:build` script; deployed by `LandingStack` to S3 + CloudFront.
- **Modified code**: `packages/infra/lib/ReleasesStack/index.ts` — adds a
  `ResponseHeadersPolicy` (CORS) on the `download.json` / `latest.json`
  behaviors, scoped to `argusdb.app` and `www.argusdb.app`.
- **External dependency**: the page consumes `https://releases.argusdb.app/download.json`
  at runtime (progressive enhancement over the embedded fallback).
- No changes to the Tauri desktop app or its release pipeline.
