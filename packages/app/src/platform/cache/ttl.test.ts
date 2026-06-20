import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_CACHE_TTL_MS, isStale } from "./ttl";

describe("isStale", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats a missing timestamp as stale", () => {
    expect(isStale(undefined)).toBe(true);
  });

  it("treats a just-now timestamp as fresh", () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(isStale(now)).toBe(false);
  });

  it("treats a timestamp older than the TTL as stale", () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(isStale(now - 2 * SCHEMA_CACHE_TTL_MS)).toBe(true);
  });

  it("respects a custom ttl", () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(isStale(now - 500, 1000)).toBe(false);
    expect(isStale(now - 1500, 1000)).toBe(true);
  });
});
