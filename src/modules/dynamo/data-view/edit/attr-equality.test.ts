import { describe, it, expect } from "vitest";
import {
  attrValueEquals,
  diffAttributeMaps,
  validateTaggedItem,
} from "./attr-equality";
import type { AttributeValue, AttributeMap } from "../types";

// ---------------------------------------------------------------------------
// attrValueEquals
// ---------------------------------------------------------------------------

describe("attrValueEquals", () => {
  // Primitives — equality
  it("S equal", () => expect(attrValueEquals({ S: "hello" }, { S: "hello" })).toBe(true));
  it("S not equal", () => expect(attrValueEquals({ S: "hello" }, { S: "world" })).toBe(false));

  it("N equal", () => expect(attrValueEquals({ N: "42" }, { N: "42" })).toBe(true));
  it("N not equal", () => expect(attrValueEquals({ N: "42" }, { N: "43" })).toBe(false));

  it("BOOL true equal", () => expect(attrValueEquals({ BOOL: true }, { BOOL: true })).toBe(true));
  it("BOOL false equal", () => expect(attrValueEquals({ BOOL: false }, { BOOL: false })).toBe(true));
  it("BOOL not equal", () => expect(attrValueEquals({ BOOL: true }, { BOOL: false })).toBe(false));

  it("NULL equal", () => expect(attrValueEquals({ NULL: true }, { NULL: true })).toBe(true));

  it("B equal", () => expect(attrValueEquals({ B: "YWJj" }, { B: "YWJj" })).toBe(true));
  it("B not equal", () => expect(attrValueEquals({ B: "YWJj" }, { B: "eHl6" })).toBe(false));

  // Different tags
  it("different tags S vs N → false", () =>
    expect(attrValueEquals({ S: "5" }, { N: "5" })).toBe(false));
  it("different tags BOOL vs NULL → false", () =>
    expect(attrValueEquals({ BOOL: true } as AttributeValue, { NULL: true } as AttributeValue)).toBe(false));

  // L — ordered list
  it("L equal same order", () =>
    expect(
      attrValueEquals({ L: [{ S: "a" }, { S: "b" }] }, { L: [{ S: "a" }, { S: "b" }] }),
    ).toBe(true));
  it("L different order → false (order matters)", () =>
    expect(
      attrValueEquals({ L: [{ S: "a" }, { S: "b" }] }, { L: [{ S: "b" }, { S: "a" }] }),
    ).toBe(false));
  it("L different length → false", () =>
    expect(attrValueEquals({ L: [{ S: "a" }] }, { L: [{ S: "a" }, { S: "b" }] })).toBe(false));
  it("L empty equal", () => expect(attrValueEquals({ L: [] }, { L: [] })).toBe(true));

  // M — map
  it("M equal same keys", () =>
    expect(
      attrValueEquals(
        { M: { x: { S: "1" }, y: { N: "2" } } },
        { M: { x: { S: "1" }, y: { N: "2" } } },
      ),
    ).toBe(true));
  it("M different value → false", () =>
    expect(
      attrValueEquals({ M: { x: { S: "1" } } }, { M: { x: { S: "2" } } }),
    ).toBe(false));
  it("M different keys → false", () =>
    expect(
      attrValueEquals({ M: { x: { S: "1" } } }, { M: { y: { S: "1" } } }),
    ).toBe(false));

  // SS — set equality (order-insensitive)
  it("SS same order", () => expect(attrValueEquals({ SS: ["a", "b"] }, { SS: ["a", "b"] })).toBe(true));
  it("SS different order → equal", () =>
    expect(attrValueEquals({ SS: ["a", "b"] }, { SS: ["b", "a"] })).toBe(true));
  it("SS different element → false", () =>
    expect(attrValueEquals({ SS: ["a", "b"] }, { SS: ["a", "c"] })).toBe(false));
  it("SS different size → false", () =>
    expect(attrValueEquals({ SS: ["a"] }, { SS: ["a", "b"] })).toBe(false));

  // NS — set equality
  it("NS same order", () => expect(attrValueEquals({ NS: ["1", "2"] }, { NS: ["1", "2"] })).toBe(true));
  it("NS different order → equal", () =>
    expect(attrValueEquals({ NS: ["2", "1"] }, { NS: ["1", "2"] })).toBe(true));
  it("NS different element → false", () =>
    expect(attrValueEquals({ NS: ["1"] }, { NS: ["2"] })).toBe(false));

  // BS — set equality
  it("BS different order → equal", () =>
    expect(attrValueEquals({ BS: ["YQ==", "Yg=="] }, { BS: ["Yg==", "YQ=="] })).toBe(true));
  it("BS different element → false", () =>
    expect(attrValueEquals({ BS: ["YQ=="] }, { BS: ["Yg=="] })).toBe(false));
});

// ---------------------------------------------------------------------------
// diffAttributeMaps
// ---------------------------------------------------------------------------

