## Context

Argus uses Tauri 2 with a fan-out release pipeline:

- `.github/workflows/release.yml` triggers on push to `master`. It runs three jobs: `bump` (patch-version bump + tag), `build` (matrix: aarch64 + x86_64 mac), `publish` (compose `latest.json` + upload to Cloudflare R2).
- `scripts/release-local.sh` mirrors the workflow so a developer with the right secrets in `.env.release` can produce a release from their macOS laptop without going through GitHub.
- `scripts/build-manifest.mjs` emits the Tauri v2 updater manifest, currently hard-coded to two macOS platform entries.
- The `release-pipeline` spec already covers production-vs-beta config separation, manifest signing, and the rollback runbook.

The whole pipeline assumes macOS. Linux and Windows users currently have no installer and no auto-update path. The `tauri.conf.json` already declares `bundle.targets: "all"` and ships a Windows `.ico` and Linux PNG icons, so the bundling formats are reachable — what's missing is the CI runners, the dependency setup on Linux, the artifact collection logic per OS, the manifest entries, and the local-script branching.

Constraints:

- The macOS path must keep working exactly as today (signed + notarized + stapled). No regressions for the existing two targets.
- Windows code-signing is out of scope for this change — procuring an Authenticode certificate is a separate purchasing + identity-verification flow that we can't reasonably block on.
- We do not want to expand the CI bill significantly. GitHub Actions provides free Linux + Windows minutes for public repos and reasonable allowances for private, but the per-minute multipliers differ (Windows is 2x, macOS is 10x). Adding Linux and Windows will not materially change the macOS-dominated cost.
- Local script must not require a Windows VM on macOS — we explicitly skip cross-compilation and require developers to run the script on a host that matches the target.

Stakeholders: anyone running Argus on Linux or Windows; the small ops surface around `release.yml` and the local script.

## Goals / Non-Goals

**Goals:**

- A single merge to `master` produces signed mac installers and unsigned Linux/Windows installers, plus a single updater manifest covering all four targets.
- `latest.json` carries enough information for the Tauri updater on every supported OS to detect and apply updates without manual intervention.
- The local script remains usable on developer laptops — at minimum macOS today, with explicit Linux/Windows paths that mirror what CI does.
- Failure isolation: a broken Linux build does not block mac releases reaching mac users (we still hold the manifest until all four succeed, but the previous release stays live).
- Naming consistency: every public artifact follows `Argus_${VERSION}_${ARCH}.<ext>` so URLs are predictable.

**Non-Goals:**

- Authenticode (Windows) code-signing. We accept the SmartScreen prompt on first install. A follow-up change introduces an EV cert.
- Linux package distribution beyond AppImage: no `.deb`, `.rpm`, Snap, Flatpak, or AUR in this iteration.
- ARM Linux or ARM Windows targets. We ship `x86_64` only for these two OSes initially.
- Cross-compilation. Building Linux artifacts on macOS or Windows artifacts on Linux is explicitly unsupported. Each target must run on its native OS runner.
- Smart partial publishes (e.g. "Linux only" release). The manifest invariant is that all four targets ship together; a missing target blocks the publish.

## Decisions

### 1. Matrix-extend the existing `build` job instead of forking parallel workflows

Add Linux and Windows entries to the `strategy.matrix.include` array in `release.yml`. Keep `fail-fast: false` so one platform's flakiness doesn't cancel the others.

**Why over alternatives:**
- *Separate workflows per OS*: would duplicate the bump-and-tag dance, risk version drift, and complicate the publish step's `needs:` graph. Single matrix keeps the version pinning automatic (`needs: bump` is shared).
- *Reusable workflow*: overkill for four targets; the per-OS steps share so little (mac needs keychain import, Linux needs apt, Windows needs nothing extra) that a unified template would be mostly `if:` conditionals.

The matrix's `os:` field becomes the natural switch for OS-specific steps via `if: matrix.os == 'ubuntu-22.04'` etc.

