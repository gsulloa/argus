import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { normalizePersistedFilter, useTableFilter } from "./useTableFilter";
import { EMPTY_FILTER_MODEL, type FilterModel } from "./types";

// A valid new-shape filter with one condition row.
const filterNewShape: FilterModel = {
  rows: [
    {
      enabled: true,
      column: { kind: "named", name: "country" },
      op: "=",
      value: "CL",
    },
  ],
  combinator: "AND",
};

// Another valid new-shape filter for independence tests.
const filterNewShapeB: FilterModel = {
  rows: [
    {
      enabled: false,
      column: { kind: "named", name: "status" },
      op: "ILIKE",
      value: "ok",
    },
  ],
  combinator: "OR",
};

// ---------------------------------------------------------------------------
// normalizePersistedFilter — shape validation and migration
// ---------------------------------------------------------------------------

describe("normalizePersistedFilter", () => {
  it("passes through a valid new-shape PersistedFilter unchanged", () => {
    const result = normalizePersistedFilter({
      draft: filterNewShape,
      applied: EMPTY_FILTER_MODEL,
    });
    expect(result.draft).toEqual(filterNewShape);
    expect(result.applied).toEqual(EMPTY_FILTER_MODEL);
  });

  it("returns DEFAULT for null input", () => {
    const result = normalizePersistedFilter(null);
    expect(result.draft).toEqual(EMPTY_FILTER_MODEL);
    expect(result.applied).toEqual(EMPTY_FILTER_MODEL);
  });

  it("returns DEFAULT for non-object input", () => {
    expect(normalizePersistedFilter("bad")).toEqual({
      draft: EMPTY_FILTER_MODEL,
      applied: EMPTY_FILTER_MODEL,
    });
  });

  it("migrates legacy { mode: 'raw', raw: '...' } draft → EMPTY_FILTER_MODEL", () => {
    const legacyRaw = {
      draft: { mode: "raw", tree: { children: [] }, raw: "id > 10" },
      applied: { mode: "raw", tree: { children: [] }, raw: "id > 10" },
    };
    const result = normalizePersistedFilter(legacyRaw);
    expect(result.draft).toEqual(EMPTY_FILTER_MODEL);
    expect(result.applied).toEqual(EMPTY_FILTER_MODEL);
  });

  it("migrates legacy tree with or_group child → EMPTY_FILTER_MODEL", () => {
    const legacyOrGroup = {
      draft: {
        mode: "structured",
        tree: {
          children: [
            {
              kind: "or_group",
              children: [{ kind: "condition", column: { kind: "named", name: "x" }, op: "=", value: "1" }],
            },
          ],
        },
        raw: "",
      },
      applied: EMPTY_FILTER_MODEL,
    };
    const result = normalizePersistedFilter(legacyOrGroup);
    expect(result.draft).toEqual(EMPTY_FILTER_MODEL);
  });

  it("backfills missing combinator to AND on valid new-shape rows", () => {
    const partial = {
      draft: { rows: [], /* no combinator */ },
      applied: { rows: [], /* no combinator */ },
    };
    const result = normalizePersistedFilter(partial);
    expect(result.draft.combinator).toBe("AND");
    expect(result.applied.combinator).toBe("AND");
  });
});

// ---------------------------------------------------------------------------
// useTableFilter — hook behaviour
// ---------------------------------------------------------------------------

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

  it("setDraft updates draft only; applied unchanged", () => {
    const { result } = renderHook(() =>
      useTableFilter("conn-1", "public", "users-setdraft"),
    );
    act(() => result.current.setDraft(filterNewShape));
    expect(result.current.draft).toEqual(filterNewShape);
    expect(result.current.applied).toEqual(EMPTY_FILTER_MODEL);
  });

  it("setApplied updates applied only; draft unchanged", () => {
    const { result } = renderHook(() =>
      useTableFilter("conn-1", "public", "users-setapplied"),
    );
    act(() => result.current.setApplied(filterNewShape));
    expect(result.current.applied).toEqual(filterNewShape);
    expect(result.current.draft).toEqual(EMPTY_FILTER_MODEL);
  });

  it("resetFilter clears both draft and applied to EMPTY_FILTER_MODEL", () => {
    const { result } = renderHook(() =>
      useTableFilter("conn-1", "public", "users-reset"),
    );
    act(() => result.current.setApplied(filterNewShape));
    act(() => result.current.setDraft(filterNewShapeB));
    expect(result.current.applied).toEqual(filterNewShape);
    expect(result.current.draft).toEqual(filterNewShapeB);
    act(() => result.current.reset());
    expect(result.current.applied).toEqual(EMPTY_FILTER_MODEL);
    expect(result.current.draft).toEqual(EMPTY_FILTER_MODEL);
  });

  it("persisted EMPTY_FILTER_MODEL-shaped value loads cleanly", () => {
    // useSetting in non-Tauri mode is synchronous; in-memory cache is pre-set.
    const { result } = renderHook(() =>
      useTableFilter("conn-1", "public", "users-persist-empty"),
    );
    expect(result.current.draft).toEqual(EMPTY_FILTER_MODEL);
    expect(result.current.applied).toEqual(EMPTY_FILTER_MODEL);
  });

  it("persisted applied is restored on remount (same key)", () => {
    const args = ["conn-1", "public", "users-remount"] as const;
    const { result, unmount } = renderHook(() => useTableFilter(...args));
    act(() => result.current.setApplied(filterNewShape));
    expect(result.current.applied).toEqual(filterNewShape);
    unmount();
    const { result: result2 } = renderHook(() => useTableFilter(...args));
    expect(result2.current.applied).toEqual(filterNewShape);
    expect(result2.current.draft).toEqual(EMPTY_FILTER_MODEL);
  });

  it("scopes per (connectionId, schema, relation)", () => {
    const { result: a } = renderHook(() =>
      useTableFilter("conn-scope-A", "public", "shared-name"),
    );
    const { result: b } = renderHook(() =>
      useTableFilter("conn-scope-B", "public", "shared-name"),
    );
    act(() => a.current.setApplied(filterNewShape));
    expect(a.current.applied).toEqual(filterNewShape);
    expect(b.current.applied).toEqual(EMPTY_FILTER_MODEL);
  });

  it("reflects the new relation's persisted state when the SAME instance re-renders with a different relation", () => {
    const { result, rerender } = renderHook(
      ({ relation }: { relation: string }) =>
        useTableFilter("conn-bleed", "public", relation),
      { initialProps: { relation: "rel-A-bleed" } },
    );

    act(() => result.current.setApplied(filterNewShape));
    expect(result.current.applied).toEqual(filterNewShape);

    rerender({ relation: "rel-B-bleed" });
    expect(result.current.applied).toEqual(EMPTY_FILTER_MODEL);
    expect(result.current.draft).toEqual(EMPTY_FILTER_MODEL);

    rerender({ relation: "rel-A-bleed" });
    expect(result.current.applied).toEqual(filterNewShape);
  });
});
