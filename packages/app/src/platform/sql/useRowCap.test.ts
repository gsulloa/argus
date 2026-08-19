import { describe, expect, it } from "vitest";
import { clampRowCap, formatRowCapShort, HARD_ROW_CAP } from "./useRowCap";

describe("clampRowCap", () => {
  it("rejects 0 (below the [1, HARD_ROW_CAP] range)", () => {
    expect(clampRowCap(0)).toBeNull();
  });

  it("accepts 1 (lower bound)", () => {
    expect(clampRowCap(1)).toBe(1);
  });

  it("accepts HARD_ROW_CAP (upper bound)", () => {
    expect(clampRowCap(HARD_ROW_CAP)).toBe(HARD_ROW_CAP);
    expect(clampRowCap(1_000_000)).toBe(1_000_000);
  });

  it("rejects HARD_ROW_CAP + 1", () => {
    expect(clampRowCap(1_000_001)).toBeNull();
  });

  it("rejects a non-integer", () => {
    expect(clampRowCap(1.5)).toBeNull();
  });

  it("rejects NaN", () => {
    expect(clampRowCap(NaN)).toBeNull();
  });

  it("rejects a non-numeric value passed via an unknown cast", () => {
    expect(clampRowCap("abc" as unknown as number)).toBeNull();
  });
});

describe("formatRowCapShort", () => {
  it("formats 1000 as 1k", () => {
    expect(formatRowCapShort(1000)).toBe("1k");
  });

  it("formats 10000 as 10k", () => {
    expect(formatRowCapShort(10000)).toBe("10k");
  });

  it("formats 50000 as 50k", () => {
    expect(formatRowCapShort(50000)).toBe("50k");
  });

  it("formats 1000000 as 1M", () => {
    expect(formatRowCapShort(1000000)).toBe("1M");
  });

  it("falls back to a thousands-separated literal for non-round values", () => {
    expect(formatRowCapShort(12345)).toBe("12,345");
  });
});
