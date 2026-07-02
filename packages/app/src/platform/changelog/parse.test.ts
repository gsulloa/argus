import { describe, it, expect } from "vitest";
import { parseChangelog, semverCompare } from "./parse";
import type { AnyToken } from "./parse";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_NORMAL = `# Changelog

All notable changes are documented here.

## [Unreleased]

## [1.2.3] - 2026-06-01

### Added
- New feature for users ([#42](https://github.com/example/repo/pull/42))
- Another plain addition

### Fixed
- Bug in the data grid
`;

const FIXTURE_EMPTY_UNRELEASED = `# Changelog

## [Unreleased]

## [0.9.0] - 2026-05-01

### Changed
- Updated styling
`;

const FIXTURE_UNKNOWN_HEADING = `# Changelog

## [2.0.0] - 2026-07-01

### Added
- Normal entry

### Experimental
- This is under an unknown heading

### Removed
- Old stuff
`;

const FIXTURE_MALFORMED = `# Changelog

## [3.0.0] - 2026-07-01

### Added
- Valid entry

This is a stray non-list line inside a version.

- Another valid entry after stray text

## [2.9.0]

### Fixed
- Missing date version works fine
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLinkTokens(tokens: AnyToken[]) {
  return tokens.filter((t): t is Extract<AnyToken, { type: "link" }> => t.type === "link");
}

function getTextTokens(tokens: AnyToken[]) {
  return tokens.filter((t): t is Extract<AnyToken, { type: "text" }> => t.type === "text");
}

// ---------------------------------------------------------------------------
// parseChangelog
// ---------------------------------------------------------------------------

describe("parseChangelog", () => {
  describe("normal version with Added/Fixed groups + inline link", () => {
    it("parses a dated version", () => {
      const result = parseChangelog(FIXTURE_NORMAL);
      expect(result.versions).toHaveLength(1);
      const v = result.versions[0]!;
      expect(v.version).toBe("1.2.3");
      expect(v.date).toBe("2026-06-01");
      expect(v.isUnreleased).toBe(false);
    });

    it("parses an Unreleased section (empty in this fixture)", () => {
      const result = parseChangelog(FIXTURE_NORMAL);
      // The Unreleased section exists but has no entries
      expect(result.unreleased).not.toBeNull();
      expect(result.unreleased?.isUnreleased).toBe(true);
    });

    it("finds Added and Fixed groups", () => {
      const result = parseChangelog(FIXTURE_NORMAL);
      const v = result.versions[0]!;
      const groupNames = v.groups.map((g) => g.name);
      expect(groupNames).toContain("Added");
      expect(groupNames).toContain("Fixed");
    });

    it("tokenizes inline link in an Added entry", () => {
      const result = parseChangelog(FIXTURE_NORMAL);
      const addedGroup = result.versions[0]!.groups.find((g) => g.name === "Added");
      expect(addedGroup).toBeDefined();

      // First entry: "New feature for users ([#42](https://github.com/...))"
      const firstEntry = addedGroup!.entries[0]!;
      expect(firstEntry.tokens.length).toBeGreaterThan(1);

      const textTokens = getTextTokens(firstEntry.tokens);
      const linkTokens = getLinkTokens(firstEntry.tokens);

      expect(textTokens.length).toBeGreaterThan(0);
      expect(linkTokens.length).toBe(1);

      const link = linkTokens[0]!;
      expect(link.text).toBe("#42");
      expect(link.url).toBe("https://github.com/example/repo/pull/42");
    });

    it("tokenizes plain entry as a single text token", () => {
      const result = parseChangelog(FIXTURE_NORMAL);
      const addedGroup = result.versions[0]!.groups.find((g) => g.name === "Added");
      const secondEntry = addedGroup!.entries[1]!;
      expect(secondEntry.tokens).toHaveLength(1);
      const firstToken = secondEntry.tokens[0]!;
      expect(firstToken.type).toBe("text");
      if (firstToken.type === "text") {
        expect(firstToken.value).toBe("Another plain addition");
      }
    });
  });

  describe("empty [Unreleased]", () => {
    it("parses unreleased with no entries/groups (or only empty groups)", () => {
      const result = parseChangelog(FIXTURE_EMPTY_UNRELEASED);
      expect(result.unreleased).not.toBeNull();
      // The unreleased block should have no non-empty groups
      const nonEmpty = result.unreleased!.groups.filter((g) => g.entries.length > 0);
      expect(nonEmpty).toHaveLength(0);
    });

    it("still parses the dated version", () => {
      const result = parseChangelog(FIXTURE_EMPTY_UNRELEASED);
      expect(result.versions).toHaveLength(1);
      expect(result.versions[0]!.version).toBe("0.9.0");
    });
  });

  describe("unknown ### heading", () => {
    it("renders under the literal heading name without throwing", () => {
      const result = parseChangelog(FIXTURE_UNKNOWN_HEADING);
      expect(result.versions).toHaveLength(1);
      const v = result.versions[0]!;
      const groupNames = v.groups.map((g) => g.name);
      expect(groupNames).toContain("Experimental");
    });

    it("also preserves standard groups alongside unknown", () => {
      const result = parseChangelog(FIXTURE_UNKNOWN_HEADING);
      const v = result.versions[0]!;
      const groupNames = v.groups.map((g) => g.name);
      expect(groupNames).toContain("Added");
      expect(groupNames).toContain("Removed");
    });

    it("does not throw when parsing", () => {
      expect(() => parseChangelog(FIXTURE_UNKNOWN_HEADING)).not.toThrow();
    });
  });

  describe("malformed / stray non-list lines", () => {
    it("does not throw on stray non-list text", () => {
      expect(() => parseChangelog(FIXTURE_MALFORMED)).not.toThrow();
    });

    it("still produces valid versions", () => {
      const result = parseChangelog(FIXTURE_MALFORMED);
      expect(result.versions.length).toBeGreaterThanOrEqual(1);
      // Find 3.0.0
      const v = result.versions.find((v) => v.version === "3.0.0");
      expect(v).toBeDefined();
    });

    it("tolerates a missing date on a version header", () => {
      const result = parseChangelog(FIXTURE_MALFORMED);
      const v = result.versions.find((v) => v.version === "2.9.0");
      expect(v).toBeDefined();
      expect(v!.date).toBeNull();
    });

    it("stray text line does not crash entry parsing", () => {
      const result = parseChangelog(FIXTURE_MALFORMED);
      const v = result.versions.find((v) => v.version === "3.0.0");
      expect(v).toBeDefined();
      // Should have the Added group with at least 1 entry
      const added = v!.groups.find((g) => g.name === "Added");
      expect(added).toBeDefined();
      expect(added!.entries.length).toBeGreaterThan(0);
    });
  });

  describe("edge cases", () => {
    it("returns empty changelog for empty input", () => {
      const result = parseChangelog("");
      expect(result.unreleased).toBeNull();
      expect(result.versions).toHaveLength(0);
    });

    it("does not throw on completely malformed input", () => {
      expect(() => parseChangelog("not a changelog at all\n\nfoo bar baz")).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// semverCompare
// ---------------------------------------------------------------------------

describe("semverCompare", () => {
  it("returns -1 when a < b (major)", () => {
    expect(semverCompare("0.7.5", "1.0.0")).toBe(-1);
  });

  it("returns -1 when a < b (minor)", () => {
    expect(semverCompare("0.7.5", "0.8.0")).toBe(-1);
  });

  it("returns -1 when a < b (patch)", () => {
    expect(semverCompare("0.7.4", "0.7.5")).toBe(-1);
  });

  it("returns 1 when a > b", () => {
    expect(semverCompare("1.0.0", "0.9.9")).toBe(1);
  });

  it("returns 0 for equal versions", () => {
    expect(semverCompare("0.7.5", "0.7.5")).toBe(0);
  });

  it("handles v-prefix", () => {
    expect(semverCompare("v0.7.5", "v0.7.6")).toBe(-1);
  });

  it("returns 0 for unparseable strings", () => {
    expect(semverCompare("unknown", "also-unknown")).toBe(0);
  });
});
