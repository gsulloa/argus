import { describe, expect, it } from "vitest";
import { formatSql } from "./format";

describe("formatSql", () => {
  it("returns input unchanged when empty or whitespace-only", () => {
    expect(formatSql("")).toBe("");
    expect(formatSql("   ")).toBe("   ");
    expect(formatSql("\n\t  \n")).toBe("\n\t  \n");
  });

  it("uppercases lowercase keywords", () => {
    const out = formatSql("select id from users");
    expect(out).toMatch(/SELECT/);
    expect(out).toMatch(/FROM/);
  });

  it("preserves quoted identifiers verbatim", () => {
    const out = formatSql('select "MixedCase" from "Schema"."T"');
    expect(out).toContain('"MixedCase"');
    expect(out).toContain('"Schema"."T"');
  });

  it("re-throws on unparseable input", () => {
    // sql-formatter throws on certain malformed dollar-quoted blocks.
    expect(() => formatSql("SELECT $$open without close")).toThrow();
  });
});
