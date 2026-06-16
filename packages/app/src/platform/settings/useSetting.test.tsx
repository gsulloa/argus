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
