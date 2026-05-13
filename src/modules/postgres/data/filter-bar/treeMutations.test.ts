import { describe, it, expect } from "vitest";
import {
  emptyTree,
  addRootCondition,
  addRootOrGroup,
  removeRootChild,
  setRootChild,
  addOrChildCondition,
  setOrChild,
  removeOrChild,
  setRootCombinator,
  emptyCondition,
} from "./treeMutations";
import { getRootCombinator } from "../types";
import type { FilterTree } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function treeWithCombinator(combinator: "AND" | "OR"): FilterTree {
  return {
    children: [
      { kind: "condition", column: { kind: "named", name: "a" }, op: "=", value: "1" },
    ],
    combinator,
  };
}

function treeWithOrGroup(combinator: "AND" | "OR" = "AND"): FilterTree {
  return {
    children: [
      {
        kind: "or_group",
        children: [
          { kind: "condition", column: { kind: "named", name: "b" }, op: "=", value: "2" },
          { kind: "condition", column: { kind: "named", name: "c" }, op: "=", value: "3" },
        ],
      },
    ],
    combinator,
  };
}

// ---------------------------------------------------------------------------
// emptyTree
// ---------------------------------------------------------------------------

describe("emptyTree", () => {
  it("returns an empty tree with combinator AND", () => {
    const t = emptyTree();
    expect(t.children).toHaveLength(0);
    expect(t.combinator).toBe("AND");
  });
});

// ---------------------------------------------------------------------------
// setRootCombinator
// ---------------------------------------------------------------------------

describe("setRootCombinator", () => {
  it("sets combinator to OR", () => {
    const t = emptyTree();
    const next = setRootCombinator(t, "OR");
    expect(next.combinator).toBe("OR");
  });

  it("sets combinator to AND", () => {
    const t = treeWithCombinator("OR");
    const next = setRootCombinator(t, "AND");
    expect(next.combinator).toBe("AND");
  });

  it("preserves all children", () => {
    const t = treeWithCombinator("AND");
    const next = setRootCombinator(t, "OR");
    expect(next.children).toEqual(t.children);
  });

  it("round-trips: AND → OR → AND", () => {
    const t = emptyTree();
    const or = setRootCombinator(t, "OR");
    const and = setRootCombinator(or, "AND");
    expect(and.combinator).toBe("AND");
  });
});

// ---------------------------------------------------------------------------
// getRootCombinator — coerces undefined to AND
// ---------------------------------------------------------------------------

describe("getRootCombinator", () => {
  it("returns AND when combinator is explicitly AND", () => {
    expect(getRootCombinator({ children: [], combinator: "AND" })).toBe("AND");
  });

  it("returns OR when combinator is explicitly OR", () => {
    expect(getRootCombinator({ children: [], combinator: "OR" })).toBe("OR");
  });

  it("returns AND when combinator is absent (backward-compat)", () => {
    // Cast to bypass the optional-but-now-present type
    const t = { children: [] } as FilterTree;
    expect(getRootCombinator(t)).toBe("AND");
  });
});

// ---------------------------------------------------------------------------
// addRootCondition — preserves combinator
// ---------------------------------------------------------------------------

describe("addRootCondition", () => {
  it("preserves AND combinator", () => {
    const t = treeWithCombinator("AND");
    const next = addRootCondition(t);
    expect(next.combinator).toBe("AND");
    expect(next.children).toHaveLength(2);
  });

  it("preserves OR combinator", () => {
    const t = treeWithCombinator("OR");
    const next = addRootCondition(t);
    expect(next.combinator).toBe("OR");
  });

  it("defaults missing combinator to AND on the result", () => {
    const t: FilterTree = { children: [] };
    const next = addRootCondition(t);
    expect(next.combinator).toBe("AND");
  });
});

// ---------------------------------------------------------------------------
// addRootOrGroup — preserves combinator
// ---------------------------------------------------------------------------

describe("addRootOrGroup", () => {
  it("preserves OR combinator", () => {
    const t = treeWithCombinator("OR");
    const next = addRootOrGroup(t);
    expect(next.combinator).toBe("OR");
  });
});

// ---------------------------------------------------------------------------
// removeRootChild — preserves combinator
// ---------------------------------------------------------------------------

describe("removeRootChild", () => {
  it("preserves combinator after removal", () => {
    const t = treeWithCombinator("OR");
    const next = removeRootChild(t, 0);
    expect(next.combinator).toBe("OR");
    expect(next.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// setRootChild — preserves combinator
// ---------------------------------------------------------------------------

describe("setRootChild", () => {
  it("preserves combinator after setting a child", () => {
    const t = treeWithCombinator("OR");
    const node = { kind: "condition" as const, column: { kind: "named" as const, name: "x" }, op: "=" as const, value: "y" };
    const next = setRootChild(t, 0, node);
    expect(next.combinator).toBe("OR");
  });
});

// ---------------------------------------------------------------------------
// addOrChildCondition — preserves combinator
// ---------------------------------------------------------------------------

describe("addOrChildCondition", () => {
  it("preserves OR combinator when adding a child to an or_group", () => {
    const t = treeWithOrGroup("OR");
    const next = addOrChildCondition(t, 0, emptyCondition());
    expect(next.combinator).toBe("OR");
    const group = next.children[0];
    expect(group?.kind).toBe("or_group");
    if (group?.kind === "or_group") {
      expect(group.children).toHaveLength(3);
    }
  });
});

// ---------------------------------------------------------------------------
// setOrChild — preserves combinator
// ---------------------------------------------------------------------------

describe("setOrChild", () => {
  it("preserves combinator when setting a child inside an or_group", () => {
    const t = treeWithOrGroup("OR");
    const node = { kind: "condition" as const, column: { kind: "named" as const, name: "z" }, op: "=" as const, value: "0" };
    const next = setOrChild(t, 0, 0, node);
    expect(next.combinator).toBe("OR");
  });
});

// ---------------------------------------------------------------------------
// removeOrChild — preserves combinator; collapses empty group
// ---------------------------------------------------------------------------

describe("removeOrChild", () => {
  it("preserves OR combinator when removing a child (group has remaining children)", () => {
    const t = treeWithOrGroup("OR");
    const next = removeOrChild(t, 0, 0);
    expect(next.combinator).toBe("OR");
    const group = next.children[0];
    expect(group?.kind).toBe("or_group");
  });

  it("preserves OR combinator when group collapses to empty", () => {
    const t: FilterTree = {
      children: [
        {
          kind: "or_group",
          children: [
            { kind: "condition", column: { kind: "named", name: "a" }, op: "=", value: "1" },
          ],
        },
      ],
      combinator: "OR",
    };
    const next = removeOrChild(t, 0, 0);
    expect(next.combinator).toBe("OR");
    expect(next.children).toHaveLength(0);
  });
});
