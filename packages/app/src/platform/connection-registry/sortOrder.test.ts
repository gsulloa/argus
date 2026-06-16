import { describe, expect, it } from "vitest";
import { computeMidpointSortOrder } from "./sortOrder";

describe("computeMidpointSortOrder", () => {
  it("returns the step value when both neighbors are absent", () => {
    expect(computeMidpointSortOrder()).toBe(1.0);
  });

  it("places before the next neighbor when prev is absent", () => {
    expect(computeMidpointSortOrder(undefined, 5)).toBe(4.0);
  });

  it("places after the prev neighbor when next is absent", () => {
    expect(computeMidpointSortOrder(2)).toBe(3.0);
  });

  it("returns the midpoint when both neighbors are present", () => {
    expect(computeMidpointSortOrder(1, 2)).toBe(1.5);
    expect(computeMidpointSortOrder(0, 10)).toBe(5);
    expect(computeMidpointSortOrder(-1, 1)).toBe(0);
  });

  it("supports many consecutive in-between inserts without becoming equal", () => {
    let prev = 0;
    let next = 1;
    for (let i = 0; i < 30; i++) {
      const mid = computeMidpointSortOrder(prev, next);
      expect(mid).toBeGreaterThan(prev);
      expect(mid).toBeLessThan(next);
      next = mid;
    }
  });
});
