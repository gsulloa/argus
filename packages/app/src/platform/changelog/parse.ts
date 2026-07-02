/**
 * parse.ts — dependency-free Keep a Changelog parser.
 *
 * Parses the strictly-structured changelog produced by the release pipeline:
 *   # Changelog          (intro block, ignored)
 *   ## [Unreleased]
 *   ## [X.Y.Z] - YYYY-MM-DD
 *     ### GroupName      (Added / Changed / Fixed / Removed, or any literal)
 *     - bullet text [link text](url) more text
 *
 * The parser is LENIENT: it never throws. Unknown ### headings are kept under
 * their literal name. Non-list, non-heading lines inside a version become a
 * single text-token entry in a group named "".
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InlineToken {
  type: "text";
  value: string;
}

export interface InlineLinkToken {
  type: "link";
  text: string;
  url: string;
}

export type AnyToken = InlineToken | InlineLinkToken;

export interface ChangelogEntry {
  /** Tokenized inline content for one bullet. */
  tokens: AnyToken[];
}

export interface ChangelogGroup {
  /** "Added" / "Changed" / "Fixed" / "Removed", or literal unknown heading. */
  name: string;
  entries: ChangelogEntry[];
}

export interface ChangelogVersion {
  /** Semver string like "0.7.5", or null for [Unreleased]. */
  version: string | null;
  /** ISO date string like "2026-07-01", or null when absent. */
  date: string | null;
  groups: ChangelogGroup[];
  isUnreleased: boolean;
}

export interface Changelog {
  unreleased: ChangelogVersion | null;
  /** All dated versions, newest-first as they appear in the file. */
  versions: ChangelogVersion[];
}

// ---------------------------------------------------------------------------
// SemVer helpers (also exported for the host)
// ---------------------------------------------------------------------------

/**
 * Parse a semver-ish string "X.Y.Z" into numeric parts.
 * Returns [0,0,0] for anything it can't parse.
 */
function parseSemver(v: string): [number, number, number] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!match) return [0, 0, 0];
  return [
    parseInt(match[1] ?? "0", 10),
    parseInt(match[2] ?? "0", 10),
    parseInt(match[3] ?? "0", 10),
  ];
}

/**
 * Compare two semver strings numerically.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function semverCompare(a: string, b: string): -1 | 0 | 1 {
  const [aMaj, aMin, aPat] = parseSemver(a);
  const [bMaj, bMin, bPat] = parseSemver(b);

  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1;
  if (aMin !== bMin) return aMin < bMin ? -1 : 1;
  if (aPat !== bPat) return aPat < bPat ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Inline tokenizer
// ---------------------------------------------------------------------------

/**
 * Tokenize a string that may contain inline markdown links [text](url).
 * Everything else becomes text tokens. Never throws.
 */
function tokenizeInline(raw: string): AnyToken[] {
  const tokens: AnyToken[] = [];
  // Match [text](url) — non-greedy on both parts, single-line
  const linkRe = /\[([^\]]*)\]\(([^)]*)\)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = linkRe.exec(raw)) !== null) {
    const before = raw.slice(lastIndex, match.index);
    if (before.length > 0) {
      tokens.push({ type: "text", value: before });
    }
    tokens.push({ type: "link", text: match[1] ?? "", url: match[2] ?? "" });
    lastIndex = match.index + match[0].length;
  }

  const tail = raw.slice(lastIndex);
  if (tail.length > 0) {
    tokens.push({ type: "text", value: tail });
  }

  return tokens.length > 0 ? tokens : [{ type: "text", value: raw }];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a Keep a Changelog formatted string into structured data.
 * Never throws.
 */
export function parseChangelog(raw: string): Changelog {
  const lines = raw.split(/\r?\n/);

  const versions: ChangelogVersion[] = [];
  let unreleased: ChangelogVersion | null = null;

  let currentVersion: ChangelogVersion | null = null;
  let currentGroup: ChangelogGroup | null = null;

  // Regex for version headers
  const unreleasedRe = /^##\s+\[Unreleased\]\s*$/i;
  const versionRe = /^##\s+\[([^\]]+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/;
  const groupRe = /^###\s+(.+)$/;
  const bulletRe = /^-\s+(.*)$/;

  function finalizeGroup() {
    if (currentVersion && currentGroup) {
      currentVersion.groups.push(currentGroup);
      currentGroup = null;
    }
  }

  function finalizeVersion() {
    finalizeGroup();
    if (currentVersion) {
      if (currentVersion.isUnreleased) {
        unreleased = currentVersion;
      } else {
        versions.push(currentVersion);
      }
      currentVersion = null;
    }
  }

  for (const line of lines) {
    // Top-level heading — skip the intro
    if (/^#\s+/.test(line) && !/^##/.test(line)) {
      continue;
    }

    // Version header: ## [Unreleased]
    if (unreleasedRe.test(line)) {
      finalizeVersion();
      currentVersion = {
        version: null,
        date: null,
        groups: [],
        isUnreleased: true,
      };
      continue;
    }

    // Version header: ## [X.Y.Z] - DATE
    const versionMatch = versionRe.exec(line);
    if (versionMatch) {
      finalizeVersion();
      currentVersion = {
        version: versionMatch[1] ?? null,
        date: versionMatch[2] ?? null,
        groups: [],
        isUnreleased: false,
      };
      continue;
    }

    // Group heading: ### Name
    const groupMatch = groupRe.exec(line);
    if (groupMatch && currentVersion) {
      finalizeGroup();
      currentGroup = { name: (groupMatch[1] ?? "").trim(), entries: [] };
      continue;
    }

    // Bullet entry: - text
    const bulletMatch = bulletRe.exec(line);
    if (bulletMatch && currentVersion) {
      // Ensure we have a group (anonymous group for entries without a ### heading)
      if (!currentGroup) {
        currentGroup = { name: "", entries: [] };
      }
      currentGroup.entries.push({ tokens: tokenizeInline(bulletMatch[1] ?? "") });
      continue;
    }

    // Non-list, non-heading line inside a version: treat as anonymous text entry
    const trimmed = line.trim();
    if (trimmed.length > 0 && currentVersion) {
      if (!currentGroup) {
        currentGroup = { name: "", entries: [] };
      }
      currentGroup.entries.push({ tokens: tokenizeInline(trimmed) });
    }
  }

  // Finalize any open version at EOF
  finalizeVersion();

  return { unreleased, versions };
}
