#!/usr/bin/env node
// Builds the Tauri v2 updater manifest (latest.json) from the artifacts
// produced by the matrix build.
//
// Inputs (env vars):
//   VERSION            e.g. 0.1.7
//   PUB_DATE           ISO 8601 timestamp
//   PUBLIC_URL_BASE    e.g. https://pub-9f3a1b7e.r2.dev
//   ARM64_TARBALL      filename of the aarch64 .app.tar.gz
//   ARM64_SIG_PATH     local path to the corresponding .sig file
//   X64_TARBALL        filename of the x86_64 .app.tar.gz
//   X64_SIG_PATH       local path to the corresponding .sig file
//   NOTES              (optional) release notes string
//
// Output: writes latest.json to ./latest.json in the working directory.

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
const arm64Tarball = required("ARM64_TARBALL");
const arm64SigPath = required("ARM64_SIG_PATH");
const x64Tarball = required("X64_TARBALL");
const x64SigPath = required("X64_SIG_PATH");
const notes = process.env.NOTES ?? `Argus v${version}`;

const arm64Sig = readFileSync(arm64SigPath, "utf8").trim();
const x64Sig = readFileSync(x64SigPath, "utf8").trim();

const manifest = {
  version,
  notes,
  pub_date: pubDate,
  platforms: {
    "darwin-aarch64": {
      signature: arm64Sig,
      url: `${baseUrl}/${arm64Tarball}`,
    },
    "darwin-x86_64": {
      signature: x64Sig,
      url: `${baseUrl}/${x64Tarball}`,
    },
  },
};

writeFileSync("latest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote latest.json for v${version}`);
