#!/usr/bin/env bash
# Local release pipeline for Argus. Mirrors .github/workflows/release.yml so
# you can ship a build without pushing to master.
#
# Steps it runs:
#   1. Preflight: tools, secrets, clean tree, branch sanity (host-conditional).
#   2. Bump patch version (tauri.conf.json / package.json / Cargo.toml).
#   3. Commit + tag the bump (locally), optionally push.
#   4. Build, sign (and notarize on macOS) for the host's native targets.
#   5. Collect + rename artifacts under ./staging/.
#   6. Build latest.json (updater manifest) and download.json (public index).
#   7. Upload binaries (immutable cache) and manifests (no-cache) to R2
#      (Cloudflare) and, when ReleasesStack env is present, to S3 + CloudFront (AWS).
#
# Host detection (from uname -s):
#   Darwin            → macOS host; default targets: aarch64-apple-darwin,
#                       x86_64-apple-darwin
#   Linux             → Linux host; default target:  x86_64-unknown-linux-gnu
#                       (WSL also reports Linux and is treated as a Linux host)
#   MINGW*/MSYS*/CYGWIN* → Windows host (Git Bash / MSYS2 / Cygwin); default
#                       target: x86_64-pc-windows-msvc
# Cross-compilation is NOT supported by this script — use CI for cross-OS builds.
#
# Usage:
#   ./scripts/release-local.sh                          # full release, prompts before push
#   ./scripts/release-local.sh --no-push                # skip git push of commit+tag
#   ./scripts/release-local.sh --no-upload              # build only, no upload (R2 + S3)
#   ./scripts/release-local.sh --skip-bump              # use current version, no commit
#   ./scripts/release-local.sh --target aarch64         # build a single target (must be valid for host)
#   ./scripts/release-local.sh --target linux           # alias for x86_64-unknown-linux-gnu (Linux host only)
#   ./scripts/release-local.sh --target windows         # alias for x86_64-pc-windows-msvc (Windows host only)
#   ./scripts/release-local.sh --dry-run                # print plan, do nothing
#
# Local-host releases always emit a *full* latest.json / download.json: the
# script downloads the live manifests from R2, spreads them, then overwrites
# only the platforms this host built. Mac-only releases keep the prior Windows
# / Linux entries, and vice versa. No .partial.json is ever produced or
# uploaded.
#
# Secrets are read from environment or from .env.release at repo root.
# See .env.release.example for the full list.

set -euo pipefail

# ---------- locate repo + load env --------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

if [ -f "$ROOT/.env.release" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env.release"
  set +a
fi

# Expand leading "~/" in TAURI_SIGNING_PRIVATE_KEY — bash does not expand tildes
# inside quoted values when sourcing, and tauri-cli treats unexpanded paths as
# raw base64 content, which fails to decode.
if [[ "${TAURI_SIGNING_PRIVATE_KEY:-}" == "~/"* ]]; then
  TAURI_SIGNING_PRIVATE_KEY="${HOME}/${TAURI_SIGNING_PRIVATE_KEY:2}"
fi

# ---------- host detection ----------------------------------------------------

host_os() {
  case "$(uname -s)" in
    Darwin)                          echo "darwin" ;;
    Linux)                           echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) echo "windows" ;;
    *)                               echo "unsupported" ;;
  esac
}

HOST_OS="$(host_os)"

valid_targets_for_host() {
  case "$1" in
    darwin)  echo "aarch64-apple-darwin x86_64-apple-darwin" ;;
    linux)   echo "x86_64-unknown-linux-gnu" ;;
    windows) echo "x86_64-pc-windows-msvc" ;;
    *)       echo "" ;;
  esac
}

# ---------- defaults + flags --------------------------------------------------

