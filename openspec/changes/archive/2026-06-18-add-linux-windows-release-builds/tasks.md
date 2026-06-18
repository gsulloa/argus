## 1. Manifest generator: support Linux + Windows entries

- [x] 1.1 Rename macOS-only env vars in `scripts/build-manifest.mjs` from `ARM64_*`/`X64_*` to `DARWIN_AARCH64_*`/`DARWIN_X86_64_*` (keep the old names as deprecated aliases so existing callers don't break mid-rollout).
- [x] 1.2 Add new optional env-var pairs: `LINUX_X86_64_TARBALL` + `LINUX_X86_64_SIG_PATH`, and `WINDOWS_X86_64_TARBALL` + `WINDOWS_X86_64_SIG_PATH`.
- [x] 1.3 Refactor the script to iterate over a table of `[platformKey, tarballEnv, sigEnv]` rows and emit a `platforms[platformKey]` entry only when both env vars are set; fail explicitly when exactly one of the pair is set.
- [x] 1.4 Introduce a `MANIFEST_MODE=ci|local` env (default `ci`); in `ci` mode exit non-zero if fewer than 4 platforms are emitted; in `local` mode print a warning instead and continue.
- [x] 1.5 When in `local` mode AND the platform set is partial, write the output to `latest.partial.json` instead of `latest.json` so the upload step can tell the difference.
- [x] 1.6 Add a smoke test (just a `node scripts/build-manifest.mjs` invocation in a temp dir with synthetic sig files) under `scripts/__tests__/` or inline in the script comments — at minimum verify the four-platform case and the Linux-only case both produce structurally valid JSON.

## 1B. Download manifest generator: build `download.json`

- [x] 1B.1 Create `scripts/build-download-manifest.mjs` (sibling to `build-manifest.mjs`) that reads `VERSION`, `PUB_DATE`, `PUBLIC_URL_BASE`, and four per-platform installer-filename env vars (`DARWIN_AARCH64_INSTALLER`, `DARWIN_X86_64_INSTALLER`, `LINUX_X86_64_INSTALLER`, `WINDOWS_X86_64_INSTALLER`).
- [x] 1B.2 For each provided installer, resolve the file inside `staging/` via `statSync` to populate `size` (bytes); fail with a clear error if the file is missing or unreadable.
- [x] 1B.3 Emit the document matching the spec schema: top-level `version` + `pub_date` + `installers[<platform-key>]` with `url`, `filename`, `size`.
- [x] 1B.4 Honor `MANIFEST_MODE=ci|local`: in `ci`, require all four installer env vars and exit non-zero otherwise; in `local`, accept any subset and write to `download.partial.json` instead of `download.json` when partial.
- [x] 1B.5 Reject any installer filename ending in `.app.tar.gz`, `.AppImage.tar.gz`, `.msi.zip`, or `.sig` with a clear error — `download.json` must only point at end-user installers.
- [x] 1B.6 Add a smoke-test invocation under `scripts/__tests__/` (or as a doc comment in the script) covering the four-platform CI case and the Linux-only local case.

## 2. GitHub Actions workflow: extend matrix to 4 targets

- [x] 2.1 Update `.github/workflows/release.yml` `build.strategy.matrix.include` to add two entries: `{ os: ubuntu-22.04, target: x86_64-unknown-linux-gnu, arch: linux-x64, manifest_key: linux-x86_64 }` and `{ os: windows-latest, target: x86_64-pc-windows-msvc, arch: windows-x64, manifest_key: windows-x86_64 }`.
- [x] 2.2 Keep `fail-fast: false` (already set) so a single OS failure doesn't cancel the others.
- [x] 2.3 Add a conditional "Install Linux deps" step gated on `matrix.os == 'ubuntu-22.04'`: `apt-get update && apt-get install -y libwebkit2gtk-4.1-dev libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev build-essential curl file wget`.
- [x] 2.4 Cache the apt downloads via `actions/cache` keyed on a hash of the package list to keep Linux build wall-clock reasonable.
- [x] 2.5 Gate the existing "Import Apple cert into keychain" step on `matrix.os` being one of the two macOS runners so it doesn't run on Linux or Windows.
- [x] 2.6 Keep the `tauri-apps/tauri-action@v0` build step but make sure its env block does NOT pass Apple env vars on non-mac runners (no-op'd by `matrix.os` check, or simply unused — the action ignores unset env).
- [x] 2.7 Replace the macOS-only "Collect artifact paths" step with a switch on `matrix.os`:
  - macOS: existing logic (rename `.dmg` + `.app.tar.gz` + `.sig`).
  - Linux: locate `.AppImage`, `.AppImage.tar.gz`, `.AppImage.tar.gz.sig` under `bundle/appimage/`; rename to `Argus_${VERSION}_x64.AppImage{,.tar.gz,.tar.gz.sig}`.
  - Windows: locate `.msi`, `.msi.zip`, `.msi.zip.sig` under `bundle/msi/`; rename to `Argus_${VERSION}_x64.msi{,.zip,.zip.sig}`.
- [x] 2.8 Update the `actions/upload-artifact` step name to use `matrix.arch` so each OS gets a distinct artifact bundle (`bundle-aarch64`, `bundle-x64`, `bundle-linux-x64`, `bundle-windows-x64`).

## 3. GitHub Actions workflow: publish across 4 platforms

- [x] 3.1 Add `actions/download-artifact` steps for `bundle-linux-x64` and `bundle-windows-x64` to the `publish` job, mirroring the existing mac downloads (all into `staging/`).
- [x] 3.2 Add a "Verify all four bundles present" step that lists the four expected canonical filenames under `staging/` and fails if any is missing.
- [x] 3.3 Pass the four new env vars to the manifest step (`LINUX_X86_64_TARBALL`, `LINUX_X86_64_SIG_PATH`, `WINDOWS_X86_64_TARBALL`, `WINDOWS_X86_64_SIG_PATH`) alongside the existing mac vars; rename the existing vars to the new `DARWIN_*` names from task 1.1.
- [x] 3.4 Set `MANIFEST_MODE=ci` in the env for the manifest step so a partial input fails the workflow.
- [x] 3.5 The R2 upload loop already iterates `for f in staging/*`, so it picks up the new artifacts automatically — verify nothing in the upload step is mac-specific.
- [x] 3.6 Add a "Build download.json" step that invokes `node scripts/build-download-manifest.mjs` with `MANIFEST_MODE=ci`, passing the four installer filenames (`Argus_${VERSION}_aarch64.dmg`, `Argus_${VERSION}_x64.dmg`, `Argus_${VERSION}_x64.AppImage`, `Argus_${VERSION}_x64.msi`).
- [x] 3.7 Extend the "Upload manifest (no cache)" step (or add a sibling step using the same env) to also upload `download.json` with `Cache-Control: no-cache, max-age=0` and `Content-Type: application/json`. Both manifests must succeed before the job is considered green.

## 4. Local script: host-aware target selection

- [x] 4.1 Add a `host_os()` helper to `scripts/release-local.sh` that maps `uname -s` to `darwin` | `linux` | `windows` | `unsupported`, treating WSL as `linux` and Git Bash / MSYS / Cygwin as `windows`.
- [x] 4.2 Add a `valid_targets_for_host()` helper returning the legal target list for the current host.
- [x] 4.3 Update the `--target` flag parsing to accept the new identifiers (`linux`, `x86_64-unknown-linux-gnu`, `windows`, `x86_64-pc-windows-msvc`) and validate them against `valid_targets_for_host`; abort with a clear error when mismatched.
- [x] 4.4 Update the `TARGETS=(...)` default selection so each host gets the right defaults: macOS → both Apple targets (current behavior); Linux → `x86_64-unknown-linux-gnu`; Windows → `x86_64-pc-windows-msvc`.
- [x] 4.5 Refactor the preflight section: split Apple-only checks (`security`, `codesign`, `xcrun`, Apple env vars, signing identity in keychain) behind a `host_os == darwin` guard.
- [x] 4.6 Add a Linux-host preflight that checks for the apt package set from task 2.3 via `dpkg -l` and prints a clear "install these" message if any is missing.
- [x] 4.7 Add a Windows-host preflight that checks for the MSVC `link.exe` on `PATH` and prints a "install Visual Studio Build Tools" message if missing.
- [x] 4.8 Add an `arch_label()` mapping for the new targets: `x86_64-unknown-linux-gnu → x64` (the script still uses the canonical naming `Argus_${VERSION}_x64.<ext>` per the spec) and `x86_64-pc-windows-msvc → x64`.
- [x] 4.9 Update the per-target collect logic to switch on the target and pick the right bundle dir (`bundle/appimage/` on Linux, `bundle/msi/` on Windows, existing logic on macOS).
- [x] 4.10 Update the manifest-build invocation to pass the new platform env vars and `MANIFEST_MODE=local`, then read `latest.partial.json` instead of `latest.json` when the build set is partial.
- [x] 4.11 Add a `--allow-partial-manifest` flag; refuse to upload `latest.partial.json` or `download.partial.json` to R2 unless this flag is set.
- [x] 4.12 Invoke `scripts/build-download-manifest.mjs` next to the existing `build-manifest.mjs` call, with `MANIFEST_MODE=local` and the installer filenames for whatever platforms were built; route output to `download.json` or `download.partial.json` accordingly.
- [x] 4.13 Extend the R2 upload section to also upload `download.json` (full builds) with the same no-cache headers as `latest.json`. Partial files (`download.partial.json`) are uploaded only when `--allow-partial-manifest` is set, and even then to a separate key — never overwriting the live `download.json`.

## 5. Config + icons sanity check

- [x] 5.1 Verify `src-tauri/tauri.conf.json` has `bundle.targets: "all"` (already true) and `bundle.icon` includes both `icon.icns` and `icon.ico` so mac and Windows bundling work without further edits.
- [x] 5.2 Verify `src-tauri/Cargo.toml` does not pin `windows`-incompatible dependencies; run `cargo check --target x86_64-pc-windows-msvc` locally (or document the check as a CI verification) — only adjust dependencies if a real failure surfaces.
- [x] 5.3 Confirm the existing icon set rasterizes correctly under Linux's AppImage (PNG paths in the icon array already cover this).

## 6. Documentation

- [x] 6.1 Update `docs/release-setup.md` with a new "Linux runner setup" section listing the apt packages and the rationale for pinning `ubuntu-22.04`.
- [x] 6.2 Add a "Windows MSI is unsigned (for now)" section to `docs/release-setup.md` describing the SmartScreen experience and the planned follow-up for code-signing.
- [x] 6.3 Update the local-script usage block in `docs/release-setup.md` to cover Linux and Windows hosts, including the prerequisite system packages on each.
- [x] 6.4a Document `download.json` in `docs/release-setup.md`: the fixed URL (`${PUBLIC_URL_BASE}/download.json`), its schema, the difference vs `latest.json` (installer URLs vs updater archives), and the stability guarantee. Include a copy-pasteable HTML snippet for a "Download Argus" button that fetches the file and routes by `navigator.platform`.
- [x] 6.4 Update `scripts/release-local.sh`'s top-of-file usage comment to reflect the new flags and the host-OS detection behavior.
- [x] 6.5 Update the `--help` text the script prints (the `sed -n '2,24p' "$0"` block) so it matches the new comment block.

## 7. End-to-end verification

- [ ] 7.1 Run `./scripts/release-local.sh --no-push --no-upload --skip-bump` on macOS and confirm both `.dmg`s still build and stage exactly as before — no regression on the mac path.
- [ ] 7.2 On a Linux VM (or via a one-off `act` run, or by pushing a throwaway branch), run the workflow end-to-end with the matrix expanded; confirm `bundle-linux-x64` artifact appears with a `.AppImage`.
- [ ] 7.3 On a Windows VM, run the workflow with the matrix expanded; confirm `bundle-windows-x64` artifact appears with a `.msi`.
- [ ] 7.4 Confirm `latest.json` after a real release contains all four platform keys with non-empty `signature` values and resolvable `url`s.
- [ ] 7.4a Confirm `download.json` after the same real release contains all four `installers` keys, each with a `url` that ends in `.dmg`/`.AppImage`/`.msi` (NOT updater archives), a non-zero `size`, and resolves with HTTP 200 returning the installer bytes.
- [ ] 7.4b Fetch `https://<r2-public>/download.json` from a clean machine (no cache) twice across two consecutive releases and verify each fetch returns the correct latest version (no stale cache).
- [ ] 7.5 Install the resulting `.AppImage` on a clean Ubuntu 22.04 box; install the resulting `.msi` on a clean Windows 11 box; verify both launch and that the in-app updater check succeeds (no actual update needed, just confirm the manifest fetch + signature check passes).
- [ ] 7.6 Bump the existing `release-pipeline` spec by archiving this change (`/opsx:archive` after merge) so future readers see the four-platform requirements as canonical.
