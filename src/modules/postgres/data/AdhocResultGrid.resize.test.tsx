/**
 * Task 5.5 — AdhocResultGrid resize behaviour
 *
 * Covers:
 * - Default column widths per type (integer → 120, text → 200, timestamptz → 168)
 * - Dragging a handle updates the in-memory width
 * - Changing the columns signature (prop shape) remounts the inner component and
 *   resets all widths to type-derived defaults
 * - No setSetting (disk-write) call is ever made — ad-hoc grids are in-memory only
 */
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { AdhocResultGrid } from "./AdhocResultGrid";
import type { DataColumn, CellValue } from "./types";
import { BASE_WIDTH_BY_CATEGORY } from "@/platform/table/columnWidths";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the settings API so we can assert setSetting is never called.
vi.mock("@/platform/settings/api", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

// jsdom does not implement pointer capture — polyfill.
beforeEach(() => {
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => true);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeColumns(names: Array<{ name: string; data_type: string }>): DataColumn[] {
  return names.map(({ name, data_type }, i) => ({
    name,
    data_type,
    ordinal_position: i + 1,
    is_nullable: true,
  }));
}

const COL_A: { name: string; data_type: string } = { name: "a", data_type: "integer" };
const COL_B: { name: string; data_type: string } = { name: "b", data_type: "text" };
const COL_C: { name: string; data_type: string } = { name: "c", data_type: "timestamptz" };
const COL_D: { name: string; data_type: string } = { name: "d", data_type: "boolean" };

const INITIAL_COLUMNS = makeColumns([COL_A, COL_B, COL_C]);
const CHANGED_COLUMNS = makeColumns([COL_A, COL_B, COL_D]);

const ROWS: CellValue[][] = [
  [1, "hello", "2024-01-01T00:00:00Z"],
  [2, "world", "2024-06-15T12:00:00Z"],
];

// Helper to fire pointer events on an element
function pointerDown(el: Element, clientX: number) {
  fireEvent.pointerDown(el, { clientX, pointerId: 1, bubbles: true });
}
function pointerMove(el: Element, clientX: number) {
  fireEvent.pointerMove(el, { clientX, pointerId: 1, bubbles: true });
}
function pointerUp(el: Element, clientX: number) {
  fireEvent.pointerUp(el, { clientX, pointerId: 1, bubbles: true });
}

// ---------------------------------------------------------------------------
// Wrapper component — lets us swap columns prop to trigger signature change
// ---------------------------------------------------------------------------

function GridWrapper({ initialColumns }: { initialColumns: DataColumn[] }) {
  const [columns, setColumns] = useState(initialColumns);
  const [rows] = useState<CellValue[][]>(ROWS);
  return (
    <>
      <button
        data-testid="swap-columns"
        onClick={() => setColumns(CHANGED_COLUMNS)}
      />
      <AdhocResultGrid columns={columns} rows={rows} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AdhocResultGrid resize", () => {
  it("5.5a: renders default widths matching type categories", () => {
    const { container } = render(
      <AdhocResultGrid columns={INITIAL_COLUMNS} rows={ROWS} />,
    );

    // Header cells — find by role
    const headers = container.querySelectorAll("[role='columnheader']");
    expect(headers).toHaveLength(3);

    // a: integer → numeric → 120
    expect((headers[0] as HTMLElement).style.width).toBe(
      `${BASE_WIDTH_BY_CATEGORY.numeric}px`,
    );
    // b: text → text → 200
    expect((headers[1] as HTMLElement).style.width).toBe(
      `${BASE_WIDTH_BY_CATEGORY.text}px`,
    );
    // c: timestamptz → date → 168
    expect((headers[2] as HTMLElement).style.width).toBe(
      `${BASE_WIDTH_BY_CATEGORY.date}px`,
    );
  });

  it("5.5b: dragging column b's handle updates its width to 280px", () => {
    const { container } = render(
      <AdhocResultGrid columns={INITIAL_COLUMNS} rows={ROWS} />,
    );

    const headers = container.querySelectorAll("[role='columnheader']");
    const bHeader = headers[1] as HTMLElement;

    // Find all direct children that could be the handle (the div rendered by ResizeHandle)
    const allChildren = Array.from(bHeader.children);
    // ResizeHandle renders a div with the handle class; it is the last child
    const resizeHandle = allChildren[allChildren.length - 1] as Element;

    // Drag from 0 to 80px → width becomes 200 + 80 = 280
    pointerDown(resizeHandle, 0);
    pointerMove(resizeHandle, 80); // +80 → 280
    pointerUp(resizeHandle, 80);

    // b header cell should now show 280px
    expect(bHeader.style.width).toBe("280px");
  });

  it("5.5c: changing columns signature resets all widths to type defaults", async () => {
    const { container, getByTestId } = render(
      <GridWrapper initialColumns={INITIAL_COLUMNS} />,
    );

    // First, drag b to 280px
    let headers = container.querySelectorAll("[role='columnheader']");
    const bHeader = headers[1] as HTMLElement;
    const allChildren = Array.from(bHeader.children);
    const resizeHandle = allChildren[allChildren.length - 1] as Element;

    pointerDown(resizeHandle, 0);
    pointerMove(resizeHandle, 80); // +80 → 280
    pointerUp(resizeHandle, 80);

    expect(bHeader.style.width).toBe("280px");

    // Now swap columns — triggers signature change and inner component remount
    act(() => {
      fireEvent.click(getByTestId("swap-columns"));
    });

    // After remount, fetch fresh header references
    headers = container.querySelectorAll("[role='columnheader']");
    expect(headers).toHaveLength(3);

    // a: integer → numeric → 120
    expect((headers[0] as HTMLElement).style.width).toBe(
      `${BASE_WIDTH_BY_CATEGORY.numeric}px`,
    );
    // b: text → text → 200 (reset to default; was 280)
    expect((headers[1] as HTMLElement).style.width).toBe(
      `${BASE_WIDTH_BY_CATEGORY.text}px`,
    );
    // d: boolean → boolean → 88
    expect((headers[2] as HTMLElement).style.width).toBe(
      `${BASE_WIDTH_BY_CATEGORY.boolean}px`,
    );
  });

  it("5.5d: setSetting is never called (no disk persistence)", async () => {
    const { setSetting } = await import("@/platform/settings/api");
    const setSettingMock = vi.mocked(setSetting);

    const { container } = render(
      <AdhocResultGrid columns={INITIAL_COLUMNS} rows={ROWS} />,
    );

    // Drag column a
    const headers = container.querySelectorAll("[role='columnheader']");
    const aHeader = headers[0] as HTMLElement;
    const allChildren = Array.from(aHeader.children);
    const resizeHandle = allChildren[allChildren.length - 1] as Element;

    pointerDown(resizeHandle, 0);
    pointerMove(resizeHandle, 50);
    pointerUp(resizeHandle, 50);

    // Allow any timers / microtasks
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    // setSetting must never have been called for ad-hoc widths
    expect(setSettingMock).not.toHaveBeenCalled();
  });
});
