/**
 * CSV export for DynamoDB PartiQL query results.
 * RFC 4180 quoting, BOM-prefixed UTF-8, header row.
 * Columns are the inferred attribute names; cells are stringified AttributeValues.
 */

import type { AttributeMap, AttributeValue } from "../../data-view/types";

const BOM = "﻿";
const EOL = "\r\n";

export function attrValueToString(value: AttributeValue | undefined | null): string {
  if (value === undefined || value === null) return "";
  if ("S" in value) return value.S;
  if ("N" in value) return value.N;
  if ("BOOL" in value) return String(value.BOOL);
  if ("NULL" in value) return "";
  if ("L" in value) return JSON.stringify(value.L);
  if ("M" in value) return JSON.stringify(value.M);
  if ("SS" in value) return JSON.stringify(value.SS);
  if ("NS" in value) return JSON.stringify(value.NS);
  if ("BS" in value) return JSON.stringify(value.BS);
  if ("B" in value) return value.B;
  return "";
}

export function toCsv(columns: string[], rows: AttributeMap[]): string {
  const out: string[] = [];
  out.push(columns.map(quoteField).join(","));
  for (const row of rows) {
    const cells: string[] = [];
    for (const col of columns) {
      cells.push(quoteField(attrValueToString(row[col])));
    }
    out.push(cells.join(","));
  }
  return BOM + out.join(EOL);
}

function quoteField(field: string): string {
  if (field === "") return "";
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}
