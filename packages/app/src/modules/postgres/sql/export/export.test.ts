import { describe, expect, it } from "vitest";
import type { DataColumn, CellValue } from "../../data/types";
import { toCsv } from "./toCsv";
import { toJsonl } from "./toJsonl";
import { toXlsx } from "./toXlsx";

const cols = (defs: Array<[string, string]>): DataColumn[] =>
  defs.map(([name, type], i) => ({
    name,
    data_type: type,
    ordinal_position: i + 1,
    is_nullable: true,
  }));

describe("toCsv", () => {
  it("BOM-prefixed and CRLF-terminated", () => {
    const out = toCsv(cols([["id", "int"]]), [[1], [2]]);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out).toContain("\r\n");
  });

  it("quotes fields with commas, quotes, or newlines", () => {
    const out = toCsv(cols([["a", "text"]]), [['a,b"c\nd' as CellValue]]);
    expect(out).toContain('"a,b""c\nd"');
  });

  it("renders null as empty field", () => {
    const out = toCsv(cols([["a", "text"], ["b", "text"]]), [[null, "x" as CellValue]]);
    const lines = out.replace(/^\uFEFF/, "").split("\r\n");
    expect(lines[1]).toBe(",x");
  });

  it("does not quote plain identifiers", () => {
    const out = toCsv(cols([["a", "text"]]), [["hello" as CellValue]]);
    expect(out).toContain("\r\nhello");
    expect(out).not.toContain('"hello"');
  });
});

describe("toJsonl", () => {
  it("preserves JSON-native types", () => {
    const out = toJsonl(
      cols([
        ["id", "int4"],
        ["active", "bool"],
        ["name", "text"],
        ["meta", "jsonb"],
      ]),
      [[7, true, null, { k: "v" } as CellValue]],
    );
    expect(out).toBe('{"id":7,"active":true,"name":null,"meta":{"k":"v"}}');
  });

  it("uses LF and no trailing newline", () => {
    const out = toJsonl(cols([["id", "int"]]), [[1], [2]]);
    expect(out).toBe('{"id":1}\n{"id":2}');
  });
});

describe("toXlsx", () => {
  it("types numeric, bool, timestamp, jsonb cells correctly", async () => {
    const c = cols([
      ["n", "int4"],
      ["active", "bool"],
      ["created_at", "timestamp"],
      ["meta", "jsonb"],
    ]);
    const rows: CellValue[][] = [[42, true, "2026-05-06T12:00:00Z", { k: "v" }]];
    const buf = await toXlsx(c, rows);
    expect(buf).toBeInstanceOf(Uint8Array);
    expect(buf.byteLength).toBeGreaterThan(0);

    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(buf as any);
    const sheet = wb.getWorksheet("Result")!;
    const dataRow = sheet.getRow(2);
    expect(dataRow.getCell(1).value).toBe(42);
    expect(dataRow.getCell(2).value).toBe(true);
    expect(dataRow.getCell(3).value).toBeInstanceOf(Date);
    expect(dataRow.getCell(4).value).toBe('{"k":"v"}');
  });

  it("writes null cells as empty", async () => {
    const c = cols([["a", "text"]]);
    const buf = await toXlsx(c, [[null]]);
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(buf as any);
    const sheet = wb.getWorksheet("Result")!;
    const v = sheet.getRow(2).getCell(1).value;
    expect(v === null || v === undefined || v === "").toBe(true);
  });
});
