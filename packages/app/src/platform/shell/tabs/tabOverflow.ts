/**
 * Pure geometry for the tab strip's overflow split.
 *
 * `TabStrip` scrolls horizontally; a tab is considered *hidden* when it is not
 * **fully** inside the scrollport. Partially visible counts as hidden — a
 * half-cut tab is exactly the case the overflow menu exists to surface.
 *
 * The arithmetic lives here, apart from any DOM, so it can be unit-tested:
 * jsdom reports `0` for every layout property, so the measurement itself
 * (`useTabOverflow`) is untestable but this decision logic is not.
 */

/** One measured tab, in scroll-content coordinates. */
export interface TabMetric {
  id: string;
  /** Offset of the tab's left edge from the start of the scroll content. */
  offsetLeft: number;
  /** Rendered width of the tab. */
  width: number;
}

/** The scrollport the metrics are measured against. */
export interface Viewport {
  scrollLeft: number;
  clientWidth: number;
}

/**
 * Ids of the tabs that are not fully visible in `viewport`, in `metrics` order
 * (which callers keep in tab order).
 *
 * `tolerancePx` absorbs sub-pixel layout rounding so a tab flush against an
 * edge is not reported as clipped by a fraction of a pixel.
 */
export function computeHiddenTabIds(
  viewport: Viewport,
  metrics: readonly TabMetric[],
  tolerancePx = 1,
): string[] {
  // Before first layout the scrollport has no width; nothing is measurable yet,
  // so report nothing rather than flagging every tab as hidden.
  if (viewport.clientWidth <= 0) return [];

  const left = viewport.scrollLeft;
  const right = viewport.scrollLeft + viewport.clientWidth;

  const hidden: string[] = [];
  for (const m of metrics) {
    const clippedLeft = m.offsetLeft < left - tolerancePx;
    const clippedRight = m.offsetLeft + m.width > right + tolerancePx;
    if (clippedLeft || clippedRight) hidden.push(m.id);
  }
  return hidden;
}
