import { describe, it, expect } from "vitest";
import { computeHiddenTabIds, type TabMetric } from "./tabOverflow";

/**
 * Builds a laid-out row of tabs: each `width` placed end to end starting at 0,
 * so `metrics` order matches tab order the way the DOM lays them out.
 */
function row(widths: number[]): TabMetric[] {
  let offsetLeft = 0;
  return widths.map((width, i) => {
    const m: TabMetric = { id: `t${i}`, offsetLeft, width };
    offsetLeft += width;
    return m;
  });
}

describe("computeHiddenTabIds", () => {
  it("reports nothing when every tab fits", () => {
    // 4 × 100px in a 500px port — 100px to spare.
    const hidden = computeHiddenTabIds(
      { scrollLeft: 0, clientWidth: 500 },
      row([100, 100, 100, 100]),
    );
    expect(hidden).toEqual([]);
  });

  it("reports nothing when the tabs exactly fill the port", () => {
    const hidden = computeHiddenTabIds(
      { scrollLeft: 0, clientWidth: 400 },
      row([100, 100, 100, 100]),
    );
    expect(hidden).toEqual([]);
  });

  it("reports tabs clipped on the right, in tab order", () => {
    // 6 × 100px in a 350px port at scrollLeft 0: t3 is cut, t4/t5 are past it.
    const hidden = computeHiddenTabIds(
      { scrollLeft: 0, clientWidth: 350 },
      row([100, 100, 100, 100, 100, 100]),
    );
    expect(hidden).toEqual(["t3", "t4", "t5"]);
  });

  it("reports tabs clipped on the left after scrolling", () => {
    // Scrolled fully past t0 and t1; port covers 200..600, so t0/t1 are behind
    // and nothing is cut on the right.
    const hidden = computeHiddenTabIds(
      { scrollLeft: 200, clientWidth: 400 },
      row([100, 100, 100, 100, 100, 100]),
    );
    expect(hidden).toEqual(["t0", "t1"]);
  });

  it("reports clipping on both sides at once", () => {
    // Port covers 150..450. t0 fully behind, t1 cut on the left,
    // t4 cut on the right, t5 fully past.
    const hidden = computeHiddenTabIds(
      { scrollLeft: 150, clientWidth: 300 },
      row([100, 100, 100, 100, 100, 100]),
    );
    expect(hidden).toEqual(["t0", "t1", "t4", "t5"]);
  });

  it("counts a partially visible tab as hidden", () => {
    // A single pixel of t2 is cut off — still hidden.
    const hidden = computeHiddenTabIds(
      { scrollLeft: 0, clientWidth: 298 },
      row([100, 100, 100]),
    );
    expect(hidden).toEqual(["t2"]);
  });

  it("absorbs sub-pixel overhang within the default tolerance", () => {
    // t2 overhangs by 0.4px — layout rounding, not a real clip.
    const hidden = computeHiddenTabIds(
      { scrollLeft: 0, clientWidth: 300 },
      row([100.1, 100.1, 100.2]),
    );
    expect(hidden).toEqual([]);
  });

  it("absorbs sub-pixel scroll offsets on the left edge", () => {
    // scrollLeft lands at 100.4 after a scroll; t1 starts at 100 — not clipped.
    const hidden = computeHiddenTabIds(
      { scrollLeft: 100.4, clientWidth: 400 },
      row([100, 100, 100, 100, 100]),
    );
    expect(hidden).toEqual(["t0"]);
  });

  it("honours an explicit tolerance", () => {
    const metrics = row([100, 100, 100]);
    // 3px overhang: hidden at the default tolerance of 1...
    expect(
      computeHiddenTabIds({ scrollLeft: 0, clientWidth: 297 }, metrics),
    ).toEqual(["t2"]);
    // ...and absorbed at a tolerance of 5.
    expect(
      computeHiddenTabIds({ scrollLeft: 0, clientWidth: 297 }, metrics, 5),
    ).toEqual([]);
  });

  it("returns [] for empty metrics", () => {
    expect(
      computeHiddenTabIds({ scrollLeft: 0, clientWidth: 500 }, []),
    ).toEqual([]);
  });

  it("returns [] before first layout, when the port has no width", () => {
    // jsdom and pre-paint both report 0 — must not flag every tab as hidden.
    expect(
      computeHiddenTabIds({ scrollLeft: 0, clientWidth: 0 }, row([100, 100])),
    ).toEqual([]);
  });

  it("preserves the given metrics order rather than sorting by position", () => {
    // Callers pass metrics in tab order; the result must follow it verbatim.
    const metrics: TabMetric[] = [
      { id: "b", offsetLeft: 400, width: 100 },
      { id: "a", offsetLeft: 500, width: 100 },
    ];
    expect(
      computeHiddenTabIds({ scrollLeft: 0, clientWidth: 300 }, metrics),
    ).toEqual(["b", "a"]);
  });
});
