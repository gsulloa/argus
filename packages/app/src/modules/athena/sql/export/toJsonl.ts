/**
 * JSON Lines export for Athena query results.
 * One JSON object per line, keys = column names.
 */

import type { AthenaResultColumnInfo } from "../../types";

export function toJsonl(columns: AthenaResultColumnInfo[], rows: unknown[][]): string {
  const lines: string[] = [];
  for (const row of rows) {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i]!.name] = row[i] ?? null;
    }
    lines.push(JSON.stringify(obj));
  }
  return lines.join("\n");
}
