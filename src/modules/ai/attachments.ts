import type { CellValue } from "@/modules/postgres/data/types";
import { isCellEnvelope } from "@/modules/postgres/data/types";

/**
 * One cross-provider attached executed-query result. Mirrors the Rust
 * `AttachedResult` serde shape (snake_case). Cells are stringified at this
 * boundary so the backend only ever carries string rows.
 */
export interface AttachedResult {
  id: string;
  columns: string[];
  rows: string[][];
  truncated: boolean;
  /** True total row count, even when `rows` was capped at capture. */
  row_count: number;
}

/** Per-attachment capture caps. */
const MAX_ROWS = 100;
const MAX_BYTES = 50 * 1024; // 50 KB serialised

/** Stringify a single cell. SQL NULL → "NULL". */
export function stringifyCell(v: CellValue): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (isCellEnvelope(v)) return v.preview;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Capture a live grid result as an AttachedResult, applying the 100-row / 50 KB
 * cap. Sets `truncated` when the source was already truncated OR the cap was hit,
 * and preserves the true total row count.
 */
export function captureResult(
  columns: string[],
  rows: CellValue[][],
  sourceTruncated: boolean,
): AttachedResult {
  const stringRows: string[][] = [];
  let truncated = sourceTruncated;
  let bytes = 0;
  for (const row of rows) {
    if (stringRows.length >= MAX_ROWS) {
      truncated = true;
      break;
    }
    const stringRow = row.map(stringifyCell);
    const rowBytes = stringRow.reduce((acc, c) => acc + c.length, 0);
    if (bytes + rowBytes > MAX_BYTES && stringRows.length > 0) {
      truncated = true;
      break;
    }
    stringRows.push(stringRow);
    bytes += rowBytes;
  }
  return {
    id: crypto.randomUUID(),
    columns,
    rows: stringRows,
    truncated,
    row_count: rows.length,
  };
}
