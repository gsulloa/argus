import { describe, expect, it } from "vitest";
import { matchesLogSubstring, matchesLogFuzzy, highlightSegments } from "./logFormat";

describe("matchesLogSubstring", () => {
  it("matches everything for an empty/whitespace query", () => {
    expect(matchesLogSubstring("anything", "")).toBe(true);
    expect(matchesLogSubstring("anything", "   ")).toBe(true);
  });

  it("matches case-insensitive substrings", () => {
    expect(matchesLogSubstring("ERROR: disk full", "error")).toBe(true);
    expect(matchesLogSubstring("error: disk full", "DISK")).toBe(true);
    expect(matchesLogSubstring("nothing here", "error")).toBe(false);
  });

  it("does NOT match scattered (non-substring) characters", () => {
    // "tmt" is a subsequence of "timeout" but not a substring → excluded
    expect(matchesLogSubstring("Connection timeout", "tmt")).toBe(false);
  });
});

describe("matchesLogFuzzy", () => {
  it("matches an in-order subsequence, case-insensitive", () => {
    expect(matchesLogFuzzy("Connection timeout", "tmt")).toBe(true);
    expect(matchesLogFuzzy("RequestId: abc-123", "reqid")).toBe(true);
  });

  it("does not match out-of-order characters", () => {
    expect(matchesLogFuzzy("Connection timeout", "tmto x")).toBe(false);
  });

  it("empty query matches everything", () => {
    expect(matchesLogFuzzy("anything", "")).toBe(true);
  });
});

describe("highlightSegments", () => {
  const joinMatched = (text: string, q: string) =>
    highlightSegments(text, q)
      .filter((s) => s.match)
      .map((s) => s.text)
      .join("|");

  it("empty query yields a single unmatched segment", () => {
    expect(highlightSegments("hello", "")).toEqual([{ text: "hello", match: false }]);
  });

  it("marks a single case-insensitive substring occurrence", () => {
    const segs = highlightSegments("ERROR: disk full", "error");
    expect(segs).toEqual([
      { text: "ERROR", match: true },
      { text: ": disk full", match: false },
    ]);
  });

  it("marks all occurrences", () => {
    expect(joinMatched("ab AB ab", "ab")).toBe("ab|AB|ab");
  });

  it("reconstructs the original text exactly", () => {
    const text = "Request abc Request";
    expect(highlightSegments(text, "request").map((s) => s.text).join("")).toBe(text);
  });

  it("falls back to subsequence chars when there is no substring", () => {
    // "tmt" is not a substring of "timeout" but is a subsequence
    expect(joinMatched("timeout", "tmt")).toBe("t|m|t");
  });

  it("returns one unmatched segment when nothing matches at all", () => {
    expect(highlightSegments("abc", "xyz")).toEqual([{ text: "abc", match: false }]);
  });
});
