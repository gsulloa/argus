import { describe, it, expect } from "vitest";
import { formatCellValue } from "./cellClipboard";

describe("formatCellValue", () => {
  it("formats null as empty string", () => {
    expect(formatCellValue(null)).toBe("");
  });

  it("formats undefined as empty string", () => {
    expect(formatCellValue(undefined)).toBe("");
  });

  it("formats boolean true as 'true'", () => {
    expect(formatCellValue(true)).toBe("true");
  });

  it("formats boolean false as 'false'", () => {
    expect(formatCellValue(false)).toBe("false");
  });

  it("formats numbers via String()", () => {
    expect(formatCellValue(42)).toBe("42");
    expect(formatCellValue(3.14)).toBe("3.14");
    expect(formatCellValue(0)).toBe("0");
  });

  it("formats strings as-is", () => {
    expect(formatCellValue("hello")).toBe("hello");
    expect(formatCellValue("")).toBe("");
  });

  it("formats plain objects via JSON.stringify", () => {
    expect(formatCellValue({ a: 1 })).toBe('{"a":1}');
  });

  it("formats arrays via JSON.stringify", () => {
    expect(formatCellValue([1, 2, 3])).toBe("[1,2,3]");
  });

  it("formats a binary cell envelope as its preview", () => {
    const envelope = { kind: "binary" as const, preview: "0xDEADBEEF", byte_length: 4 };
    expect(formatCellValue(envelope)).toBe("0xDEADBEEF");
  });

  it("formats a truncated cell envelope as its preview", () => {
    const envelope = { kind: "truncated" as const, preview: "long text…", byte_length: 2048 };
    expect(formatCellValue(envelope)).toBe("long text…");
  });
});
