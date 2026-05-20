import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HEADER_FONT,
  _clearHeaderMeasureCache,
  headerFloorWidthFor,
  measureHeaderTextWidth,
} from "./headerMeasure";
import { KEY_BADGE_PAD } from "@/platform/table/columnWidths";

// Deterministic 7px-per-character canvas stub.
const measureText = vi.fn((s: string) => ({ width: s.length * 7 }));
const originalGetContext = HTMLCanvasElement.prototype.getContext;

beforeEach(() => {
  _clearHeaderMeasureCache();
  measureText.mockClear();
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    font: "",
    measureText,
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});

describe("measureHeaderTextWidth", () => {
  it("returns the canvas-measured width", () => {
    expect(measureHeaderTextWidth("abc", HEADER_FONT)).toBe(21);
  });

  it("memoizes by `${font}|${name}`", () => {
    measureHeaderTextWidth("abc", HEADER_FONT);
    measureHeaderTextWidth("abc", HEADER_FONT);
    measureHeaderTextWidth("abc", HEADER_FONT);
    expect(measureText).toHaveBeenCalledTimes(1);
  });

  it("treats different fonts as different cache keys", () => {
    measureHeaderTextWidth("abc", HEADER_FONT);
    measureHeaderTextWidth("abc", "12px Arial");
    expect(measureText).toHaveBeenCalledTimes(2);
  });
});

describe("headerFloorWidthFor", () => {
  // Fixed pads from headerMeasure.ts:
  //   padding (24) + gap (4) + sort badge slot (16) + resize slot (6) = 50
  const PADS = 50;

  it("returns measured + pads (rounded up) for a non-key column", () => {
    // "abc" → 3 * 7 = 21px measured
    expect(headerFloorWidthFor({ name: "abc" })).toBe(21 + PADS);
  });

  it("adds KEY_BADGE_PAD for key columns", () => {
    expect(headerFloorWidthFor({ name: "abc", isKey: true })).toBe(
      21 + PADS + KEY_BADGE_PAD,
    );
  });

  it("Math.ceils fractional measurements", () => {
    measureText.mockReturnValueOnce({ width: 10.4 });
    // ceil(10.4 + 50) = 61
    expect(headerFloorWidthFor({ name: "x" })).toBe(61);
  });
});
