#!/usr/bin/env node
// Bumps the patch version across all version-bearing files in the repo.
// Reads the current version from src-tauri/tauri.conf.json (the source of truth),
// computes next patch, and writes it back to:
//   - src-tauri/tauri.conf.json
//   - src-tauri/tauri.beta.conf.json (if present)
//   - package.json
//   - src-tauri/Cargo.toml
//
// Prints the new version on stdout so CI can capture it for tag creation.
// Exits 0 silently if no change is needed (file already at target).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const tauriConfPath = join(root, "src-tauri", "tauri.conf.json");
const tauriBetaConfPath = join(root, "src-tauri", "tauri.beta.conf.json");
const packageJsonPath = join(root, "package.json");
const cargoTomlPath = join(root, "src-tauri", "Cargo.toml");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

function bumpPatch(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version);
  if (!m) throw new Error(`Cannot parse version: ${version}`);
  const [, major, minor, patch] = m;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

const tauriConf = readJson(tauriConfPath);
const current = tauriConf.version;
if (typeof current !== "string") {
  throw new Error(`tauri.conf.json has no string version field`);
}
const next = bumpPatch(current);

// tauri.conf.json
tauriConf.version = next;
writeJson(tauriConfPath, tauriConf);

// tauri.beta.conf.json — only if it has a top-level version field; otherwise
// it inherits from tauri.conf.json at build time.
if (existsSync(tauriBetaConfPath)) {
  const beta = readJson(tauriBetaConfPath);
  if ("version" in beta) {
    beta.version = next;
    writeJson(tauriBetaConfPath, beta);
  }
}

// package.json
const pkg = readJson(packageJsonPath);
pkg.version = next;
writeJson(packageJsonPath, pkg);

// Cargo.toml — naive line edit for the [package] version field.
const cargo = readFileSync(cargoTomlPath, "utf8");
let inPackage = false;
const updatedCargo = cargo
  .split("\n")
  .map((line) => {
    if (/^\[\w/.test(line.trim())) inPackage = line.trim() === "[package]";
    if (inPackage && /^version\s*=/.test(line)) return `version = "${next}"`;
    return line;
  })
  .join("\n");
writeFileSync(cargoTomlPath, updatedCargo);

process.stdout.write(next);
