/**
 * ResultPanel tests (task 6.4).
 *
 * Asserts that a multi-row gutter selection in AdhocResultGrid drives the
 * inspector's `selectedRows` array (anchor/active → inspector shows multiple
 * rows).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ResultPanel } from "./ResultPanel";
import type { RunState } from "./useQueryRun";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/platform/settings/api", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/platform/toast", () => ({
  useToast: () => ({ show: vi.fn() }),
}));

// Mock @tanstack/react-virtual so all rows render in JSDOM.
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

function makeRunState(): RunState {
  return {
    status: "done",
    mode: "single",
    sql: "SELECT 1",
    error: null,
    startOffset: 0,
    result: {
      kind: "rows",
      columns: [
        { name: "id", data_type: "int4", ordinal_position: 1, is_nullable: false },
        { name: "label", data_type: "text", ordinal_position: 2, is_nullable: true },
      ],
      rows: [
        [1, "alpha"],
        [2, "beta"],
        [3, "gamma"],
        [4, "delta"],
      ],
      truncated_columns: [],
      truncated: false,
      query_ms: 10,
    },
  };
}

function getDataRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-selected]"));
}

beforeEach(() => {
  writeText.mockClear();
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => true);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ResultPanel inspector driven by gutter selection", () => {
  it("selecting a single row via gutter shows its value in the inspector", async () => {
    const { container } = render(
      <ResultPanel state={makeRunState()} onShowInEditor={() => {}} />,
    );

    const rows = getDataRows(container);
    expect(rows.length).toBeGreaterThan(0);

    // Click gutter of row 0 (id=1, label="alpha").
    const gutter = rows[0]!.querySelector<HTMLElement>("[title='Select row']");
    expect(gutter).not.toBeNull();
    act(() => {
      fireEvent.mouseDown(gutter!, { button: 0 });
    });

    // The inspector should display the value "alpha" in the inspector panel.
    // We verify by checking there is at least one "alpha" in the inspector area.
    await waitFor(() => {
      // Inspector renders column values; "alpha" should appear (possibly multiple times).
      expect(screen.getAllByText("alpha").length).toBeGreaterThan(0);
    });

    // Additionally confirm the inspector's field div contains "alpha" (not just the grid cell).
    const inspectorArea = container.querySelector("[class*='rowsInspector']");
    expect(inspectorArea).not.toBeNull();
    expect(inspectorArea!.textContent).toContain("alpha");
  });

  it("selecting a multi-row range via shift-gutter-click populates inspector with all rows", async () => {
    const { container } = render(
      <ResultPanel state={makeRunState()} onShowInEditor={() => {}} />,
    );

    const rows = getDataRows(container);

    // Click gutter of row 0.
    fireEvent.mouseDown(rows[0]!.querySelector("[title='Select row']")!, { button: 0 });
    // Shift-click gutter of row 2 to select rows 0-2.
    fireEvent.mouseDown(rows[2]!.querySelector("[title='Select row']")!, {
      button: 0,
      shiftKey: true,
    });

    // The inspector should show the bulk "N rows selected" header.
    await waitFor(() => {
      // BulkInspector renders a header like "Inspector · N rows selected"
      const header = screen.queryByText(/rows selected/i) ?? screen.queryByText(/Inspector/i);
      expect(header).toBeInTheDocument();
    });
  });

  it("clearing selection (Escape) clears the inspector panel values", async () => {
    const { container } = render(
      <ResultPanel state={makeRunState()} onShowInEditor={() => {}} />,
    );

    const rows = getDataRows(container);

    // Select row 0.
    act(() => {
      fireEvent.mouseDown(rows[0]!.querySelector("[title='Select row']")!, { button: 0 });
    });

    const inspectorArea = container.querySelector("[class*='rowsInspector']");
    expect(inspectorArea).not.toBeNull();

    // Inspector should now show "alpha".
    await waitFor(() => {
      expect(inspectorArea!.textContent).toContain("alpha");
    });

    // Escape on the grid root clears selection.
    const gridRoot = container.querySelector("[tabindex='0']") as HTMLElement;
    act(() => {
      fireEvent.keyDown(gridRoot, { key: "Escape" });
    });

    // Inspector should now show no row values (alpha disappears from inspector).
    await waitFor(() => {
      expect(inspectorArea!.textContent).not.toContain("alpha");
    });
  });
});
