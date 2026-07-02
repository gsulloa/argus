#!/usr/bin/env node
// Bumps the version across all version-bearing files in the repo.
// Reads the current version from src-tauri/tauri.conf.json (the source of truth),
// computes the next version for the given bump kind, and writes it back to:
//   - src-tauri/tauri.conf.json
//   - package.json
//   - src-tauri/Cargo.toml
//   - src-tauri/Cargo.lock  (the `argus` package entry — kept in sync so the
//     lockfile never drifts behind the manifest, which previously caused
//     intermittent "build error" failures and --locked breakage in CI)
//
// Usage: node bump-version.mjs [major|minor|patch]
//   kind defaults to "patch" when omitted (back-compat).
//
// Prints the new version on stdout so CI can capture it for tag creation.
// Exits 0 silently if no change is needed (file already at target).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pure function: compute the next version string for the given bump kind.
 * The suffix (e.g. "-beta") is parsed but always dropped in the result.
 *
 * @param {string} current  - current version string, e.g. "0.1.39" or "0.1.39-beta"
 * @param {"major"|"minor"|"patch"} kind
 * @returns {string}  bumped version, always clean X.Y.Z
 */
export function nextVersion(current, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(current);
  if (!m) throw new Error(`Cannot parse version: ${current}`);
  let [, major, minor, patch] = m;
  major = Number(major);
  minor = Number(minor);
  patch = Number(patch);

  switch (kind) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      throw new Error(`Invalid bump kind: ${kind}. Expected major|minor|patch`);
  }
}

/**
 * Pure function: set the version of a named package entry in a Cargo.lock file.
 * Cargo.lock blocks look like:
 *   [[package]]
 *   name = "argus"
 *   version = "0.1.38"
 *   dependencies = [ ... ]
 * We track which [[package]] block we're in and rewrite only the `version`
 * line of the target package. Throws if the package is not found, so a rename
 * or structural change fails loudly instead of silently leaving drift.
 *
 * @param {string} lockContent  - full Cargo.lock text
 * @param {string} pkgName      - package name to update, e.g. "argus"
 * @param {string} version      - new version string, e.g. "0.2.0"
 * @returns {string}  updated Cargo.lock text
 */
export function setLockfileVersion(lockContent, pkgName, version) {
  let isTarget = false;
  let replaced = false;
  const out = lockContent
    .split("\n")
    .map((line) => {
      if (line.trim() === "[[package]]") {
        isTarget = false;
        return line;
      }
      if (/^name\s*=/.test(line.trim())) {
        isTarget = line.trim() === `name = "${pkgName}"`;
        return line;
      }
      if (isTarget && /^version\s*=/.test(line.trim())) {
        replaced = true;
        isTarget = false;
        return `version = "${version}"`;
      }
      return line;
    })
    .join("\n");
  if (!replaced) {
    throw new Error(`Could not find [[package]] "${pkgName}" version in Cargo.lock`);
  }
  return out;
}

/**
 * Pure function: promote the `## [Unreleased]` section of a Keep a Changelog
 * file into a dated version section and insert a fresh empty `## [Unreleased]`
 * above it.
 *
 * Rules:
 *   - If there is no `## [Unreleased]` heading, returns the text unchanged.
 *   - If the `[Unreleased]` body (lines between the heading and the next
 *     `## [` heading, or end of file) contains no non-blank content, a single
 *     placeholder line `_No user-facing changes._` is inserted so the
 *     GitHub Release body is never blank.
 *   - A fresh empty `## [Unreleased]` section is prepended above the newly
 *     dated section, separated by a blank line.
 *
 * @param {string} changelogText  - full CHANGELOG.md text
 * @param {string} version        - new version string, e.g. "0.7.6"
 * @param {string} date           - ISO date string, e.g. "2026-07-02"
 * @returns {string}  updated changelog text
 */
export function promoteUnreleased(changelogText, version, date) {
  const lines = changelogText.split("\n");

  // Find the line index of `## [Unreleased]`
  const unreleasedIdx = lines.findIndex((l) => /^## \[Unreleased\]/i.test(l));
  if (unreleasedIdx === -1) {
    return changelogText;
  }

  // Find the start of the next `## [` heading (the next version section).
  let nextSectionIdx = lines.length;
  for (let i = unreleasedIdx + 1; i < lines.length; i++) {
    if (/^## \[/.test(lines[i])) {
      nextSectionIdx = i;
      break;
    }
  }

  // Extract the body between [Unreleased] heading and the next section.
  const bodyLines = lines.slice(unreleasedIdx + 1, nextSectionIdx);
  const hasContent = bodyLines.some((l) => l.trim() !== "");

  // Build the promoted section lines.
  const promotedHeading = `## [${version}] - ${date}`;
  const promotedBody = hasContent ? bodyLines : ["", "_No user-facing changes._"];

  // Construct the replacement: fresh [Unreleased] + blank line + promoted section.
  const replacement = [
    "## [Unreleased]",
    "",
    promotedHeading,
    ...promotedBody,
  ];

  // Splice: replace from unreleasedIdx through nextSectionIdx (exclusive).
  const before = lines.slice(0, unreleasedIdx);
  const after = lines.slice(nextSectionIdx);

  // Ensure a blank line separates the replacement from the following section,
  // but only if `after` starts with a non-empty line (avoid double blanks).
  const joinedAfter =
    after.length > 0 && after[0] !== "" ? ["", ...after] : after;

  return [...before, ...replacement, ...joinedAfter].join("\n");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");

  const tauriConfPath = join(root, "src-tauri", "tauri.conf.json");
  const packageJsonPath = join(root, "package.json");
  const cargoTomlPath = join(root, "src-tauri", "Cargo.toml");
  const cargoLockPath = join(root, "src-tauri", "Cargo.lock");

  const kind = process.argv[2] ?? "patch";

  const tauriConf = readJson(tauriConfPath);
  const current = tauriConf.version;
  if (typeof current !== "string") {
    throw new Error(`tauri.conf.json has no string version field`);
  }
  const next = nextVersion(current, kind);

  // tauri.conf.json
  tauriConf.version = next;
  writeJson(tauriConfPath, tauriConf);

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

  // Cargo.lock — keep the `argus` package entry in sync with Cargo.toml so the
  // lockfile never lags the manifest (the historical "build error" cause).
  const lock = readFileSync(cargoLockPath, "utf8");
  writeFileSync(cargoLockPath, setLockfileVersion(lock, "argus", next));

  // Root CHANGELOG.md — promote [Unreleased] → [X.Y.Z] - <UTC date>.
  // repo root = packages/app/../../  (two levels up from `root` which is packages/app)
  const repoRoot = join(root, "..", "..");
  const changelogPath = join(repoRoot, "CHANGELOG.md");
  if (existsSync(changelogPath)) {
    const changelogText = readFileSync(changelogPath, "utf8");
    const today = new Date().toISOString().slice(0, 10);
    const updated = promoteUnreleased(changelogText, next, today);
    writeFileSync(changelogPath, updated, "utf8");
  }

  process.stdout.write(next);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
