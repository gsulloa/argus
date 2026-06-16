/**
 * §20.7 — CSV export for MS SQL Server query results.
 * RFC 4180 quoting, BOM-prefixed UTF-8, header row.
 */

import type { ColumnInfo } from "../../types";
import type { CellValue } from "../../data/types";

const BOM = "﻿";
const EOL = "\r\n";

export function toCsv(columns: ColumnInfo[], rows: CellValue[][]): string {
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
  return JSON.stringify(value);
}

function quote(field: string): string {
  if (field === "") return "";
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}