SKIP_BUMP=0
NO_PUSH=0
NO_UPLOAD=0
DRY_RUN=0
TARGETS_FLAG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-bump)               SKIP_BUMP=1 ;;
    --no-push)                 NO_PUSH=1 ;;
    --no-upload)               NO_UPLOAD=1 ;;
    --dry-run)                 DRY_RUN=1 ;;
    --allow-partial-manifest)
      echo "--allow-partial-manifest is deprecated and ignored (local releases always emit a full manifest by merging with R2)." >&2 ;;
    --target)                  TARGETS_FLAG="$2"; shift ;;
    --target=*)                TARGETS_FLAG="${1#*=}" ;;
    -h|--help)
      sed -n '2,44p' "$0"; exit 0 ;;
    *)
      echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

# Resolve the requested target alias to a canonical Rust triple, OR pick host defaults.
resolve_target_alias() {
  case "$1" in
    aarch64|arm64|aarch64-apple-darwin) echo "aarch64-apple-darwin" ;;
    x64|x86_64|x86_64-apple-darwin)     echo "x86_64-apple-darwin" ;;
    linux|x86_64-unknown-linux-gnu)     echo "x86_64-unknown-linux-gnu" ;;
    windows|x86_64-pc-windows-msvc)     echo "x86_64-pc-windows-msvc" ;;
    *)                                  echo "" ;;
  esac
}

case "$HOST_OS" in
  darwin)  DEFAULT_TARGETS=("aarch64-apple-darwin" "x86_64-apple-darwin") ;;
  linux)   DEFAULT_TARGETS=("x86_64-unknown-linux-gnu") ;;
  windows) DEFAULT_TARGETS=("x86_64-pc-windows-msvc") ;;
  *)
    echo "Unsupported host OS: $(uname -s). This script supports macOS, Linux, and Windows (Git Bash / MSYS / Cygwin)." >&2
    exit 1
    ;;
esac

case "$TARGETS_FLAG" in
  ""|"both"|"all") TARGETS=("${DEFAULT_TARGETS[@]}") ;;
  *)
    resolved="$(resolve_target_alias "$TARGETS_FLAG")"
    if [ -z "$resolved" ]; then
      echo "Unknown --target: $TARGETS_FLAG" >&2; exit 2
    fi
    valid=" $(valid_targets_for_host "$HOST_OS") "
    if [[ "$valid" != *" $resolved "* ]]; then
      echo "ERROR: target '$resolved' is not buildable on host '$HOST_OS'." >&2
      echo "Valid targets on this host:$(valid_targets_for_host "$HOST_OS" | tr ' ' '\n' | sed 's/^/  - /')" >&2
      echo "Cross-compilation is not supported by this script — use the GitHub Actions workflow instead." >&2
      exit 2
    fi
    TARGETS=("$resolved")
    ;;
esac

# ---------- helpers -----------------------------------------------------------

c_blue()  { printf '\033[1;34m%s\033[0m\n' "$*"; }
c_green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
c_red()   { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }
c_dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

step() { c_blue "==> $*"; }
die()  { c_red  "ERROR: $*"; exit 1; }

run() {
  if [ "$DRY_RUN" = "1" ]; then
    c_dim "DRY: $*"
  else
    eval "$@"
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    die "Missing required env var: $name (set in .env.release or environment)"
  fi
}

arch_label() {
  case "$1" in
    aarch64-apple-darwin)      echo "aarch64" ;;
    x86_64-apple-darwin)       echo "x64" ;;
    x86_64-unknown-linux-gnu)  echo "x64" ;;
    x86_64-pc-windows-msvc)    echo "x64" ;;
    *) die "Unknown target: $1" ;;
  esac
}

manifest_key_for_target() {
  case "$1" in
    aarch64-apple-darwin)      echo "darwin-aarch64" ;;
    x86_64-apple-darwin)       echo "darwin-x86_64" ;;
    x86_64-unknown-linux-gnu)  echo "linux-x86_64" ;;
    x86_64-pc-windows-msvc)    echo "windows-x86_64" ;;
    *) die "Unknown target: $1" ;;
  esac
}

# ---------- preflight ---------------------------------------------------------

step "Preflight (host: $HOST_OS)"

