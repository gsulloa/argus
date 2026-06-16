import { describe, expect, it, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useExpandedGroups } from "./useExpandedGroups";

describe("useExpandedGroups", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults groups to expanded when localStorage has no entry", () => {
    const { result } = renderHook(() => useExpandedGroups(["a", "b"]));
    expect(result.current.isExpanded("a")).toBe(true);
    expect(result.current.isExpanded("b")).toBe(true);
  });

  it("reads collapsed state from localStorage", () => {
    window.localStorage.setItem("connection-groups.expanded.a", "0");
    const { result } = renderHook(() => useExpandedGroups(["a"]));
    expect(result.current.isExpanded("a")).toBe(false);
  });

  it("toggling persists to localStorage", () => {
    const { result } = renderHook(() => useExpandedGroups(["a"]));
    act(() => result.current.toggle("a"));
    expect(result.current.isExpanded("a")).toBe(false);
    expect(window.localStorage.getItem("connection-groups.expanded.a")).toBe("0");

    act(() => result.current.toggle("a"));
    expect(result.current.isExpanded("a")).toBe(true);
    expect(window.localStorage.getItem("connection-groups.expanded.a")).toBe("1");
  });

  it("setExpanded persists explicit state", () => {
    const { result } = renderHook(() => useExpandedGroups(["a"]));
    act(() => result.current.setExpanded("a", false));
    expect(result.current.isExpanded("a")).toBe(false);
    expect(window.localStorage.getItem("connection-groups.expanded.a")).toBe("0");
  });

  it("each group's state is independent", () => {
    window.localStorage.setItem("connection-groups.expanded.a", "0");
    const { result } = renderHook(() => useExpandedGroups(["a", "b"]));
    expect(result.current.isExpanded("a")).toBe(false);
    expect(result.current.isExpanded("b")).toBe(true);
  });
});
