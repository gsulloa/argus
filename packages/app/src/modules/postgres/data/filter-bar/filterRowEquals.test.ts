import { describe, expect, it } from "vitest";
import { filterRowEquals } from "../types";
import type { FilterRow } from "../types";

function row(overrides: Partial<FilterRow> = {}): FilterRow {
  return {
    enabled: true,
    column: { kind: "any_column" },
    op: "Contains",
    value: "hello",
    ...overrides,
  };
}

describe("filterRowEquals", () => {
  it("two structurally equal rows with different enabled flags → true", () => {
    const a = row({ enabled: true });
    const b = row({ enabled: false });
    expect(filterRowEquals(a, b)).toBe(true);
  });

  it("two rows with different columns → false", () => {
    const a = row({ column: { kind: "named", name: "country" } });
    const b = row({ column: { kind: "named", name: "status" } });
    expect(filterRowEquals(a, b)).toBe(false);
  });

  it("two rows with different ops → false", () => {
    const a = row({ op: "=" });
    const b = row({ op: "!=" });
    expect(filterRowEquals(a, b)).toBe(false);
  });

  it("two rows with different scalar values → false", () => {
    const a = row({ value: "CL" });
    const b = row({ value: "US" });
    expect(filterRowEquals(a, b)).toBe(false);
  });

  it("two rows with the same scalar value → true", () => {
    const a = row({ value: "CL" });
    const b = row({ value: "CL" });
    expect(filterRowEquals(a, b)).toBe(true);
  });

  it("two rows with same array values → true", () => {
    const a = row({ op: "In", value: ["a", "b", "c"] });
    const b = row({ op: "In", value: ["a", "b", "c"] });
    expect(filterRowEquals(a, b)).toBe(true);
  });

  it("two rows with different array values → false", () => {
    const a = row({ op: "In", value: ["a", "b"] });
    const b = row({ op: "In", value: ["a", "c"] });
    expect(filterRowEquals(a, b)).toBe(false);
  });

  it("two rows with same {min, max} object values → true", () => {
    const a = row({ op: "BETWEEN", value: { min: 1, max: 10 } });
    const b = row({ op: "BETWEEN", value: { min: 1, max: 10 } });
    expect(filterRowEquals(a, b)).toBe(true);
  });

  it("two rows with different {min, max} object values → false", () => {
    const a = row({ op: "BETWEEN", value: { min: 1, max: 10 } });
    const b = row({ op: "BETWEEN", value: { min: 1, max: 20 } });
    expect(filterRowEquals(a, b)).toBe(false);
  });

  it("any_column vs named column with same-ish context → false", () => {
    const a = row({ column: { kind: "any_column" } });
    const b = row({ column: { kind: "named", name: "country" } });
    expect(filterRowEquals(a, b)).toBe(false);
  });

  it("two any_column rows → true", () => {
    const a = row({ column: { kind: "any_column" }, enabled: true });
    const b = row({ column: { kind: "any_column" }, enabled: false });
    expect(filterRowEquals(a, b)).toBe(true);
  });

  it("two rows with undefined value → true", () => {
    const a = row({ op: "IS NULL", value: undefined });
    const b = row({ op: "IS NULL", value: undefined });
    expect(filterRowEquals(a, b)).toBe(true);
  });

  it("one row with value, one without → false", () => {
    const a = row({ value: "CL" });
    const b = row({ value: undefined });
    expect(filterRowEquals(a, b)).toBe(false);
  });

  it("array with different lengths → false", () => {
    const a = row({ op: "In", value: ["a", "b", "c"] });
    const b = row({ op: "In", value: ["a", "b"] });
    expect(filterRowEquals(a, b)).toBe(false);
  });
});
