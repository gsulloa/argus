/**
 * XLSX export for DynamoDB PartiQL query results.
 * Uses ExcelJS (already a dep via Postgres/MySQL counterpart).
 */

import type { AttributeMap } from "../../data-view/types";
import { attrValueToString } from "./toCsv";

export async function toXlsx(
  columns: string[],
  rows: AttributeMap[],
): Promise<Uint8Array> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Result");

  sheet.columns = columns.map((c) => ({
    header: c,
    key: c,
    width: 12,
  }));

  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getRow(1).font = { bold: true };

  const widths = columns.map((c) => Math.max(c.length, 8));

  for (const row of rows) {
    const out: (string | null)[] = [];
    for (let i = 0; i < columns.length; i++) {
      const val = row[columns[i]!];
      const cell = val === undefined ? null : attrValueToString(val) || null;
      out.push(cell);
      const display = cell ?? "";
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
