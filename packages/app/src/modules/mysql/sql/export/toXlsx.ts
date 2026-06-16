/**
 * §20.7 — XLSX export for MySQL query results.
 * Uses ExcelJS (already a dep via Postgres counterpart).
 */

import type { ColumnInfo } from "../../types";
import type { CellValue } from "../../data/types";
import { isCellEnvelope } from "../../data/types";

type ExcelCell = string | number | boolean | Date | null;

export async function toXlsx(
  columns: ColumnInfo[],
  rows: CellValue[][],
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
      const cell = toExcelCell(value, col.data_type);
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

function toExcelCell(value: CellValue, dataType: string): ExcelCell {
  if (value === null || value === undefined) return null;

  const t = dataType.toLowerCase();

  if (isNumericType(t)) {
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
    if (typeof value === "string") {
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }
  }

  if (t === "tinyint(1)" || t === "boolean" || t === "bool") {
    if (typeof value === "boolean") return value;
    if (value === 1 || value === "1") return true;
    if (value === 0 || value === "0") return false;
  }

  if (isDateType(t)) {
    if (value instanceof Date) return value;
    if (typeof value === "string") {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  if (t === "json") {
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  }

  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (isCellEnvelope(value)) {
    return value.kind === "binary" ? `\\x${value.preview}` : value.preview;
  }
  return JSON.stringify(value);
}

function isNumericType(t: string): boolean {
  return (
    t === "int" ||
    t === "integer" ||
    t === "tinyint" ||
    t === "smallint" ||
    t === "mediumint" ||
    t === "bigint" ||
    t === "decimal" ||
    t === "numeric" ||
    t === "float" ||
    t === "double" ||
    t === "real" ||
    t.startsWith("int") ||
    t.startsWith("decimal") ||
    t.startsWith("numeric") ||
    t.startsWith("float") ||
    t.startsWith("double")
  );
}

function isDateType(t: string): boolean {
  return (
    t === "date" ||
    t === "datetime" ||
    t === "timestamp" ||
    t.startsWith("datetime") ||
    t.startsWith("timestamp")
  );
}
