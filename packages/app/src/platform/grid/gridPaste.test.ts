import { describe, expect, it, vi } from "vitest";
import { parseTsvRows, pasteRowRangeFromKeydown } from "./gridPaste";
import { formatRowsTSV } from "./cellClipboard";
import { NOTHING_TO_PASTE_MESSAGE, PASTE_FAILED_MESSAGE } from "../clipboard";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(targetOverride?: Partial<HTMLElement>) {
  return {
    target: (targetOverride ?? null) as unknown as EventTarget | null,
    preventDefault: vi.fn(),
  };
}

function makeRead(resolves: string | null) {
  return vi.fn().mockResolvedValue(resolves);
}

// ---------------------------------------------------------------------------
// parseTsvRows
// ---------------------------------------------------------------------------

describe("parseTsvRows", () => {
  it("parses a single line", () => {
    expect(parseTsvRows("a\tb\tc")).toEqual([["a", "b", "c"]]);
  });

  it("parses multiple lines", () => {
    expect(parseTsvRows("a\tb\nc\td")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("drops a single trailing empty line from a trailing newline", () => {
    expect(parseTsvRows("a\tb\n")).toEqual([["a", "b"]]);
  });

  it("handles \\r\\n line endings", () => {
    expect(parseTsvRows("a\tb\r\nc\td\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("handles empty cells", () => {
    expect(parseTsvRows("a\t\tb")).toEqual([["a", "", "b"]]);
  });

  it("returns [] for empty input", () => {
    expect(parseTsvRows("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// pasteRowRangeFromKeydown — decline paths
// ---------------------------------------------------------------------------

describe("pasteRowRangeFromKeydown", () => {
  it("(a) returns false and does not read when editing is true", async () => {
    const read = makeRead("a\tb");
    const onPasteRows = vi.fn();
    const e = makeEvent();
    const result = await pasteRowRangeFromKeydown(e, {
      editing: true,
      activeCell: null,
      selection: { anchor: 0, active: 0 },
      columns: [{ name: "a" }, { name: "b" }],
      pkColumns: null,
      read,
      onPasteRows,
    });

    expect(result).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(onPasteRows).not.toHaveBeenCalled();
  });

  it("(b) returns false and does not read when target is a native editable (INPUT)", async () => {
    const read = makeRead("a\tb");
    const onPasteRows = vi.fn();
    const e = makeEvent({ tagName: "INPUT", isContentEditable: false } as unknown as HTMLElement);
    const result = await pasteRowRangeFromKeydown(e, {
      editing: false,
      activeCell: null,
      selection: { anchor: 0, active: 0 },
      columns: [{ name: "a" }, { name: "b" }],
      pkColumns: null,
      read,
      onPasteRows,
    });

    expect(result).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(onPasteRows).not.toHaveBeenCalled();
  });

  it("(c) returns false and does not read when activeCell is non-null", async () => {
    const read = makeRead("a\tb");
    const onPasteRows = vi.fn();
    const e = makeEvent();
    const result = await pasteRowRangeFromKeydown(e, {
      editing: false,
      activeCell: { row: 0, col: 0 },
      selection: { anchor: 0, active: 0 },
      columns: [{ name: "a" }, { name: "b" }],
      pkColumns: null,
      read,
      onPasteRows,
    });

    expect(result).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(onPasteRows).not.toHaveBeenCalled();
  });

  it("(d) returns false and does not read when selection anchor/active are null", async () => {
    const read = makeRead("a\tb");
    const onPasteRows = vi.fn();
    const e = makeEvent();
    const result = await pasteRowRangeFromKeydown(e, {
      editing: false,
      activeCell: null,
      selection: { anchor: null, active: null },
      columns: [{ name: "a" }, { name: "b" }],
      pkColumns: null,
      read,
      onPasteRows,
    });

    expect(result).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(onPasteRows).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // accept paths
  // -------------------------------------------------------------------------

  it("(e) maps TSV cells positionally to column names, calls preventDefault, returns true", async () => {
    const read = makeRead("1\tfoo\n2\tbar");
    const onPasteRows = vi.fn();
    const e = makeEvent();
    const result = await pasteRowRangeFromKeydown(e, {
      editing: false,
      activeCell: null,
      selection: { anchor: 0, active: 1 },
      columns: [{ name: "id" }, { name: "name" }],
      pkColumns: null,
      read,
      onPasteRows,
    });

    expect(result).toBe(true);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(onPasteRows).toHaveBeenCalledOnce();
    expect(onPasteRows).toHaveBeenCalledWith([
      { id: "1", name: "foo" },
      { id: "2", name: "bar" },
    ]);
  });

  it("(f) omits PK columns from produced row objects", async () => {
    const read = makeRead("1\tfoo");
    const onPasteRows = vi.fn();
    const e = makeEvent();
    const result = await pasteRowRangeFromKeydown(e, {
      editing: false,
      activeCell: null,
      selection: { anchor: 0, active: 0 },
      columns: [{ name: "id" }, { name: "name" }],
      pkColumns: ["id"],
      read,
      onPasteRows,
    });

    expect(result).toBe(true);
    expect(onPasteRows).toHaveBeenCalledWith([{ name: "foo" }]);
    const row = onPasteRows.mock.calls[0]![0][0];
    expect(Object.prototype.hasOwnProperty.call(row, "id")).toBe(false);
  });

  it("(g) maps an empty cell to null", async () => {
    const read = makeRead("1\t");
    const onPasteRows = vi.fn();
    const e = makeEvent();
    const result = await pasteRowRangeFromKeydown(e, {
      editing: false,
      activeCell: null,
      selection: { anchor: 0, active: 0 },
      columns: [{ name: "id" }, { name: "name" }],
      pkColumns: null,
      read,
      onPasteRows,
    });

    expect(result).toBe(true);
    expect(onPasteRows).toHaveBeenCalledWith([{ id: "1", name: null }]);
  });

  it("(h) short line leaves trailing columns unset (key absent)", async () => {
    const read = makeRead("1");
    const onPasteRows = vi.fn();
    const e = makeEvent();
    const result = await pasteRowRangeFromKeydown(e, {
      editing: false,
      activeCell: null,
      selection: { anchor: 0, active: 0 },
      columns: [{ name: "id" }, { name: "name" }],
      pkColumns: null,
      read,
      onPasteRows,
    });

    expect(result).toBe(true);
    const row = onPasteRows.mock.calls[0]![0][0];
    expect(row).toEqual({ id: "1" });
    expect(Object.prototype.hasOwnProperty.call(row, "name")).toBe(false);
  });

  it("(i) long line ignores extra cells beyond declared columns", async () => {
    const read = makeRead("1\tfoo\textra");
    const onPasteRows = vi.fn();
    const e = makeEvent();
    const result = await pasteRowRangeFromKeydown(e, {
      editing: false,
      activeCell: null,
      selection: { anchor: 0, active: 0 },
      columns: [{ name: "id" }, { name: "name" }],
      pkColumns: null,
      read,
      onPasteRows,
    });

    expect(result).toBe(true);
    expect(onPasteRows).toHaveBeenCalledWith([{ id: "1", name: "foo" }]);
  });

  // -------------------------------------------------------------------------
  // failure surfacing
  // -------------------------------------------------------------------------

  it("(j) calls onError with PASTE_FAILED_MESSAGE when read resolves null, does not call onPasteRows", async () => {
    const read = makeRead(null);
    const onPasteRows = vi.fn();
    const onError = vi.fn();
    const e = makeEvent();
    const result = await pasteRowRangeFromKeydown(e, {
      editing: false,
      activeCell: null,
      selection: { anchor: 0, active: 0 },
      columns: [{ name: "id" }],
      pkColumns: null,
      read,
      onPasteRows,
      onError,
    });

    expect(result).toBe(true);
    expect(onError).toHaveBeenCalledExactlyOnceWith(PASTE_FAILED_MESSAGE);
    expect(onPasteRows).not.toHaveBeenCalled();
  });

  it("(k) calls onError with NOTHING_TO_PASTE_MESSAGE when read resolves empty string, does not call onPasteRows", async () => {
    const read = makeRead("");
    const onPasteRows = vi.fn();
    const onError = vi.fn();
    const e = makeEvent();
    const result = await pasteRowRangeFromKeydown(e, {
      editing: false,
      activeCell: null,
      selection: { anchor: 0, active: 0 },
      columns: [{ name: "id" }],
      pkColumns: null,
      read,
      onPasteRows,
      onError,
    });

    expect(result).toBe(true);
    expect(onError).toHaveBeenCalledExactlyOnceWith(NOTHING_TO_PASTE_MESSAGE);
    expect(onPasteRows).not.toHaveBeenCalled();
  });

  it("(l) does not call onError on a successful paste", async () => {
    const read = makeRead("1\tfoo");
    const onPasteRows = vi.fn();
    const onError = vi.fn();
    const e = makeEvent();
    const result = await pasteRowRangeFromKeydown(e, {
      editing: false,
      activeCell: null,
      selection: { anchor: 0, active: 0 },
      columns: [{ name: "id" }, { name: "name" }],
      pkColumns: null,
      read,
      onPasteRows,
      onError,
    });

    expect(result).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // round-trip with formatRowsTSV
  // -------------------------------------------------------------------------

  it("(m) round-trips through formatRowsTSV", () => {
    const source = [
      ["a", "b"],
      ["c", "d"],
    ];
    const tsv = formatRowsTSV(source);
    expect(parseTsvRows(tsv)).toEqual(source);
  });
});
