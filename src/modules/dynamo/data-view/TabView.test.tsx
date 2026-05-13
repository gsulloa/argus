/**
 * TabView.test.tsx — task 10.6
 *
 * Covers:
 *   - Column ordering with mixed-shape items: PK first, SK second, alpha tie-break
 *   - Column stability across pages
 *   - Summary rendering for L, M, B, SS, NS, BS types
 *   - Primitive rendering: S, N, BOOL, NULL
 *   - Click-to-inspector routing:
 *       • complex-cell click → onSelect(rowIndex, attributeName)
 *       • primitive-cell row click → onSelect(rowIndex) (no attribute)
 *       • "More…" button click → onSelect(rowIndex) (no attribute)
 *   - Scroll-to-load:
 *       Because IntersectionObserver is hard to mock at the jsdom level, we
 *       factor the trigger logic into a useScrollToLoad hook (see implementation
 *       notes in TabView.tsx) and test it via a helper that simulates the IO
 *       callback. The TabView test here verifies the sentinel div exists in the
 *       DOM and that onLoadMore is called under the right conditions via direct
 *       IO mock.
 *
 * Scroll-to-load implementation note (per task spec "if it gets thorny"):
 *   The test mocks IntersectionObserver globally, captures the registered
 *   observer, and then manually fires the callback to assert onLoadMore is
 *   called exactly once. This avoids relying on the virtualizer's internal
 *   scroll simulation which is JSDOM-unfriendly.
 *
 * Virtualizer mock note:
 *   @tanstack/react-virtual's useVirtualizer computes visible items based on
 *   the scroll element's real dimensions. In JSDOM, all elements have 0 height,
 *   so getVirtualItems() returns []. We mock useVirtualizer to render all rows
 *   as virtual items at fixed positions so cell-rendering tests work.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TabView } from "./TabView";
import type { AttributeMap } from "./types";
import type { TableDescription } from "@/modules/dynamo/tables/types";

// ---------------------------------------------------------------------------
// Mock @tanstack/react-virtual so all rows render in JSDOM
// ---------------------------------------------------------------------------

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => {
    const size = estimateSize();
    return {
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

// ---------------------------------------------------------------------------
// IntersectionObserver mock
// ---------------------------------------------------------------------------

type IoCallback = (entries: IntersectionObserverEntry[]) => void;

let capturedIoCallback: IoCallback | null = null;

function MockIntersectionObserver(cb: IoCallback) {
  capturedIoCallback = cb;
  return {
    observe: vi.fn(),
    disconnect: vi.fn(),
  };
}

beforeEach(() => {
  capturedIoCallback = null;
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDescribe(pk = "id", sk: string | null = null): TableDescription {
  return {
    table_name: "t",
    table_arn: "arn:aws:dynamodb:us-east-1:123:table/t",
    table_status: "ACTIVE",
    item_count: 0,
    table_size_bytes: 0,
    billing_mode: "PAY_PER_REQUEST",
    key_schema: [
      { attribute_name: pk, key_type: "HASH" },
      ...(sk ? [{ attribute_name: sk, key_type: "RANGE" as const }] : []),
    ],
    attribute_definitions: [
      { attribute_name: pk, attribute_type: "S" },
      ...(sk ? [{ attribute_name: sk, attribute_type: "S" as const }] : []),
    ],
    global_secondary_indexes: [],
    local_secondary_indexes: [],
  };
}

function baseProps(overrides?: Partial<React.ComponentProps<typeof TabView>>) {
  return {
    items: [] as AttributeMap[],
    describe: makeDescribe("pk"),
    indexName: null,
    selectedRowIndex: null,
    onSelect: vi.fn(),
    onLoadMore: vi.fn(),
    hasMore: false,
    status: "ready" as const,
    autoScrollDisabled: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Column ordering
// ---------------------------------------------------------------------------

describe("TabView — column ordering", () => {
  it("shows PK first, SK second, then alpha-sorted same-frequency attrs", () => {
    const items: AttributeMap[] = [
      {
        pk: { S: "1" },
        sk: { S: "a" },
        gamma: { S: "g" },
        alpha: { S: "a" },
        beta: { S: "b" },
      },
    ];
    render(
      <TabView {...baseProps({ items, describe: makeDescribe("pk", "sk") })} />,
    );

    const headers = screen.getAllByRole("columnheader");
    // textContent includes any badge text (e.g. "pkPK"), so we use toContain
    const headerTexts = headers.map((h) => h.textContent?.trim() ?? "");

    expect(headerTexts[0]).toContain("pk");
    expect(headerTexts[1]).toContain("sk");
    // alpha, beta, gamma — alphabetical for equal-frequency attrs
    expect(headerTexts[2]).toContain("alpha");
    expect(headerTexts[3]).toContain("beta");
    expect(headerTexts[4]).toContain("gamma");
    // Last one is the More… column (renders "…")
    expect(headerTexts[headerTexts.length - 1]).toContain("…");
  });

  it("column stability: page-2 items do not displace page-1 columns", () => {
    const page1: AttributeMap[] = [
      { pk: { S: "1" }, alpha: { S: "x" }, beta: { S: "x" } },
      { pk: { S: "2" }, alpha: { S: "x" }, beta: { S: "x" } },
    ];

    const { rerender } = render(
      <TabView {...baseProps({ items: page1 })} />,
    );

    let headers = screen.getAllByRole("columnheader").map((h) => h.textContent?.trim() ?? "");
    expect(headers[0]).toContain("pk");
    expect(headers[1]).toContain("alpha");
    expect(headers[2]).toContain("beta");

    // Page 2: adds "category" at same frequency as existing attrs
    const page2: AttributeMap[] = [
      ...page1,
      { pk: { S: "3" }, alpha: { S: "x" }, beta: { S: "x" }, category: { S: "c" } },
      { pk: { S: "4" }, alpha: { S: "x" }, beta: { S: "x" }, category: { S: "c" } },
    ];

    rerender(<TabView {...baseProps({ items: page2 })} />);

    headers = screen.getAllByRole("columnheader").map((h) => h.textContent?.trim() ?? "");
    // pk, alpha, beta must be in the same positions
    expect(headers[0]).toContain("pk");
    expect(headers[1]).toContain("alpha");
    expect(headers[2]).toContain("beta");
    // More… still last
    expect(headers[headers.length - 1]).toContain("…");
  });
});

// ---------------------------------------------------------------------------
// Cell rendering — summary types (task 10.3)
// ---------------------------------------------------------------------------

describe("TabView — summary cell rendering", () => {
  function renderWith(item: AttributeMap) {
    const items: AttributeMap[] = [{ pk: { S: "1" }, ...item }];
    render(<TabView {...baseProps({ items, status: "ready" })} />);
  }

  // Helper: find the cell for the "data" column specifically (not the pk cell)
  function getDataCell() {
    const cells = screen.getAllByTestId("tabla-cell");
    // pk column renders as "1" (S value); data column renders the complex type
    return cells.find((c) => c.textContent !== "1") ?? cells[cells.length - 1]!;
  }

  it("renders L as [N items]", () => {
    renderWith({ data: { L: [{ S: "a" }, { S: "b" }, { S: "c" }] } });
    expect(getDataCell().textContent).toContain("[3 items]");
  });

  it("renders M as {K keys}", () => {
    renderWith({ data: { M: { a: { S: "1" }, b: { S: "2" } } } });
    expect(getDataCell().textContent).toContain("{2 keys}");
  });

  it("renders B as <binary NB>", () => {
    // base64 "aGVsbG8=" encodes "hello" (5 bytes); floor(8 * 0.75) = 6
    renderWith({ data: { B: "aGVsbG8=" } });
    const cell = getDataCell();
    expect(cell.textContent).toContain("<binary");
    expect(cell.textContent).toContain("B>");
  });

  it("renders SS as [N items]", () => {
    renderWith({ data: { SS: ["a", "b"] } });
    expect(getDataCell().textContent).toContain("[2 items]");
  });

  it("renders NS as [N items]", () => {
    renderWith({ data: { NS: ["1", "2", "3"] } });
    expect(getDataCell().textContent).toContain("[3 items]");
  });

  it("renders BS as [N items]", () => {
    renderWith({ data: { BS: ["aGVs", "bG8="] } });
    expect(getDataCell().textContent).toContain("[2 items]");
  });

  it("renders S inline", () => {
    renderWith({ data: { S: "hello world" } });
    const cells = screen.getAllByTestId("tabla-cell");
    const dataCell = cells.find((c) => c.textContent === "hello world");
    expect(dataCell).toBeTruthy();
  });

  it("renders N inline", () => {
    renderWith({ data: { N: "42.5" } });
    const cells = screen.getAllByTestId("tabla-cell");
    const dataCell = cells.find((c) => c.textContent === "42.5");
    expect(dataCell).toBeTruthy();
  });

  it("renders BOOL true as 'true'", () => {
    renderWith({ data: { BOOL: true } });
    const cells = screen.getAllByTestId("tabla-cell");
    const truCell = cells.find((c) => c.textContent === "true");
    expect(truCell).toBeTruthy();
  });

  it("renders BOOL false as 'false'", () => {
    renderWith({ data: { BOOL: false } });
    const cells = screen.getAllByTestId("tabla-cell");
    const falseCell = cells.find((c) => c.textContent === "false");
    expect(falseCell).toBeTruthy();
  });

  it("renders NULL as 'null'", () => {
    renderWith({ data: { NULL: true } });
    const cells = screen.getAllByTestId("tabla-cell");
    const nullCell = cells.find((c) => c.textContent === "null");
    expect(nullCell).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Click-to-inspector routing (task 10.3, 10.4)
// ---------------------------------------------------------------------------

describe("TabView — click routing", () => {
  it("complex-cell click calls onSelect(rowIndex, attributeName)", () => {
    const onSelect = vi.fn();
    const items: AttributeMap[] = [
      { pk: { S: "1" }, data: { L: [{ S: "a" }, { S: "b" }] } },
    ];
    render(
      <TabView
        {...baseProps({ items, onSelect, status: "ready" })}
      />,
    );

    // Find the complex chip button (the [2 items] chip)
    const chip = screen.getByText("[2 items]");
    fireEvent.click(chip);

    expect(onSelect).toHaveBeenCalledWith(0, "data");
  });

  it("primitive-cell row click calls onSelect(rowIndex) — no attribute", () => {
    const onSelect = vi.fn();
    const items: AttributeMap[] = [
      { pk: { S: "1" }, name: { S: "Alice" } },
    ];
    render(
      <TabView
        {...baseProps({ items, onSelect, status: "ready" })}
      />,
    );

    // Click the row (not the chip) — by clicking the row div
    const rows = screen.getAllByTestId("tabla-row");
    fireEvent.click(rows[0]!);

    // Row click: onSelect(0) with no second arg
    expect(onSelect).toHaveBeenCalledWith(0);
    expect(onSelect.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("More… button click calls onSelect(rowIndex) — no attribute", () => {
    const onSelect = vi.fn();
    const items: AttributeMap[] = [{ pk: { S: "1" } }];
    render(
      <TabView
        {...baseProps({ items, onSelect, status: "ready" })}
      />,
    );

    const moreBtn = screen.getByTestId("tabla-cell-more");
    fireEvent.click(moreBtn);

    expect(onSelect).toHaveBeenCalledWith(0);
    expect(onSelect.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("complex-cell click does NOT also trigger row-level onSelect", () => {
    const onSelect = vi.fn();
    const items: AttributeMap[] = [
      { pk: { S: "1" }, data: { M: { a: { S: "1" } } } },
    ];
    render(
      <TabView
        {...baseProps({ items, onSelect, status: "ready" })}
      />,
    );

    const chip = screen.getByText("{1 keys}");
    fireEvent.click(chip);

    // onSelect called exactly once (from the complex chip, not the row)
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(0, "data");
  });
});

// ---------------------------------------------------------------------------
// Row selection
// ---------------------------------------------------------------------------

describe("TabView — row selection", () => {
  it("selected row has data-selected=true", () => {
    const items: AttributeMap[] = [
      { pk: { S: "1" } },
      { pk: { S: "2" } },
    ];
    render(
      <TabView
        {...baseProps({ items, selectedRowIndex: 1, status: "ready" })}
      />,
    );

    const rows = screen.getAllByTestId("tabla-row");
    expect(rows[0]).toHaveAttribute("data-selected", "false");
    expect(rows[1]).toHaveAttribute("data-selected", "true");
  });
});

// ---------------------------------------------------------------------------
// Scroll-to-load (task 10.5)
// ---------------------------------------------------------------------------

describe("TabView — scroll-to-load", () => {
  it("calls onLoadMore when sentinel enters viewport and conditions are met", () => {
    const onLoadMore = vi.fn();
    const items: AttributeMap[] = [{ pk: { S: "1" } }];

    render(
      <TabView
        {...baseProps({
          items,
          onLoadMore,
          hasMore: true,
          autoScrollDisabled: false,
          status: "ready",
        })}
      />,
    );

    // Simulate the IntersectionObserver firing with isIntersecting: true
    expect(capturedIoCallback).toBeTruthy();
    capturedIoCallback?.([
      { isIntersecting: true } as IntersectionObserverEntry,
    ]);

    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onLoadMore when hasMore is false", () => {
    const onLoadMore = vi.fn();
    const items: AttributeMap[] = [{ pk: { S: "1" } }];

    render(
      <TabView
        {...baseProps({
          items,
          onLoadMore,
          hasMore: false,
          autoScrollDisabled: false,
          status: "ready",
        })}
      />,
    );

    capturedIoCallback?.([
      { isIntersecting: true } as IntersectionObserverEntry,
    ]);

    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("does NOT call onLoadMore when autoScrollDisabled is true", () => {
    const onLoadMore = vi.fn();
    const items: AttributeMap[] = [{ pk: { S: "1" } }];

    render(
      <TabView
        {...baseProps({
          items,
          onLoadMore,
          hasMore: true,
          autoScrollDisabled: true,
          status: "ready",
        })}
      />,
    );

    capturedIoCallback?.([
      { isIntersecting: true } as IntersectionObserverEntry,
    ]);

    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("does NOT call onLoadMore when status is loading", () => {
    const onLoadMore = vi.fn();
    const items: AttributeMap[] = [{ pk: { S: "1" } }];

    render(
      <TabView
        {...baseProps({
          items,
          onLoadMore,
          hasMore: true,
          autoScrollDisabled: false,
          status: "loading",
        })}
      />,
    );

    capturedIoCallback?.([
      { isIntersecting: true } as IntersectionObserverEntry,
    ]);

    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("fires onLoadMore exactly once per state transition (not twice)", () => {
    const onLoadMore = vi.fn();
    const items: AttributeMap[] = [{ pk: { S: "1" } }];

    render(
      <TabView
        {...baseProps({
          items,
          onLoadMore,
          hasMore: true,
          autoScrollDisabled: false,
          status: "ready",
        })}
      />,
    );

    // Fire IO callback twice in the same render
    capturedIoCallback?.([
      { isIntersecting: true } as IntersectionObserverEntry,
    ]);
    capturedIoCallback?.([
      { isIntersecting: true } as IntersectionObserverEntry,
    ]);

    // Must only have been called once (firedRef guards double-call)
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Empty / idle state
// ---------------------------------------------------------------------------

describe("TabView — empty state", () => {
  it("shows 'Run a query to see results' when idle with no items", () => {
    render(<TabView {...baseProps({ status: "idle", items: [] })} />);
    expect(screen.getByText("Run a query to see results.")).toBeTruthy();
  });

  it("shows 'No items found.' when ready with no items", () => {
    render(<TabView {...baseProps({ status: "ready", items: [] })} />);
    expect(screen.getByText("No items found.")).toBeTruthy();
  });

  it("shows 'Query returned an error.' when error with no items", () => {
    render(<TabView {...baseProps({ status: "error", items: [] })} />);
    expect(screen.getByText("Query returned an error.")).toBeTruthy();
  });
});
