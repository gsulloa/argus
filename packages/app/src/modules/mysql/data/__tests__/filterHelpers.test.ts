/**
 * §26.3 — Frontend tests for MySQL filter model helpers.
 * Tests pure logic functions in data/types.ts: isCompleteRow, modelToPayload.
 */

import { describe, expect, it } from "vitest";
import {
  isCompleteRow,
  modelToPayload,
  EMPTY_FILTER_TREE,
  EMPTY_FILTER_ROW,
} from "../types";
import type { FilterRow } from "../../types";

function makeRow(overrides: Partial<FilterRow> = {}): FilterRow {
  return {
    enabled: true,
    column: { kind: "named", name: "id" },
    op: "=",
    value: "42",
    ...overrides,
  };
}

describe("isCompleteRow", () => {
  it("returns true for a complete eq row", () => {
    expect(isCompleteRow(makeRow())).toBe(true);
  });

  it("returns true when column is any_column (no name required)", () => {
    // any_column does not require a name — only named columns check the name field.
    expect(isCompleteRow(makeRow({ column: { kind: "any_column" } }))).toBe(true);
  });

  it("returns false when named column has empty name", () => {
    expect(isCompleteRow(makeRow({ column: { kind: "named", name: "" } }))).toBe(false);
  });

  it("returns true for IS NULL with no value needed", () => {
    expect(isCompleteRow(makeRow({ op: "IS NULL", value: "" }))).toBe(true);
  });

  it("returns true for IS NOT NULL with no value needed", () => {
    expect(isCompleteRow(makeRow({ op: "IS NOT NULL", value: undefined }))).toBe(true);
  });

  it("returns false for In with empty array value", () => {
    expect(isCompleteRow(makeRow({ op: "In", value: [] }))).toBe(false);
  });

  it("returns false for In with non-array value", () => {
    expect(isCompleteRow(makeRow({ op: "In", value: "not-array" }))).toBe(false);
  });

  it("returns true for In with non-empty array of valid values", () => {
    expect(isCompleteRow(makeRow({ op: "In", value: ["a", "b"] }))).toBe(true);
  });

  it("returns false for In array with empty string element", () => {
    expect(isCompleteRow(makeRow({ op: "In", value: ["a", ""] }))).toBe(false);
  });

  it("returns false for NotIn with empty array", () => {
    expect(isCompleteRow(makeRow({ op: "NotIn", value: [] }))).toBe(false);
  });

  it("returns true for NotIn with valid values", () => {
    expect(isCompleteRow(makeRow({ op: "NotIn", value: [1, 2, 3] }))).toBe(true);
  });

  it("returns false for BETWEEN with missing min", () => {
    expect(
      isCompleteRow(makeRow({ op: "BETWEEN", value: { min: "", max: "10" } }))
    ).toBe(false);
  });

  it("returns false for BETWEEN with missing max", () => {
    expect(
      isCompleteRow(makeRow({ op: "BETWEEN", value: { min: "1", max: "" } }))
    ).toBe(false);
  });

  it("returns true for BETWEEN with both min and max set", () => {
    expect(
      isCompleteRow(makeRow({ op: "BETWEEN", value: { min: "1", max: "10" } }))
    ).toBe(true);
  });

  it("returns false when value is empty string for = operator", () => {
    expect(isCompleteRow(makeRow({ op: "=", value: "" }))).toBe(false);
  });

  it("returns false when value is undefined for < operator", () => {
    expect(isCompleteRow(makeRow({ op: "<", value: undefined }))).toBe(false);
  });

  it("returns true for Contains with a non-empty string value", () => {
    expect(isCompleteRow(makeRow({ op: "Contains", value: "hello" }))).toBe(true);
  });

  it("returns false for Contains with empty string value", () => {
    expect(isCompleteRow(makeRow({ op: "Contains", value: "" }))).toBe(false);
  });

  it("returns true for LIKE with a non-empty string value", () => {
    expect(isCompleteRow(makeRow({ op: "LIKE", value: "al%" }))).toBe(true);
  });

  it("returns true for StartsWith with a non-empty value", () => {
    expect(isCompleteRow(makeRow({ op: "StartsWith", value: "Jo" }))).toBe(true);
  });

  it("returns true for EndsWith with a non-empty value", () => {
    expect(isCompleteRow(makeRow({ op: "EndsWith", value: "son" }))).toBe(true);
  });
});

describe("modelToPayload", () => {
  it("returns empty object for empty filter tree", () => {
    const result = modelToPayload(EMPTY_FILTER_TREE);
    expect(result).toEqual({});
  });

  it("returns empty object when all rows are disabled", () => {
    const model = {
      rows: [makeRow({ enabled: false })],
      combinator: "AND" as const,
    };
    expect(modelToPayload(model)).toEqual({});
  });

  it("returns filter_tree with AND combinator for complete rows", () => {
    const model = {
      rows: [makeRow({ column: { kind: "named", name: "id" }, op: "=", value: "1" })],
      combinator: "AND" as const,
    };
    const result = modelToPayload(model);
    expect(result.filter_tree).toBeDefined();
    expect(result.filter_tree!.combinator).toBe("AND");
    expect(result.filter_tree!.children).toHaveLength(1);
  });

  it("returns filter_tree with OR combinator", () => {
    const model = {
      rows: [
        makeRow({ column: { kind: "named", name: "id" }, op: "=", value: "1" }),
        makeRow({ column: { kind: "named", name: "id" }, op: "=", value: "2" }),
      ],
      combinator: "OR" as const,
    };
    const result = modelToPayload(model);
    expect(result.filter_tree!.combinator).toBe("OR");
    expect(result.filter_tree!.children).toHaveLength(2);
  });

  it("excludes incomplete rows from payload", () => {
    const model = {
      rows: [
        makeRow({ column: { kind: "named", name: "id" }, op: "=", value: "1" }),
        makeRow({ op: "=", value: "" }), // incomplete — empty value
      ],
      combinator: "AND" as const,
    };
    const result = modelToPayload(model);
    expect(result.filter_tree!.children).toHaveLength(1);
  });

  it("maps row op and column correctly", () => {
    const model = {
      rows: [
        makeRow({
          column: { kind: "named", name: "name" },
          op: "Contains",
          value: "alice",
        }),
      ],
      combinator: "AND" as const,
    };
    const result = modelToPayload(model);
    const child = result.filter_tree!.children[0]!;
    expect(child.op).toBe("Contains");
    expect((child.column as { kind: string; name?: string }).name).toBe("name");
  });

  it("maps IS NULL row with no value", () => {
    const model = {
      rows: [
        makeRow({
          column: { kind: "named", name: "deleted_at" },
          op: "IS NULL",
          value: undefined,
        }),
      ],
      combinator: "AND" as const,
    };
    const result = modelToPayload(model);
    expect(result.filter_tree!.children).toHaveLength(1);
    expect(result.filter_tree!.children[0]!.op).toBe("IS NULL");
  });
});

describe("EMPTY_FILTER_ROW", () => {
  it("has enabled=true and op=Contains by default", () => {
    expect(EMPTY_FILTER_ROW.enabled).toBe(true);
    expect(EMPTY_FILTER_ROW.op).toBe("Contains");
  });
});

describe("EMPTY_FILTER_TREE", () => {
  it("has empty rows and AND combinator", () => {
    expect(EMPTY_FILTER_TREE.rows).toHaveLength(0);
    expect(EMPTY_FILTER_TREE.combinator).toBe("AND");
  });
});
