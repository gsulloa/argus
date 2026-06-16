import { describe, expect, it } from "vitest";
import { pixelYToRowIndex } from "../dragRowIndex";

describe("pixelYToRowIndex", () => {
  const ROW_HEIGHT = 26;

  it("returns 0 for the top edge", () => {
    // scrollTop=0, clientY at bodyTop → row 0
    expect(pixelYToRowIndex(0, 100, 100, ROW_HEIGHT, 10)).toBe(0);
  });

  it("returns correct index for a middle row", () => {
    // scrollTop=0, bodyTop=100, clientY=152 → 52px from top → row 2 (floor(52/26)=2)
    expect(pixelYToRowIndex(0, 152, 100, ROW_HEIGHT, 10)).toBe(2);
  });

  it("clamps to 0 when cursor is above body", () => {
    // clientY < bodyTop
    expect(pixelYToRowIndex(0, 90, 100, ROW_HEIGHT, 10)).toBe(0);
  });

  it("clamps to rowCount-1 when cursor is below last row", () => {
    // scrollTop=0, bodyTop=100, clientY=999 → way beyond row 9
    expect(pixelYToRowIndex(0, 999, 100, ROW_HEIGHT, 10)).toBe(9);
  });

  it("accounts for scrollTop", () => {
    // scrollTop=26, bodyTop=100, clientY=126 → (26 + 26)/26=2 → row 2
    expect(pixelYToRowIndex(26, 126, 100, ROW_HEIGHT, 10)).toBe(2);
  });

  it("handles empty row list with clamp", () => {
    expect(pixelYToRowIndex(0, 150, 100, ROW_HEIGHT, 0)).toBe(0);
  });
});
