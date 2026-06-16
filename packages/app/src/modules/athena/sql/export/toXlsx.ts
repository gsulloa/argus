/**
 * XLSX export for Athena query results.
 * Uses ExcelJS (already a dep via Postgres/MySQL counterpart).
 */

import type { AthenaResultColumnInfo } from "../../types";

type ExcelCell = string | number | boolean | Date | null;

export async function toXlsx(
  columns: AthenaResultColumnInfo[],
  rows: unknown[][],
): Promise<Uint8Array> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Result");

  sheet.columns = columns.map((c) => ({
    header: c.name,
    key: c.name,
    width: 12,
  }));

  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getRow(1).font = { bold: true };

  const widths = columns.map((c) => Math.max(c.name.length, 8));

  for (const row of rows) {
    const out: ExcelCell[] = [];
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i]!;
      const value = row[i] ?? null;
      const cell = toExcelCell(value, col.ty);
      out.push(cell);
      const display = cell === null || cell === undefined ? "" : String(cell);
      if (display.length > widths[i]!) widths[i] = Math.min(60, display.length);
    }
    sheet.addRow(out);
  }

  for (let i = 0; i < columns.length; i++) {
    sheet.getColumn(i + 1).width = Math.min(60, Math.max(8, widths[i]! + 1));
  }

  const buffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

function toExcelCell(value: unknown, ty: string): ExcelCell {
  if (value === null || value === undefined) return null;

  const t = ty.toLowerCase();

  if (isNumericType(t)) {
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
    if (typeof value === "string") {
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }
  }

  if (isDateType(t)) {
    if (value instanceof Date) return value;
    if (typeof value === "string") {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

function isNumericType(t: string): boolean {
  return (
    t === "int" ||
    t === "integer" ||
    t === "bigint" ||
    t === "smallint" ||
    t === "tinyint" ||
    t === "decimal" ||
    t === "double" ||
    t === "float" ||
    t === "real" ||
    t.startsWith("decimal") ||
    t.startsWith("numeric") ||
    t.startsWith("double") ||
    t.startsWith("float")
  );
}

function isDateType(t: string): boolean {
  return (
    t === "date" ||
    t === "timestamp" ||
    t === "timestamp with time zone" ||
    t.startsWith("timestamp")
  );
}
