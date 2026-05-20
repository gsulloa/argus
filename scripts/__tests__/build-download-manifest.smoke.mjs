#!/usr/bin/env node
// Smoke test for scripts/build-download-manifest.mjs.
//
// Runs four cases in a temp directory:
//   1. Four-platform CI case → expect exit 0 and a download.json with all
//      four installers and a non-zero size each.
//   2. Linux-only local case (no base) → expect exit 0 and a download.json
//      (NOT .partial.json) with only the linux-x86_64 entry.
//   3. Rejects updater-archive filename.
//   4. Mac-only local WITH MANIFEST_BASE_FILE → expect exit 0 and a
//      download.json containing the new mac installers plus the
//      windows/linux installers carried over from the base file.
//
// Usage: node scripts/__tests__/build-download-manifest.smoke.mjs

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(
  new URL("../build-download-manifest.mjs", import.meta.url).pathname
);

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function run(env, cwd) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function setup(installers) {
  const dir = mkdtempSync(join(tmpdir(), "build-download-smoke-"));
  const staging = join(dir, "staging");
  mkdirSync(staging);
  for (const name of installers) {
    // Body length differs per file so sizes are non-trivial.
    writeFileSync(join(staging, name), `installer body for ${name}\n`);
  }
  return dir;
}

// Case 1: four-platform CI
{
  const installers = [
    "Argus_9.9.9_aarch64.dmg",
    "Argus_9.9.9_x64.dmg",
    "Argus_9.9.9_x64.AppImage",
    "Argus_9.9.9_x64.msi",
  ];
  const dir = setup(installers);
  const r = run(
    {
      VERSION: "9.9.9",
      PUB_DATE: "2026-01-01T00:00:00Z",
      PUBLIC_URL_BASE: "https://example.test",
      MANIFEST_MODE: "ci",
      DARWIN_AARCH64_INSTALLER: installers[0],
      DARWIN_X86_64_INSTALLER: installers[1],
      LINUX_X86_64_INSTALLER: installers[2],
      WINDOWS_X86_64_INSTALLER: installers[3],
    },
    dir
  );
  if (r.status !== 0)
    fail(`four-platform CI: expected exit 0, got ${r.status}\n${r.stderr}`);
  const out = JSON.parse(readFileSync(join(dir, "download.json"), "utf8"));
  const keys = Object.keys(out.installers).sort();
  const want = [
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-x86_64",
    "windows-x86_64",
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(want))
    fail(`four-platform CI: installer keys mismatch. got ${keys}`);
  for (const k of keys) {
    if (!out.installers[k].size || out.installers[k].size <= 0)
      fail(`four-platform CI: ${k} size is zero or missing`);
    if (!out.installers[k].url.startsWith("https://example.test/"))
      fail(`four-platform CI: ${k} url mismatch`);
  }
  rmSync(dir, { recursive: true, force: true });
  console.log("PASS: four-platform CI case");
}

// Case 2: Linux-only local (no base). Output goes to download.json.
{
  const installers = ["Argus_9.9.9_x64.AppImage"];
  const dir = setup(installers);
  const r = run(
    {
      VERSION: "9.9.9",
      PUB_DATE: "2026-01-01T00:00:00Z",
      PUBLIC_URL_BASE: "https://example.test",
      MANIFEST_MODE: "local",
      LINUX_X86_64_INSTALLER: installers[0],
    },
    dir
  );
  if (r.status !== 0)
    fail(`linux-only local: expected exit 0, got ${r.status}\n${r.stderr}`);
  const out = JSON.parse(readFileSync(join(dir, "download.json"), "utf8"));
  if (Object.keys(out.installers).length !== 1)
    fail(`linux-only local: expected 1 installer`);
  if (!out.installers["linux-x86_64"])
    fail(`linux-only local: missing linux-x86_64`);
  rmSync(dir, { recursive: true, force: true });
  console.log("PASS: linux-only local case (writes download.json)");
}

// Case 3: rejects updater archive filename
{
  const installers = ["Argus_9.9.9_x64.msi.zip"];
  const dir = setup(installers);
  const r = run(
    {
      VERSION: "9.9.9",
      PUB_DATE: "2026-01-01T00:00:00Z",
      PUBLIC_URL_BASE: "https://example.test",
      MANIFEST_MODE: "local",
      WINDOWS_X86_64_INSTALLER: installers[0],
    },
    dir
  );
  if (r.status === 0)
    fail(`rejects-updater-archive: expected non-zero exit, got 0`);
  if (!r.stderr.includes("updater archive"))
    fail(`rejects-updater-archive: expected error mentioning updater archive`);
  rmSync(dir, { recursive: true, force: true });
  console.log("PASS: rejects updater archive filename");
}

// Case 4: Mac-only local WITH base file → merged download.json carries linux/windows.
{
  const installers = ["Argus_9.9.9_aarch64.dmg", "Argus_9.9.9_x64.dmg"];
  const dir = setup(installers);
  const basePath = join(dir, "base-download.json");
  writeFileSync(
    basePath,
    JSON.stringify({
      version: "9.9.8",
      pub_date: "2025-12-01T00:00:00Z",
      installers: {
        "darwin-aarch64": { url: "https://example.test/old-arm.dmg", filename: "old-arm.dmg", size: 111 },
        "darwin-x86_64":  { url: "https://example.test/old-x64.dmg", filename: "old-x64.dmg", size: 222 },
        "linux-x86_64":   { url: "https://example.test/old.AppImage", filename: "old.AppImage", size: 333 },
        "windows-x86_64": { url: "https://example.test/old.msi", filename: "old.msi", size: 444 },
      },
    })
  );
  const r = run(
    {
      VERSION: "9.9.9",
      PUB_DATE: "2026-01-01T00:00:00Z",
      PUBLIC_URL_BASE: "https://example.test",
      MANIFEST_MODE: "local",
      MANIFEST_BASE_FILE: basePath,
      DARWIN_AARCH64_INSTALLER: installers[0],
      DARWIN_X86_64_INSTALLER: installers[1],
    },
    dir
  );
  if (r.status !== 0)
    fail(`mac+base local: expected exit 0, got ${r.status}\n${r.stderr}`);
  const out = JSON.parse(readFileSync(join(dir, "download.json"), "utf8"));
  if (out.version !== "9.9.9") fail(`mac+base local: top-level version must be the new one`);
  const keys = Object.keys(out.installers).sort();
  const want = ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(want))
    fail(`mac+base local: expected all 4 installers after merge, got ${keys}`);
  if (out.installers["darwin-aarch64"].size === 111)
    fail(`mac+base local: darwin-aarch64 should be overwritten with the new build`);
  if (out.installers["windows-x86_64"].size !== 444)
    fail(`mac+base local: windows-x86_64 should be carried over from base`);
  if (out.installers["linux-x86_64"].size !== 333)
    fail(`mac+base local: linux-x86_64 should be carried over from base`);
  rmSync(dir, { recursive: true, force: true });
  console.log("PASS: mac-only local + base file merge");
}

console.log("All smoke tests passed.");
