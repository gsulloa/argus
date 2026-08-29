// What this file proves, and what it does not:
//
// These tests mock `@dnd-kit/core` and `@dnd-kit/sortable` the same way
// `FilterBar.dnd.test.tsx` does — capturing `onDragEnd` out of `DndContext`
// and stubbing `useSortable`/`SortableContext` to no-ops — then invoke the
// captured handler directly with synthetic `{active, over}` events. That
// locks the id→index mapping in `handleDragEnd` and its no-op guards (the
// parts of this component that are pure logic), plus the click-to-activate
// and click-to-close paths and the tab ARIA shape.
//
// It does NOT prove a real pointer/keyboard drag starts and completes in a
// WKWebView. A jsdom test exercising the *old* native-HTML5-DnD
// implementation the same way would also have passed — jsdom's synthetic
// drag events carry none of the Tauri/WebKit behaviour that broke it in the
// running app. That claim is established by the manual verification pass
// in the running app (task group 4 of the change), not by anything here.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import type { Tab } from "./types";

// Capture the onDragEnd callback from DndContext so tests can simulate a drop.
const capturedOnDragEnd: { current: ((e: unknown) => void) | null } = {
  current: null,
};

vi.mock("@dnd-kit/core", async () => {
  const actual = await vi.importActual<typeof import("@dnd-kit/core")>(
    "@dnd-kit/core",
  );
  return {
    ...actual,
    DndContext: ({
      children,
      onDragEnd,
    }: {
      children: React.ReactNode;
      onDragEnd: (e: unknown) => void;
    }) => {
      capturedOnDragEnd.current = onDragEnd;
      return React.createElement(React.Fragment, null, children);
    },
  };
});

vi.mock("@dnd-kit/sortable", async () => {
  const actual = await vi.importActual<typeof import("@dnd-kit/sortable")>(
    "@dnd-kit/sortable",
  );
  return {
    ...actual,
    SortableContext: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useSortable: () => ({
      // Mirrors what real `useSortable` returns, NOT an empty object. The
      // `role: "button"` / `tabIndex` pair is exactly what the tab's own
      // role="tab"/tabIndex must override by being written after the spread,
      // so stubbing `attributes: {}` here would quietly disarm the
      // spread-order regression guard in the ARIA test below.
      attributes: {
        role: "button",
        tabIndex: 0,
        "aria-roledescription": "sortable",
      },
      listeners: {},
      setNodeRef: () => undefined,
      transform: null,
      transition: null,
      isDragging: false,
    }),
  };
});

// `useTabs()` is mocked directly rather than wrapping the tree in
// `TabsProvider` + `FocusedConnectionProvider` — the latter pulls in
// `useOpenConnections` (a Tauri-backed hook) for no benefit here. `move`,
// `activate` and `close` are plain spies; `tabs`/`activeTabId` come from a
// mutable module-level object each test can set up before rendering.
const tabsState: { tabs: Tab[]; activeTabId: string | null } = {
  tabs: [],
  activeTabId: null,
};
const activate = vi.fn();
const close = vi.fn();
const move = vi.fn();

vi.mock("./TabsContext", () => ({
  useTabs: () => ({
    tabs: tabsState.tabs,
    activeTabId: tabsState.activeTabId,
    activate,
    close,
    move,
  }),
}));

// Import AFTER the mocks so TabStrip picks up the mocked dnd-kit + TabsContext.
const { TabStrip } = await import("./TabStrip");

function threeTabs(): Tab[] {
  return [
    { id: "A", kind: "postgres-query", title: "A", closable: true, payload: null },
    { id: "B", kind: "postgres-query", title: "B", closable: true, payload: null },
    { id: "C", kind: "postgres-query", title: "C", closable: true, payload: null },
  ];
}

beforeEach(() => {
  capturedOnDragEnd.current = null;
  activate.mockClear();
  close.mockClear();
  move.mockClear();
  tabsState.tabs = threeTabs();
  tabsState.activeTabId = "A";
});

