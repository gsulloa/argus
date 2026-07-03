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
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Config constants (exported so tests can import and override)
// ---------------------------------------------------------------------------

/** Map of conventional-commit type → changelog group. Only these types produce entries. */
export const ALLOWED_TYPES = {
  feat: "Added",
  fix: "Fixed",
  perf: "Changed",
};

/** Commit scopes whose entries are never user-facing (excluded from changelog). */
export const DENIED_SCOPES = ["landing"];

/** GitHub repo URL used for rendering PR links in bullets. */
export const REPO_URL = "https://github.com/gsulloa/argus";

/** Patterns for subjects that must be skipped entirely (merge/back-merge/release commits). */
export const SKIP_PATTERNS = [/^Merge /, /^chore:\s*(back-merge|release)\b/];

// ---------------------------------------------------------------------------
// Pure helpers (no git / no fs — unit-testable)
// ---------------------------------------------------------------------------

/**
 * Parse a conventional-commit subject line.
 *
 * Recognised form: `type(scope)!: description (#N) (#M) …`
 * - `scope` is optional.
 * - `!` marks a breaking change.
 * - One or more trailing `(#NNNN)` groups are extracted into `prNumbers`.
 *
 * @param {string} subject
 * @returns {{ type: string, scope: string|null, description: string, breaking: boolean, prNumbers: number[] } | null}
 *   Returns null when the subject does not match the conventional-commit format.
 */