require_cmd node
require_cmd pnpm
require_cmd cargo
require_cmd rustup
require_cmd jq
[ "$NO_UPLOAD" = "1" ] || require_cmd aws

# Updater key is required on every host — every release archive is signed with
# the Ed25519 updater key.
require_env TAURI_SIGNING_PRIVATE_KEY
require_env TAURI_SIGNING_PRIVATE_KEY_PASSWORD

case "$HOST_OS" in
  darwin)
    require_cmd security
    require_cmd codesign
    require_cmd xcrun

    require_env APPLE_ID
    require_env APPLE_PASSWORD
    require_env APPLE_TEAM_ID

    IDENTITY_MATCHES="$(security find-identity -v -p codesigning | grep -c "Developer ID Application" || true)"
    if [ "$IDENTITY_MATCHES" -eq 0 ]; then
      die "No 'Developer ID Application' identity found in keychain. Import the .p12 first."
    fi
    if [ "$IDENTITY_MATCHES" -gt 1 ] && [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
      c_red "Multiple 'Developer ID Application' identities found in keychain:"
      security find-identity -v -p codesigning | grep "Developer ID Application" >&2
      die "Set APPLE_SIGNING_IDENTITY in .env.release to the desired SHA-1 hash to disambiguate."
    fi
    ;;
  linux)
    LINUX_APT_PACKAGES=(
      libwebkit2gtk-4.1-dev
      libsoup-3.0-dev
      libayatana-appindicator3-dev
      librsvg2-dev
      build-essential
      curl
      file
      wget
    )
    if command -v dpkg >/dev/null 2>&1; then
      missing=()
      for pkg in "${LINUX_APT_PACKAGES[@]}"; do
        if ! dpkg -l "$pkg" >/dev/null 2>&1; then
          missing+=("$pkg")
        fi
      done
      if [ "${#missing[@]}" -gt 0 ]; then
        c_red "Missing Linux build dependencies:"
        printf '  - %s\n' "${missing[@]}" >&2
        die "Install with: sudo apt-get update && sudo apt-get install -y ${missing[*]}"
      fi
    else
      c_dim "dpkg not available — skipping apt package check (non-Debian host?). Ensure the equivalent Tauri build deps are installed."
    fi
    ;;
  windows)
    if ! command -v link.exe >/dev/null 2>&1 && ! command -v link >/dev/null 2>&1; then
      die "MSVC 'link.exe' not on PATH. Install Visual Studio Build Tools with the 'Desktop development with C++' workload, then run from a Developer Command Prompt or Git Bash launched from one."
    fi
    ;;
esac

# Required secrets for upload.
if [ "$NO_UPLOAD" = "0" ]; then
  require_env R2_ACCOUNT_ID
  require_env R2_ACCESS_KEY_ID
  require_env R2_SECRET_ACCESS_KEY
  require_env R2_BUCKET
  require_env R2_PUBLIC_URL
fi

# Verify rustup targets are installed.
INSTALLED_TARGETS="$(rustup target list --installed)"
for t in "${TARGETS[@]}"; do
  if ! echo "$INSTALLED_TARGETS" | grep -qx "$t"; then
    step "Installing missing rust target: $t"
    run "rustup target add '$t'"
  fi
done

# Working-tree must be clean unless we're skipping the bump (then nothing to commit anyway).
if [ "$SKIP_BUMP" = "0" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    die "Working tree is dirty. Commit or stash before running a release."
  fi
fi

# Branch sanity: warn if not on master.
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "master" ]; then
  c_red "Warning: current branch is '$CURRENT_BRANCH', not 'master'."
  if [ "$NO_PUSH" = "0" ] && [ "$DRY_RUN" = "0" ]; then
    read -r -p "Continue and push commit+tag to '$CURRENT_BRANCH'? [y/N] " ans
    [ "$ans" = "y" ] || [ "$ans" = "Y" ] || die "Aborted."
  fi
fi

c_green "Preflight OK"

