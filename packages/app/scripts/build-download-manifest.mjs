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
//                                 sets are allowed and the script merges this
//                                 build's installers on top of
//                                 MANIFEST_BASE_FILE (if provided) so the
//                                 output is always a full download.json —
//                                 never a .partial.json.
//   MANIFEST_BASE_FILE            (local mode only) path to an existing
//                                 download.json to use as the base. Installers
//                                 produced by this build overwrite the
//                                 corresponding entries; installers not built
//                                 this run are carried over from the base file.
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
// Output: always writes download.json to the working directory. In local mode
// with MANIFEST_BASE_FILE the output is a full manifest (this build's
// installers spread over the base file's installers).
//
// Smoke tests:
//   - Four-platform CI case: see scripts/__tests__/build-download-manifest.smoke.mjs
//   - Linux-only local case: see scripts/__tests__/build-download-manifest.smoke.mjs

import { readFileSync, statSync, writeFileSync } from "node:fs";
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
const builtKeys = Object.keys(installers);

// In local mode, merge this build's installers on top of a base manifest so we
// can always emit a full download.json — never a .partial.json.
let baseInstallers = {};
const baseFile = process.env.MANIFEST_BASE_FILE;
if (baseFile) {
  if (mode !== "local") {
    console.error(
      `[build-download-manifest] MANIFEST_BASE_FILE is only supported in MANIFEST_MODE=local (got ${mode}).`
    );
    process.exit(1);
  }
  try {
    const baseDoc = JSON.parse(readFileSync(baseFile, "utf8"));
    baseInstallers = baseDoc.installers ?? {};
    if (baseDoc.version && baseDoc.version !== version) {
      console.warn(
        `[build-download-manifest] base manifest version (${baseDoc.version}) differs from this build (${version}). Carried-over installers still point at v${baseDoc.version} files.`
      );
    }
  } catch (err) {
    console.error(
      `[build-download-manifest] Cannot read MANIFEST_BASE_FILE (${baseFile}): ${err.code ?? err.message}`
    );
    process.exit(1);
  }
}

const mergedInstallers = { ...baseInstallers, ...installers };
const isPartial = Object.keys(mergedInstallers).length < PLATFORMS.length;

if (mode === "ci") {
  if (isPartial) {
    const missing = PLATFORMS.filter(([k]) => !mergedInstallers[k]).map(([k]) => k);
    console.error(
      `[build-download-manifest] CI mode requires all 4 installers; missing: ${missing.join(", ")}`
    );
    process.exit(1);
  }
} else if (isPartial) {
  const missing = PLATFORMS.filter(([k]) => !mergedInstallers[k]).map(([k]) => k);
  console.warn(
    `[build-download-manifest] WARNING: emitting download.json with missing installers: ${missing.join(", ")} (no base file provided or base file lacked these). Provide MANIFEST_BASE_FILE to keep prior entries.`
  );
}

const doc = {
  version,
  pub_date: pubDate,
  installers: mergedInstallers,
};

writeFileSync("download.json", JSON.stringify(doc, null, 2) + "\n");
const carried = Object.keys(mergedInstallers).filter((k) => !builtKeys.includes(k));
console.log(
  `Wrote download.json for v${version} (${emittedCount} built: ${builtKeys.join(", ") || "none"}; ${carried.length} carried: ${carried.join(", ") || "none"})`
);
