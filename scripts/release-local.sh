#!/usr/bin/env bash
# Local release pipeline for Argus. Mirrors .github/workflows/release.yml so
# you can ship a build without pushing to master.
#
# Steps it runs:
#   1. Preflight: tools, secrets, clean tree, branch sanity.
#   2. Bump patch version (tauri.conf.json / package.json / Cargo.toml).
#   3. Commit + tag the bump (locally), optionally push.
#   4. Build, sign, notarize for aarch64 + x86_64 darwin targets.
#   5. Collect + rename artifacts under ./staging/.
#   6. Build latest.json manifest.
#   7. Upload binaries (immutable cache) and manifest (no-cache) to R2.
#
# Usage:
#   ./scripts/release-local.sh                  # full release, prompts before push
#   ./scripts/release-local.sh --no-push        # skip git push of commit+tag
#   ./scripts/release-local.sh --no-upload      # build only, no R2 upload
#   ./scripts/release-local.sh --skip-bump      # use current version, no commit
#   ./scripts/release-local.sh --target aarch64 # build a single target
#   ./scripts/release-local.sh --dry-run        # print plan, do nothing
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

# ---------- defaults + flags --------------------------------------------------

SKIP_BUMP=0
NO_PUSH=0
NO_UPLOAD=0
DRY_RUN=0
TARGETS_FLAG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-bump)   SKIP_BUMP=1 ;;
    --no-push)     NO_PUSH=1 ;;
    --no-upload)   NO_UPLOAD=1 ;;
    --dry-run)     DRY_RUN=1 ;;
    --target)      TARGETS_FLAG="$2"; shift ;;
    --target=*)    TARGETS_FLAG="${1#*=}" ;;
    -h|--help)
      sed -n '2,24p' "$0"; exit 0 ;;
    *)
      echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

case "$TARGETS_FLAG" in
  ""|"both"|"all") TARGETS=("aarch64-apple-darwin" "x86_64-apple-darwin") ;;
  "aarch64"|"arm64"|"aarch64-apple-darwin") TARGETS=("aarch64-apple-darwin") ;;
  "x64"|"x86_64"|"x86_64-apple-darwin")     TARGETS=("x86_64-apple-darwin") ;;
  *) echo "Unknown --target: $TARGETS_FLAG" >&2; exit 2 ;;
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
    aarch64-apple-darwin) echo "aarch64" ;;
    x86_64-apple-darwin)  echo "x64" ;;
    *) die "Unknown target: $1" ;;
  esac
}

# ---------- preflight ---------------------------------------------------------

step "Preflight"

[ "$(uname -s)" = "Darwin" ] || die "This script must run on macOS (codesign + notarize)."

require_cmd node
require_cmd pnpm
require_cmd cargo
require_cmd rustup
require_cmd jq
require_cmd security
require_cmd codesign
require_cmd xcrun
[ "$NO_UPLOAD" = "1" ] || require_cmd aws

# Required secrets for the build (signing + notarization + updater signer).
require_env APPLE_ID
require_env APPLE_PASSWORD
require_env APPLE_TEAM_ID
require_env TAURI_SIGNING_PRIVATE_KEY
require_env TAURI_SIGNING_PRIVATE_KEY_PASSWORD

# Required secrets for upload.
if [ "$NO_UPLOAD" = "0" ]; then
  require_env R2_ACCOUNT_ID
  require_env R2_ACCESS_KEY_ID
  require_env R2_SECRET_ACCESS_KEY
  require_env R2_BUCKET
  require_env R2_PUBLIC_URL
fi

# Verify the Developer ID Application identity is in a keychain.
IDENTITY_MATCHES="$(security find-identity -v -p codesigning | grep -c "Developer ID Application" || true)"
if [ "$IDENTITY_MATCHES" -eq 0 ]; then
  die "No 'Developer ID Application' identity found in keychain. Import the .p12 first."