export function parseCommitSubject(subject) {
  const m = /^(feat|fix|perf|chore|ci|docs|test|refactor|build|style|revert)(\(([^)]+)\))?(!)?:\s*(.+)$/.exec(
    subject,
  );
  if (!m) return null;

  const type = m[1];
  const scope = m[3] ?? null;
  const breaking = m[4] === "!";
  const rawDescription = m[5];

  // Extract all trailing (#NNNN) groups from the description.
  const prNumbers = [];
  const prRegex = /\(#(\d+)\)/g;
  let prMatch;
  while ((prMatch = prRegex.exec(rawDescription)) !== null) {
    prNumbers.push(Number(prMatch[1]));
  }

  // Strip ALL consecutive trailing (#NNNN) groups from the rendered description
  // so links aren't doubled — subjects can carry more than one (e.g. a dev PR
  // number plus a release-merge PR number: `… (#233) (#237)`).
  const description = rawDescription.replace(/(?:\s*\(#\d+\))+\s*$/, "").trimEnd();

  return { type, scope, description, breaking, prNumbers };
}

/**
 * Extract all PR numbers that already appear in the given `## [Unreleased]` body text.
 * Recognises both `[#229](…)` Markdown-link form and bare `(#229)` form.
 *
 * @param {string} unreleasedBody
 * @returns {Set<number>}
 */
export function existingPrNumbers(unreleasedBody) {
  const set = new Set();
  const re = /#(\d+)/g;
  let m;
  while ((m = re.exec(unreleasedBody)) !== null) {
    set.add(Number(m[1]));
  }
  return set;
}

/**
 * @typedef {{ prNumber: number|null, bullet: string }} Entry
 */

/**
 * Derive changelog entries from an array of commit subject lines.
 *
 * @param {string[]} subjects
 * @param {{ allowedTypes: Record<string,string>, deniedScopes: string[], skipPatterns: RegExp[], repoUrl: string }} config
 * @returns {{ Added: Entry[], Changed: Entry[], Fixed: Entry[] }}
 */
export function deriveEntries(
  subjects,
  { allowedTypes, deniedScopes, skipPatterns, repoUrl },
) {
  /** @type {{ Added: Entry[], Changed: Entry[], Fixed: Entry[] }} */
  const groups = { Added: [], Changed: [], Fixed: [] };

  for (const subject of subjects) {
    // 1. Skip merge/back-merge/release subjects.
    if (skipPatterns.some((p) => p.test(subject))) continue;

    // 2. Parse conventional commit.
    const parsed = parseCommitSubject(subject);
    if (!parsed) continue;

    // 3. Skip disallowed types.
    const group = allowedTypes[parsed.type];
    if (!group) continue;

    // 4. Skip denied scopes.
    if (parsed.scope && deniedScopes.includes(parsed.scope)) continue;

    // 5. Render bullet.
    const prNumber = parsed.prNumbers.length > 0 ? parsed.prNumbers[0] : null;
    let bullet;
    if (prNumber !== null) {
      bullet = `- ${parsed.description} ([#${prNumber}](${repoUrl}/pull/${prNumber}))`;
    } else {
      bullet = `- ${parsed.description}`;
    }

    groups[group].push({ prNumber, bullet });
  }

  return groups;
}

/**
 * Merge hand-written `## [Unreleased]` content with auto-derived entries.
 *
 * Hand-written lines come first within each group; auto entries whose `prNumber`
 * is not in `existingPrs` are appended. Null-prNumber entries always append.
 * Empty groups are omitted. Group order: Added, Changed, Fixed, Removed.
 *
 * @param {string} handWrittenBody  - existing body of [Unreleased] (between heading and next ##)
 * @param {{ Added: Entry[], Changed: Entry[], Fixed: Entry[] }} derivedGroups
 * @param {Set<number>} existingPrs
 * @returns {string}  the merged body string (no leading blank line)
 */
export function mergeUnreleased(handWrittenBody, derivedGroups, existingPrs) {
  const GROUP_ORDER = ["Added", "Changed", "Fixed", "Removed"];

  // Parse the hand-written body into its groups and any extra content.
  // Each group section starts with `### <Name>` and ends at the next `### ` or end.
  const handGroups = /** @type {Record<string, string[]>} */ ({});
  const extraLines = [];

  const bodyLines = handWrittenBody.split("\n");
  let currentGroup = null;

  for (const line of bodyLines) {
    const groupMatch = /^### (.+)$/.exec(line);
    if (groupMatch) {
      currentGroup = groupMatch[1].trim();
      if (!handGroups[currentGroup]) handGroups[currentGroup] = [];
    } else if (currentGroup !== null) {
      handGroups[currentGroup].push(line);
    } else {
      // Content before any group heading — keep as extra.
      extraLines.push(line);
    }
  }

  // Strip trailing blank lines from each hand-written group.
  for (const g of Object.keys(handGroups)) {
    while (handGroups[g].length > 0 && handGroups[g][handGroups[g].length - 1].trim() === "") {
      handGroups[g].pop();
    }
  }

  // Collect all known group names (hand-written + derived + canonical order).
  const allGroups = new Set([
    ...GROUP_ORDER,
    ...Object.keys(handGroups),
  ]);

  const outputSections = [];

  for (const group of allGroups) {
    const handLines = handGroups[group] ?? [];
    const autoEntries = derivedGroups[group] ?? [];

    // Filter auto entries: skip if prNumber already in existingPrs.
    const newAutoEntries = autoEntries.filter(
      (e) => e.prNumber === null || !existingPrs.has(e.prNumber),
    );

    if (handLines.length === 0 && newAutoEntries.length === 0) continue;

    const sectionLines = [`### ${group}`];
    if (handLines.length > 0) {
      sectionLines.push(...handLines);
    }
    for (const entry of newAutoEntries) {
      sectionLines.push(entry.bullet);
    }
    outputSections.push(sectionLines.join("\n"));
  }

  // Preserve any extra hand-written content (before any group heading) at the start.
  const extraContent = extraLines.join("\n").trim();

  const parts = [];
  if (extraContent) parts.push(extraContent);
  parts.push(...outputSections);

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Impure helper: read git commit subjects
// ---------------------------------------------------------------------------

/**
 * Read commit subject lines in range `<lastTag>..HEAD` using git.
 * On any git error (including no tags), prints a warning and returns [].
 * NEVER throws.
 *
 * @returns {string[]}
 */
export function readCommitSubjectsSinceLastTag() {
  try {
    const tag = execFileSync("git", ["describe", "--tags", "--abbrev=0"], {
      encoding: "utf8",
    }).trim();

    const log = execFileSync(
      "git",
      ["log", `${tag}..HEAD`, "--format=%s"],
      { encoding: "utf8" },
    );

    return log.split("\n").filter((l) => l.trim() !== "");
  } catch (err) {
    console.warn(
      `[bump-version] Warning: could not read git log since last tag — ` +
        `falling back to hand-written-only changelog. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Changelog promotion
// ---------------------------------------------------------------------------

/**
 * Pure function: promote the `## [Unreleased]` section of a Keep a Changelog
 * file into a dated version section and insert a fresh empty `## [Unreleased]`
 * above it.
 *
 * Rules:
 *   - If there is no `## [Unreleased]` heading, returns the text unchanged.
 *   - Auto-derives entries from `subjects` (commit subject lines since last tag)
 *     and merges them with any hand-written bullets already in `[Unreleased]`.
 *   - If the merged body has no bullets in any group, promotes with the
 *     placeholder `_No user-facing changes._` (internal-only fallback).
 *   - A fresh empty `## [Unreleased]` section is prepended above the newly
 *     dated section, separated by a blank line.
 *
 * @param {string} changelogText  - full CHANGELOG.md text
 * @param {string} version        - new version string, e.g. "0.7.6"
 * @param {string} date           - ISO date string, e.g. "2026-07-02"
 * @param {string[]} [subjects]   - commit subject lines since last tag (default [])
 * @returns {string}  updated changelog text
 */
export function promoteUnreleased(changelogText, version, date, subjects = []) {
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
  const handWrittenBody = bodyLines.join("\n");

  // Derive auto entries from commit subjects.
  const derivedGroups = deriveEntries(subjects, {
    allowedTypes: ALLOWED_TYPES,
    deniedScopes: DENIED_SCOPES,
    skipPatterns: SKIP_PATTERNS,
    repoUrl: REPO_URL,
  });

  // Compute existing PR numbers from current [Unreleased] body (for dedup).
  const existingPrs = existingPrNumbers(handWrittenBody);

  // Merge hand-written + auto-derived.
  const mergedBody = mergeUnreleased(handWrittenBody, derivedGroups, existingPrs);

  // Determine the final promoted body.
  // If no bullets exist after merge → use the internal-only fallback placeholder.
  const hasBullets = /^- /m.test(mergedBody);
  const promotedBodyContent = hasBullets ? mergedBody : "_No user-facing changes._";

  // Build the promoted section lines.
  const promotedHeading = `## [${version}] - ${date}`;

  // Construct the replacement: fresh [Unreleased] + blank line + promoted section.
  const promotedBodyLines = promotedBodyContent.split("\n");
  const replacement = [
    "## [Unreleased]",
    "",
    promotedHeading,
    "",
    ...promotedBodyLines,
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

  // Read commit subjects for auto-derivation (impure; falls back to [] on error).
  const subjects = readCommitSubjectsSinceLastTag();

  // Compute the promoted CHANGELOG.md first so any failure happens
  // BEFORE any version file is mutated (no partial bump on failure).
  // repo root = packages/app/../../ (two levels up from `root`).
  const repoRoot = join(root, "..", "..");
  const changelogPath = join(repoRoot, "CHANGELOG.md");
  const changelogExists = existsSync(changelogPath);
  let updatedChangelog = null;
  if (changelogExists) {
    const changelogText = readFileSync(changelogPath, "utf8");
    const today = new Date().toISOString().slice(0, 10);
    updatedChangelog = promoteUnreleased(changelogText, next, today, subjects);
  }

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

  // Write the promoted changelog last (already computed + validated above).
  if (changelogExists) {
    writeFileSync(changelogPath, updatedChangelog, "utf8");
  }

  process.stdout.write(next);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
