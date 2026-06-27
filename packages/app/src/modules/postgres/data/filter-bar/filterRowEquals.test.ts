import { describe, expect, it } from "vitest";
import { filterRowEquals, isCompleteRow, modelToPayload } from "../types";
import type { FilterRow, FilterModel } from "../types";

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

// ---------------------------------------------------------------------------
// isCompleteRow — RAW rows
// ---------------------------------------------------------------------------

describe("isCompleteRow — RAW rows", () => {
  it("returns false for RAW row with empty string value", () => {
    const r: FilterRow = { enabled: true, column: { kind: "raw" }, op: "RAW", value: "" };
    expect(isCompleteRow(r)).toBe(false);
  });

  it("returns false for RAW row with whitespace-only value", () => {
    const r: FilterRow = { enabled: true, column: { kind: "raw" }, op: "RAW", value: "   " };
    expect(isCompleteRow(r)).toBe(false);
  });

  it("returns false for RAW row with undefined value", () => {
    const r: FilterRow = { enabled: true, column: { kind: "raw" }, op: "RAW", value: undefined };
    expect(isCompleteRow(r)).toBe(false);
  });

  it("returns true for RAW row with a non-empty expression", () => {
    const r: FilterRow = { enabled: true, column: { kind: "raw" }, op: "RAW", value: "id > 0" };
    expect(isCompleteRow(r)).toBe(true);
  });

  it("returns true for RAW row with leading/trailing whitespace around a non-empty expression", () => {
    const r: FilterRow = { enabled: true, column: { kind: "raw" }, op: "RAW", value: "  id > 0  " };
    expect(isCompleteRow(r)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// modelToPayload — RAW rows
// ---------------------------------------------------------------------------

describe("modelToPayload — RAW rows", () => {
  it("emits wire shape { kind: condition, column: { kind: raw }, op: RAW, value } for a complete RAW row", () => {
    const model: FilterModel = {
      rows: [{ enabled: true, column: { kind: "raw" }, op: "RAW", value: "data->>'flag' = 'true'" }],
      combinator: "AND",
    };
    const payload = modelToPayload(model);
    expect(payload.filter_tree).toBeDefined();
    expect(payload.filter_tree!.children).toHaveLength(1);
    expect(payload.filter_tree!.children[0]).toEqual({
      kind: "condition",
      column: { kind: "raw" },
      op: "RAW",
      value: "data->>'flag' = 'true'",
    });
  });

  it("drops incomplete RAW rows (empty expression)", () => {
    const model: FilterModel = {
      rows: [
        { enabled: true, column: { kind: "raw" }, op: "RAW", value: "" },
        { enabled: true, column: { kind: "named", name: "status" }, op: "=", value: "active" },
      ],
      combinator: "AND",
    };
    const payload = modelToPayload(model);
    expect(payload.filter_tree!.children).toHaveLength(1);
    expect(payload.filter_tree!.children[0]!.op).toBe("=");
  });

  it("drops incomplete RAW rows (whitespace-only expression)", () => {
    const model: FilterModel = {
      rows: [{ enabled: true, column: { kind: "raw" }, op: "RAW", value: "   " }],
      combinator: "AND",
    };
    const payload = modelToPayload(model);
    expect(payload.filter_tree).toBeUndefined();
  });

  it("drops disabled RAW rows", () => {
    const model: FilterModel = {
      rows: [{ enabled: false, column: { kind: "raw" }, op: "RAW", value: "id > 0" }],
      combinator: "AND",
    };
    const payload = modelToPayload(model);
    expect(payload.filter_tree).toBeUndefined();
  });
});