fi
if [ "$IDENTITY_MATCHES" -gt 1 ] && [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  c_red "Multiple 'Developer ID Application' identities found in keychain:"
  security find-identity -v -p codesigning | grep "Developer ID Application" >&2
  die "Set APPLE_SIGNING_IDENTITY in .env.release to the desired SHA-1 hash to disambiguate."
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

# Resolve TAURI_SIGNING_PRIVATE_KEY: workflow passes raw contents, but locally
# users often have a file path. tauri-cli accepts either: if the env value is a
# readable file path it loads the file, otherwise treats it as the key content.
# Nothing to do here — just pass through.

step "Installing pnpm dependencies"
run "pnpm install --frozen-lockfile"

for TARGET in "${TARGETS[@]}"; do
  ARCH="$(arch_label "$TARGET")"
  step "Building target: $TARGET ($ARCH)"

  # Tauri picks up these env vars to drive codesign + notarytool + updater signing.
  run "TAURI_SIGNING_PRIVATE_KEY='$TAURI_SIGNING_PRIVATE_KEY' \
       TAURI_SIGNING_PRIVATE_KEY_PASSWORD='$TAURI_SIGNING_PRIVATE_KEY_PASSWORD' \
       APPLE_ID='$APPLE_ID' \
       APPLE_PASSWORD='$APPLE_PASSWORD' \
       APPLE_TEAM_ID='$APPLE_TEAM_ID' \
       APPLE_SIGNING_IDENTITY='${APPLE_SIGNING_IDENTITY:-Developer ID Application}' \
       pnpm tauri build --target '$TARGET'"

  BUNDLE_DIR="src-tauri/target/$TARGET/release/bundle"
  if [ "$DRY_RUN" = "1" ]; then
    c_dim "DRY: would collect artifacts from $BUNDLE_DIR"
    continue
  fi

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
done

# ---------- manifest ----------------------------------------------------------

# Only build the manifest if we have BOTH targets in staging — the workflow
# always ships both platforms in a single latest.json.
WANT_MANIFEST=1
if [ "${#TARGETS[@]}" -ne 2 ]; then
  WANT_MANIFEST=0
fi

if [ "$WANT_MANIFEST" = "1" ]; then
  step "Building latest.json manifest"
  PUB_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  if [ "$DRY_RUN" = "1" ]; then
    c_dim "DRY: would run node scripts/build-manifest.mjs"
  else
    VERSION="$VERSION" \
    PUB_DATE="$PUB_DATE" \
    PUBLIC_URL_BASE="$R2_PUBLIC_URL" \
    ARM64_TARBALL="Argus_${VERSION}_aarch64.app.tar.gz" \
    ARM64_SIG_PATH="$STAGING/Argus_${VERSION}_aarch64.app.tar.gz.sig" \
    X64_TARBALL="Argus_${VERSION}_x64.app.tar.gz" \
    X64_SIG_PATH="$STAGING/Argus_${VERSION}_x64.app.tar.gz.sig" \
      node scripts/build-manifest.mjs
  fi
else
  c_dim "Skipping manifest (need both targets; got: ${TARGETS[*]})"
fi

# ---------- upload to R2 ------------------------------------------------------

if [ "$NO_UPLOAD" = "1" ]; then
  c_dim "Skipping R2 upload (--no-upload)."
else
  step "Uploading to R2 (bucket: $R2_BUCKET)"
  ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  export AWS_DEFAULT_REGION="auto"
  export AWS_EC2_METADATA_DISABLED="true"

  # Binaries: long cache (1 year), immutable.
  for f in "$STAGING"/*; do
    key="$(basename "$f")"
    run "aws s3 cp '$f' 's3://${R2_BUCKET}/${key}' \
          --endpoint-url '$ENDPOINT' \
          --cache-control 'public, max-age=31536000, immutable'"
  done

  # Manifest: no-cache, JSON content type.
  if [ "$WANT_MANIFEST" = "1" ] && [ -f "$ROOT/latest.json" ]; then
    run "aws s3 cp '$ROOT/latest.json' 's3://${R2_BUCKET}/latest.json' \
          --endpoint-url '$ENDPOINT' \
          --cache-control 'no-cache, max-age=0' \
          --content-type 'application/json'"
  fi
fi

# ---------- summary -----------------------------------------------------------

c_green ""
c_green "Release v$VERSION complete."
echo
echo "  Staging dir : $STAGING"
echo "  Targets     : ${TARGETS[*]}"
if [ "$WANT_MANIFEST" = "1" ]; then
  echo "  Manifest    : $ROOT/latest.json"
fi
if [ "$NO_UPLOAD" = "0" ]; then
  echo "  Public URL  : $R2_PUBLIC_URL/latest.json"
  for f in "$STAGING"/*.dmg; do
    [ -f "$f" ] && echo "  DMG         : $R2_PUBLIC_URL/$(basename "$f")"
  done
fi
