import { describe, it, expect } from "vitest";
import {
  isTableMatchEmpty,
  normalizeTableName,
  validateTableMatch,
} from "./tableMatch";

describe("normalizeTableName", () => {
  it("returns the name unchanged with no rule", () => {
    expect(normalizeTableName("Events", null)).toBe("Events");
    expect(normalizeTableName("Events", undefined)).toBe("Events");
    expect(normalizeTableName("Events", {})).toBe("Events");
  });

  it("strips prefix and suffix pattern (simple form)", () => {
    const rule = { prefix: "MyApp-prod-", suffix_pattern: "-[A-Z0-9]+$" };
    expect(
      normalizeTableName("MyApp-prod-EventsTable-3M4N5O6P7Q8R", rule),
    ).toBe("EventsTable");
  });

  it("returns the logical capture group (advanced form)", () => {
    const rule = { regex: "^MyApp-prod-(?<logical>.+?)-[A-Z0-9]+$" };
    expect(
      normalizeTableName("MyApp-prod-EventsTable-3M4N5O6P7Q8R", rule),
    ).toBe("EventsTable");
  });

  it("normalizes equal across changing random suffixes", () => {
    const rule = { prefix: "MyApp-prod-", suffix_pattern: "-[A-Z0-9]+$" };
    const a = normalizeTableName("MyApp-prod-EventsTable-3M4N5O6P7Q8R", rule);
    const b = normalizeTableName("MyApp-prod-EventsTable-9Z8Y7X6W5V4U", rule);
    expect(a).toBe(b);
    expect(a).toBe("EventsTable");
  });

  it("degrades to identity when the regex does not match", () => {
    const rule = { regex: "^MyApp-prod-(?<logical>.+?)-[A-Z0-9]+$" };
    expect(normalizeTableName("SomeOtherTable", rule)).toBe("SomeOtherTable");
  });

  it("degrades to identity when the regex does not compile", () => {
    const rule = { regex: "(" };
    expect(normalizeTableName("anything", rule)).toBe("anything");
  });

  it("is idempotent on an already-logical name", () => {
    const rule = { prefix: "MyApp-prod-", suffix_pattern: "-[A-Z0-9]+$" };
    expect(normalizeTableName("EventsTable", rule)).toBe("EventsTable");
  });
});

describe("validateTableMatch", () => {
  it("accepts empty / absent rules", () => {
    expect(validateTableMatch(null)).toBeNull();
    expect(validateTableMatch({})).toBeNull();
  });

  it("accepts a valid simple rule", () => {
    expect(
      validateTableMatch({ prefix: "MyApp-", suffix_pattern: "-[A-Z0-9]+$" }),
    ).toBeNull();
  });

  it("accepts a valid advanced rule with a logical group", () => {
    expect(
      validateTableMatch({ regex: "^(?<logical>.+?)-[A-Z]+$" }),
    ).toBeNull();
  });

  it("rejects an advanced rule without a logical group", () => {
    expect(validateTableMatch({ regex: "^MyApp-.+$" })).toMatch(/logical/);
  });

  it("rejects a non-compiling suffix pattern", () => {
    expect(validateTableMatch({ suffix_pattern: "-[A-Z0-9" })).toMatch(
      /compile/i,
    );
  });

  it("rejects mixing simple and advanced forms", () => {
    expect(
      validateTableMatch({ prefix: "X-", regex: "^(?<logical>.+)$" }),
    ).toMatch(/either/i);
  });
});

describe("isTableMatchEmpty", () => {
  it("treats null/undefined/empty as empty", () => {
    expect(isTableMatchEmpty(null)).toBe(true);
    expect(isTableMatchEmpty(undefined)).toBe(true);
    expect(isTableMatchEmpty({})).toBe(true);
  });
  it("treats a populated rule as non-empty", () => {
    expect(isTableMatchEmpty({ prefix: "X-" })).toBe(false);
  });
});
