## Context

The landing app (`packages/infra/lib/LandingStack/app/src/App.tsx`) is a single
React component that fetches `download.json` at runtime and falls back to an
embedded snapshot. Today it only reads `darwin-aarch64` / `darwin-x86_64` and
detects Apple Silicon vs. Intel via a WebGL renderer probe. The hero CTA is
hard-coded to "Download for macOS" and the download section renders exactly two
`<DownloadCard>`s. The manifest now also carries `windows-x86_64` (`.msi`) and
`linux-x86_64` (`.AppImage`).

This is a UI-only change inside one app; no CDK, S3, or CloudFront changes. The
manifest schema is already `Record<string, Installer>`, so the type doesn't need
to change shape — only the consuming logic and presentation do.

## Goals / Non-Goals

**Goals:**
- Read and present Windows and Linux installers when present in the manifest.
- Detect the visitor's OS and recommend the right installer in the hero CTA.
- Keep the page resilient: missing installers never render broken links; failed
  fetch still shows all four platforms via the embedded fallback.
- Conform to `DESIGN.md` (Geist typography, single violet accent, hairline
  borders, compact radii, no decorative gradients).

**Non-Goals:**
- No change to the release pipeline or the manifest producer.
- No ARM Linux / ARM Windows builds (manifest only has `*-x86_64` for those).
- No CDK / hosting changes.
- No new runtime dependencies.

## Decisions

### OS detection via User-Agent / platform hints, not WebGL
The existing Apple-Silicon probe stays for macOS-arch disambiguation. For OS
family, use `navigator.userAgent` / `navigator.userAgentData.platform` /
`navigator.platform` heuristics (mac / win / linux). Chosen over server-side
detection because the page is a static CloudFront-served SPA with no server, and
over WebGL because OS family is reliably available from UA strings.
- *Alternative considered:* `navigator.userAgentData.getHighEntropyValues` —
  async and not universally supported; the synchronous low-entropy hints plus UA
  string are sufficient for a best-effort recommendation.

### A single `pickPrimary()` resolving installer + label
Derive the recommended installer from detected OS (and arch on macOS) once, and
compute the hero button label/glyph from it. Falls back through a priority order
(detected platform → macOS arm → any available installer) so the CTA is never
empty. Keeps the "primary is never empty" invariant the current code already
relies on.

### Render download cards from what the manifest actually contains
Replace the two hard-coded cards with a derived list of present installers
(macOS Apple Silicon, macOS Intel, Windows, Linux), each mapped to a
`<DownloadCard>` with platform-appropriate title, sub, glyph, and file extension
label (`.dmg` / `.msi` / `.AppImage`). Cards for absent installers are omitted.
This keeps the "no broken link" invariant from the spec.
- *Alternative considered:* always render four cards with disabled state for
  missing platforms — rejected as noisier; omission is cleaner and the manifest
  currently always carries all four.

### Platform-aware copy
"Get Argus for macOS" / "requires macOS 11 Big Sur or later" become neutral or
per-card. The hero CTA label and glyph follow the detected OS; the macOS-version
note moves into the macOS cards' context rather than the global footer, or the
footer is generalized. Keep an Apple/Windows/Linux glyph set (hairline,
`currentColor`, per DESIGN.md) — add Windows and Linux marks alongside the
existing `AppleLogo`.

### Embedded fallback updated to four installers
Update `FALLBACK` to include `windows-x86_64` and `linux-x86_64` so a blocked
fetch still offers every platform. Use the current shipping version's real URLs
to keep the snapshot honest.

## Risks / Trade-offs

- **OS detection is best-effort and can be wrong** (spoofed UA, uncommon
  platforms) → Always offer every installer; detection only changes which one is
  highlighted, never which are available.
- **Linux `.AppImage` is large (~85 MB) vs. macOS ~10 MB** → size is shown per
  card from the manifest, so the difference is transparent; no special handling.
- **Embedded fallback drifts from the live manifest over time** → acceptable;
  the runtime fetch supersedes it, and the fallback only needs to be a plausible
  recent snapshot, same as today.
- **Card layout grows from 2 to 4** → adjust the `.dl-cards` grid (e.g. 2×2 /
  responsive) within the existing design tokens; verify against `design/preview.html`.

## Open Questions

- Should the macOS-version requirement note ("macOS 11+") be replaced with
  per-platform requirements (e.g. Windows 10+, glibc baseline for the AppImage)?
  Default: keep a brief per-card note where a real minimum is known, drop the
  global macOS-only line. Confirm during implementation/QA.
