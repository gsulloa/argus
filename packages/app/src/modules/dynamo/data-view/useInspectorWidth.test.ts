/**
 * useDynamoInspectorWidth unit tests.
 *
 * Covers:
 *   - Default width applied on first mount
 *   - setWidth clamps to [MIN, MAX]
 *   - Distinct keys for distinct tables
 */

import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDynamoInspectorWidth } from "./useInspectorWidth";

// useSetting reads from Tauri's store when in Tauri runtime. In jsdom (tests)
// isTauriRuntime() returns false, so settings start from defaultValue.

describe("useDynamoInspectorWidth", () => {
  it("returns default width on first mount", () => {
    const { result } = renderHook(() =>
      useDynamoInspectorWidth("conn-1", "table-a"),
    );
    expect(result.current.width).toBe(320);
  });

  it("clamps to MIN width", () => {
    const { result } = renderHook(() =>
      useDynamoInspectorWidth("conn-1", "table-b"),
    );
    act(() => {
      result.current.setWidth(10);
    });
    expect(result.current.width).toBe(result.current.min);
  });

  it("clamps to MAX width", () => {
    const { result } = renderHook(() =>
      useDynamoInspectorWidth("conn-1", "table-c"),
    );
    act(() => {
      result.current.setWidth(9999);
    });
    expect(result.current.width).toBe(result.current.max);
  });

  it("exposes min and max constants", () => {
    const { result } = renderHook(() =>
      useDynamoInspectorWidth("conn-1", "table-d"),
    );
    expect(result.current.min).toBeLessThan(result.current.max);
    expect(result.current.min).toBeGreaterThan(0);
  });

  it("uses distinct per-table storage keys (no bleed between tables)", () => {
    const hookA = renderHook(() =>
      useDynamoInspectorWidth("conn-1", "table-x"),
    );
    const hookB = renderHook(() =>
      useDynamoInspectorWidth("conn-1", "table-y"),
    );

    act(() => {
      hookA.result.current.setWidth(400);
    });

    // hookB should NOT be affected by hookA's change.
    expect(hookB.result.current.width).toBe(320);
  });
});
