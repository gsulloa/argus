import { describe, expect, it, vi, beforeEach } from "vitest";
import { copyCell, copyRows, copyRowRangeFromKeydown } from "./gridCopy";
import { formatRowsTSV } from "./cellClipboard";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(targetOverride?: Partial<HTMLElement>) {
  return {
    target: (targetOverride ?? null) as unknown as EventTarget | null,
    preventDefault: vi.fn(),
  };
}

function makeWrite(resolves = true) {
  return vi.fn().mockResolvedValue(resolves);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("copyRowRangeFromKeydown", () => {
  it("(a) copies row range when no active cell: write called once with expected TSV, preventDefault called, returns true", async () => {
    const write = makeWrite(true);
    const e = makeEvent();
    const result = await copyRowRangeFromKeydown(e, {
      editing: false,
      activeCell: null,
      selection: { anchor: 0, active: 2 },
      columnNames: ["a", "b"],
      resolveRow: (i) => [i, `v${i}`],
      write,
    });

    expect(result).toBe(true);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();

    const expected = formatRowsTSV([
      [0, "v0"],
      [1, "v1"],
      [2, "v2"],
    ]);
    expect(write).toHaveBeenCalledWith(expected);

    // Verify TSV structure: 3 lines, each with a tab
    const lines = expected.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("0\tv0");
    expect(lines[1]).toBe("1\tv1");
    expect(lines[2]).toBe("2\tv2");
  });

  it("(b) returns false and does not write when activeCell is non-null", async () => {
    const write = makeWrite(true);
    const e = makeEvent();
    const result = await copyRowRangeFromKeydown(e, {
      editing: false,
      activeCell: { row: 0, col: 0 },
      selection: { anchor: 0, active: 2 },
      columnNames: ["a"],
      resolveRow: (i) => [i],
      write,
    });

    expect(result).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("(c) returns false and does not write when target is a native editable (INPUT)", async () => {
    const write = makeWrite(true);
    const e = makeEvent({ tagName: "INPUT", isContentEditable: false } as unknown as HTMLElement);
    const result = await copyRowRangeFromKeydown(e, {
      editing: false,
      activeCell: null,
      selection: { anchor: 0, active: 1 },
      columnNames: ["a"],
      resolveRow: (i) => [i],
      write,
    });

    expect(result).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("(d) returns false and does not write or call onError when selection anchor/active are null", async () => {
    const write = makeWrite(true);
    const onError = vi.fn();
    const e = makeEvent();
    const result = await copyRowRangeFromKeydown(e, {
      editing: false,
      activeCell: null,
      selection: { anchor: null, active: null },
      columnNames: ["a"],
      resolveRow: (i) => [i],
      write,
      onError,
    });

    expect(result).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("(e) edited buffer values flow through: resolveRow returning edited values produces correct TSV", async () => {
    const write = makeWrite(true);
    const e = makeEvent();
    // Simulate a buffer that has edited row 1: value changes from "v1" to "edited"
    const editedValues: Record<number, unknown[]> = {
      0: [0, "v0"],
      1: [1, "edited"],
      2: [2, "v2"],
    };
    const result = await copyRowRangeFromKeydown(e, {
      editing: false,
      activeCell: null,
      selection: { anchor: 0, active: 2 },
      columnNames: ["id", "name"],
      resolveRow: (i) => editedValues[i] ?? null,
      write,
    });

    expect(result).toBe(true);
    const tsv = write.mock.calls[0]![0] as string;
    const lines = tsv.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("1\tedited");
  });

  it("(f) when write resolves false, onError is called once with a non-empty message and returns true", async () => {
    const write = makeWrite(false);
    const onError = vi.fn();
    const e = makeEvent();
    const result = await copyRowRangeFromKeydown(e, {
      editing: false,
      activeCell: null,
      selection: { anchor: 0, active: 0 },
      columnNames: ["a"],
      resolveRow: (i) => [i],
      write,
      onError,
    });

    expect(result).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
    const msg = onError.mock.calls[0]![0] as string;
    expect(msg.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// copyCell / copyRows
// ---------------------------------------------------------------------------

describe("copyCell", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    writeText.mockReset();
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText } },
      writable: true,
      configurable: true,
    });
  });

  it("returns true and does not call onError when writeText resolves", async () => {
    writeText.mockResolvedValueOnce(undefined);
    const onError = vi.fn();
    const result = await copyCell("hello", onError);
    expect(result).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("returns false and calls onError once with a non-empty message when writeText rejects", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    const onError = vi.fn();
    const result = await copyCell("hello", onError);
    expect(result).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
    const msg = onError.mock.calls[0]![0] as string;
    expect(msg.length).toBeGreaterThan(0);
  });
});

describe("copyRows", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    writeText.mockReset();
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText } },
      writable: true,
      configurable: true,
    });
  });

  it("returns true and does not call onError when writeText resolves", async () => {
    writeText.mockResolvedValueOnce(undefined);
    const onError = vi.fn();
    const result = await copyRows([[1, "a"], [2, "b"]], ["id", "name"], onError);
    expect(result).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("returns false and calls onError once with a non-empty message when writeText rejects", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    const onError = vi.fn();
    const result = await copyRows([[1, "a"]], ["id"], onError);
    expect(result).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
    const msg = onError.mock.calls[0]![0] as string;
    expect(msg.length).toBeGreaterThan(0);
  });
});
