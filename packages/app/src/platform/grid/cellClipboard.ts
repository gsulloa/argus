/**
 * Shared clipboard utilities for all data-grid engines (Postgres, MySQL, MSSQL,
 * Athena). A single `formatCellValue` replaces the duplicated `cellToString`
 * functions and guarantees identical formatting for both single-cell copy and
 * row-range TSV copy.
 *
 * Cell-envelope shape (binary / truncated) is detected structurally so this
 * module has zero engine-specific imports and works with all engines' CellValue
 * types.
 */

/** Minimal structural check for a cell envelope (binary/truncated). */
function isCellEnvelope(v: unknown): v is { kind: "binary" | "truncated"; preview: string } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    (o.kind === "binary" || o.kind === "truncated") &&
    typeof o.preview === "string"
  );
}

/**
 * Convert any cell value to its clipboard string representation.
 *
 * - `null` / `undefined`  → `""`
 * - boolean              → `"true"` / `"false"`
 * - binary/truncated envelope → its `.preview` string
 * - object / array       → `JSON.stringify(value)`
 * - everything else      → `String(value)`
 */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (isCellEnvelope(value)) return value.preview;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value);
}

/**
 * Serialize a 2-D array of cell values to a TSV string suitable for pasting
 * into a spreadsheet. Each row's cells are joined by `\t`; rows are joined by
 * `\n`. Cell values are formatted via `formatCellValue` so output is
 * byte-for-byte identical to a sequence of single-cell copies. An empty input
 * array returns `""`.
 */
export function formatRowsTSV(rows: unknown[][]): string {
  return rows.map((cells) => cells.map(formatCellValue).join("\t")).join("\n");
}

/**
 * Write a cell value to the system clipboard. Formats via `formatCellValue`,
 * then writes with `navigator.clipboard.writeText`. Any error is swallowed
 * (logged as a warning) so callers never need to handle clipboard failures.
 */
export async function copyCellValue(value: unknown): Promise<void> {
  const text = formatCellValue(value);
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.warn("[cellClipboard] clipboard write failed:", err);
  }
}
