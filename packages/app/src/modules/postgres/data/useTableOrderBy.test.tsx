import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTableOrderBy } from "./useTableOrderBy";
import type { OrderBy } from "./types";

const orderA: OrderBy[] = [{ column: "created_at", direction: "desc" }];

describe("useTableOrderBy", () => {
  it("reports null when no order has ever been persisted (unset, not empty)", () => {
    const { result } = renderHook(() =>
      useTableOrderBy("conn-1", "public", "users-default"),
    );
    // null lets the caller distinguish "unset" (apply the PK default) from a
    // user-chosen empty order.
    expect(result.current.persistedOrderBy).toBeNull();
    expect(result.current.isLoaded).toBe(true);
  });

  it("persists an explicit empty order distinctly from unset", () => {
    const args = ["conn-1", "public", "users-empty"] as const;
    const { result, unmount } = renderHook(() => useTableOrderBy(...args));
    act(() => result.current.setOrderBy([]));
    expect(result.current.persistedOrderBy).toEqual([]);
    unmount();
    const { result: result2 } = renderHook(() => useTableOrderBy(...args));
    // Reloads as [] (persisted), NOT null — so the default is not re-applied.
    expect(result2.current.persistedOrderBy).toEqual([]);
  });

  it("round-trips a single descending sort across mounts", () => {
    const args = ["conn-1", "public", "users-rt"] as const;
    const { result, unmount } = renderHook(() => useTableOrderBy(...args));
    act(() => result.current.setOrderBy(orderA));
    expect(result.current.persistedOrderBy).toEqual(orderA);
    unmount();
    const { result: result2 } = renderHook(() => useTableOrderBy(...args));
    expect(result2.current.persistedOrderBy).toEqual(orderA);
  });

  it("scopes per (connectionId, schema, relation)", () => {
    const { result: a } = renderHook(() =>
      useTableOrderBy("conn-A", "public", "shared"),
    );
    const { result: b } = renderHook(() =>
      useTableOrderBy("conn-B", "public", "shared"),
    );
    act(() => a.current.setOrderBy(orderA));
    expect(a.current.persistedOrderBy).toEqual(orderA);
    expect(b.current.persistedOrderBy).toBeNull();
  });
});
