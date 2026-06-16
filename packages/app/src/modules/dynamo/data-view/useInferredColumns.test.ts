/**
 * useInferredColumns.test.ts — task 10.6
 *
 * Covers:
 *   - PK first, SK second, then alphabetical-tie-break for same-frequency attrs
 *   - Column stability across pages: existing columns don't move; new attrs
 *     append before "More…" when frequency qualifies
 *   - "More…" is always the last column
 *   - When items go empty (reset), accepted list clears
 *   - When indexName changes, accepted list resets (new key schema)
 */

import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useInferredColumns, MORE_COLUMN_ID } from "./useInferredColumns";
import type { AttributeMap } from "./types";
import type { TableDescription } from "@/modules/dynamo/tables/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDescribe(
  pk = "id",
  sk: string | null = null,
  gsiName: string | null = null,
  gsiPk = "gsi_pk",
  gsiSk: string | null = null,
): TableDescription {
  return {
    table_name: "test-table",
    table_arn: "arn:aws:dynamodb:us-east-1:123:table/test-table",
    table_status: "ACTIVE",
    item_count: 0,
    table_size_bytes: 0,
    billing_mode: "PAY_PER_REQUEST",
    key_schema: [
      { attribute_name: pk, key_type: "HASH" },
      ...(sk ? [{ attribute_name: sk, key_type: "RANGE" as const }] : []),
    ],
    attribute_definitions: [
      { attribute_name: pk, attribute_type: "S" },
      ...(sk ? [{ attribute_name: sk, attribute_type: "S" as const }] : []),
    ],
    global_secondary_indexes: gsiName
      ? [
          {
            index_name: gsiName,
            key_schema: [
              { attribute_name: gsiPk, key_type: "HASH" as const },
              ...(gsiSk
                ? [{ attribute_name: gsiSk, key_type: "RANGE" as const }]
                : []),
            ],
            projection_type: "ALL",
            index_status: "ACTIVE",
          },
        ]
      : [],
    local_secondary_indexes: [],
  };
}

