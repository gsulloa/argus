const STEP = 1.0;

export function computeMidpointSortOrder(prev?: number, next?: number): number {
  if (prev === undefined && next === undefined) return STEP;
  if (prev === undefined) return (next as number) - STEP;
  if (next === undefined) return (prev as number) + STEP;
  return (prev + next) / 2;
}