### 2. Pin Ubuntu to `ubuntu-22.04`, not `ubuntu-latest`

Tauri's Linux dependency story is sensitive to WebKitGTK ABI versions. `ubuntu-22.04` ships `libwebkit2gtk-4.1` (the version Tauri 2 wants). `ubuntu-latest` currently points at 22.04 too but will roll forward to 24.04 — and historically GTK/WebKit major bumps have broken Tauri builds. Pinning gives us a stable baseline; we upgrade deliberately when we test against a newer LTS.

**Trade-off:** binaries link against an older WebKitGTK, but AppImage bundles its runtime so end-user GLIBC compatibility is what actually matters. We document the assumption.

### 3. Use AppImage as the Linux distribution format

Tauri can produce `.deb`, `.rpm`, and `.AppImage`. AppImage is the only one that's distro-agnostic and runs on Ubuntu, Fedora, Arch, etc. without a package manager. It's also the format Tauri's own updater natively supports (it expects the `.AppImage.tar.gz` next to the `.AppImage` for delta-free replacement). `.deb`/`.rpm` would be nice but require us to host two more repositories with their own signing — a separate change.

### 4. Ship Windows MSI unsigned, document the SmartScreen consequence

Authenticode certs cost $200-500/yr and require an organization identity-proofing step that takes 1-2 weeks. We don't want this change to block on procurement. Instead:

- The MSI builds and signs the *updater archive* (`.msi.zip.sig` via the Ed25519 key — this is what the updater plugin checks, not Authenticode).
- The MSI itself is unsigned. First-install users see Windows SmartScreen warning; they click "More info" → "Run anyway". This is documented in `release-setup.md`.
- Existing installations auto-update via the Ed25519-signed `.msi.zip` — the OS only checks Authenticode on user-initiated installs, not on updater-triggered ones, so post-first-install the experience is seamless.

A follow-up change `add-windows-code-signing` will introduce the cert and sign the MSI before upload.

### 5. Linux dependency install: explicit `apt-get install`, no third-party action

We do NOT use third-party actions like `tauri-apps/tauri-action` for the Linux deps — `tauri-action` is fine for the build invocation itself but its dependency-install step is a moving target. We pin the apt package list ourselves:

```
libwebkit2gtk-4.1-dev
libsoup-3.0-dev
libayatana-appindicator3-dev
librsvg2-dev
build-essential
curl
file
wget
```

This list is the Tauri 2 stable docs' recommendation for Ubuntu 22.04+ and matches the runner image. We add a cache for the apt downloads via `actions/cache` keyed on the package list hash to keep build times reasonable.

### 6. Manifest generator: make all platforms optional, fail loud when CI emits a partial one

Today `build-manifest.mjs` requires `ARM64_TARBALL`, `ARM64_SIG_PATH`, `X64_TARBALL`, `X64_SIG_PATH`. We change this to:

- Each of the four `<PLATFORM>_TARBALL` / `<PLATFORM>_SIG_PATH` pairs is optional.
- If both are set for a given platform, emit that platform's entry.
- If neither is set, omit the platform.
- If exactly one is set, fail (incoherent input).
- At the end, if fewer than 4 platforms made it into the manifest:
  - In CI: exit non-zero (the publish step expected all four).
  - In local: warn and continue (so the developer can still inspect `latest.partial.json`).

The signal for "am I CI or local?" is a new env var `MANIFEST_MODE=ci|local` set by each caller. Default is `ci` to keep CI strict.

### 7. Local script: branch on `uname -s`, refuse cross-compilation

`scripts/release-local.sh` today is macOS-only. We restructure it as:

