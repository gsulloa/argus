#!/usr/bin/env node
// Builds the Tauri v2 updater manifest (latest.json) from the artifacts
// produced by the matrix build.
//
// Inputs (env vars):
//   VERSION                       e.g. 0.1.7
//   PUB_DATE                      ISO 8601 timestamp
//   PUBLIC_URL_BASE               e.g. https://pub-9f3a1b7e.r2.dev
//   NOTES                         (optional) release notes string
//   MANIFEST_MODE                 ci | local (default ci). In ci, all four
//                                 platforms are required and the script exits
//                                 non-zero otherwise. In local, partial sets
//                                 are allowed and the script merges this
//                                 build's platforms on top of MANIFEST_BASE_FILE
//                                 (if provided) so the output is always a full
//                                 latest.json — never a .partial.json.
//   MANIFEST_BASE_FILE            (local mode only) path to an existing
//                                 latest.json to use as the base. Platforms
//                                 produced by this build overwrite the
//                                 corresponding entries; platforms not built
//                                 this run are carried over from the base file.
//
// Per-platform env-var pairs (each pair is optional; both must be set together):
//   DARWIN_AARCH64_TARBALL  + DARWIN_AARCH64_SIG_PATH
//   DARWIN_X86_64_TARBALL   + DARWIN_X86_64_SIG_PATH
//   LINUX_X86_64_TARBALL    + LINUX_X86_64_SIG_PATH
//   WINDOWS_X86_64_TARBALL  + WINDOWS_X86_64_SIG_PATH
//
// Deprecated aliases (still accepted to ease mid-rollout):
//   ARM64_TARBALL / ARM64_SIG_PATH  → DARWIN_AARCH64_*
//   X64_TARBALL   / X64_SIG_PATH    → DARWIN_X86_64_*
//
// Output: always writes latest.json to the working directory. In local mode
// with MANIFEST_BASE_FILE the output is a full manifest (this build's
// platforms spread over the base file's platforms).
//
// Smoke tests:
//   - Four-platform CI case: see scripts/__tests__/build-manifest.smoke.mjs
//   - Linux-only local case: see scripts/__tests__/build-manifest.smoke.mjs

import { readFileSync, writeFileSync } from "node:fs";

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const version = required("VERSION");
const pubDate = required("PUB_DATE");
const baseUrl = required("PUBLIC_URL_BASE").replace(/\/+$/, "");
const notes = process.env.NOTES ?? `Argus v${version}`;
const mode = (process.env.MANIFEST_MODE ?? "ci").toLowerCase();
if (mode !== "ci" && mode !== "local") {
  console.error(`Invalid MANIFEST_MODE: ${mode} (expected "ci" or "local")`);
  process.exit(1);
}

// Deprecated aliases → canonical names. The new names take precedence if both
// are set, but we warn so callers notice they should migrate.
function aliasFallback(canonicalName, legacyName) {
  if (process.env[canonicalName]) return;
  if (process.env[legacyName]) {
    console.warn(
      `[build-manifest] ${legacyName} is deprecated; use ${canonicalName} instead.`
    );
    process.env[canonicalName] = process.env[legacyName];
  }
}
aliasFallback("DARWIN_AARCH64_TARBALL", "ARM64_TARBALL");
aliasFallback("DARWIN_AARCH64_SIG_PATH", "ARM64_SIG_PATH");
aliasFallback("DARWIN_X86_64_TARBALL", "X64_TARBALL");
aliasFallback("DARWIN_X86_64_SIG_PATH", "X64_SIG_PATH");

const PLATFORMS = [
  ["darwin-aarch64", "DARWIN_AARCH64_TARBALL", "DARWIN_AARCH64_SIG_PATH"],
  ["darwin-x86_64", "DARWIN_X86_64_TARBALL", "DARWIN_X86_64_SIG_PATH"],
  ["linux-x86_64", "LINUX_X86_64_TARBALL", "LINUX_X86_64_SIG_PATH"],
  ["windows-x86_64", "WINDOWS_X86_64_TARBALL", "WINDOWS_X86_64_SIG_PATH"],
];

const platforms = {};
for (const [platformKey, tarballEnv, sigEnv] of PLATFORMS) {
  const tarball = process.env[tarballEnv];
  const sigPath = process.env[sigEnv];
  if (!tarball && !sigPath) continue;
  if (!tarball || !sigPath) {
    console.error(
      `Incoherent input for ${platformKey}: set both ${tarballEnv} and ${sigEnv}, or neither.`
    );
    process.exit(1);
  }
  const signature = readFileSync(sigPath, "utf8").trim();
  platforms[platformKey] = {
    signature,
    url: `${baseUrl}/${tarball}`,
  };
}

const emittedCount = Object.keys(platforms).length;
const builtKeys = Object.keys(platforms);

// In local mode, merge this build's platforms on top of a base manifest so we
// can always emit a full latest.json — never a .partial.json.
let basePlatforms = {};
const baseFile = process.env.MANIFEST_BASE_FILE;
if (baseFile) {
  if (mode !== "local") {
    console.error(
      `[build-manifest] MANIFEST_BASE_FILE is only supported in MANIFEST_MODE=local (got ${mode}).`
    );
    process.exit(1);
  }
  try {
    const baseDoc = JSON.parse(readFileSync(baseFile, "utf8"));
    basePlatforms = baseDoc.platforms ?? {};
    if (baseDoc.version && baseDoc.version !== version) {
      console.warn(
        `[build-manifest] base manifest version (${baseDoc.version}) differs from this build (${version}). Carried-over platforms still point at v${baseDoc.version} artifacts.`
      );
    }
  } catch (err) {
    console.error(
      `[build-manifest] Cannot read MANIFEST_BASE_FILE (${baseFile}): ${err.code ?? err.message}`
    );
    process.exit(1);
  }
}

const mergedPlatforms = { ...basePlatforms, ...platforms };
const isPartial = Object.keys(mergedPlatforms).length < PLATFORMS.length;

if (mode === "ci") {
  if (isPartial) {
    const missing = PLATFORMS.filter(([k]) => !mergedPlatforms[k]).map(([k]) => k);
    console.error(
      `[build-manifest] CI mode requires all 4 platforms; missing: ${missing.join(", ")}`
    );
    process.exit(1);
  }
} else if (isPartial) {
  const missing = PLATFORMS.filter(([k]) => !mergedPlatforms[k]).map(([k]) => k);
  console.warn(
    `[build-manifest] WARNING: emitting latest.json with missing platforms: ${missing.join(", ")} (no base file provided or base file lacked these). Provide MANIFEST_BASE_FILE to keep prior entries.`
  );
}

const manifest = {
  version,
  notes,
  pub_date: pubDate,
  platforms: mergedPlatforms,
};

writeFileSync("latest.json", JSON.stringify(manifest, null, 2) + "\n");
const carried = Object.keys(mergedPlatforms).filter((k) => !builtKeys.includes(k));
console.log(
  `Wrote latest.json for v${version} (${emittedCount} built: ${builtKeys.join(", ") || "none"}; ${carried.length} carried: ${carried.join(", ") || "none"})`
);
