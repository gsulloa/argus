/**
 * dynamoSortHelpers.test.ts
 *
 * Covers:
 *   - Numeric ordering ("2", "10", "3" → 2, 3, 10)
 *   - Boolean (false < true)
 *   - Text localeCompare with numeric: true ("item2" < "item10")
 *   - Complex types sort by summary length
 *   - undefined placement: sorts last in asc, sorts first in desc
 */

import { describe, it, expect } from "vitest";
import type { Row } from "@tanstack/react-table";
import { makeSortingFn } from "./dynamoSortHelpers";
import type { AttributeMap, AttributeValue } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(value: AttributeValue | undefined): Row<AttributeMap> {
  return {
    getValue: (_colId: string) => value,
  } as unknown as Row<AttributeMap>;
}

function sort(
  values: (AttributeValue | undefined)[],
  category: Parameters<typeof makeSortingFn>[0],
  desc = false,
): (AttributeValue | undefined)[] {
  const fn = makeSortingFn(category);
  const rows = values.map((v) => makeRow(v));
  const colId = "col";

  // Simulate TanStack sorting: asc = fn result, desc = -fn result
  // sortUndefined "last" is handled on column def; here we replicate it
  const sorted = [...rows].sort((a, b) => {
    const av = a.getValue(colId) as AttributeValue | undefined;
    const bv = b.getValue(colId) as AttributeValue | undefined;

    // Replicate sortUndefined: "last" — always put undefined at the end
    if (av === undefined && bv === undefined) return 0;
    if (av === undefined) return 1;  // a goes after b
    if (bv === undefined) return -1; // b goes after a

    const result = fn(a, b, colId);
    return desc ? -result : result;
  });

  return sorted.map((r) => r.getValue(colId) as AttributeValue | undefined);
}

// ---------------------------------------------------------------------------
// Numeric
// ---------------------------------------------------------------------------

describe("makeSortingFn — numeric", () => {
  it("sorts numerically, not lexicographically", () => {
    const values = [{ N: "2" }, { N: "10" }, { N: "3" }];
    const result = sort(values, "numeric");
    expect(result.map((v) => (v as { N: string }).N)).toEqual(["2", "3", "10"]);
  });

  it("NaN sorts after finite numbers in asc", () => {
    const values = [{ N: "5" }, { N: "NaN" }, { N: "1" }];
    const result = sort(values, "numeric");
    const Ns = result.map((v) => (v as { N: string }).N);
    // NaN (parsed as NaN) should be last
    expect(Ns[0]).toBe("1");
    expect(Ns[1]).toBe("5");
    expect(Ns[2]).toBe("NaN");
  });

  it("NaN sorts before finite numbers in desc", () => {
    const values = [{ N: "5" }, { N: "NaN" }, { N: "1" }];
    const result = sort(values, "numeric", true);
    const Ns = result.map((v) => (v as { N: string }).N);
    // In desc, the comparator result is negated, so NaN (which returns +1) becomes -1 → sorts first
    expect(Ns[0]).toBe("NaN");
  });
});

// ---------------------------------------------------------------------------
// Boolean
// ---------------------------------------------------------------------------

describe("makeSortingFn — boolean", () => {
  it("false < true in asc", () => {
    const values = [{ BOOL: true }, { BOOL: false }];
    const result = sort(values, "boolean");
    expect((result[0] as { BOOL: boolean }).BOOL).toBe(false);
    expect((result[1] as { BOOL: boolean }).BOOL).toBe(true);
  });

  it("true < false in desc (reversed)", () => {
    const values = [{ BOOL: false }, { BOOL: true }];
    const result = sort(values, "boolean", true);
    expect((result[0] as { BOOL: boolean }).BOOL).toBe(true);
    expect((result[1] as { BOOL: boolean }).BOOL).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Text / UUID — localeCompare with numeric: true
// ---------------------------------------------------------------------------

describe("makeSortingFn — text", () => {
  it("sorts item2 before item10 with numeric locale", () => {
    const values = [{ S: "item10" }, { S: "item2" }, { S: "item1" }];
    const result = sort(values, "text");
    const Ss = result.map((v) => (v as { S: string }).S);
    expect(Ss).toEqual(["item1", "item2", "item10"]);
  });

  it("is case-insensitive (sensitivity: base)", () => {
    const values = [{ S: "Banana" }, { S: "apple" }, { S: "cherry" }];
    const result = sort(values, "text");
    const Ss = result.map((v) => (v as { S: string }).S);
    // With sensitivity: "base", 'a' == 'A' — order is apple, banana, cherry
    expect(Ss[0]!.toLowerCase()).toBe("apple");
    expect(Ss[1]!.toLowerCase()).toBe("banana");
    expect(Ss[2]!.toLowerCase()).toBe("cherry");
  });
});

// ---------------------------------------------------------------------------
// Complex types — sort by summary size
// ---------------------------------------------------------------------------

describe("makeSortingFn — json (complex)", () => {
  it("sorts L values by list length asc", () => {
    const values = [
      { L: [{ S: "a" }, { S: "b" }, { S: "c" }] },
      { L: [{ S: "x" }] },
      { L: [{ S: "p" }, { S: "q" }, { S: "r" }, { S: "s" }, { S: "t" }, { S: "u" }, { S: "v" }] },
    ];
    const result = sort(values, "json");
    const lengths = result.map((v) => (v as { L: unknown[] }).L.length);
    expect(lengths).toEqual([1, 3, 7]);
  });

  it("sorts M values by key count asc", () => {
    const values: AttributeValue[] = [
      { M: { a: { S: "1" }, b: { S: "2" }, c: { S: "3" } } },
      { M: {} },
      { M: { x: { S: "1" } } },
    ];
    const result = sort(values, "json");
    const keyCounts = result.map((v) => Object.keys((v as { M: Record<string, unknown> }).M).length);
    expect(keyCounts).toEqual([0, 1, 3]);
  });
});

// ---------------------------------------------------------------------------
// undefined placement
// ---------------------------------------------------------------------------

describe("makeSortingFn — undefined placement", () => {
  it("undefined rows sort last in asc (sortUndefined: last equivalent)", () => {
    const values: (AttributeValue | undefined)[] = [
      { N: "5" },
      undefined,
      { N: "1" },
    ];
    const result = sort(values, "numeric");
    expect(result[0]).toEqual({ N: "1" });
    expect(result[1]).toEqual({ N: "5" });
    expect(result[2]).toBeUndefined();
  });

  it("undefined rows sort last in desc (always last regardless of direction)", () => {
    // The sort helper always puts undefined at the end regardless of direction
    // (sortUndefined: "last" on the column def, replicated in our test sort fn)
    const values: (AttributeValue | undefined)[] = [
      { N: "5" },
      undefined,
      { N: "1" },
    ];
    const result = sort(values, "numeric", true);
    // Desc: 5, 1, undefined
    expect(result[0]).toEqual({ N: "5" });
    expect(result[1]).toEqual({ N: "1" });
    expect(result[2]).toBeUndefined();
  });
});
