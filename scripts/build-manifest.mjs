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
//                                 are allowed and the output goes to
//                                 latest.partial.json when not all four
//                                 platforms are emitted.
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
// Output: writes latest.json (or latest.partial.json in local mode when
// partial) to the working directory.
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
const isPartial = emittedCount < PLATFORMS.length;

if (isPartial) {
  const missing = PLATFORMS.filter(([k]) => !platforms[k]).map(([k]) => k);
  if (mode === "ci") {
    console.error(
      `[build-manifest] CI mode requires all 4 platforms; missing: ${missing.join(", ")}`
    );
    process.exit(1);
  }
  console.warn(
    `[build-manifest] WARNING: partial manifest — missing platforms: ${missing.join(", ")}`
  );
}

const manifest = {
  version,
  notes,
  pub_date: pubDate,
  platforms,
};

const outName = isPartial && mode === "local" ? "latest.partial.json" : "latest.json";
writeFileSync(outName, JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `Wrote ${outName} for v${version} (${emittedCount}/${PLATFORMS.length} platforms)`
);
