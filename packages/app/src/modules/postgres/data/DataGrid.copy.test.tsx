/**
 * DataGrid ⌘C copy integration tests (issue #213).
 *
 * Verifies that row-range copy works via the keydown handler (not via a native
 * window "copy" event) and that single-cell copy precedence is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { DataGrid } from "./DataGrid";
import type { DataGridProps } from "./DataGrid";
import type { UseEditBufferResult } from "./useEditBuffer";
import type { CellValue, DataColumn } from "./types";

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

function makeBuffer(overrides: Partial<UseEditBufferResult> = {}): UseEditBufferResult {
  return {
    rows: new Map(),
    hasDirty: false,
    dirtyCounts: { updates: 0, inserts: 0, deletes: 0 },
    getRowEdits: () => undefined,
    getDisplayValue: (_rk, serverRow, columns, columnName) => {
      const idx = columns.indexOf(columnName);
      return idx >= 0 ? (serverRow[idx] ?? null) : null;
    },
    isCellDirty: () => false,
    isRowDeleted: () => false,
    setCellEdit: vi.fn(),
    markRowDelete: vi.fn(),
    markRowUndelete: vi.fn(),
    addInsertRow: vi.fn(() => "tmp:1"),
    removeInsertRow: vi.fn(),
    undo: vi.fn(),
    clear: vi.fn(),
    commitSuccess: vi.fn(),
    toEditOps: () => [],
    toRowKeys: () => [],
    bulkSetCellEdit: vi.fn(),
    bulkDeleteToggle: vi.fn(),
    ...overrides,
  };
}

const columns: DataColumn[] = [
  { name: "id", data_type: "int4", ordinal_position: 1, is_nullable: false },
  { name: "name", data_type: "text", ordinal_position: 2, is_nullable: true },
];

function makeRows(count: number): DataGridProps["rows"] {
  return Array.from({ length: count }, (_, i) => ({
    rowKey: `key-${i}`,
    cells: [i + 1, `row-${i}`] as CellValue[],
    source: "server" as const,
  }));
}

function buildProps(overrides: Partial<DataGridProps> = {}): DataGridProps {
  return {
    columns,
    rows: makeRows(5),
    pageSize: 50,
    orderBy: [],
    status: "ready",
    nextError: null,
    reachedEnd: true,
    selection: { anchor: null, active: null },
    activeCell: null,
    bulkEditActive: false,
    isReadOnly: false,
    pkColumns: ["id"],
    enumValuesByColumn: {},
    buffer: makeBuffer(),
    connectionId: "conn-1",
    schema: "public",
    relation: "test",
    onSelectionChange: vi.fn(),
    onActiveCellChange: vi.fn(),
    onSortChange: vi.fn(),
    onLoadNextPage: vi.fn(),
    onRetryNextPage: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  writeText.mockClear();
  toastShow.mockClear();
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => true);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find rendered data rows by the [data-selected] attribute (same as contextMenu tests).
 */
function getDataRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-selected]"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DataGrid ⌘C row-range copy (issue #213)", () => {
  it("Cmd+C with row-range selection copies rows 0,1,2 as 3-line TSV", async () => {
    const { container } = render(
      <DataGrid
        {...buildProps({
          selection: { anchor: 0, active: 2 },
          activeCell: null,
        })}
      />,
    );

    const gridRoot = container.querySelector("[tabindex='0']") as HTMLElement;
    fireEvent.keyDown(gridRoot, { key: "c", metaKey: true });

    await waitFor(() => expect(writeText).toHaveBeenCalled());

    const text = writeText.mock.calls[0]![0] as string;
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    // Each line should contain a tab (two columns: id and name)
    expect(lines[0]).toContain("\t");
    // Row 0: id=1, name="row-0"
    expect(lines[0]).toBe("1\trow-0");
  });

  it("Cmd+C with activeCell set copies single cell (precedence unchanged)", async () => {
    const { container } = render(
      <DataGrid
        {...buildProps({
          activeCell: { row: 0, col: 0 },
          selection: { anchor: null, active: null },
        })}
      />,
    );

    const gridRoot = container.querySelector("[tabindex='0']") as HTMLElement;
    fireEvent.keyDown(gridRoot, { key: "c", metaKey: true });

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("1"));
  });
});

describe("DataGrid ⌘C copy error toasts (commit 3)", () => {
  it("shows error toast when clipboard write fails on row-range copy", async () => {
    writeText.mockRejectedValueOnce(new Error("nope"));
    const { container } = render(
      <DataGrid
        {...buildProps({
          selection: { anchor: 0, active: 2 },
          activeCell: null,
        })}
      />,
    );

    const gridRoot = container.querySelector("[tabindex='0']") as HTMLElement;
    gridRoot.focus();
    fireEvent.keyDown(gridRoot, { key: "c", metaKey: true });

    await waitFor(() =>
      expect(toastShow).toHaveBeenCalledWith(expect.any(String), "error"),
    );
  });

  it("does NOT show toast when clipboard write succeeds on row-range copy", async () => {
    writeText.mockResolvedValue(undefined);
    const { container } = render(
      <DataGrid
        {...buildProps({
          selection: { anchor: 0, active: 2 },
          activeCell: null,
        })}
      />,
    );

    const gridRoot = container.querySelector("[tabindex='0']") as HTMLElement;
    gridRoot.focus();
    fireEvent.keyDown(gridRoot, { key: "c", metaKey: true });

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(toastShow).not.toHaveBeenCalled();
  });
});

describe("DataGrid gutter row-select (issue #213 commit 2)", () => {
  it("clicking a row's gutter selects that row", () => {
    const onSelectionChange = vi.fn();
    const onActiveCellChange = vi.fn();
    const { container } = render(
      <DataGrid
        {...buildProps({
          selection: { anchor: null, active: null },
          activeCell: null,
          onSelectionChange,
          onActiveCellChange,
        })}
      />,
    );

    const rows = getDataRows(container);
    expect(rows.length).toBeGreaterThan(0);

    // The gutter cell is the first child div of the row element, identified by title="Select row"
    const gutterCell = rows[0]!.querySelector<HTMLElement>("[title='Select row']");
    expect(gutterCell).not.toBeNull();

    fireEvent.mouseDown(gutterCell!);

    expect(onSelectionChange).toHaveBeenCalledWith({ anchor: 0, active: 0 });
    expect(onActiveCellChange).toHaveBeenCalledWith(null);
  });

  it("gutter-select then ⌘C copies that row", async () => {
    // Render with row 1 already selected (anchor=1, active=1) and no activeCell
    const { container } = render(
      <DataGrid
        {...buildProps({
          selection: { anchor: 1, active: 1 },
          activeCell: null,
        })}
      />,
    );

    const gridRoot = container.querySelector("[tabindex='0']") as HTMLElement;
    gridRoot.focus();
    fireEvent.keyDown(gridRoot, { key: "c", metaKey: true });

    // Row 1 has cells [2, "row-1"] → TSV: "2\trow-1"
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = writeText.mock.calls[0]![0] as string;
    expect(text).toBe("2\trow-1");
  });
});
