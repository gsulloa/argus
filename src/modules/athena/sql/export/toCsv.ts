/**
 * CSV export for Athena query results.
 * RFC 4180 quoting, BOM-prefixed UTF-8, header row.
 */

import type { AthenaResultColumnInfo } from "../../types";

const BOM = "﻿";
const EOL = "\r\n";

export function toCsv(columns: AthenaResultColumnInfo[], rows: unknown[][]): string {
  const out: string[] = [];
  out.push(columns.map((c) => quoteField(c.name)).join(","));
  for (const row of rows) {
    const cells: string[] = [];
    for (let i = 0; i < columns.length; i++) {
      cells.push(quoteField(stringifyCell(row[i] ?? null)));
    }
    out.push(cells.join(","));
  }
  return BOM + out.join(EOL);
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function quoteField(field: string): string {
  if (field === "") return "";
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}
