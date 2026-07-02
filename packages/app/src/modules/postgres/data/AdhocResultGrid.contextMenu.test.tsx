/**
 * AdhocResultGrid context-menu tests (task 6.3).
 *
 * Covers:
 *   - Menu shows ONLY "Copy cell" and "Copy row(s)" (no Edit cell / Delete row).
 *   - Right-click outside selection retargets to single row.
 *   - Right-click inside multi-row selection keeps range.
 *   - Copy cell matches ⌘C single-cell output.
 *   - Copy rows matches ⌘C row-range output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
// Helpers
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

// The grid's gutter click starts an "active" drag whose auto-scroll loop runs
// on requestAnimationFrame. That loop only matters in a real browser (it maps
// the cursor's clientY to a row while scrolling); under jsdom every rect is
// zero-height so a stray tick recomputes `active` to row 0 and clobbers the
// selection across act() boundaries. Stub rAF to a no-op so selection reflects
// only the explicit mousedown/shift-click gestures.
beforeEach(() => {
  writeText.mockClear();
  toastShow.mockClear();
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => true);
  // Neutralize any Radix scroll-lock / inert state left on <body> by an earlier
  // test (its own or another file's). Radix's RemoveScroll clears these
  // asynchronously on menu close; RTL's synchronous unmount can race ahead of
  // that, leaving `data-scroll-locked` + `pointer-events: none` on <body> which
  // makes the grid inert so its context menu never opens.
  document.body.style.pointerEvents = "";
  document.body.removeAttribute("data-scroll-locked");
});

afterEach(() => {
  cleanup();
  document.body.style.pointerEvents = "";
  document.body.removeAttribute("data-scroll-locked");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Menu content: copy-only
// ---------------------------------------------------------------------------

describe("AdhocResultGrid context menu — copy-only items", () => {
  it("right-click opens a menu with ONLY Copy cell and Copy row (no Edit, no Delete)", async () => {
    const { container } = render(
      <AdhocResultGrid columns={columns} rows={makeRows(3)} />,
    );
    const rows = getDataRows(container);
    expect(rows.length).toBeGreaterThan(0);

    fireEvent.contextMenu(rows[0]!);

    await waitFor(() => {
      expect(screen.getByText("Copy cell")).toBeInTheDocument();
      expect(screen.getByText("Copy row")).toBeInTheDocument();
    });

    // Edit cell and Delete row must NOT be present.
    expect(screen.queryByText("Edit cell")).toBeNull();
    expect(screen.queryByText("Delete row")).toBeNull();
    expect(screen.queryByText("Restore row")).toBeNull();
  });

  it("Copy cell via context menu copies the cell value of the right-clicked row", async () => {
    const { container } = render(
      <AdhocResultGrid columns={columns} rows={makeRows(3)} />,
    );
    const rows = getDataRows(container);

    // Right-click row 0 (id=1, name="row-0") — default col 0 = id.
    fireEvent.contextMenu(rows[0]!);
    await waitFor(() => screen.getByText("Copy cell"));

    act(() => {
      screen.getByText("Copy cell").click();
    });

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("1"));
  });

  it("Copy row via context menu copies the row as TSV", async () => {
    const { container } = render(
      <AdhocResultGrid columns={columns} rows={makeRows(3)} />,
    );
    const rows = getDataRows(container);

    fireEvent.contextMenu(rows[1]!);
    await waitFor(() => screen.getByText("Copy row"));

    act(() => {
      screen.getByText("Copy row").click();
    });

    // Row 1: id=2, name="row-1" → "2\trow-1"
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0]![0]).toBe("2\trow-1");
  });
});

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

describe("AdhocResultGrid context menu — target resolution", () => {
  it("right-click outside a single-row selection retargets to that single row", async () => {
    const onSelectionChange = vi.fn();
    const { container } = render(
      <AdhocResultGrid
        columns={columns}
        rows={makeRows(5)}
        onSelectionChange={onSelectionChange}
      />,
    );
    const rows = getDataRows(container);

    // Select row 0 via gutter.
    act(() => {
      fireEvent.mouseDown(rows[0]!.querySelector("[title='Select row']")!, { button: 0 });
    });

    onSelectionChange.mockClear();

    // Right-click row 4 (outside selection 0-0).
    act(() => {
      fireEvent.contextMenu(rows[4]!);
    });

    // Selection should be cleared (applyActiveCell was called).
    expect(onSelectionChange).toHaveBeenCalledWith({ anchor: null, active: null });

    await waitFor(() => screen.getByText("Copy row"));
    act(() => {
      screen.getByText("Copy row").click();
    });

    // Row 4: id=5, name="row-4" → "5\trow-4"
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0]![0]).toBe("5\trow-4");
  });

  it("right-click inside a selected row keeps selection and copies it", async () => {
    const onSelectionChange = vi.fn();
    const { container } = render(
      <AdhocResultGrid
        columns={columns}
        rows={makeRows(5)}
        onSelectionChange={onSelectionChange}
      />,
    );
    const rows = getDataRows(container);

    // Select only row 1 via gutter (single-row selection).
    act(() => {
      fireEvent.mouseDown(rows[1]!.querySelector("[title='Select row']")!, { button: 0 });
    });

    expect(onSelectionChange).toHaveBeenCalledWith({ anchor: 1, active: 1 });
    onSelectionChange.mockClear();

    // Right-click row 1 (inside the selection) — must NOT change selection.
    act(() => {
      fireEvent.contextMenu(rows[1]!);
    });

    // onSelectionChange must NOT have been called again.
    expect(onSelectionChange).not.toHaveBeenCalled();

    await waitFor(() => screen.getByText("Copy row"));
    act(() => {
      screen.getByText("Copy row").click();
    });

    // Row 1: id=2, name="row-1" → "2\trow-1"
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0]![0]).toBe("2\trow-1");
  });

  it("right-click inside multi-row selection copies all selected rows via Copy rows", async () => {
    const { container } = render(
      <AdhocResultGrid columns={columns} rows={makeRows(5)} />,
    );
    const rows = getDataRows(container);

    // Select row 0 via gutter, then shift-click row 2.
    act(() => {
      fireEvent.mouseDown(rows[0]!.querySelector("[title='Select row']")!, { button: 0 });
    });
    // After act(), the component has re-rendered with selection.anchor=0.
    act(() => {
      fireEvent.mouseDown(rows[2]!.querySelector("[title='Select row']")!, {
        button: 0,
        shiftKey: true,
      });
    });

    // Right-click row 1 (inside selection 0-2).
    act(() => {
      fireEvent.contextMenu(rows[1]!);
    });

    await waitFor(() => screen.getByText("Copy rows"));
    act(() => {
      screen.getByText("Copy rows").click();
    });

    // 3 rows (0,1,2) → 3-line TSV.
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = writeText.mock.calls[0]![0] as string;
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("1\trow-0");
    expect(lines[1]).toBe("2\trow-1");
    expect(lines[2]).toBe("3\trow-2");
  });
});
