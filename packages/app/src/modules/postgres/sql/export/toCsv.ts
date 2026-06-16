import type { CellValue, DataColumn } from "../../data/types";
import { isCellEnvelope } from "../../data/types";

const BOM = "\uFEFF";
const EOL = "\r\n";

export function toCsv(columns: DataColumn[], rows: CellValue[][]): string {
  const out: string[] = [];
  out.push(columns.map((c) => quote(c.name)).join(","));
  for (const row of rows) {
    const cells: string[] = [];
    for (let i = 0; i < columns.length; i++) {
      cells.push(quote(stringifyCell(row[i] ?? null)));
    }
    out.push(cells.join(","));
  }
  return BOM + out.join(EOL);
}

function stringifyCell(value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isCellEnvelope(value)) {
    if (value.kind === "binary") return `\\x${value.preview}`;
    return value.preview;
  }
  return JSON.stringify(value);
}

function quote(field: string): string {
  if (field === "") return "";
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}
