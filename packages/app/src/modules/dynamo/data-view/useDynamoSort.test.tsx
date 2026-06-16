/**
 * useDynamoSort.test.tsx
 *
 * Covers:
 *   - Default returns []
 *   - Persistence round-trip per (connectionId, tableName)
 *   - Isolation between two tables on the same connection
 *   - setSorting accepts both a value and an updater fn
 */

import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDynamoSort } from "./useDynamoSort";
import type { SortingState } from "@tanstack/react-table";

describe("useDynamoSort", () => {
  it("returns empty array by default", () => {
    const { result } = renderHook(() => useDynamoSort("conn1", "MyTable"));
    expect(result.current.sorting).toEqual([]);
  });

  it("setSorting accepts a direct value", () => {
    const { result } = renderHook(() => useDynamoSort("conn2", "TableA"));

    act(() => {
      result.current.setSorting([{ id: "quantity", desc: false }]);
    });

    expect(result.current.sorting).toEqual([{ id: "quantity", desc: false }]);
  });

  it("setSorting accepts an updater function", () => {
    const { result } = renderHook(() => useDynamoSort("conn3", "TableB"));

    act(() => {
      result.current.setSorting([{ id: "status", desc: false }]);
    });

    act(() => {
      result.current.setSorting((prev: SortingState) => [
        ...prev,
        { id: "quantity", desc: true },
      ]);
    });

    expect(result.current.sorting).toEqual([
      { id: "status", desc: false },
      { id: "quantity", desc: true },
    ]);
  });

  it("persists state within the same hook instance", () => {
    const { result } = renderHook(() => useDynamoSort("conn4", "OrdersTable"));

    act(() => {
      result.current.setSorting([{ id: "quantity", desc: true }]);
    });

    expect(result.current.sorting).toEqual([{ id: "quantity", desc: true }]);
  });

  it("isolates state between two different tables on the same connection", () => {
    const { result: resultA } = renderHook(() => useDynamoSort("conn5", "OrdersTable"));
    const { result: resultB } = renderHook(() => useDynamoSort("conn5", "UsersTable"));

    act(() => {
      resultA.current.setSorting([{ id: "quantity", desc: true }]);
    });

    // UsersTable should still be empty
    expect(resultB.current.sorting).toEqual([]);
  });

  it("isolates state between the same table on different connections", () => {
    const { result: resultA } = renderHook(() => useDynamoSort("connA", "OrdersTable"));
    const { result: resultB } = renderHook(() => useDynamoSort("connB", "OrdersTable"));

    act(() => {
      resultA.current.setSorting([{ id: "quantity", desc: true }]);
    });

    expect(resultB.current.sorting).toEqual([]);
  });
});
