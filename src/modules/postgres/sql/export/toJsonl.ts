import type { CellValue, DataColumn } from "../../data/types";

export function toJsonl(columns: DataColumn[], rows: CellValue[][]): string {
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