describe("diffAttributeMaps", () => {
  it("identical maps → empty set and remove", () => {
    const map: AttributeMap = { name: { S: "Alice" }, age: { N: "30" } };
    const result = diffAttributeMaps(map, map);
    expect(result.set).toEqual({});
    expect(result.remove).toEqual([]);
  });

  it("single value changed → set has that key, remove empty", () => {
    const original: AttributeMap = { name: { S: "Alice" } };
    const edited: AttributeMap = { name: { S: "Bob" } };
    const result = diffAttributeMaps(original, edited);
    expect(result.set).toEqual({ name: { S: "Bob" } });
    expect(result.remove).toEqual([]);
  });

  it("key deleted → remove has the key, set empty", () => {
    const original: AttributeMap = { name: { S: "Alice" }, age: { N: "30" } };
    const edited: AttributeMap = { name: { S: "Alice" } };
    const result = diffAttributeMaps(original, edited);
    expect(result.set).toEqual({});
    expect(result.remove).toEqual(["age"]);
  });

  it("new key added → set has the new key, remove empty", () => {
    const original: AttributeMap = { name: { S: "Alice" } };
    const edited: AttributeMap = { name: { S: "Alice" }, city: { S: "Santiago" } };
    const result = diffAttributeMaps(original, edited);
    expect(result.set).toEqual({ city: { S: "Santiago" } });
    expect(result.remove).toEqual([]);
  });

  it("SS reorder only → no change reported", () => {
    const original: AttributeMap = { tags: { SS: ["a", "b"] } };
    const edited: AttributeMap = { tags: { SS: ["b", "a"] } };
    const result = diffAttributeMaps(original, edited);
    expect(result.set).toEqual({});
    expect(result.remove).toEqual([]);
  });

  it("multiple changes mixed", () => {
    const original: AttributeMap = {
      keep: { S: "same" },
      change: { N: "1" },
      del: { BOOL: true },
    };
    const edited: AttributeMap = {
      keep: { S: "same" },
      change: { N: "2" },
      add: { NULL: true },
    };
    const result = diffAttributeMaps(original, edited);
    expect(result.set).toEqual({ change: { N: "2" }, add: { NULL: true } });
    expect(result.remove).toEqual(["del"]);
  });
});

// ---------------------------------------------------------------------------
// validateTaggedItem
// ---------------------------------------------------------------------------

describe("validateTaggedItem", () => {
  it("valid full item with every tag → null", () => {
    const item = {
      strAttr: { S: "hello" },
      numAttr: { N: "42" },
      boolAttr: { BOOL: true },
      nullAttr: { NULL: true },
      bAttr: { B: "YWJj" },
      lAttr: { L: [{ S: "a" }, { N: "1" }] },
      mAttr: { M: { nested: { S: "val" } } },
      ssAttr: { SS: ["x", "y"] },
      nsAttr: { NS: ["1", "2"] },
      bsAttr: { BS: ["YQ==", "Yg=="] },
    };
    expect(validateTaggedItem(item)).toBeNull();
  });

  it("bare scalar at top level → returns path", () => {
    const item = { status: "ok" };
    expect(validateTaggedItem(item)).toEqual({ path: "status" });
  });

  it("multi-key tag object → returns path", () => {
    const item = { status: { S: "ok", N: "5" } };
    expect(validateTaggedItem(item)).toEqual({ path: "status" });
  });

  it("unknown tag → returns path", () => {
    const item = { status: { Q: "ok" } };
    expect(validateTaggedItem(item)).toEqual({ path: "status" });
  });

  it("nested invalid in M value → returns dotted path", () => {
    const item = { meta: { M: { city: "Santiago" } } };
    expect(validateTaggedItem(item)).toEqual({ path: "meta.city" });
  });

  it("list with invalid element → returns path with index", () => {
    const item = { tags: { L: [{ S: "a" }, "raw"] } };
    expect(validateTaggedItem(item)).toEqual({ path: "tags[1]" });
  });

  it("non-object input → returns empty path", () => {
    expect(validateTaggedItem("not an object")).toEqual({ path: "" });
    expect(validateTaggedItem(null)).toEqual({ path: "" });
    expect(validateTaggedItem(42)).toEqual({ path: "" });
    expect(validateTaggedItem([])).toEqual({ path: "" });
  });

  it("empty item → null (no attributes to validate)", () => {
    expect(validateTaggedItem({})).toBeNull();
  });

  it("valid nested M with multiple levels → null", () => {
    const item = {
      address: {
        M: {
          street: { S: "Main St" },
          zip: { N: "10000" },
        },
      },
    };
    expect(validateTaggedItem(item)).toBeNull();
  });

  it("valid L containing L → null", () => {
    const item = {
      matrix: { L: [{ L: [{ N: "1" }, { N: "2" }] }, { L: [{ N: "3" }] }] },
    };
    expect(validateTaggedItem(item)).toBeNull();
  });
});