- A `host_os` variable derived from `uname -s` (`Darwin` | `Linux` | `MINGW*`/`MSYS*` → `Windows`).
- A `valid_targets_for_host` function that returns the legal target list for the host. macOS host allows both Apple targets; Linux host allows `x86_64-unknown-linux-gnu`; Windows host allows `x86_64-pc-windows-msvc`.
- The `--target` flag validates against that list and aborts with a clear error if mismatched (e.g. asking for `linux` on a mac host).
- Preflight checks become host-conditional: keychain + codesign + xcrun checks only run on macOS; apt-package presence check only on Linux; `cl.exe` / `link.exe` reachability only on Windows.
- The script is still `bash`. For Windows hosts the same script runs under Git Bash / MSYS2. We do NOT ship a separate PowerShell version in this iteration; if Windows developers struggle with Git Bash we add `release-local.ps1` as a follow-up.

### 8. Artifact naming: enforce in collect step, not at build time

Tauri's bundler produces names like `Argus_0.1.16_amd64.AppImage` (note: `amd64`, not `x64`) on Linux and `Argus_0.1.16_x64_en-US.msi` on Windows. To keep the manifest predictable and the R2 keys consistent with the existing mac convention (`Argus_${VERSION}_x64.dmg`), the collect step renames every artifact to the canonical `Argus_${VERSION}_${ARCH}.<ext>` shape during staging. The renaming logic lives in both `release.yml` (per-matrix-entry "Collect artifact paths" step) and `release-local.sh` (in-script after the build).

### 9. New stable URL `download.json` for direct-installer links

We add a second always-live JSON file alongside `latest.json` because the two have fundamentally different consumers and shapes:

- `latest.json` is the **Tauri updater manifest**. It points at the signed `.app.tar.gz` / `.AppImage.tar.gz` / `.msi.zip` *updater archives*, embeds an Ed25519 signature per platform, and is read by the in-app updater plugin. Schema dictated by Tauri.
- `download.json` is the **public download index**. It points at the end-user-facing installers (`.dmg`, `.AppImage`, `.msi`), exposes filename + size for nice "Download (45 MB)" labels, and is read by landing pages, README badges, or any script that just wants the latest installer URL without knowing the version. Schema dictated by us.

**Why a separate file rather than reusing `latest.json`:**
- The updater fetches `latest.json` on a 4-hour interval; making it carry an extra installer URL per platform would bloat it slightly but more importantly invites confusion ("which URL do I link from my landing page?"). One file, one purpose.
- Different consumers can evolve independently. We can add a `download.json` v2 with checksums or release notes without touching the updater contract.
- The Tauri updater manifest schema is fixed; we can't safely add unknown fields without risking a future updater rejecting them.

**Generation:** a new sibling script `scripts/build-download-manifest.mjs`, structured like `build-manifest.mjs`:

- Takes per-platform env vars `DARWIN_AARCH64_INSTALLER`, `DARWIN_X86_64_INSTALLER`, `LINUX_X86_64_INSTALLER`, `WINDOWS_X86_64_INSTALLER` (each = installer filename), plus `PUBLIC_URL_BASE`, `VERSION`, `PUB_DATE`.
- Resolves each installer file inside `staging/` to read its `size` via `statSync`. Required because the spec demands the size field.
- Emits `download.json` in `ci` mode (all four platforms required) or `download.partial.json` in `local` mode when partial.
- Same `MANIFEST_MODE` env var as `build-manifest.mjs` for consistency; same exit-non-zero contract in CI.

**Upload:** identical caching to `latest.json` — `Cache-Control: no-cache, max-age=0`, `Content-Type: application/json`. The publish step uploads it in the same loop as the manifest.

**Stability guarantee:** `${PUBLIC_URL_BASE}/download.json` is part of the public surface. We never rename it, never move it. Any future schema additions are backward-compatible (new optional fields only). If we ever want a breaking change, it ships as `download-v2.json` alongside.

### 10. Publish step: hard-require all four artifacts, but only after build completes

The `publish` job already declares `needs: [bump, build]`. With `fail-fast: false`, one matrix entry can fail while the others succeed; without further guards the publish step would still run and emit a 3-platform manifest. We add an explicit guard at the top of the publish job:

