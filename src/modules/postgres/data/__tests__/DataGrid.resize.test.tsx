/**
 * DataGrid column-resize tests (task 4.8).
 *
 * Verifies that:
 * 1. Type-derived default widths are applied on first render.
 * 2. Dragging the resize handle on the "email" column updates its width.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { DataGrid } from "../DataGrid";
import type { DataGridProps } from "../DataGrid";
import type { UseEditBufferResult } from "../useEditBuffer";
import type { DataColumn } from "../types";

// ---------------------------------------------------------------------------
// Minimal stub for UseEditBufferResult
// ---------------------------------------------------------------------------
function makeBuffer(): UseEditBufferResult {
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
  };
}

// ---------------------------------------------------------------------------
// Column fixtures
// ---------------------------------------------------------------------------
const columns: DataColumn[] = [
  { name: "id", data_type: "uuid", ordinal_position: 1, is_nullable: false },
  { name: "email", data_type: "text", ordinal_position: 2, is_nullable: true },
  {
    name: "created_at",
    data_type: "timestamptz",
    ordinal_position: 3,
    is_nullable: true,
  },
  {
    name: "is_active",
    data_type: "boolean",
    ordinal_position: 4,
    is_nullable: true,
  },
];

function buildProps(overrides: Partial<DataGridProps> = {}): DataGridProps {
  return {
    columns,
    rows: [],
    pageSize: 50,
    orderBy: [],
    status: "ready",
    nextError: null,
    reachedEnd: true,
    selection: { anchor: null, active: null },
    isReadOnly: true,
    pkColumns: null, // no PK → isKey: false for all columns
    enumValuesByColumn: {},
    buffer: makeBuffer(),
    connectionId: "test-conn",
    schema: "public",
    relation: "users",
    onSelectionChange: vi.fn(),
    onSortChange: vi.fn(),
    onLoadNextPage: vi.fn(),
    onRetryNextPage: vi.fn(),
    bulkEditActive: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Expected default widths per spec scenario:
//   id (uuid) = 280, email (text) = 200, created_at (timestamptz/date) = 168,
//   is_active (boolean) = 88
// ---------------------------------------------------------------------------
const EXPECTED_WIDTHS = [280, 200, 168, 88];

describe("DataGrid column widths", () => {
  it("renders header cells with type-derived default widths", () => {
    render(<DataGrid {...buildProps()} />);

    const headers = screen.getAllByRole("columnheader");
    expect(headers).toHaveLength(4);

    headers.forEach((header, i) => {
      expect(header.style.width).toBe(`${EXPECTED_WIDTHS[i]}px`);
    });
  });

  it("dragging the email handle updates email header to 320px", async () => {
    render(<DataGrid {...buildProps()} />);

    // The email header is the second column header.
    const emailHeader = screen.getAllByRole("columnheader")[1]!;

    // The ResizeHandle renders as a div inside the header. We target it by
    // looking for the child div that has the resize handle class (it is the
    // last child of the header and has no textContent).
    // ResizeHandle renders a <div> with no text. We find the hit area by
    // querying within the email header.
    const handle = emailHeader.querySelector("div")!;
    expect(handle).toBeTruthy();

    // Simulate pointer capture: jsdom doesn't implement setPointerCapture,
    // so we stub it.
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();

    // Start drag at x=100 (startWidth=200).
    act(() => {
      handle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          clientX: 100,
          pointerId: 1,
        }),
      );
    });

    // Move 120px to the right → 200 + 120 = 320.
    act(() => {
      handle.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: 220,
          pointerId: 1,
        }),
      );
    });

    // Release.
    act(() => {
      handle.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: 220,
          pointerId: 1,
        }),
      );
    });

    // After the drag, the email header should be 320px wide.
    const updatedEmailHeader = screen.getAllByRole("columnheader")[1]!;
    expect(updatedEmailHeader.style.width).toBe("320px");
  });
});
