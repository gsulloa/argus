/**
 * §20.7 — JSON Lines export for MySQL query results.
 * One JSON object per line, keys = column names.
 */

import type { ColumnInfo } from "../../types";
import type { CellValue } from "../../data/types";

export function toJsonl(columns: ColumnInfo[], rows: CellValue[][]): string {
  const lines: string[] = [];
  for (const row of rows) {
    const obj: Record<string, CellValue> = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i]!.name] = row[i] ?? null;
    }
    lines.push(JSON.stringify(obj));
  }
  return lines.join("\n");
}
