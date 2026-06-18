## Why

Today Argus only ships macOS builds: `release.yml` and `scripts/release-local.sh` both hard-code the `aarch64-apple-darwin` + `x86_64-apple-darwin` matrix, and `latest.json` only carries `darwin-aarch64` / `darwin-x86_64` platform entries. Team members on Linux and Windows have no installer and no auto-update path. We want to extend both pipelines so a single tag produces signed installers and an updater manifest for all four targets (mac arm64/x64, Linux x64, Windows x64), without changing how the macOS path works.

## What Changes

- Extend the GitHub Actions matrix in `.github/workflows/release.yml` to add `x86_64-unknown-linux-gnu` (on `ubuntu-22.04`) and `x86_64-pc-windows-msvc` (on `windows-latest`).
- Install the platform build prerequisites in CI: WebKitGTK + system libs on Linux; nothing extra on Windows beyond the stable Rust toolchain.
- Collect, rename, and stage the platform-native artifacts:
  - Linux: `.AppImage` + `.AppImage.tar.gz` + `.sig` (the updater tarball/sig that Tauri emits next to the AppImage).
  - Windows: `.msi` + `.msi.zip` + `.sig` (updater archive).
- Extend `scripts/release-local.sh` so a Linux or Windows developer can invoke it locally and produce the same set of artifacts. The script SHALL skip platforms it cannot build on (macOS host → mac targets only; Linux host → Linux only; Windows host → Windows only) instead of trying to cross-compile.
- Extend `scripts/build-manifest.mjs` to accept Linux and Windows tarball/sig env vars and emit `linux-x86_64` and `windows-x86_64` entries in `latest.json` when those inputs are present, so the running app's auto-updater picks up updates on every OS.
- Update the publish step to upload the new artifacts under canonical names (`Argus_${VERSION}_x64.AppImage`, `Argus_${VERSION}_x64.msi`, plus their `.tar.gz`/`.zip`/`.sig` siblings) to R2 with the same caching rules as today.
- Publish a second, fixed-URL JSON file `download.json` to R2 alongside `latest.json`. Unlike the updater-targeted `latest.json` (which points at signed updater archives), `download.json` SHALL map each supported platform to the direct **installer** URL (DMG / AppImage / MSI) for the latest release. A landing page, README badge, or "Download Argus" button can fetch `${PUBLIC_URL_BASE}/download.json` once and route users to the right installer without knowing the current version. Cached `no-cache` so the URL is always live.
- Documentation: extend `docs/release-setup.md` with the new secrets, the Linux runner image requirements, the `download.json` schema + intended consumers, and a note that Windows code-signing is deferred (unsigned MSI for the first iteration) so users get a SmartScreen prompt on first install.

**Not in scope (deferred):**
- Windows code-signing certificate procurement and Authenticode signing. The first iteration ships unsigned `.msi` artifacts. A follow-up change will add signing.
- ARM Linux and ARM Windows builds.
- Snap / Flatpak / winget distribution.

## Capabilities

### New Capabilities

(none — this extends an existing capability)

### Modified Capabilities

- `release-pipeline`: extend the CI workflow, local script, and manifest requirements to cover Linux x64 and Windows x64 in addition to macOS. The current macOS-only requirements (matrix targets, manifest platform entries) become broader requirements that must hold for all supported targets.

## Impact

- **Code**:
  - `.github/workflows/release.yml` — add matrix entries, conditional setup steps (Linux deps, no Apple keychain on non-mac runners), conditional collect step per OS.
  - `scripts/release-local.sh` — branch on `uname -s`, parameterize the targets list, skip Apple-only preflight checks on non-mac hosts.
  - `scripts/build-manifest.mjs` — accept new env vars (`LINUX_TARBALL`, `LINUX_SIG_PATH`, `WIN_TARBALL`, `WIN_SIG_PATH`), make all platforms optional so a partial build still emits a usable manifest, but warn loudly when a platform is missing.
  - `scripts/build-download-manifest.mjs` (new) — emit `download.json` from the staged installer filenames. Lives next to `build-manifest.mjs` so both CI and the local script can call it.
  - `src-tauri/tauri.conf.json` — verify `bundle.targets` is `"all"` (already is) and that the `icon.ico` is present for Windows (already is). No code change expected.
  - `docs/release-setup.md` — add Linux/Windows runner notes and explicit "Windows is unsigned" warning.
- **CI**: build time roughly doubles (4 parallel jobs instead of 2). All jobs run in the existing `bump → build → publish` flow.
- **Storage**: R2 bucket gains ~4 extra files per release (AppImage + sig + tarball; MSI + sig + zip). At typical Tauri sizes (~50-80 MB each) that's ~250 MB per release — within budget.
- **Updater**: existing macOS clients are unaffected — `latest.json` still contains `darwin-aarch64` and `darwin-x86_64` with identical signatures. New `linux-x86_64` and `windows-x86_64` entries are additive.
- **Public download surface**: a new stable URL `${PUBLIC_URL_BASE}/download.json` becomes the canonical entry point for landing pages and "Download" buttons. Versioned installer URLs continue to be the immutable artifact URLs; consumers who hard-code those keep working.
- **Secrets**: no new GitHub Actions secrets in this iteration (Linux + unsigned Windows build needs none beyond what already exists). When Windows code-signing lands later, that change will introduce its own secrets.
