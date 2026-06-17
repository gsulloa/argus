## 1. Manifest & detection logic

- [x] 1.1 In `App.tsx`, update the embedded `FALLBACK` manifest to include `windows-x86_64` (`.msi`) and `linux-x86_64` (`.AppImage`) installers with real URLs/sizes for the current shipping version
- [x] 1.2 Add an OS-family detection helper (macOS / Windows / Linux) using `navigator.userAgentData.platform` / `navigator.userAgent` / `navigator.platform`, defaulting to macOS when unknown
- [x] 1.3 Add a `pickPrimary()` helper that resolves the recommended installer from detected OS (and Apple-Silicon arch on macOS), with a non-empty fallback priority order
- [x] 1.4 Derive the present-installers list from `manifest.installers` so absent platforms render nothing (no broken links)

## 2. Hero CTA & glyphs

- [x] 2.1 Add hairline `currentColor` Windows and Linux glyph components alongside the existing `AppleLogo` (per DESIGN.md)
- [x] 2.2 Make the hero primary button label, glyph, and meta (arch/size) follow the detected OS via `pickPrimary()` instead of hard-coded "Download for macOS"
- [x] 2.3 Generalize the hero `cta-note` line so it is not macOS-only

## 3. Download section

- [x] 3.1 Replace the two hard-coded `<DownloadCard>`s with cards rendered from the present-installers list: macOS Apple Silicon, macOS Intel, Windows, Linux
- [x] 3.2 Pass platform-appropriate title, sub, glyph, and file-extension label (`.dmg` / `.msi` / `.AppImage`) to each card; mark the detected platform's card recommended
- [x] 3.3 Update download-section heading/copy and footer note from "Get Argus for macOS" / "requires macOS 11+" to platform-neutral or per-card wording

## 4. Styling

- [x] 4.1 Update `.dl-cards` grid in `styles.css` to lay out up to four cards responsively (e.g. 2×2 → single column on narrow viewports) within existing design tokens
- [x] 4.2 Verify card spacing, glyph sizing, and accent usage against `design/preview.html` / DESIGN.md

## 5. Verification

- [x] 5.1 Run `pnpm run landing:build` and confirm a clean build
- [ ] 5.2 Manually verify (or simulate UA) that each OS gets the correct recommended installer and that all four download links resolve to the manifest URLs
- [ ] 5.3 Verify graceful fallback: with the manifest fetch blocked, all four platforms still render from the embedded snapshot; with an installer omitted, no broken link appears
