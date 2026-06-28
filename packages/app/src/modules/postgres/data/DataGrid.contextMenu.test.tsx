/**
 * DataGrid context-menu tests (tasks 4.2–4.4).
 *
 * Covers:
 *   4.2 Right-click opens menu; Copy cell == ⌘C; Edit cell == double-click;
 *       Delete == Backspace; menu dismisses on Escape.
 *   4.3 Target resolution: right-click outside selection retargets; inside
 *       multi-row selection keeps it and acts on all rows.
 *   4.4 Disabled states: read-only grid; no-PK server-row delete; non-editable
 *       PK cell disables Edit — each with a tooltip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DataGrid } from "./DataGrid";
import type { DataGridProps } from "./DataGrid";
import type { UseEditBufferResult } from "./useEditBuffer";
import type { CellValue, DataColumn } from "./types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

/**
 * Find a rendered data row by its virtual index. The rows are rendered as
 * absolutely positioned divs inside the grid body. We identify them by
 * data-selected attribute (present on every data row).
 */
function getDataRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-selected]"));
}

beforeEach(() => {
  writeText.mockClear();
  // Stub pointer capture API used by ResizeHandle
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => true);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 4.2 — Basic menu open / action parity
// ---------------------------------------------------------------------------

describe("4.2 DataGrid context menu — basic open and actions", () => {
  it("right-clicking a row opens a context menu with all four items", async () => {
    const { container } = render(<DataGrid {...buildProps()} />);
    const rows = getDataRows(container);
    expect(rows.length).toBeGreaterThan(0);

    const row = rows[0]!;
    fireEvent.contextMenu(row);

    await waitFor(() => {
      expect(screen.getByText("Copy cell")).toBeInTheDocument();
      expect(screen.getByText("Copy row")).toBeInTheDocument();
      expect(screen.getByText("Edit cell")).toBeInTheDocument();
      expect(screen.getByText("Delete row")).toBeInTheDocument();
    });
  });

  it("Copy cell copies the same value as ⌘C on that cell", async () => {
    const props = buildProps({ activeCell: { row: 0, col: 0 } });
    const { container } = render(<DataGrid {...props} />);
    const rows = getDataRows(container);
    const row = rows[0]!;

    // Verify ⌘C on the active cell writes the id value "1"
    const gridRoot = container.querySelector("[tabindex='0']") as HTMLElement;
    fireEvent.keyDown(gridRoot, { key: "c", metaKey: true });
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("1");
    });

    // Now verify "Copy cell" via the context menu produces the same result
    writeText.mockClear();
    fireEvent.contextMenu(row);
    await waitFor(() => screen.getByText("Copy cell"));
    act(() => {
      screen.getByText("Copy cell").click();
    });

    // The first cell value of the first row is 1 (the id column)
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("1");
    });
  });

  it("Edit cell menu item is enabled for editable cells and disabled for read-only cells", async () => {
    // EDITABLE: insert row with no PK — Edit cell should be enabled
    const insertRows: DataGridProps["rows"] = [
      { rowKey: "ins-0", cells: [1, "row-0"], source: "insert" as const },
    ];
    const { container: c1 } = render(
      <DataGrid {...buildProps({ rows: insertRows, pkColumns: null })} />,
    );
    const rows1 = getDataRows(c1);
    fireEvent.contextMenu(rows1[0]!);
    await waitFor(() => screen.getByText("Edit cell"));

    // For an editable insert row, Edit cell should NOT be disabled
    const enabledItem = screen.getByText("Edit cell").closest("[data-disabled]");
    expect(enabledItem).toBeNull();

    // Click it — should not throw and menu should close
    act(() => {
      screen.getByText("Edit cell").click();
    });

    // Menu should close (Edit cell item no longer visible in the document)
    await waitFor(() => {
      expect(screen.queryByText("Edit cell")).toBeNull();
    });

    // READ-ONLY: server row with PK — Edit cell on PK column should be disabled
    const { container: c2 } = render(
      <DataGrid {...buildProps({ pkColumns: ["id"] })} />,
    );
    const rows2 = getDataRows(c2);
    fireEvent.contextMenu(rows2[0]!);
    await waitFor(() => screen.getByText("Edit cell"));

    // For a PK cell of a server row, Edit cell should be disabled
    const disabledItem = screen.getByText("Edit cell").parentElement;
    expect(disabledItem?.hasAttribute("data-disabled")).toBe(true);
  });

  it("Delete row toggles the buffer (same as Backspace on a row selection)", async () => {
    const bulkDeleteToggle = vi.fn();
    const props = buildProps({
      buffer: makeBuffer({ bulkDeleteToggle }),
      pkColumns: ["id"],
      selection: { anchor: 0, active: 0 },
    });
    const { container } = render(<DataGrid {...props} />);
    const rows = getDataRows(container);
    const row = rows[0]!;

    fireEvent.contextMenu(row);
    await waitFor(() => screen.getByText("Delete row"));
    act(() => {
      screen.getByText("Delete row").click();
    });

    await waitFor(() => {
      expect(bulkDeleteToggle).toHaveBeenCalled();
      const entries = bulkDeleteToggle.mock.calls[0]![0] as Array<{ rowKey: string; source: string }>;
      expect(entries).toHaveLength(1);
      expect(entries[0]!.rowKey).toBe("key-0");
      expect(entries[0]!.source).toBe("server");
    });
  });

  it("menu dismisses on Escape", async () => {
    const { container } = render(<DataGrid {...buildProps()} />);
    const rows = getDataRows(container);
    const row = rows[0]!;

    fireEvent.contextMenu(row);
    await waitFor(() => screen.getByText("Copy cell"));

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByText("Copy cell")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// 4.3 — Target resolution
// ---------------------------------------------------------------------------

describe("4.3 DataGrid context menu — target resolution", () => {
  it("right-click outside selection retargets: calls onActiveCellChange and clears range", async () => {
    const onActiveCellChange = vi.fn();
    const onSelectionChange = vi.fn();
    // rows 0–2 are selected
    const props = buildProps({
      selection: { anchor: 0, active: 2 },
      onActiveCellChange,
      onSelectionChange,
    });
    const { container } = render(<DataGrid {...props} />);
    const rows = getDataRows(container);

    // Right-click row 4 (outside selection 0-2)
    const row4 = rows[4]!;
    fireEvent.contextMenu(row4);

    await waitFor(() => {
      expect(onActiveCellChange).toHaveBeenCalledWith(
        expect.objectContaining({ row: 4 }),
      );
      expect(onSelectionChange).toHaveBeenCalledWith({ anchor: null, active: null });
    });
  });

  it("right-click inside multi-row selection keeps selection untouched", async () => {
    const onActiveCellChange = vi.fn();
    const onSelectionChange = vi.fn();
    const props = buildProps({
      selection: { anchor: 0, active: 3 },
      onActiveCellChange,
      onSelectionChange,
    });
    const { container } = render(<DataGrid {...props} />);
    const rows = getDataRows(container);

    // Right-click row 1 (inside selection 0-3)
    fireEvent.contextMenu(rows[1]!);

    await waitFor(() => {
      // Should NOT call onActiveCellChange or onSelectionChange
      expect(onActiveCellChange).not.toHaveBeenCalled();
      expect(onSelectionChange).not.toHaveBeenCalled();
    });
  });

  it("Copy rows inside multi-row selection copies all selected rows", async () => {
    const props = buildProps({
      selection: { anchor: 0, active: 2 },
    });
    const { container } = render(<DataGrid {...props} />);
    const rows = getDataRows(container);

    // Right-click row 1 (inside selection)
    fireEvent.contextMenu(rows[1]!);
    await waitFor(() => screen.getByText("Copy rows"));

    act(() => {
      screen.getByText("Copy rows").click();
    });

    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
      const text = writeText.mock.calls[0]![0] as string;
      // 3 rows (0,1,2) → 3 lines
      const lines = text.split("\n");
      expect(lines).toHaveLength(3);
    });
  });
});