describe("TabStrip — drag reordering", () => {
  it("dropping C over A calls move(from=2, to=0)", () => {
    render(<TabStrip />);
    capturedOnDragEnd.current?.({ active: { id: "C" }, over: { id: "A" } });
    expect(move).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledWith(2, 0);
  });

  it("dropping A over C calls move(from=0, to=2)", () => {
    render(<TabStrip />);
    capturedOnDragEnd.current?.({ active: { id: "A" }, over: { id: "C" } });
    expect(move).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledWith(0, 2);
  });

  it("over === active is a no-op", () => {
    render(<TabStrip />);
    capturedOnDragEnd.current?.({ active: { id: "B" }, over: { id: "B" } });
    expect(move).not.toHaveBeenCalled();
  });

  it("over === null is a no-op", () => {
    render(<TabStrip />);
    capturedOnDragEnd.current?.({ active: { id: "B" }, over: null });
    expect(move).not.toHaveBeenCalled();
  });

  it("an id not present in the strip is a no-op (indexOf === -1 guard)", () => {
    render(<TabStrip />);
    capturedOnDragEnd.current?.({ active: { id: "ZZZ" }, over: { id: "A" } });
    expect(move).not.toHaveBeenCalled();
  });
});

// Tabs render both their title text and (via the ✕ button's aria-label
// "Close <title>") a name-from-content that includes it — so matching
// role=tab by accessible `name` is unreliable. Find the tab element by its
// title text and walk up to the nearest [role="tab"] instead.
function getTabByTitle(title: string): HTMLElement {
  const el = screen.getByText(title).closest('[role="tab"]');
  if (!el) throw new Error(`no [role="tab"] ancestor for title "${title}"`);
  return el as HTMLElement;
}

describe("TabStrip — click activation and close", () => {
  it("clicking an inactive tab activates it and does not call move", async () => {
    render(<TabStrip />);
    fireEvent.click(getTabByTitle("B"));
    await waitFor(() => expect(activate).toHaveBeenCalledWith("B"));
    expect(move).not.toHaveBeenCalled();
  });

  it("clicking the already-active tab activates nothing and does not call move", async () => {
    render(<TabStrip />);
    fireEvent.click(getTabByTitle("A"));
    // Give any stray microtask a chance to run before asserting the negative.
    await Promise.resolve();
    expect(activate).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });

  it("clicking a tab's close button closes that tab and does not call move", async () => {
    render(<TabStrip />);
    fireEvent.click(screen.getByRole("button", { name: "Close B" }));
    await waitFor(() => expect(close).toHaveBeenCalledWith("B"));
    expect(move).not.toHaveBeenCalled();
  });
});

describe("TabStrip — ARIA / DOM shape", () => {
  it("exposes role=tablist with one role=tab per tab and correct aria-selected, and no role=button tabs", () => {
    render(<TabStrip />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();

    const tabEls = screen.getAllByRole("tab");
    expect(tabEls).toHaveLength(3);

    expect(getTabByTitle("A")).toHaveAttribute("aria-selected", "true");
    expect(getTabByTitle("B")).toHaveAttribute("aria-selected", "false");
    expect(getTabByTitle("C")).toHaveAttribute("aria-selected", "false");

    // Regression guard for the D2 spread-order trap: sortable.attributes
    // carries its own role="button". If role="tab" were written BEFORE the
    // {...sortable.attributes} spread instead of after, the spread would win,
    // getAllByRole("tab") above would come back empty, and the 3 tab divs
    // would show up as extra role="button" elements alongside the 3 ✕
    // closers. Exactly 3 buttons confirms the spread order is correct.
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("no rendered tab carries the native draggable attribute", () => {
    render(<TabStrip />);
    for (const tabEl of screen.getAllByRole("tab")) {
      expect(tabEl).not.toHaveAttribute("draggable");
    }
  });
});