```yaml
- name: Verify all four bundles present
  run: |
    for arch in aarch64 x64 linux-x64 windows-x64; do
      test -d "staging/$arch" || { echo "Missing bundle: $arch"; exit 1; }
    done
```

This means a Linux apt outage that breaks the Linux build will leave the previous `latest.json` live for all users — which is exactly the desired safety property.

## Risks / Trade-offs

- **CI minutes cost increase** → Mitigation: pin Ubuntu, cache cargo + apt, run all platforms in parallel so wall-clock stays similar. Expected monthly bill impact: low double-digit dollars at our merge cadence.
- **Tauri's Linux build is fragile across distro versions** → Mitigation: pin `ubuntu-22.04`, document the upgrade procedure when we next bump.
- **Unsigned MSI scares first-time Windows users** → Mitigation: explicit doc note + screenshot of the SmartScreen prompt + planned follow-up for code-signing. We accept the friction for now.
- **Updater archive on Linux is `.AppImage.tar.gz` not `.AppImage`** → Mitigation: documented in the manifest spec; both files are uploaded; users download the `.AppImage` for first install and the updater fetches `.AppImage.tar.gz` for subsequent updates.
- **Local script may misdetect Windows under exotic shells (Cygwin, WSL bash, MSYS2, Git Bash)** → Mitigation: explicit pattern match on `uname -s` and a clear error message when unrecognized. WSL bash should be treated as Linux, and the script should make that explicit so a developer running WSL doesn't accidentally try to ship a Windows binary from WSL.
- **`needs: build` with `fail-fast: false` and partial success** → Mitigation: explicit verification step in publish that all four bundle dirs exist; refuse to publish otherwise.
- **`download.json` becomes a public contract we can't break** → Mitigation: explicit "stability guarantee" clause in the spec; any future incompatible schema change ships as `download-v2.json`. The current shape is deliberately conservative (version + pub_date + per-platform url/filename/size) so we have room to extend additively.
- **Inconsistency between `latest.json` and `download.json`** (e.g. one updates and the other doesn't) → Mitigation: both are generated in the same publish job after the same "all four bundles present" check, and both are uploaded in the same R2 loop. They go live together or not at all.
- **Tauri 2 changes its Linux dep list** → Mitigation: pin to Tauri 2.x in `Cargo.toml`; the apt list is in one place in the workflow and one place in the local script, so updates are mechanical.

## Migration Plan

- This is purely additive at the runtime layer — no installed mac client sees any change.
- The first release after merging this change will publish a `latest.json` that adds `linux-x86_64` and `windows-x86_64` platforms. Mac clients ignore unfamiliar platform keys; no regression.
- Linux and Windows users have no installed app yet, so there's no migration on their side — they simply download the first AppImage / MSI from the public R2 URLs documented in `release-setup.md`.
- Rollback: revert the workflow + script + manifest-generator changes in a single commit; the next release goes back to mac-only `latest.json`. Existing AppImage and MSI artifacts remain on R2 but get no updater pings.

## Open Questions

- Do we publish a Linux `.deb` in this change for Debian/Ubuntu users who hate AppImage? **Decision: no, follow-up change.**
- Do we want to set up Windows code-signing in the same change to avoid the SmartScreen prompt? **Decision: no, separate change to avoid blocking on cert procurement.**
- Should the local script gain a `release-local.ps1` for native PowerShell? **Decision: defer until a Windows developer complains about Git Bash.**
- Do we surface Linux/Windows install instructions inside the app's "About" screen? **Out of scope — the app's UX side is independent of the release pipeline.**
- Should `download.json` include a SHA-256 hash of each installer for verification on the consumer side? **Deferred — the immutable artifact URLs + the existing R2 TLS already give integrity guarantees in practice. We can add `sha256` as an optional field later without breaking consumers.**
- Should `download.json` include release notes or a changelog snippet? **Deferred — landing pages can fetch the GitHub release notes separately. Keep `download.json` focused on "what's the download URL".**
