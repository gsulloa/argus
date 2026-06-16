/**
 * Off-DOM canvas-based text measurement for header floor widths.
 *
 * Used so that columns whose header name is wider than the type-derived base
 * width don't render the name ellipsis-truncated at default widths.
 * Measurements are deterministic, offline, and cached per `(font, name)`.
 */

import { KEY_BADGE_PAD } from "@/platform/table/columnWidths";

export const HEADER_FONT = '11px "Geist Mono", monospace';

// Pads matching the current `.headerCell` CSS (DataGrid.module.css):
//   padding 5px 12px  → 24px horizontal
//   gap: 4px between name / badge / handle slots
//   sort badge slot ~ 16px (rendered only when sorted, but reserve so the
//     floor is stable regardless of sort state)
//   resize handle slot ~ 6px (handle width inside the cell)
const HEADER_PADDING_PX = 24;
const HEADER_GAP_PX = 4;
const SORT_BADGE_SLOT_PX = 16;
const RESIZE_HANDLE_SLOT_PX = 6;

let _ctx: CanvasRenderingContext2D | null = null;
const _cache = new Map<string, number>();

function getCtx(): CanvasRenderingContext2D | null {
  if (_ctx) return _ctx;
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  _ctx = c.getContext("2d");
  return _ctx;
}

export function measureHeaderTextWidth(name: string, font: string): number {
  const key = `${font}|${name}`;
  const hit = _cache.get(key);
  if (hit !== undefined) return hit;
  const ctx = getCtx();
  if (!ctx) {
    _cache.set(key, 0);
    return 0;
  }
  ctx.font = font;
  const w = ctx.measureText(name).width;
  _cache.set(key, w);
  return w;
}

export function headerFloorWidthFor({
  name,
  isKey,
}: {
  name: string;
  isKey?: boolean;
}): number {
  const measured = measureHeaderTextWidth(name, HEADER_FONT);
  return Math.ceil(
    measured +
      HEADER_PADDING_PX +
      HEADER_GAP_PX +
      SORT_BADGE_SLOT_PX +
      RESIZE_HANDLE_SLOT_PX +
      (isKey ? KEY_BADGE_PAD : 0),
  );
}

// Exported for tests only — clears the cache between cases that stub the
// canvas measurement.
export function _clearHeaderMeasureCache(): void {
  _cache.clear();
  _ctx = null;
}
