#!/usr/bin/env node
// Builds the public download index (download.json) from staged installer
// filenames. Unlike latest.json (the Tauri updater manifest), this file points
// at end-user installers (.dmg / .AppImage / .msi) and exposes filename + size
// so landing pages can render "Download Argus (45 MB)" buttons.
//
// Inputs (env vars):
//   VERSION                       e.g. 0.1.7
//   PUB_DATE                      ISO 8601 timestamp
//   PUBLIC_URL_BASE               e.g. https://pub-9f3a1b7e.r2.dev
//   MANIFEST_MODE                 ci | local (default ci). In ci, all four
//                                 installers are required. In local, partial
//                                 sets are allowed and the output goes to
//                                 download.partial.json when not all four
//                                 installers are emitted.
//
// Per-platform installer-filename env vars (each optional in local mode;
// all four required in ci mode):
//   DARWIN_AARCH64_INSTALLER   e.g. Argus_0.1.7_aarch64.dmg
//   DARWIN_X86_64_INSTALLER    e.g. Argus_0.1.7_x64.dmg
//   LINUX_X86_64_INSTALLER     e.g. Argus_0.1.7_x64.AppImage
//   WINDOWS_X86_64_INSTALLER   e.g. Argus_0.1.7_x64.msi
//
// Filenames are resolved inside ./staging/ to read each installer's size in
// bytes. Updater archives (.app.tar.gz, .AppImage.tar.gz, .msi.zip) and .sig
// files are rejected — this manifest must only point at end-user installers.
//
// Output: writes download.json (or download.partial.json in local mode when
// partial) to the working directory.
//
// Smoke tests:
//   - Four-platform CI case: see scripts/__tests__/build-download-manifest.smoke.mjs
//   - Linux-only local case: see scripts/__tests__/build-download-manifest.smoke.mjs

import { statSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

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
const mode = (process.env.MANIFEST_MODE ?? "ci").toLowerCase();
if (mode !== "ci" && mode !== "local") {
  console.error(`Invalid MANIFEST_MODE: ${mode} (expected "ci" or "local")`);
  process.exit(1);
}

const PLATFORMS = [
  ["darwin-aarch64", "DARWIN_AARCH64_INSTALLER"],
  ["darwin-x86_64", "DARWIN_X86_64_INSTALLER"],
  ["linux-x86_64", "LINUX_X86_64_INSTALLER"],
  ["windows-x86_64", "WINDOWS_X86_64_INSTALLER"],
];

const FORBIDDEN_SUFFIXES = [".app.tar.gz", ".AppImage.tar.gz", ".msi.zip", ".sig"];

function rejectIfUpdaterArchive(platformKey, filename) {
  for (const suffix of FORBIDDEN_SUFFIXES) {
    if (filename.endsWith(suffix)) {
      console.error(
        `[build-download-manifest] ${platformKey}: "${filename}" looks like an updater archive or signature (suffix "${suffix}"). download.json must point at end-user installers (.dmg/.AppImage/.msi).`
      );
      process.exit(1);
    }
  }
}

const STAGING_DIR = process.env.STAGING_DIR ?? "staging";

const installers = {};
for (const [platformKey, envName] of PLATFORMS) {
  const filename = process.env[envName];
  if (!filename) continue;
  rejectIfUpdaterArchive(platformKey, filename);
  const filePath = join(STAGING_DIR, filename);
  let size;
  try {
    const stat = statSync(filePath);
    size = stat.size;
  } catch (err) {
    console.error(
      `[build-download-manifest] Cannot stat installer for ${platformKey}: ${filePath} (${err.code ?? err.message})`
    );
    process.exit(1);
  }
  installers[platformKey] = {
    url: `${baseUrl}/${filename}`,
    filename,
    size,
  };
}

const emittedCount = Object.keys(installers).length;
const isPartial = emittedCount < PLATFORMS.length;

if (isPartial) {
  const missing = PLATFORMS.filter(([k]) => !installers[k]).map(([k]) => k);
  if (mode === "ci") {
    console.error(
      `[build-download-manifest] CI mode requires all 4 installers; missing: ${missing.join(", ")}`
    );
    process.exit(1);
  }
  console.warn(
    `[build-download-manifest] WARNING: partial download manifest — missing: ${missing.join(", ")}`
  );
}

const doc = {
  version,
  pub_date: pubDate,
  installers,
};

const outName = isPartial && mode === "local" ? "download.partial.json" : "download.json";
writeFileSync(outName, JSON.stringify(doc, null, 2) + "\n");
console.log(
  `Wrote ${outName} for v${version} (${emittedCount}/${PLATFORMS.length} installers)`
);