function makeItem(attrs: Record<string, string>): AttributeMap {
  const result: AttributeMap = {};
  for (const [k, v] of Object.entries(attrs)) {
    result[k] = { S: v };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useInferredColumns", () => {
  it("returns [PK, More…] with no items and no SK", () => {
    const describe = makeDescribe("pk");
    const { result } = renderHook(() =>
      useInferredColumns([], describe, null),
    );
    const ids = result.current.map((c) => c.id);
    expect(ids).toEqual(["pk", MORE_COLUMN_ID]);
  });

  it("returns [PK, SK, More…] with no items when table has SK", () => {
    const describe = makeDescribe("pk", "sk");
    const { result } = renderHook(() =>
      useInferredColumns([], describe, null),
    );
    const ids = result.current.map((c) => c.id);
    expect(ids).toEqual(["pk", "sk", MORE_COLUMN_ID]);
  });

  it("puts PK first, SK second, then alphabetical among same-frequency attrs", () => {
    const describe = makeDescribe("pk", "sk");
    const items: AttributeMap[] = [
      makeItem({ pk: "1", sk: "a", gamma: "x", alpha: "y", beta: "z" }),
      makeItem({ pk: "2", sk: "b", gamma: "x", alpha: "y", beta: "z" }),
      makeItem({ pk: "3", sk: "c", gamma: "x", alpha: "y", beta: "z" }),
    ];
    const { result } = renderHook(() =>
      useInferredColumns(items, describe, null),
    );
    const ids = result.current.map((c) => c.id);
    // PK first, SK second, then alpha, beta, gamma (alphabetical, same freq=3)
    expect(ids[0]).toBe("pk");
    expect(ids[1]).toBe("sk");
    expect(ids[2]).toBe("alpha");
    expect(ids[3]).toBe("beta");
    expect(ids[4]).toBe("gamma");
    expect(ids[ids.length - 1]).toBe(MORE_COLUMN_ID);
  });

  it("puts higher-frequency attrs before lower-frequency ones", () => {
    const describe = makeDescribe("pk");
    const items: AttributeMap[] = [
      makeItem({ pk: "1", common: "x", rare: "y" }),
      makeItem({ pk: "2", common: "x" }),
      makeItem({ pk: "3", common: "x" }),
    ];
    const { result } = renderHook(() =>
      useInferredColumns(items, describe, null),
    );
    const ids = result.current.map((c) => c.id);
    expect(ids[0]).toBe("pk");
    expect(ids[1]).toBe("common"); // freq=3
    expect(ids[2]).toBe("rare"); // freq=1
    expect(ids[ids.length - 1]).toBe(MORE_COLUMN_ID);
  });

  it("isKey is true for PK and SK, false for data columns", () => {
    const describe = makeDescribe("pk", "sk");
    const items = [makeItem({ pk: "1", sk: "a", extra: "e" })];
    const { result } = renderHook(() =>
      useInferredColumns(items, describe, null),
    );
    const pkCol = result.current.find((c) => c.id === "pk");
    const skCol = result.current.find((c) => c.id === "sk");
    const extraCol = result.current.find((c) => c.id === "extra");
    const moreCol = result.current.find((c) => c.id === MORE_COLUMN_ID);
    expect(pkCol?.isKey).toBe(true);
    expect(skCol?.isKey).toBe(true);
    expect(extraCol?.isKey).toBe(false);
    expect(moreCol?.isKey).toBe(false);
  });

  it("column stability: existing columns don't move when new page loads", () => {
    const describe = makeDescribe("pk", "sk");

    // Page 1: attrs alpha, beta, gamma (all freq 3 — fills up topN=3)
    const page1Items: AttributeMap[] = [
      makeItem({ pk: "1", sk: "a", alpha: "x", beta: "x", gamma: "x" }),
      makeItem({ pk: "2", sk: "b", alpha: "x", beta: "x", gamma: "x" }),
      makeItem({ pk: "3", sk: "c", alpha: "x", beta: "x", gamma: "x" }),
    ];

    const { result, rerender } = renderHook(
      ({ items }: { items: AttributeMap[] }) =>
        useInferredColumns(items, describe, null, 3),
      { initialProps: { items: page1Items } },
    );

    const idsPage1 = result.current.map((c) => c.id);
    // pk, sk, then alpha, beta, gamma (alphabetical), then More…
    expect(idsPage1).toEqual(["pk", "sk", "alpha", "beta", "gamma", MORE_COLUMN_ID]);

    // Page 2: adds "category" (high freq) — but accepted list is full
    // category is new, only existing columns are stable
    const page2Items = [
      ...page1Items,
      makeItem({
        pk: "4",
        sk: "d",
        alpha: "x",
        beta: "x",
        gamma: "x",
        category: "x",
      }),
      makeItem({
        pk: "5",
        sk: "e",
        alpha: "x",
        beta: "x",
        gamma: "x",
        category: "x",
      }),
    ];

    rerender({ items: page2Items });

    const idsPage2 = result.current.map((c) => c.id);
    // Existing columns MUST stay in same positions
    expect(idsPage2[0]).toBe("pk");
    expect(idsPage2[1]).toBe("sk");
    expect(idsPage2[2]).toBe("alpha");
    expect(idsPage2[3]).toBe("beta");
    expect(idsPage2[4]).toBe("gamma");
    // More… is still last
    expect(idsPage2[idsPage2.length - 1]).toBe(MORE_COLUMN_ID);
  });

  it("new high-frequency attr appends before More… when slots available", () => {
    const describe = makeDescribe("pk");

    // Start with 2 data attrs, topN=3 so one slot is available
    const page1Items: AttributeMap[] = [
      makeItem({ pk: "1", alpha: "x", beta: "x" }),
      makeItem({ pk: "2", alpha: "x", beta: "x" }),
    ];

    const { result, rerender } = renderHook(
      ({ items }: { items: AttributeMap[] }) =>
        useInferredColumns(items, describe, null, 3),
      { initialProps: { items: page1Items } },
    );

    const idsPage1 = result.current.map((c) => c.id);
    expect(idsPage1).toEqual(["pk", "alpha", "beta", MORE_COLUMN_ID]);

    // Page 2: introduce "gamma" at high freq — should fill the open slot
    const page2Items = [
      ...page1Items,
      makeItem({ pk: "3", alpha: "x", beta: "x", gamma: "x" }),
      makeItem({ pk: "4", alpha: "x", beta: "x", gamma: "x" }),
    ];
    rerender({ items: page2Items });

    const idsPage2 = result.current.map((c) => c.id);
    expect(idsPage2[0]).toBe("pk");
    expect(idsPage2[1]).toBe("alpha"); // unchanged position
    expect(idsPage2[2]).toBe("beta"); // unchanged position
    expect(idsPage2[3]).toBe("gamma"); // appended
    expect(idsPage2[idsPage2.length - 1]).toBe(MORE_COLUMN_ID);
  });

  it("clears accepted list when items goes >0 → 0 (reset)", () => {
    const describe = makeDescribe("pk");
    const items = [makeItem({ pk: "1", alpha: "x" })];

    const { result, rerender } = renderHook(
      ({ items }: { items: AttributeMap[] }) =>
        useInferredColumns(items, describe, null),
      { initialProps: { items } },
    );

    const idsWithItems = result.current.map((c) => c.id);
    expect(idsWithItems).toContain("alpha");

    // Reset — items become empty
    rerender({ items: [] });

    const idsEmpty = result.current.map((c) => c.id);
    // alpha should be gone (accepted list cleared)
    expect(idsEmpty).not.toContain("alpha");
  });

  it("resets accepted list when indexName changes", () => {
    const describe = makeDescribe("pk", null, "byGsi", "gsiPk");
    const items = [
      makeItem({ pk: "1", someAttr: "x" }),
      makeItem({ pk: "2", someAttr: "x" }),
    ];

    const { result, rerender } = renderHook(
      ({
        items,
        indexName,
      }: {
        items: AttributeMap[];
        indexName: string | null;
      }) => useInferredColumns(items, describe, indexName),
      { initialProps: { items, indexName: null as string | null } },
    );

    expect(result.current.map((c) => c.id)).toContain("someAttr");

    // Switch to GSI index
    rerender({ items, indexName: "byGsi" });

    // The accepted list should reset; PK is now gsiPk
    const afterSwitch = result.current.map((c) => c.id);
    expect(afterSwitch[0]).toBe("gsiPk");
    // someAttr will be re-inferred, but the key point is the list restarted
    expect(afterSwitch[afterSwitch.length - 1]).toBe(MORE_COLUMN_ID);
  });

  it("More… is always the last column", () => {
    const describe = makeDescribe("pk", "sk");
    const manyItems: AttributeMap[] = Array.from({ length: 20 }, (_, i) =>
      makeItem({
        pk: String(i),
        sk: String(i),
        a: "x",
        b: "x",
        c: "x",
        d: "x",
        e: "x",
        f: "x",
        g: "x",
        h: "x",
        i: "x",
        j: "x",
        k: "x",
      }),
    );
    const { result } = renderHook(() =>
      useInferredColumns(manyItems, describe, null),
    );
    const ids = result.current.map((c) => c.id);
    expect(ids[ids.length - 1]).toBe(MORE_COLUMN_ID);
  });

  it("handles null describe gracefully", () => {
    const items = [makeItem({ anything: "x" })];
    const { result } = renderHook(() =>
      useInferredColumns(items, null, null),
    );
    const ids = result.current.map((c) => c.id);
    // No PK/SK known — still returns data attrs + More…
    expect(ids[ids.length - 1]).toBe(MORE_COLUMN_ID);
  });
});
