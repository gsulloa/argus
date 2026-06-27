import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatCellValue, copyRowsTsv } from "./cellClipboard";

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

// ---------------------------------------------------------------------------
// copyRowsTsv
// ---------------------------------------------------------------------------

describe("copyRowsTsv", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText } },
      writable: true,
      configurable: true,
    });
  });

  it("writes a single row with a single column", async () => {
    await copyRowsTsv([["hello"]], ["col_a"]);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("joins multiple columns with tabs", async () => {
    await copyRowsTsv([[42, true, null]], ["a", "b", "c"]);
    expect(writeText).toHaveBeenCalledWith("42\ttrue\t");
  });

  it("joins multiple rows with newlines", async () => {
    await copyRowsTsv([[1, "a"], [2, "b"]], ["id", "name"]);
    expect(writeText).toHaveBeenCalledWith("1\ta\n2\tb");
  });

  it("formats null cells as empty string", async () => {
    await copyRowsTsv([[null, undefined]], ["x", "y"]);
    expect(writeText).toHaveBeenCalledWith("\t");
  });

  it("formats boolean cells", async () => {
    await copyRowsTsv([[true, false]], ["p", "q"]);
    expect(writeText).toHaveBeenCalledWith("true\tfalse");
  });

  it("formats object cells as JSON", async () => {
    await copyRowsTsv([[{ a: 1 }]], ["json"]);
    expect(writeText).toHaveBeenCalledWith('{"a":1}');
  });

  it("formats array cells as JSON", async () => {
    await copyRowsTsv([[[1, 2, 3]]], ["arr"]);
    expect(writeText).toHaveBeenCalledWith("[1,2,3]");
  });

  it("handles multiple rows × multiple columns", async () => {
    await copyRowsTsv([[1, null, true], ["hello", { x: 2 }, false]], ["a", "b", "c"]);
    expect(writeText).toHaveBeenCalledWith('1\t\ttrue\nhello\t{"x":2}\tfalse');
  });

  it("swallows clipboard errors without throwing", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    await expect(copyRowsTsv([["test"]], ["col"])).resolves.toBeUndefined();
  });
});