# ---------- bump version ------------------------------------------------------

CURRENT_VERSION="$(jq -r .version src-tauri/tauri.conf.json)"
[ -n "$CURRENT_VERSION" ] && [ "$CURRENT_VERSION" != "null" ] || die "Cannot read current version"

if [ "$SKIP_BUMP" = "1" ]; then
  VERSION="$CURRENT_VERSION"
  step "Skipping bump. Using current version: v$VERSION"
else
  step "Bumping version (current: $CURRENT_VERSION)"
  if [ "$DRY_RUN" = "1" ]; then
    # Compute what the bump would be without writing.
    VERSION="$(node -e "
      const v='$CURRENT_VERSION'.split('.');
      console.log(\`\${v[0]}.\${v[1]}.\${Number(v[2])+1}\`);
    ")"
    c_dim "DRY: node scripts/bump-version.mjs  (would write v$VERSION)"
  else
    VERSION="$(node scripts/bump-version.mjs)"
  fi
  step "Bumped to v$VERSION"

  step "Committing + tagging v$VERSION"
  run "git add src-tauri/tauri.conf.json package.json src-tauri/Cargo.toml"
  run "git commit -m 'chore: bump version to v$VERSION [skip ci]'"
  run "git tag 'v$VERSION'"

  if [ "$NO_PUSH" = "0" ]; then
    if [ "$DRY_RUN" = "0" ]; then
      read -r -p "Push commit + tag v$VERSION to origin/$CURRENT_BRANCH? [y/N] " ans
      if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
        run "git push origin 'HEAD:$CURRENT_BRANCH'"
        run "git push origin 'v$VERSION'"
      else
        c_dim "Skipping push. You can push later with:"
        c_dim "  git push origin HEAD:$CURRENT_BRANCH && git push origin v$VERSION"
      fi
    else
      c_dim "DRY: would push HEAD and tag v$VERSION"
    fi
  fi
fi

# ---------- build each target -------------------------------------------------

STAGING="$ROOT/staging"
run "rm -rf '$STAGING'"
run "mkdir -p '$STAGING'"

step "Installing pnpm dependencies"
run "pnpm install --frozen-lockfile"

for TARGET in "${TARGETS[@]}"; do
  ARCH="$(arch_label "$TARGET")"
  step "Building target: $TARGET ($ARCH)"

  case "$HOST_OS" in
    darwin)
      # Tauri picks up these env vars to drive codesign + notarytool + updater signing.
      # We explicitly unset APPLE_CERTIFICATE{,_PASSWORD} so the keychain identity is used
      # locally — if they leak in from .env.release, tauri-bundler tries to re-import the
      # p12 and rejects any APPLE_SIGNING_IDENTITY that doesn't match it byte-for-byte.
      run "env -u APPLE_CERTIFICATE -u APPLE_CERTIFICATE_PASSWORD \
           TAURI_SIGNING_PRIVATE_KEY='$TAURI_SIGNING_PRIVATE_KEY' \
           TAURI_SIGNING_PRIVATE_KEY_PASSWORD='$TAURI_SIGNING_PRIVATE_KEY_PASSWORD' \
           APPLE_ID='$APPLE_ID' \
           APPLE_PASSWORD='$APPLE_PASSWORD' \
           APPLE_TEAM_ID='$APPLE_TEAM_ID' \
           APPLE_SIGNING_IDENTITY='${APPLE_SIGNING_IDENTITY:-Developer ID Application}' \
           pnpm tauri build --target '$TARGET'"
      ;;
    linux|windows)
      run "env \
           TAURI_SIGNING_PRIVATE_KEY='$TAURI_SIGNING_PRIVATE_KEY' \
           TAURI_SIGNING_PRIVATE_KEY_PASSWORD='$TAURI_SIGNING_PRIVATE_KEY_PASSWORD' \
           pnpm tauri build --target '$TARGET'"
      ;;
  esac

  BUNDLE_DIR="src-tauri/target/$TARGET/release/bundle"
  if [ "$DRY_RUN" = "1" ]; then
    c_dim "DRY: would collect artifacts from $BUNDLE_DIR"
    continue
  fi

  case "$TARGET" in
    aarch64-apple-darwin|x86_64-apple-darwin)
      DMG="$(ls "$BUNDLE_DIR/dmg/"*.dmg 2>/dev/null | head -1 || true)"
      TARBALL="$(ls "$BUNDLE_DIR/macos/"*.app.tar.gz 2>/dev/null | head -1 || true)"
      SIG="${TARBALL}.sig"
      [ -f "$DMG" ]     || die "DMG not found under $BUNDLE_DIR/dmg/"
      [ -f "$TARBALL" ] || die "Updater tarball not found under $BUNDLE_DIR/macos/"
      [ -f "$SIG" ]     || die "Updater signature not found: $SIG"

      BASE_DMG="Argus_${VERSION}_${ARCH}.dmg"
      BASE_TARBALL="Argus_${VERSION}_${ARCH}.app.tar.gz"
      cp "$DMG"     "$STAGING/$BASE_DMG"
      cp "$TARBALL" "$STAGING/$BASE_TARBALL"
      cp "$SIG"     "$STAGING/${BASE_TARBALL}.sig"
      c_green "  Staged: $BASE_DMG, $BASE_TARBALL, ${BASE_TARBALL}.sig"
      ;;
    x86_64-unknown-linux-gnu)
      APPIMAGE="$(ls "$BUNDLE_DIR/appimage/"*.AppImage 2>/dev/null | head -1 || true)"
      TARBALL="$(ls "$BUNDLE_DIR/appimage/"*.AppImage.tar.gz 2>/dev/null | head -1 || true)"
      SIG="${TARBALL}.sig"
      [ -f "$APPIMAGE" ] || die "AppImage not found under $BUNDLE_DIR/appimage/"
      [ -f "$TARBALL" ]  || die "Updater tarball not found under $BUNDLE_DIR/appimage/"
      [ -f "$SIG" ]      || die "Updater signature not found: $SIG"

      BASE_APPIMAGE="Argus_${VERSION}_${ARCH}.AppImage"
      BASE_TARBALL="Argus_${VERSION}_${ARCH}.AppImage.tar.gz"
      cp "$APPIMAGE" "$STAGING/$BASE_APPIMAGE"
      cp "$TARBALL"  "$STAGING/$BASE_TARBALL"
      cp "$SIG"      "$STAGING/${BASE_TARBALL}.sig"
      c_green "  Staged: $BASE_APPIMAGE, $BASE_TARBALL, ${BASE_TARBALL}.sig"
      ;;
    x86_64-pc-windows-msvc)
      MSI="$(ls "$BUNDLE_DIR/msi/"*.msi 2>/dev/null | head -1 || true)"
      ZIP="$(ls "$BUNDLE_DIR/msi/"*.msi.zip 2>/dev/null | head -1 || true)"
      SIG="${ZIP}.sig"
      [ -f "$MSI" ] || die "MSI not found under $BUNDLE_DIR/msi/"
      [ -f "$ZIP" ] || die "Updater archive not found under $BUNDLE_DIR/msi/"
      [ -f "$SIG" ] || die "Updater signature not found: $SIG"

      BASE_MSI="Argus_${VERSION}_${ARCH}.msi"
      BASE_ZIP="Argus_${VERSION}_${ARCH}.msi.zip"
      cp "$MSI" "$STAGING/$BASE_MSI"
      cp "$ZIP" "$STAGING/$BASE_ZIP"
      cp "$SIG" "$STAGING/${BASE_ZIP}.sig"
      c_green "  Staged: $BASE_MSI, $BASE_ZIP, ${BASE_ZIP}.sig"
      ;;
  esac
done

# ---------- manifests ---------------------------------------------------------

# Determine which manifest_keys we built so we can pass them down to the
# generator. The generators merge this build's entries on top of a base
# manifest fetched from R2 so the output is always full (never .partial.json).
BUILT_KEYS=()
for TARGET in "${TARGETS[@]}"; do
  BUILT_KEYS+=("$(manifest_key_for_target "$TARGET")")
done

env_for_manifest() {
  # Echo the env-var assignments for build-manifest.mjs / build-download-manifest.mjs
  # based on which platforms were built. Caller composes the rest.
  local mode="$1"
  local kind="$2" # "updater" | "download"
  for key in "${BUILT_KEYS[@]}"; do
    case "$key:$kind" in
      darwin-aarch64:updater)
        echo "DARWIN_AARCH64_TARBALL='Argus_${VERSION}_aarch64.app.tar.gz'"
        echo "DARWIN_AARCH64_SIG_PATH='$STAGING/Argus_${VERSION}_aarch64.app.tar.gz.sig'"
        ;;
      darwin-x86_64:updater)
        echo "DARWIN_X86_64_TARBALL='Argus_${VERSION}_x64.app.tar.gz'"
        echo "DARWIN_X86_64_SIG_PATH='$STAGING/Argus_${VERSION}_x64.app.tar.gz.sig'"
        ;;
      linux-x86_64:updater)
        echo "LINUX_X86_64_TARBALL='Argus_${VERSION}_x64.AppImage.tar.gz'"
        echo "LINUX_X86_64_SIG_PATH='$STAGING/Argus_${VERSION}_x64.AppImage.tar.gz.sig'"
        ;;
      windows-x86_64:updater)
        echo "WINDOWS_X86_64_TARBALL='Argus_${VERSION}_x64.msi.zip'"
        echo "WINDOWS_X86_64_SIG_PATH='$STAGING/Argus_${VERSION}_x64.msi.zip.sig'"
        ;;
      darwin-aarch64:download)
        echo "DARWIN_AARCH64_INSTALLER='Argus_${VERSION}_aarch64.dmg'"
        ;;
      darwin-x86_64:download)
        echo "DARWIN_X86_64_INSTALLER='Argus_${VERSION}_x64.dmg'"
        ;;
      linux-x86_64:download)
        echo "LINUX_X86_64_INSTALLER='Argus_${VERSION}_x64.AppImage'"
        ;;
      windows-x86_64:download)
        echo "WINDOWS_X86_64_INSTALLER='Argus_${VERSION}_x64.msi'"
        ;;
    esac
  done
}

step "Fetching base manifests from R2 (so we merge instead of overwriting other platforms)"
BASE_DIR="$STAGING/.manifest-base"
LATEST_BASE="$BASE_DIR/latest.json"
DOWNLOAD_BASE="$BASE_DIR/download.json"
run "mkdir -p '$BASE_DIR'"

# Configure aws creds early so we can read from R2 even when --no-upload is
# set later. If R2 credentials are missing (e.g. --no-upload + unset env),
# we skip the fetch and emit the manifest from scratch.
HAVE_R2_READ=0
if [ -n "${R2_ACCOUNT_ID:-}" ] && [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -n "${R2_SECRET_ACCESS_KEY:-}" ] && [ -n "${R2_BUCKET:-}" ]; then
  HAVE_R2_READ=1
  ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  export AWS_DEFAULT_REGION="auto"
  export AWS_EC2_METADATA_DISABLED="true"
fi

fetch_base() {
  local key="$1" out="$2"
  if [ "$HAVE_R2_READ" = "0" ]; then
    c_dim "  Skipping fetch of $key (R2 credentials not available)."
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    c_dim "DRY: would fetch s3://${R2_BUCKET}/${key} → $out"
    return 0
  fi
  if aws s3 cp "s3://${R2_BUCKET}/${key}" "$out" \
        --endpoint-url "$ENDPOINT" >/dev/null 2>&1; then
    c_green "  Fetched base $key"
  else
    c_dim "  No existing $key in R2 (will emit from scratch)."
    rm -f "$out"
  fi
}

fetch_base "latest.json" "$LATEST_BASE"
fetch_base "download.json" "$DOWNLOAD_BASE"

# Manifests reference the CloudFront base when the ReleasesStack env is loaded
# (PUBLIC_URL_BASE from .envrc), so updating clients migrate to AWS hosting.
# Falls back to the R2 public URL when the S3 infra isn't configured.
MANIFEST_URL_BASE="${PUBLIC_URL_BASE:-$R2_PUBLIC_URL}"

step "Building latest.json manifest (mode=local)"
PUB_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
if [ "$DRY_RUN" = "1" ]; then
  c_dim "DRY: would run node scripts/build-manifest.mjs"
  c_dim "DRY: would run node scripts/build-download-manifest.mjs"
else
  # env_for_manifest emits one assignment per line; flatten to a single line
  # so the embedded newlines do not split the eval'd command into pieces
  # (which would leave `env` printing its environment and `node` running
  # without VERSION/PUB_DATE/etc).

  # Pass MANIFEST_BASE_FILE only if the file actually exists on disk.
  LATEST_BASE_ENV=""
  [ -f "$LATEST_BASE" ] && LATEST_BASE_ENV="MANIFEST_BASE_FILE='$LATEST_BASE'"
  DOWNLOAD_BASE_ENV=""
  [ -f "$DOWNLOAD_BASE" ] && DOWNLOAD_BASE_ENV="MANIFEST_BASE_FILE='$DOWNLOAD_BASE'"

  # Updater manifest
  UPDATER_ENV="$(env_for_manifest local updater | tr '\n' ' ')"
  eval "env \
    VERSION='$VERSION' \
    PUB_DATE='$PUB_DATE' \
    PUBLIC_URL_BASE='$MANIFEST_URL_BASE' \
    MANIFEST_MODE=local \
    $LATEST_BASE_ENV \
    $UPDATER_ENV \
    node scripts/build-manifest.mjs"

  # Download manifest
  DOWNLOAD_ENV="$(env_for_manifest local download | tr '\n' ' ')"
  eval "env \
    VERSION='$VERSION' \
    PUB_DATE='$PUB_DATE' \
    PUBLIC_URL_BASE='$MANIFEST_URL_BASE' \
    MANIFEST_MODE=local \
    STAGING_DIR='$STAGING' \
    $DOWNLOAD_BASE_ENV \
    $DOWNLOAD_ENV \
    node scripts/build-download-manifest.mjs"
fi

LATEST_FILE="latest.json"
DOWNLOAD_FILE="download.json"

# ---------- upload to R2 ------------------------------------------------------

if [ "$NO_UPLOAD" = "1" ]; then
  c_dim "Skipping R2 upload (--no-upload)."
else
  step "Uploading to R2 (bucket: $R2_BUCKET)"
  # AWS creds + ENDPOINT were already exported above for the base-manifest
  # fetch. We require_env'd them in preflight, so they're guaranteed set here.

  # Binaries: long cache (1 year), immutable. Skip the manifest-base cache
  # subdirectory so we don't try to upload it as an artifact.
  for f in "$STAGING"/*; do
    [ -f "$f" ] || continue
    key="$(basename "$f")"
    run "aws s3 cp '$f' 's3://${R2_BUCKET}/${key}' \
          --endpoint-url '$ENDPOINT' \
          --cache-control 'public, max-age=31536000, immutable'"
  done

  # Manifests: no-cache, JSON content type. Always full — the generators
  # spread the base file fetched from R2 so other platforms keep their entries.
  if [ -f "$ROOT/$LATEST_FILE" ]; then
    run "aws s3 cp '$ROOT/$LATEST_FILE' 's3://${R2_BUCKET}/latest.json' \
          --endpoint-url '$ENDPOINT' \
          --cache-control 'no-cache, max-age=0' \
          --content-type 'application/json'"
  fi
  if [ -f "$ROOT/$DOWNLOAD_FILE" ]; then
    run "aws s3 cp '$ROOT/$DOWNLOAD_FILE' 's3://${R2_BUCKET}/download.json' \
          --endpoint-url '$ENDPOINT' \
          --cache-control 'no-cache, max-age=0' \
          --content-type 'application/json'"
  fi
fi

# ---------- upload to S3 + CloudFront (AWS) -----------------------------------

# Dual-publish to AWS using the loaded AWS profile (AWS_PROFILE). Resource names
# come from the ReleasesStack SSM params, exported into the env by .envrc:
#   RELEASE_S3_BUCKET, RELEASE_CLOUDFRONT_DISTRIBUTION_ID
# The R2 fetch/upload above exported R2 creds into AWS_ACCESS_KEY_ID/etc; we
# strip them per-command so the AWS profile (not R2) authenticates these calls.
S3_AWS="env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_DEFAULT_REGION -u AWS_EC2_METADATA_DISABLED aws"

if [ "$NO_UPLOAD" = "1" ]; then
  c_dim "Skipping S3 upload (--no-upload)."
elif [ -z "${RELEASE_S3_BUCKET:-}" ]; then
  c_dim "Skipping S3 upload (RELEASE_S3_BUCKET unset — deploy ReleasesStack and load .envrc to enable)."
else
  step "Uploading to S3 (bucket: $RELEASE_S3_BUCKET, profile: ${AWS_PROFILE:-default})"

  # Binaries: long cache (1 year), immutable. Skip the .manifest-base subdir.
  for f in "$STAGING"/*; do
    [ -f "$f" ] || continue
    key="$(basename "$f")"
    run "$S3_AWS s3 cp '$f' 's3://${RELEASE_S3_BUCKET}/${key}' \
          --cache-control 'public, max-age=31536000, immutable'"
  done

  # Manifests: no-cache, JSON content type.
  if [ -f "$ROOT/$LATEST_FILE" ]; then
    run "$S3_AWS s3 cp '$ROOT/$LATEST_FILE' 's3://${RELEASE_S3_BUCKET}/latest.json' \
          --cache-control 'no-cache, max-age=0' \
          --content-type 'application/json'"
  fi
  if [ -f "$ROOT/$DOWNLOAD_FILE" ]; then
    run "$S3_AWS s3 cp '$ROOT/$DOWNLOAD_FILE' 's3://${RELEASE_S3_BUCKET}/download.json' \
          --cache-control 'no-cache, max-age=0' \
          --content-type 'application/json'"
  fi

  # Bust the CloudFront cache for the two manifests.
  if [ -n "${RELEASE_CLOUDFRONT_DISTRIBUTION_ID:-}" ]; then
    step "Invalidating CloudFront manifests ($RELEASE_CLOUDFRONT_DISTRIBUTION_ID)"
    run "$S3_AWS cloudfront create-invalidation \
          --distribution-id '$RELEASE_CLOUDFRONT_DISTRIBUTION_ID' \
          --paths '/latest.json' '/download.json'"
  fi
fi

# ---------- summary -----------------------------------------------------------

c_green ""
c_green "Release v$VERSION complete."
echo
echo "  Host        : $HOST_OS"
echo "  Staging dir : $STAGING"
echo "  Targets     : ${TARGETS[*]}"
echo "  Manifest    : $ROOT/$LATEST_FILE"
echo "  Download    : $ROOT/$DOWNLOAD_FILE"
if [ "$NO_UPLOAD" = "0" ]; then
  echo "  Manifest URL: $MANIFEST_URL_BASE/latest.json"
  echo "  Download    : $MANIFEST_URL_BASE/download.json"
  echo "  R2 bucket   : $R2_BUCKET"
  [ -n "${RELEASE_S3_BUCKET:-}" ] && echo "  S3 bucket   : $RELEASE_S3_BUCKET"
  for f in "$STAGING"/*; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    case "$name" in
      *.dmg|*.AppImage|*.msi) echo "  Installer   : $MANIFEST_URL_BASE/$name" ;;
    esac
  done
fi
