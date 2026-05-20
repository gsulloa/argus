#!/usr/bin/env node
// Smoke test for scripts/build-manifest.mjs.
//
// Runs three cases in a temp directory:
//   1. Four-platform CI case → expect exit 0 and a structurally valid
//      latest.json with all four platforms.
//   2. Linux-only local case → expect exit 0 and a latest.json (NOT
//      .partial.json) with only the linux-x86_64 entry.
//   3. Mac-only local case WITH MANIFEST_BASE_FILE → expect exit 0 and a
//      latest.json containing the new mac entries plus the windows/linux
//      entries carried over from the base file.
//
// Usage: node scripts/__tests__/build-manifest.smoke.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(new URL("../build-manifest.mjs", import.meta.url).pathname);

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

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "build-manifest-smoke-"));
  for (const name of ["arm.sig", "x64.sig", "linux.sig", "win.sig"]) {
    writeFileSync(join(dir, name), `sig-${name}\n`);
  }
  return dir;
}

// Case 1: four-platform CI
{
  const dir = setup();
  const r = run(
    {
      VERSION: "9.9.9",
      PUB_DATE: "2026-01-01T00:00:00Z",
      PUBLIC_URL_BASE: "https://example.test",
      MANIFEST_MODE: "ci",
      DARWIN_AARCH64_TARBALL: "Argus_9.9.9_aarch64.app.tar.gz",
      DARWIN_AARCH64_SIG_PATH: join(dir, "arm.sig"),
      DARWIN_X86_64_TARBALL: "Argus_9.9.9_x64.app.tar.gz",
      DARWIN_X86_64_SIG_PATH: join(dir, "x64.sig"),
      LINUX_X86_64_TARBALL: "Argus_9.9.9_x64.AppImage.tar.gz",
      LINUX_X86_64_SIG_PATH: join(dir, "linux.sig"),
      WINDOWS_X86_64_TARBALL: "Argus_9.9.9_x64.msi.zip",
      WINDOWS_X86_64_SIG_PATH: join(dir, "win.sig"),
    },
    dir
  );
  if (r.status !== 0) fail(`four-platform CI: expected exit 0, got ${r.status}\n${r.stderr}`);
  const out = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
  const keys = Object.keys(out.platforms).sort();
  const want = ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(want)) {
    fail(`four-platform CI: platforms mismatch. got ${keys}`);
  }
  if (out.version !== "9.9.9") fail(`four-platform CI: version mismatch`);
  rmSync(dir, { recursive: true, force: true });
  console.log("PASS: four-platform CI case");
}

// Case 2: Linux-only local (no base file). Output goes to latest.json.
{
  const dir = setup();
  const r = run(
    {
      VERSION: "9.9.9",
      PUB_DATE: "2026-01-01T00:00:00Z",
      PUBLIC_URL_BASE: "https://example.test",
      MANIFEST_MODE: "local",
      LINUX_X86_64_TARBALL: "Argus_9.9.9_x64.AppImage.tar.gz",
      LINUX_X86_64_SIG_PATH: join(dir, "linux.sig"),
    },
    dir
  );
  if (r.status !== 0) fail(`linux-only local: expected exit 0, got ${r.status}\n${r.stderr}`);
  const out = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
  if (Object.keys(out.platforms).length !== 1) fail(`linux-only local: expected 1 platform`);
  if (!out.platforms["linux-x86_64"]) fail(`linux-only local: missing linux-x86_64`);
  rmSync(dir, { recursive: true, force: true });
  console.log("PASS: linux-only local case (writes latest.json)");
}

// Case 3: Mac-only local WITH base file → merged manifest carries windows/linux.
{
  const dir = setup();
  const basePath = join(dir, "base-latest.json");
  writeFileSync(
    basePath,
    JSON.stringify({
      version: "9.9.8",
      notes: "previous",
      pub_date: "2025-12-01T00:00:00Z",
      platforms: {
        "darwin-aarch64": { signature: "OLD-arm", url: "https://example.test/old-arm.tar.gz" },
        "darwin-x86_64":  { signature: "OLD-x64", url: "https://example.test/old-x64.tar.gz" },
        "linux-x86_64":   { signature: "OLD-linux", url: "https://example.test/old-linux.tar.gz" },
        "windows-x86_64": { signature: "OLD-win", url: "https://example.test/old-win.zip" },
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
      DARWIN_AARCH64_TARBALL: "Argus_9.9.9_aarch64.app.tar.gz",
      DARWIN_AARCH64_SIG_PATH: join(dir, "arm.sig"),
      DARWIN_X86_64_TARBALL: "Argus_9.9.9_x64.app.tar.gz",
      DARWIN_X86_64_SIG_PATH: join(dir, "x64.sig"),
    },
    dir
  );
  if (r.status !== 0) fail(`mac+base local: expected exit 0, got ${r.status}\n${r.stderr}`);
  const out = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
  if (out.version !== "9.9.9") fail(`mac+base local: top-level version must be the new one`);
  const keys = Object.keys(out.platforms).sort();
  const want = ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(want)) {
    fail(`mac+base local: expected all 4 platforms after merge, got ${keys}`);
  }
  if (out.platforms["darwin-aarch64"].signature === "OLD-arm") {
    fail(`mac+base local: darwin-aarch64 should be overwritten with the new build`);
  }
  if (out.platforms["windows-x86_64"].signature !== "OLD-win") {
    fail(`mac+base local: windows-x86_64 should be carried over from base`);
  }
  if (out.platforms["linux-x86_64"].signature !== "OLD-linux") {
    fail(`mac+base local: linux-x86_64 should be carried over from base`);
  }
  rmSync(dir, { recursive: true, force: true });
  console.log("PASS: mac-only local + base file merge");
}

console.log("All smoke tests passed.");
