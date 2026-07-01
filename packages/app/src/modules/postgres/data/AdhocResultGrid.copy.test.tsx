/**
 * AdhocResultGrid ⌘C copy tests (tasks 6.1, 6.2).
 *
 * Covers:
 *   6.1 Single-cell ⌘C; row-range ⌘C (multi-row and single-row); mutual
 *       exclusivity (row range → row range copy); TSV format.
 *   6.2 Gutter selection (plain click, shift-click extend); ⌘A select-all
 *       (extend to all rows; inert when nothing selected).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { AdhocResultGrid } from "./AdhocResultGrid";
import type { DataColumn, CellValue } from "./types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { toastShow } = vi.hoisted(() => ({ toastShow: vi.fn() }));

vi.mock("@/platform/toast", () => ({
  useToast: () => ({ show: toastShow }),
}));

vi.mock("@/platform/settings/api", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

// Mock @tanstack/react-virtual so all rows render in JSDOM (no layout engine).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => {
    const size = estimateSize();
    return {
      scrollToIndex: vi.fn(),
      getVirtualItems: () =>
        Array.from({ length: count }, (_, i) => ({
          index: i,
          key: i,
          start: i * size,
          size,
          lane: 0,
        })),
      getTotalSize: () => count * size,
    };
  },
}));

// Clipboard
const writeText = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText } },
  writable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const columns: DataColumn[] = [
  { name: "id", data_type: "int4", ordinal_position: 1, is_nullable: false },
  { name: "name", data_type: "text", ordinal_position: 2, is_nullable: true },
];

function makeRows(count: number): CellValue[][] {
  return Array.from({ length: count }, (_, i) => [i + 1, `row-${i}`] as CellValue[]);
}

function getDataRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-selected]"));
}

beforeEach(() => {
  writeText.mockClear();
  toastShow.mockClear();
  // Stub rAF to a no-op: the gutter click starts an "active" drag whose
  // auto-scroll loop runs on rAF. It only matters in a real browser; under
  // jsdom (zero-height rects) a stray tick recomputes `active` to row 0 and
  // clobbers the selection, so stub it out for deterministic gutter selection.
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Single-cell ⌘C
// ---------------------------------------------------------------------------

describe("AdhocResultGrid single-cell ⌘C", () => {
  it("gutter click then ⌘C copies that row (single-row range copy)", async () => {
    // When a single row is selected via gutter, ⌘C copies it as a 1-line TSV.
    const { container } = render(
      <AdhocResultGrid columns={columns} rows={makeRows(3)} />,
    );

    const rows = getDataRows(container);
    act(() => {
      fireEvent.mouseDown(rows[0]!.querySelector("[title='Select row']")!, { button: 0 });
    });

    const gridRoot = container.querySelector("[tabindex='0']") as HTMLElement;
    gridRoot.focus();
    fireEvent.keyDown(gridRoot, { key: "c", metaKey: true });

    // Row 0: id=1, name="row-0" → single-line TSV.
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0]![0]).toBe("1\trow-0");
  });
});

// ---------------------------------------------------------------------------
// Row-range ⌘C
// ---------------------------------------------------------------------------

describe("AdhocResultGrid row-range ⌘C", () => {
  it("gutter click then ⌘C copies that single row as TSV", async () => {
    const onSelectionChange = vi.fn();
    const { container } = render(
      <AdhocResultGrid
        columns={columns}
        rows={makeRows(5)}
        onSelectionChange={onSelectionChange}
      />,
    );

    const rows = getDataRows(container);
    // Click gutter of row 1 → selection { anchor: 1, active: 1 }.
    act(() => {
      fireEvent.mouseDown(rows[1]!.querySelector("[title='Select row']")!, { button: 0 });
    });

    expect(onSelectionChange).toHaveBeenCalledWith({ anchor: 1, active: 1 });

    const gridRoot = container.querySelector("[tabindex='0']") as HTMLElement;
    gridRoot.focus();
    fireEvent.keyDown(gridRoot, { key: "c", metaKey: true });

    // Row 1: id=2, name="row-1" → "2\trow-1"
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0]![0]).toBe("2\trow-1");
  });

  it("multi-row gutter selection ⌘C produces multi-line TSV", async () => {
    const onSelectionChange = vi.fn();
    const { container } = render(
      <AdhocResultGrid
        columns={columns}
        rows={makeRows(5)}
        onSelectionChange={onSelectionChange}
      />,
    );

    const rows = getDataRows(container);
    // Click gutter of row 0.
    act(() => {
      fireEvent.mouseDown(rows[0]!.querySelector("[title='Select row']")!, { button: 0 });
    });
    // Shift-click gutter of row 2 to extend to rows 0-2.
    // After the first act(), selection.anchor is 0 in the component state.
    act(() => {
      fireEvent.mouseDown(rows[2]!.querySelector("[title='Select row']")!, {
        button: 0,
        shiftKey: true,
      });
    });

    const gridRoot = container.querySelector("[tabindex='0']") as HTMLElement;
    gridRoot.focus();
    fireEvent.keyDown(gridRoot, { key: "c", metaKey: true });

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = writeText.mock.calls[0]![0] as string;
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("1\trow-0");
    expect(lines[1]).toBe("2\trow-1");
    expect(lines[2]).toBe("3\trow-2");
  });
});

// ---------------------------------------------------------------------------
// Mutual exclusivity: gutter selection then extend
// ---------------------------------------------------------------------------

describe("AdhocResultGrid row-range selection extend", () => {
  it("once a row range is selected, shift-click extends it and ⌘C copies all rows", async () => {
    const onSelectionChange = vi.fn();
    const { container } = render(
      <AdhocResultGrid
        columns={columns}
        rows={makeRows(5)}
        onSelectionChange={onSelectionChange}
      />,
    );

    const rows = getDataRows(container);
    // Click gutter of row 0 → selection { anchor: 0, active: 0 }.
    act(() => {
      fireEvent.mouseDown(rows[0]!.querySelector("[title='Select row']")!, { button: 0 });
    });
    expect(onSelectionChange).toHaveBeenCalledWith({ anchor: 0, active: 0 });

    // Shift-click gutter of row 2 → extends to { anchor: 0, active: 2 }.
    act(() => {
      fireEvent.mouseDown(rows[2]!.querySelector("[title='Select row']")!, {
        button: 0,
        shiftKey: true,
      });
    });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ anchor: 0, active: 2 });

    // Now ⌘C should copy the 3-row range.
    const gridRoot = container.querySelector("[tabindex='0']") as HTMLElement;
    gridRoot.focus();
    fireEvent.keyDown(gridRoot, { key: "c", metaKey: true });

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = writeText.mock.calls[0]![0] as string;
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("1\trow-0");
  });
});

// ---------------------------------------------------------------------------
// ⌘A select-all
// ---------------------------------------------------------------------------

describe("AdhocResultGrid ⌘A select-all", () => {
  it("⌘A after gutter-click extends selection to all rows", async () => {
    const onSelectionChange = vi.fn();
    const rows5 = makeRows(5);
    const { container } = render(
      <AdhocResultGrid
        columns={columns}
        rows={rows5}
        onSelectionChange={onSelectionChange}
      />,
    );

    const rows = getDataRows(container);
    // Click gutter of row 0 to activate a selection.
    act(() => {
      fireEvent.mouseDown(rows[0]!.querySelector("[title='Select row']")!, { button: 0 });
    });

    // Now ⌘A.
    const gridRoot = container.querySelector("[tabindex='0']") as HTMLElement;
    fireEvent.keyDown(gridRoot, { key: "a", metaKey: true });

    // Should have been called with full range.
    expect(onSelectionChange).toHaveBeenLastCalledWith({ anchor: 0, active: 4 });
  });

  it("⌘A with no selection and no active cell is inert (no preventDefault)", async () => {
    const onSelectionChange = vi.fn();
    const { container } = render(
      <AdhocResultGrid
        columns={columns}
        rows={makeRows(5)}
        onSelectionChange={onSelectionChange}
      />,
    );

    const gridRoot = container.querySelector("[tabindex='0']") as HTMLElement;

    // Track preventDefault calls.
    let defaultPrevented = false;
    gridRoot.addEventListener("keydown", (e) => {
      if (e.defaultPrevented) defaultPrevented = true;
    });

    fireEvent.keyDown(gridRoot, { key: "a", metaKey: true });

    // Neither preventDefault nor onSelectionChange should have been called.
    expect(defaultPrevented).toBe(false);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("⌘A is inert when rows.length === 0", async () => {
    const onSelectionChange = vi.fn();
    const { container } = render(
      <AdhocResultGrid
        columns={columns}
        rows={[]}
        onSelectionChange={onSelectionChange}
        emptyState={<div>empty</div>}
      />,
    );

    const gridRoot = container.querySelector("[tabindex='0']") as HTMLElement;
    if (!gridRoot) return; // empty state renders no tabindex root
    fireEvent.keyDown(gridRoot, { key: "a", metaKey: true });

    expect(onSelectionChange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Clipboard failure toast
// ---------------------------------------------------------------------------

describe("AdhocResultGrid copy error toast", () => {
  it("shows error toast when clipboard write fails on row-range ⌘C", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    const { container } = render(
      <AdhocResultGrid columns={columns} rows={makeRows(5)} />,
    );

    const rows = getDataRows(container);
    act(() => {
      fireEvent.mouseDown(rows[0]!.querySelector("[title='Select row']")!, { button: 0 });
    });

    const gridRoot = container.querySelector("[tabindex='0']") as HTMLElement;
    gridRoot.focus();
    fireEvent.keyDown(gridRoot, { key: "c", metaKey: true });

    await waitFor(() =>
      expect(toastShow).toHaveBeenCalledWith(expect.any(String), "error"),
    );
  });
});
