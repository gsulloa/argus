/**
 * Pure helper: converts a mouse clientY position + scroll state to a
 * virtualizer row index. Extracted from DataGrid so the mapping logic
 * can be unit-tested independently of React.
 */
export function pixelYToRowIndex(
  scrollTop: number,
  clientY: number,
  bodyTop: number,
  rowHeight: number,
  rowCount: number,
): number {
  const offsetFromBodyTop = scrollTop + clientY - bodyTop;
  const idx = Math.floor(offsetFromBodyTop / rowHeight);
  if (rowCount <= 0) return 0;
  return Math.max(0, Math.min(rowCount - 1, idx));
}
