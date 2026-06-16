import { describe, it, expect } from "vitest";
import {
  compareCellValues,
  cycleColumnSort,
  sortResultRows,
  type SortOrder,
} from "./sortResultRows";

const COLS = ["id", "name", "created"];
const cell = (row: unknown[], i: number) => row[i];

function ids(rows: unknown[][]): unknown[] {
  return rows.map((r) => r[0]);
}

describe("cycleColumnSort", () => {
  it("cycles unsorted → asc → desc → unsorted on the same column", () => {
    let order: SortOrder[] = [];
    order = cycleColumnSort("name", order);
    expect(order).toEqual([{ column: "name", direction: "asc" }]);
    order = cycleColumnSort("name", order);
    expect(order).toEqual([{ column: "name", direction: "desc" }]);
    order = cycleColumnSort("name", order);
    expect(order).toEqual([]);
  });

  it("clicking a different column replaces the sort with that column ascending", () => {
    const order = cycleColumnSort("id", [{ column: "name", direction: "desc" }]);
    expect(order).toEqual([{ column: "id", direction: "asc" }]);
  });
});

describe("compareCellValues", () => {
  it("compares numbers numerically, not lexically", () => {
    expect(compareCellValues(9, 10)).toBeLessThan(0);
    expect(compareCellValues(100, 9)).toBeGreaterThan(0);
  });

  it("compares numeric-looking strings numerically", () => {
    expect(compareCellValues("9", "10")).toBeLessThan(0);
  });

  it("orders booleans false < true", () => {
    expect(compareCellValues(false, true)).toBeLessThan(0);
  });

  it("compares ISO timestamps chronologically", () => {
    expect(
      compareCellValues("2024-01-01T00:00:00Z", "2024-12-31T00:00:00Z"),
    ).toBeLessThan(0);
  });

  it("falls back to lexical for plain text", () => {
    expect(compareCellValues("apple", "banana")).toBeLessThan(0);
  });

  it("puts nulls after present values (ascending semantics)", () => {
    expect(compareCellValues(null, 1)).toBeGreaterThan(0);
    expect(compareCellValues(1, null)).toBeLessThan(0);
    expect(compareCellValues(null, null)).toBe(0);
  });

  it("does not misread a bare integer string as a date", () => {
    // Both are numeric → numeric compare wins (10 < 100), proving "10" was not
    // parsed as a year.
    expect(compareCellValues("10", "100")).toBeLessThan(0);
  });
});

describe("sortResultRows", () => {
  it("returns a shallow copy unchanged when orderBy is empty", () => {
    const rows = [[2], [1], [3]];
    const out = sortResultRows(rows, COLS, [], cell);
    expect(out).not.toBe(rows);
    expect(ids(out as unknown[][])).toEqual([2, 1, 3]);
  });

  it("never mutates the input array or rows", () => {
    const rows = [[2], [1], [3]];
    const snapshot = JSON.stringify(rows);
    sortResultRows(rows, COLS, [{ column: "id", direction: "asc" }], cell);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });

  it("sorts a numeric column ascending numerically", () => {
    const rows = [[100], [9], [10]];
    const out = sortResultRows(
      rows,
      COLS,
      [{ column: "id", direction: "asc" }],
      cell,
    );
    expect(ids(out as unknown[][])).toEqual([9, 10, 100]);
  });

  it("sorts descending", () => {
    const rows = [[9], [100], [10]];
    const out = sortResultRows(
      rows,
      COLS,
      [{ column: "id", direction: "desc" }],
      cell,
    );
    expect(ids(out as unknown[][])).toEqual([100, 10, 9]);
  });

  it("groups nulls last in ascending order", () => {
    const rows = [[3], [null], [1], [null], [2]];
    const out = sortResultRows(
      rows,
      COLS,
      [{ column: "id", direction: "asc" }],
      cell,
    );
    expect(ids(out as unknown[][])).toEqual([1, 2, 3, null, null]);
  });

  it("keeps nulls grouped last in descending order too", () => {
    const rows = [[3], [null], [1], [null], [2]];
    const out = sortResultRows(
      rows,
      COLS,
      [{ column: "id", direction: "desc" }],
      cell,
    );
    expect(ids(out as unknown[][])).toEqual([3, 2, 1, null, null]);
  });

  it("is stable: equal keys preserve original order", () => {
    // Sort by name (col 1); the two "a" rows must keep ids 1 then 2.
    const rows = [
      [1, "a"],
      [2, "a"],
      [3, "b"],
    ];
    const out = sortResultRows(
      rows,
      COLS,
      [{ column: "name", direction: "asc" }],
      cell,
    );
    expect(ids(out as unknown[][])).toEqual([1, 2, 3]);
  });

  it("ignores sort keys whose column is absent", () => {
    const rows = [[2], [1]];
    const out = sortResultRows(
      rows,
      COLS,
      [{ column: "nonexistent", direction: "asc" }],
      cell,
    );
    expect(ids(out as unknown[][])).toEqual([2, 1]);
  });

  it("works with UnifiedRow-shaped rows via a custom getCell", () => {
    const rows = [
      { rowKey: "0", cells: [2, "b"] },
      { rowKey: "1", cells: [1, "a"] },
    ];
    const out = sortResultRows(
      rows,
      COLS,
      [{ column: "id", direction: "asc" }],
      (r, i) => r.cells[i],
    );
    expect(out.map((r) => r.rowKey)).toEqual(["1", "0"]);
  });
});
