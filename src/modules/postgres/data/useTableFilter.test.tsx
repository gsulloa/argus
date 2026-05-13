import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { normalizePersistedFilter, useTableFilter } from "./useTableFilter";
import { EMPTY_FILTER_MODEL, type FilterModel } from "./types";

const filterA: FilterModel = {
  mode: "structured",
  tree: {
    children: [
      {
        kind: "condition",
        column: { kind: "named", name: "country" },
        op: "=",
        value: "CL",
      },
    ],
    combinator: "AND",
  },
  raw: "",
};

const filterB: FilterModel = {
  mode: "raw",
  tree: { children: [], combinator: "AND" },
  raw: "id > 10",
};

// ---------------------------------------------------------------------------
// normalizePersistedFilter — backward-compat coercion
// ---------------------------------------------------------------------------

describe("normalizePersistedFilter", () => {
  it("coerces missing combinator to AND on both trees", () => {
    // Simulate a legacy persisted record without the combinator field.
    const legacy = {
      draft: {
        mode: "structured" as const,
        tree: { children: [] }, // no combinator field
        raw: "",
      },
      applied: {
        mode: "structured" as const,
        tree: {
          children: [
            {
              kind: "condition" as const,
              column: { kind: "named" as const, name: "x" },
              op: "=" as const,
              value: "1",
            },
          ],
          // no combinator field
        },
        raw: "",
      },
    };
    const normalized = normalizePersistedFilter(legacy);
    expect(normalized.draft.tree.combinator).toBe("AND");
    expect(normalized.applied.tree.combinator).toBe("AND");
  });

  it("preserves an explicitly set combinator", () => {
    const record = {
      draft: {
        mode: "structured" as const,
        tree: { children: [], combinator: "OR" as const },
        raw: "",
      },
      applied: {
        mode: "structured" as const,
        tree: { children: [], combinator: "AND" as const },
        raw: "",
      },
    };
    const normalized = normalizePersistedFilter(record);
    expect(normalized.draft.tree.combinator).toBe("OR");
    expect(normalized.applied.tree.combinator).toBe("AND");
  });
});

describe("useTableFilter", () => {
  it("starts at EMPTY_FILTER_MODEL when nothing is persisted", () => {
    const { result } = renderHook(() =>
      useTableFilter("conn-1", "public", "users-default"),
    );
    expect(result.current.draft).toEqual(EMPTY_FILTER_MODEL);
    expect(result.current.applied).toEqual(EMPTY_FILTER_MODEL);
  });

  it("isLoaded is true after first render in non-Tauri runtimes", () => {
    const { result } = renderHook(() =>
      useTableFilter("conn-1", "public", "users-isloaded"),
    );
    expect(result.current.isLoaded).toBe(true);
  });

  it("persists applied through unmount → remount on the same key", () => {
    const args = ["conn-1", "public", "users-applied"] as const;
    const { result, unmount } = renderHook(() => useTableFilter(...args));
    act(() => result.current.setApplied(filterA));
    expect(result.current.applied).toEqual(filterA);
    expect(result.current.draft).toEqual(EMPTY_FILTER_MODEL);
    unmount();
    const { result: result2 } = renderHook(() => useTableFilter(...args));
    expect(result2.current.applied).toEqual(filterA);
    // Draft is independently persisted; unchanged here.
    expect(result2.current.draft).toEqual(EMPTY_FILTER_MODEL);
  });

  it("persists draft independently of applied", () => {
    const args = ["conn-1", "public", "users-draft"] as const;
    const { result, unmount } = renderHook(() => useTableFilter(...args));
    act(() => result.current.setDraft(filterB));
    expect(result.current.draft).toEqual(filterB);
    expect(result.current.applied).toEqual(EMPTY_FILTER_MODEL);
    unmount();
    const { result: result2 } = renderHook(() => useTableFilter(...args));
    expect(result2.current.draft).toEqual(filterB);
    expect(result2.current.applied).toEqual(EMPTY_FILTER_MODEL);
  });

  it("reset() returns both halves to the empty model", () => {
    const args = ["conn-1", "public", "users-reset"] as const;
    const { result } = renderHook(() => useTableFilter(...args));
    act(() => result.current.setApplied(filterA));
    act(() => result.current.setDraft(filterA));
    expect(result.current.applied).toEqual(filterA);
    expect(result.current.draft).toEqual(filterA);
    act(() => result.current.reset());
    expect(result.current.applied).toEqual(EMPTY_FILTER_MODEL);
    expect(result.current.draft).toEqual(EMPTY_FILTER_MODEL);
  });

  it("scopes per (connectionId, schema, relation)", () => {
    const { result: a } = renderHook(() =>
      useTableFilter("conn-A", "public", "shared-name"),
    );
    const { result: b } = renderHook(() =>
      useTableFilter("conn-B", "public", "shared-name"),
    );
    act(() => a.current.setApplied(filterA));
    expect(a.current.applied).toEqual(filterA);
    expect(b.current.applied).toEqual(EMPTY_FILTER_MODEL);
  });

  it("reflects the new relation's persisted state when the SAME instance re-renders with a different relation", () => {
    // Mirrors the TabContent reuse-across-tabs path: TableViewerTab is the
    // same React instance, but `relation` flips between renders.
    const { result, rerender } = renderHook(
      ({ relation }: { relation: string }) =>
        useTableFilter("conn-1", "public", relation),
      { initialProps: { relation: "rel-A-bleed" } },
    );

    act(() => result.current.setApplied(filterA));
    expect(result.current.applied).toEqual(filterA);

    rerender({ relation: "rel-B-bleed" });
    // Relation B has nothing persisted → must NOT show A's filter.
    expect(result.current.applied).toEqual(EMPTY_FILTER_MODEL);
    expect(result.current.draft).toEqual(EMPTY_FILTER_MODEL);

    rerender({ relation: "rel-A-bleed" });
    // Returning to A → cached filter resurrects.
    expect(result.current.applied).toEqual(filterA);
  });
});
