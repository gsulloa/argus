## Why

The release manifest (`download.json`) now ships Windows (`windows-x86_64`, `.msi`)
and Linux (`linux-x86_64`, `.AppImage`) installers alongside the two macOS builds,
but the landing page only reads and presents the macOS installers. Windows and
Linux visitors currently see no download for their platform and a CTA hard-wired
to macOS, so the new cross-platform builds are effectively invisible to the
people who need them.

## What Changes

- Extend the landing app's `Manifest`/`Installer` handling to read the new
  `windows-x86_64` and `linux-x86_64` entries from the `installers` map.
- Add OS detection (macOS / Windows / Linux) so the hero primary CTA and the
  hero metadata reflect the visitor's platform rather than always saying
  "Download for macOS".
- Present all available installers in the download section: keep the two macOS
  architectures and add Windows (`.msi`) and Linux (`.AppImage`) cards, each
  showing the manifest-provided URL, filename, and size.
- Update the embedded fallback manifest snapshot to include the Windows and
  Linux installers so platform coverage survives a failed manifest fetch.
- Update download-section copy and footer/CTA notes that currently assume macOS
  ("Get Argus for macOS", "requires macOS 11+") to be platform-aware.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `landing-page`: The "Platform-aware download CTA driven by the release
  manifest" requirement changes from macOS-only architecture detection to
  cross-platform OS + architecture detection, and the page must render download
  options for the Windows and Linux installers in addition to the two macOS
  architectures. The embedded fallback snapshot must include the new installers.

## Impact

- `packages/infra/lib/LandingStack/app/src/App.tsx` — manifest typing, OS
  detection, hero CTA, download cards, embedded fallback, copy.
- `packages/infra/lib/LandingStack/app/src/styles.css` — download grid / card
  layout to accommodate up to four installer options and platform glyphs.
- No infrastructure (CDK) changes: `LandingStack/index.ts`, the S3 bucket, and
  CloudFront distribution are unaffected. The manifest contract is owned
  elsewhere (release pipeline); this change only consumes the new fields.
