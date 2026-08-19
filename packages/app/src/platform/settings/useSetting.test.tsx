import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSetting } from "./useSetting";

describe("useSetting — key changes within the same hook instance", () => {
  it("re-derives value from memory cache when the key changes between renders", () => {
    // Seed key A with a non-default value.
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useSetting<string>(key, "default"),
      { initialProps: { key: "useSetting:test:keyA" } },
    );
    expect(result.current[0]).toBe("default");
    act(() => result.current[1]("A-value"));
    expect(result.current[0]).toBe("A-value");

    // Same instance, new key with no cache → must drop back to default.
    rerender({ key: "useSetting:test:keyB" });
    expect(result.current[0]).toBe("default");

    // Switch back to A → cached value resurrects.
    rerender({ key: "useSetting:test:keyA" });
    expect(result.current[0]).toBe("A-value");
  });

  it("loaded stays true across key changes when memory has the new key (or non-Tauri)", () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useSetting<number>(key, 0),
      { initialProps: { key: "useSetting:test:loadedA" } },
    );
    expect(result.current[2]).toBe(true);

    rerender({ key: "useSetting:test:loadedB" });
    // jsdom is not a Tauri runtime → loaded short-circuits to true.
    expect(result.current[2]).toBe(true);
  });
});

describe("useSetting — live sync between simultaneously mounted hooks", () => {
  it("pushes a write to another mounted hook on the same key", () => {
    const a = renderHook(() => useSetting("sync.demo", 10000));
    const b = renderHook(() => useSetting("sync.demo", 10000));

    expect(a.result.current[0]).toBe(10000);
    expect(b.result.current[0]).toBe(10000);

    act(() => a.result.current[1](50000));

    // Without the subscriber registry this stayed at 10000: the memory cache
    // only helps a *newly* mounting hook, so a row-limit control in one query
    // tab would keep showing a stale value after another tab wrote a new one.
    expect(a.result.current[0]).toBe(50000);
    expect(b.result.current[0]).toBe(50000);
  });

  it("does not cross-talk between different keys", () => {
    const a = renderHook(() => useSetting("sync.one", 1));
    const b = renderHook(() => useSetting("sync.two", 2));

    act(() => a.result.current[1](99));

    expect(a.result.current[0]).toBe(99);
    expect(b.result.current[0]).toBe(2);
  });

  it("resolves the functional form against the latest cross-instance value", () => {
    const a = renderHook(() => useSetting("sync.fn", 0));
    const b = renderHook(() => useSetting("sync.fn", 0));

    act(() => a.result.current[1](5));
    act(() => b.result.current[1]((prev) => prev + 1));

    expect(a.result.current[0]).toBe(6);
    expect(b.result.current[0]).toBe(6);
  });

  it("stops receiving updates after unmount", () => {
    const a = renderHook(() => useSetting("sync.unmount", 0));
    const b = renderHook(() => useSetting("sync.unmount", 0));

    b.unmount();
    expect(() => act(() => a.result.current[1](7))).not.toThrow();
    expect(a.result.current[0]).toBe(7);
  });
});
