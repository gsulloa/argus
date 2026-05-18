import { describe, it, expect } from "vitest";
import {
  addRow,
  removeRow,
  setRow,
  setEnabled,
  setCombinator,
  clearAllRows,
  coerceValueForOperator,
} from "./treeMutations";
import { EMPTY_FILTER_ROW } from "../types";
import type { FilterRow, FilterTree } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function row(overrides: Partial<FilterRow> = {}): FilterRow {
  return {
    enabled: true,
    column: { kind: "named", name: "a" },
    op: "=",
    value: "1",
    ...overrides,
  };
}

function treeOf(...rows: FilterRow[]): FilterTree {
  return { rows, combinator: "AND" };
}

// ---------------------------------------------------------------------------
// addRow
// ---------------------------------------------------------------------------

describe("addRow", () => {
  it("appends a default empty row when no args given", () => {
    const t = treeOf(row());
    const next = addRow(t);
    expect(next.rows).toHaveLength(2);
    expect(next.rows[1]).toEqual(EMPTY_FILTER_ROW);
  });

  it("inserts at the specified index", () => {
    const r0 = row({ value: "0" });
    const r1 = row({ value: "1" });
    const t = treeOf(r0, r1);
    const newRow = row({ value: "inserted" });
    const next = addRow(t, 1, newRow);
    expect(next.rows).toHaveLength(3);
    expect(next.rows[0]).toEqual(r0);
    expect(next.rows[1]).toEqual(newRow);
    expect(next.rows[2]).toEqual(r1);
  });

  it("inserts at index 0 (prepend)", () => {
    const t = treeOf(row({ value: "existing" }));
    const prepended = row({ value: "first" });
    const next = addRow(t, 0, prepended);
    expect(next.rows[0]).toEqual(prepended);
    expect(next.rows).toHaveLength(2);
  });

  it("appends when atIndex equals rows.length", () => {
    const t = treeOf(row());
    const appended = row({ value: "last" });
    const next = addRow(t, t.rows.length, appended);
    expect(next.rows[next.rows.length - 1]).toEqual(appended);
  });

  it("preserves combinator", () => {
    const t: FilterTree = { rows: [row()], combinator: "OR" };
    expect(addRow(t).combinator).toBe("OR");
  });
});

// ---------------------------------------------------------------------------
// removeRow
// ---------------------------------------------------------------------------

describe("removeRow", () => {
  it("removes a row by index", () => {
    const r0 = row({ value: "0" });
    const r1 = row({ value: "1" });
    const t = treeOf(r0, r1);
    const next = removeRow(t, 0);
    expect(next.rows).toHaveLength(1);
    expect(next.rows[0]).toEqual(r1);
  });

  it("clears to EMPTY_FILTER_ROW when removing the last row", () => {
    const t = treeOf(row({ value: "only" }));
    const next = removeRow(t, 0);
    expect(next.rows).toHaveLength(1);
    expect(next.rows[0]).toEqual(EMPTY_FILTER_ROW);
  });

  it("preserves combinator after removal", () => {
    const t: FilterTree = { rows: [row(), row()], combinator: "OR" };
    expect(removeRow(t, 0).combinator).toBe("OR");
  });
});

// ---------------------------------------------------------------------------
// setRow
// ---------------------------------------------------------------------------

describe("setRow", () => {
  it("replaces the row at the given index", () => {
    const t = treeOf(row({ value: "old" }));
    const replacement = row({ value: "new" });
    const next = setRow(t, 0, replacement);
    expect(next.rows[0]).toEqual(replacement);
  });

  it("does not mutate other rows", () => {
    const r0 = row({ value: "0" });
    const r1 = row({ value: "1" });
    const t = treeOf(r0, r1);
    const next = setRow(t, 0, row({ value: "replaced" }));
    expect(next.rows[1]).toEqual(r1);
  });
});

// ---------------------------------------------------------------------------
// setEnabled
// ---------------------------------------------------------------------------

describe("setEnabled", () => {
  it("sets enabled to false on an enabled row", () => {
    const t = treeOf(row({ enabled: true }));
    const next = setEnabled(t, 0, false);
    expect(next.rows[0]?.enabled).toBe(false);
  });

  it("sets enabled to true on a disabled row", () => {
    const t = treeOf(row({ enabled: false }));
    const next = setEnabled(t, 0, true);
    expect(next.rows[0]?.enabled).toBe(true);
  });

  it("returns the same tree reference when index is out of bounds", () => {
    const t = treeOf(row());
    expect(setEnabled(t, 99, false)).toBe(t);
  });
});

// ---------------------------------------------------------------------------
// setCombinator
// ---------------------------------------------------------------------------

describe("setCombinator", () => {
  it("changes combinator to OR", () => {
    const t = treeOf(row());
    expect(setCombinator(t, "OR").combinator).toBe("OR");
  });

  it("changes combinator to AND", () => {
    const t: FilterTree = { rows: [row()], combinator: "OR" };
    expect(setCombinator(t, "AND").combinator).toBe("AND");
  });

  it("preserves rows", () => {
    const t = treeOf(row({ value: "x" }));
    expect(setCombinator(t, "OR").rows).toEqual(t.rows);
  });
});

// ---------------------------------------------------------------------------
// clearAllRows
// ---------------------------------------------------------------------------

describe("clearAllRows", () => {
  it("resets rows to a single EMPTY_FILTER_ROW", () => {
    const t = treeOf(row({ value: "a" }), row({ value: "b" }));
    const next = clearAllRows(t);
    expect(next.rows).toHaveLength(1);
    expect(next.rows[0]).toEqual(EMPTY_FILTER_ROW);
  });

  it("preserves combinator", () => {
    const t: FilterTree = { rows: [row(), row()], combinator: "OR" };
    expect(clearAllRows(t).combinator).toBe("OR");
  });
});

// ---------------------------------------------------------------------------
// coerceValueForOperator
// ---------------------------------------------------------------------------

describe("coerceValueForOperator", () => {
  it("returns undefined for IS NULL", () => {
    expect(coerceValueForOperator("foo", "IS NULL")).toBeUndefined();
  });

  it("returns undefined for IS NOT NULL", () => {
    expect(coerceValueForOperator("foo", "IS NOT NULL")).toBeUndefined();
  });

  it("returns {min:'',max:''} for BETWEEN when prev is a scalar", () => {
    expect(coerceValueForOperator("x", "BETWEEN")).toEqual({ min: "", max: "" });
  });

  it("preserves existing {min,max} for BETWEEN", () => {
    const v = { min: "a", max: "b" };
    expect(coerceValueForOperator(v, "BETWEEN")).toEqual(v);
  });

  it("returns [] for In when prev is a scalar", () => {
    expect(coerceValueForOperator("x", "In")).toEqual([]);
  });

  it("preserves existing array for In", () => {
    const v = ["a", "b"];
    expect(coerceValueForOperator(v, "In")).toEqual(v);
  });

  it("returns [] for NotIn when prev is undefined", () => {
    expect(coerceValueForOperator(undefined, "NotIn")).toEqual([]);
  });

  it("coerces array to first element for binary op", () => {
    expect(coerceValueForOperator(["a", "b"], "=")).toBe("a");
  });

  it("coerces {min,max} object to '' for binary op", () => {
    expect(coerceValueForOperator({ min: "a", max: "b" }, "=")).toBe("");
  });

  it("returns '' for undefined on binary op", () => {
    expect(coerceValueForOperator(undefined, "=")).toBe("");
  });

  it("preserves scalar value for binary op", () => {
    expect(coerceValueForOperator("hello", "ILIKE")).toBe("hello");
  });
});
