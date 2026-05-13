/**
 * useUnsavedDraft.test.tsx — task 11.4
 *
 * Unit tests for the three-source dirty aggregator.
 */

import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useUnsavedDraft } from "./useUnsavedDraft";

describe("useUnsavedDraft — initial state", () => {
  it("all sources false → hasUnsavedDraft is false", () => {
    const { result } = renderHook(() => useUnsavedDraft());
    expect(result.current.hasUnsavedDraft).toBe(false);
  });
});

describe("useUnsavedDraft — inline cell source", () => {
  it("setting inlineCellDirty true → hasUnsavedDraft becomes true", () => {
    const { result } = renderHook(() => useUnsavedDraft());

    act(() => {
      result.current.setInlineCellDirty(true);
    });

    expect(result.current.hasUnsavedDraft).toBe(true);
  });

  it("setting inlineCellDirty back false → hasUnsavedDraft becomes false", () => {
    const { result } = renderHook(() => useUnsavedDraft());

    act(() => result.current.setInlineCellDirty(true));
    act(() => result.current.setInlineCellDirty(false));

    expect(result.current.hasUnsavedDraft).toBe(false);
  });
});

describe("useUnsavedDraft — inspector source", () => {
  it("setting inspectorDirty true → hasUnsavedDraft becomes true", () => {
    const { result } = renderHook(() => useUnsavedDraft());

    act(() => {
      result.current.setInspectorDirty(true);
    });

    expect(result.current.hasUnsavedDraft).toBe(true);
  });

  it("setting inspectorDirty back false → hasUnsavedDraft becomes false", () => {
    const { result } = renderHook(() => useUnsavedDraft());

    act(() => result.current.setInspectorDirty(true));
    act(() => result.current.setInspectorDirty(false));

    expect(result.current.hasUnsavedDraft).toBe(false);
  });
});

describe("useUnsavedDraft — insert modal source", () => {
  it("setting insertModalDirty true → hasUnsavedDraft becomes true", () => {
    const { result } = renderHook(() => useUnsavedDraft());

    act(() => {
      result.current.setInsertModalDirty(true);
    });

    expect(result.current.hasUnsavedDraft).toBe(true);
  });

  it("setting insertModalDirty back false → hasUnsavedDraft becomes false", () => {
    const { result } = renderHook(() => useUnsavedDraft());

    act(() => result.current.setInsertModalDirty(true));
    act(() => result.current.setInsertModalDirty(false));

    expect(result.current.hasUnsavedDraft).toBe(false);
  });
});

describe("useUnsavedDraft — multiple sources", () => {
  it("two sources dirty → hasUnsavedDraft true; clearing one still true", () => {
    const { result } = renderHook(() => useUnsavedDraft());

    act(() => {
      result.current.setInspectorDirty(true);
      result.current.setInsertModalDirty(true);
    });

    expect(result.current.hasUnsavedDraft).toBe(true);

    act(() => result.current.setInspectorDirty(false));
    expect(result.current.hasUnsavedDraft).toBe(true); // insertModal still dirty

    act(() => result.current.setInsertModalDirty(false));
    expect(result.current.hasUnsavedDraft).toBe(false);
  });
});
