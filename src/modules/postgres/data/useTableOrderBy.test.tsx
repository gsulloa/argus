import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTableOrderBy } from "./useTableOrderBy";
import type { OrderBy } from "./types";

const orderA: OrderBy[] = [{ column: "created_at", direction: "desc" }];

describe("useTableOrderBy", () => {
  it("defaults to []", () => {
    const { result } = renderHook(() =>
      useTableOrderBy("conn-1", "public", "users-default"),
    );
    expect(result.current.orderBy).toEqual([]);
    expect(result.current.isLoaded).toBe(true);
  });

  it("round-trips a single descending sort across mounts", () => {
    const args = ["conn-1", "public", "users-rt"] as const;
    const { result, unmount } = renderHook(() => useTableOrderBy(...args));
    act(() => result.current.setOrderBy(orderA));
    expect(result.current.orderBy).toEqual(orderA);
    unmount();
    const { result: result2 } = renderHook(() => useTableOrderBy(...args));
    expect(result2.current.orderBy).toEqual(orderA);
  });

  it("scopes per (connectionId, schema, relation)", () => {
    const { result: a } = renderHook(() =>
      useTableOrderBy("conn-A", "public", "shared"),
    );
    const { result: b } = renderHook(() =>
      useTableOrderBy("conn-B", "public", "shared"),
    );
    act(() => a.current.setOrderBy(orderA));
    expect(a.current.orderBy).toEqual(orderA);
    expect(b.current.orderBy).toEqual([]);
  });
});
