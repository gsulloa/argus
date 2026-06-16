import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureResult, stringifyCell } from "./attachments";

beforeEach(() => {
  // jsdom may lack randomUUID; stub deterministically.
  if (!globalThis.crypto?.randomUUID) {
    // @ts-expect-error partial stub
    globalThis.crypto = { ...globalThis.crypto, randomUUID: () => "test-uuid" };
  } else {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("test-uuid-0000-0000-0000-000000000000");
  }
});

describe("stringifyCell", () => {
  it("renders null as NULL", () => {
    expect(stringifyCell(null)).toBe("NULL");
  });
  it("passes strings through and stringifies primitives", () => {
    expect(stringifyCell("hi")).toBe("hi");
    expect(stringifyCell(42)).toBe("42");
    expect(stringifyCell(true)).toBe("true");
  });
  it("uses preview for cell envelopes", () => {
    expect(stringifyCell({ kind: "binary", preview: "0xDEAD", byte_length: 2 })).toBe("0xDEAD");
  });
});

describe("captureResult truncation", () => {
  it("caps a 10k-row result to 100 rows, marks truncated, keeps true row_count", () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => [`r${i}`, i]);
    const att = captureResult(["a", "b"], rows, false);
    expect(att.rows.length).toBe(100);
    expect(att.truncated).toBe(true);
    expect(att.row_count).toBe(10_000);
  });
  it("does not mark truncated for a small untruncated result", () => {
    const att = captureResult(["a"], [["x"], ["y"]], false);
    expect(att.rows.length).toBe(2);
    expect(att.truncated).toBe(false);
    expect(att.row_count).toBe(2);
  });
  it("propagates source truncation even when under the row cap", () => {
    const att = captureResult(["a"], [["x"]], true);
    expect(att.truncated).toBe(true);
  });
});