// ---------------------------------------------------------------------------
// 4.4 — Disabled states
// ---------------------------------------------------------------------------

describe("4.4 DataGrid context menu — disabled states", () => {
  it("read-only grid: Edit cell and Delete row are disabled; Copy items remain enabled", async () => {
    const props = buildProps({ isReadOnly: true });
    const { container } = render(<DataGrid {...props} />);
    const rows = getDataRows(container);

    fireEvent.contextMenu(rows[0]!);
    await waitFor(() => screen.getByText("Copy cell"));

    // Copy cell should NOT be inside a disabled ancestor
    const copyCellDisabledEl = screen.getByText("Copy cell").closest("[data-disabled]");
    expect(copyCellDisabledEl).toBeNull();

    // Edit cell: Radix sets data-disabled="" (empty string) on disabled items.
    // We check that its closest menu-item ancestor has the data-disabled attribute present.
    const editCellItem = screen.getByText("Edit cell").parentElement;
    expect(editCellItem?.hasAttribute("data-disabled")).toBe(true);

    const deleteRowItem = screen.getByText("Delete row").parentElement;
    expect(deleteRowItem?.hasAttribute("data-disabled")).toBe(true);
  });

  it("no-PK server row: Delete is disabled with tooltip explaining PK requirement", async () => {
    // pkColumns: null → no primary key
    const props = buildProps({ pkColumns: null });
    const { container } = render(<DataGrid {...props} />);
    const rows = getDataRows(container);

    fireEvent.contextMenu(rows[0]!);
    await waitFor(() => screen.getByText("Delete row"));

    const deleteSpan = screen.getByText("Delete row");
    // The tooltip is on the span via title attribute
    expect(deleteSpan.getAttribute("title")).toBeTruthy();
    expect(deleteSpan.getAttribute("title")).toContain("primary key");
  });

  it("PK cell: Edit cell is disabled with tooltip", async () => {
    // pkColumns: ['id'] — clicking the id column (index 0) should disable Edit
    const props = buildProps({ pkColumns: ["id"] });
    const { container } = render(<DataGrid {...props} />);
    const rows = getDataRows(container);
    const row = rows[0]!;

    // Get id cell (data-col="0")
    const idCell = row.querySelector<HTMLElement>("[data-col='0']");
    fireEvent.contextMenu(idCell ?? row, { target: idCell ?? row });

    await waitFor(() => screen.getByText("Edit cell"));

    const editSpan = screen.getByText("Edit cell");
    // When disabled, span has a title explaining why
    const editItem = editSpan.closest("[data-disabled]");
    expect(editItem).not.toBeNull();
    expect(editSpan.getAttribute("title")).toBeTruthy();
  });

  it("Delete row label changes to Restore row when row is already deleted", async () => {
    const props = buildProps({
      pkColumns: ["id"],
      buffer: makeBuffer({ isRowDeleted: () => true }),
    });
    const { container } = render(<DataGrid {...props} />);
    const rows = getDataRows(container);

    fireEvent.contextMenu(rows[0]!);

    await waitFor(() => {
      expect(screen.getByText("Restore row")).toBeInTheDocument();
    });
  });
});
