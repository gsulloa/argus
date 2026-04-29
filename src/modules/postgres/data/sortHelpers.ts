import type { OrderBy } from "./types";

/**
 * Click cycle on a header: `asc → desc → none`. Shift-click adds the column
 * to the multi-column sort instead of replacing it.
 */
export function cycleSort(
  column: string,
  current: OrderBy[],
  shift: boolean,
): OrderBy[] {
  const idx = current.findIndex((o) => o.column === column);
  if (idx === -1) {
    const next: OrderBy = { column, direction: "asc" };
    return shift ? [...current, next] : [next];
  }
  const cur = current[idx];
  if (!cur) return current;
  if (cur.direction === "asc") {
    const flipped: OrderBy = { column, direction: "desc" };
    if (shift) {
      const copy = current.slice();
      copy[idx] = flipped;
      return copy;
    }
    return [flipped];
  }
  // desc → remove
  if (shift) {
    return current.filter((_, i) => i !== idx);
  }
  return [];
}

export function sortIndexFor(column: string, current: OrderBy[]): number {
  return current.findIndex((o) => o.column === column);
}
