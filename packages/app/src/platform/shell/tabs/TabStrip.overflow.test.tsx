/**
 * TabStrip.overflow.test.tsx — tab-strip overflow menu (issue #281).
 *
 * `useTabs` is mocked rather than wrapping the strip in
 * `FocusedConnectionProvider` + `TabsProvider`: the real provider pulls in
 * `useOpenConnections`, which is Tauri-dependent. Mocking the hook matches how
 * the rest of the suite isolates components (see `welcome.test.tsx`) and lets
 * each test drive `tabs` / `activeTabId` directly.
 *
 * jsdom reports 0 for every layout property, so geometry is injected onto the
 * rendered nodes with `Object.defineProperty`. The arithmetic itself is covered
 * separately and exhaustively by `tabOverflow.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import type { Tab } from "./types";

// --- Mock the tabs store -----------------------------------------------------

const mockActivate = vi.fn();
const mockClose = vi.fn();
const mockMove = vi.fn();
const mockUseTabs = vi.fn();

vi.mock("./TabsContext", () => ({
  useTabs: () => mockUseTabs(),
}));

import { TabStrip } from "./TabStrip";
import {
  registerActivateHandler,
  unregisterActivateHandler,
  registerCloseHandler,
  unregisterCloseHandler,
} from "./useCloseConfirm";

// --- Fixtures ----------------------------------------------------------------

function makeTabs(n: number, over: Partial<Tab> = {}): Tab[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    kind: "table",
    title: `table_${i}`,
    closable: true,
    payload: null,
    ...over,
  }));
}

function setup(tabs: Tab[], activeTabId: string | null = tabs[0]?.id ?? null) {
  mockUseTabs.mockReturnValue({
    tabs,
    activeTabId,
    activate: mockActivate,
    close: mockClose,
    move: mockMove,
    open: vi.fn(),
    cycle: vi.fn(),
    setTabTitle: vi.fn(),
    setTabDirty: vi.fn(),
    _allSets: new Map(),
  });
  return render(<TabStrip />);
}

/** Fixed value for a layout property jsdom always reports as 0. */
function define(el: Element, prop: string, value: number) {
  Object.defineProperty(el, prop, { configurable: true, value });
}

function getScroller(): HTMLElement {
  const el = document.querySelector("[role='tablist']");
  if (!el) throw new Error("tablist not found");
  return el as HTMLElement;
}

/**
 * Lay the rendered tabs out end to end at `tabWidth` each inside a scrollport
 * of `clientWidth`, then let the strip re-measure.
 */
function layout(opts: {
  tabWidth: number;
  clientWidth: number;
  scrollLeft?: number;
}) {
  const scroller = getScroller();
  define(scroller, "clientWidth", opts.clientWidth);
  define(scroller, "scrollLeft", opts.scrollLeft ?? 0);

  const tabEls = screen.getAllByRole("tab");
  tabEls.forEach((el, i) => {
    define(el, "offsetLeft", i * opts.tabWidth);
    define(el, "offsetWidth", opts.tabWidth);
  });

  act(() => {
    fireEvent.scroll(scroller);
  });
}

function overflowButton() {
  return screen.queryByTitle("Hidden tabs");
}

/** Open the Radix dropdown and return its content element. */
function openOverflowMenu(): HTMLElement {
  const trigger = overflowButton();
  if (!trigger) throw new Error("overflow button not rendered");
  act(() => {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  });
  return screen.getByRole("menu");
}

// --- Harness -----------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Run scheduled measurements synchronously so a dispatched `scroll` settles
  // before the assertion. `useTabOverflow` guards scheduling with a boolean set
  // before the frame is requested, so a synchronous rAF is safe here.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- Overflow button ---------------------------------------------------------

describe("TabStrip overflow — the button", () => {
  it("is not rendered when every tab fits", () => {
    setup(makeTabs(4));
    layout({ tabWidth: 100, clientWidth: 500 });
    expect(overflowButton()).toBeNull();
  });

  it("is not rendered when the tabs exactly fill the strip", () => {
    setup(makeTabs(4));
    layout({ tabWidth: 100, clientWidth: 400 });
    expect(overflowButton()).toBeNull();
  });

  it("appears with the count of tabs that do not fit", () => {
    setup(makeTabs(8));
    // Port shows 0..350 → t3 is cut, t4-t7 are past it: 5 hidden.
    layout({ tabWidth: 100, clientWidth: 350 });
    const btn = overflowButton();
    expect(btn).not.toBeNull();
    expect(btn).toHaveTextContent("5");
    expect(btn).toHaveAccessibleName("Show 5 hidden tabs");
  });

  it("uses the singular label for exactly one hidden tab", () => {
    setup(makeTabs(4));
    layout({ tabWidth: 100, clientWidth: 350 });
    expect(overflowButton()).toHaveAccessibleName("Show 1 hidden tab");
  });

  it("counts tabs scrolled off the left as hidden too", () => {
    setup(makeTabs(6));
    // Port covers 200..600: t0 and t1 are behind the left edge.
    layout({ tabWidth: 100, clientWidth: 400, scrollLeft: 200 });
    expect(overflowButton()).toHaveTextContent("2");
  });

  it("disappears once everything fits again", () => {
    setup(makeTabs(8));
    layout({ tabWidth: 100, clientWidth: 350 });
    expect(overflowButton()).not.toBeNull();

    // The strip widens (sidebar collapsed, window resized, tabs closed…).
    layout({ tabWidth: 100, clientWidth: 900 });
    expect(overflowButton()).toBeNull();
  });

  it("is not inside the tablist — it is not a tab", () => {
    setup(makeTabs(8));
    layout({ tabWidth: 100, clientWidth: 350 });
    expect(getScroller().contains(overflowButton())).toBe(false);
    expect(screen.getAllByRole("tab")).toHaveLength(8);
  });
});

// --- Overflow menu -----------------------------------------------------------

describe("TabStrip overflow — the menu", () => {
  it("lists exactly the hidden tabs, in tab order", () => {
    setup(makeTabs(8));
    layout({ tabWidth: 100, clientWidth: 350 });

    const menu = openOverflowMenu();
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((el) => el.textContent)).toEqual([
      "table_3",
      "table_4",
      "table_5",
      "table_6",
      "table_7",
    ]);
  });

  it("lists tabs hidden on the left before tabs hidden on the right", () => {
    setup(makeTabs(6));
    // Port covers 150..450: t0 fully behind, t1 cut left, t4 cut right, t5 past.
    layout({ tabWidth: 100, clientWidth: 300, scrollLeft: 150 });

    const menu = openOverflowMenu();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((el) => el.textContent),
    ).toEqual(["table_0", "table_1", "table_4", "table_5"]);
  });

  it("shows the dirty indicator on a dirty hidden tab", () => {
    const tabs = makeTabs(4);
    tabs[3] = { ...tabs[3]!, dirty: true };
    setup(tabs);
    layout({ tabWidth: 100, clientWidth: 350 });

    const menu = openOverflowMenu();
    const item = within(menu).getByRole("menuitem");
    expect(within(item).getByLabelText("Unsaved changes")).toBeTruthy();
  });

  it("does not show a dirty indicator on a clean hidden tab", () => {
    setup(makeTabs(4));
    layout({ tabWidth: 100, clientWidth: 350 });

    const menu = openOverflowMenu();
    const item = within(menu).getByRole("menuitem");
    expect(within(item).queryByLabelText("Unsaved changes")).toBeNull();
  });

  it("offers no close affordance — activation only", () => {
    setup(makeTabs(8));
    layout({ tabWidth: 100, clientWidth: 350 });

    const menu = openOverflowMenu();
    expect(within(menu).queryByRole("button")).toBeNull();
    expect(within(menu).queryByLabelText(/^Close /)).toBeNull();
  });

  it("activates the selected tab", async () => {
    setup(makeTabs(8));
    layout({ tabWidth: 100, clientWidth: 350 });

    const menu = openOverflowMenu();
    const item = within(menu).getByText("table_5");
    // `shouldActivateTab` resolves in a microtask, so the await matters.
    await act(async () => {
      fireEvent.click(item);
    });

    expect(mockActivate).toHaveBeenCalledWith("t5");
  });

  it("does not activate when the switch guard refuses", async () => {
    // t0 is active and refuses to be left (e.g. a dirty buffer).
    registerActivateHandler("t0", () => false);
    try {
      setup(makeTabs(8), "t0");
      layout({ tabWidth: 100, clientWidth: 350 });

      const menu = openOverflowMenu();
      await act(async () => {
        fireEvent.click(within(menu).getByText("table_5"));
      });

      expect(mockActivate).not.toHaveBeenCalled();
    } finally {
      unregisterActivateHandler("t0");
    }
  });

  it("activates when the switch guard allows", async () => {
    registerActivateHandler("t0", () => true);
    try {
      setup(makeTabs(8), "t0");
      layout({ tabWidth: 100, clientWidth: 350 });

      const menu = openOverflowMenu();
      await act(async () => {
        fireEvent.click(within(menu).getByText("table_5"));
      });

      expect(mockActivate).toHaveBeenCalledWith("t5");
    } finally {
      unregisterActivateHandler("t0");
    }
  });
});

// --- Keeping the active tab visible ------------------------------------------

describe("TabStrip overflow — active tab stays visible", () => {
  it("scrolls the active tab into view on mount", () => {
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    setup(makeTabs(8), "t6");

    expect(spy).toHaveBeenCalled();
    const target = spy.mock.instances.at(-1) as HTMLElement;
    expect(target).toHaveTextContent("table_6");
    expect(spy).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest" });
    spy.mockRestore();
  });

  it("scrolls the newly active tab into view when activeTabId changes", () => {
    const tabs = makeTabs(8);
    const { rerender } = setup(tabs, "t0");

    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    // Simulates ⌃Tab / the command palette / the quick-switcher moving focus.
    mockUseTabs.mockReturnValue({
      tabs,
      activeTabId: "t7",
      activate: mockActivate,
      close: mockClose,
      move: mockMove,
      open: vi.fn(),
      cycle: vi.fn(),
      setTabTitle: vi.fn(),
      setTabDirty: vi.fn(),
      _allSets: new Map(),
    });
    rerender(<TabStrip />);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.instances[0]).toHaveTextContent("table_7");
    spy.mockRestore();
  });

  it("does not scroll on a re-render that leaves the active tab unchanged", () => {
    const tabs = makeTabs(8);
    const { rerender } = setup(tabs, "t0");

    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    rerender(<TabStrip />);
    // Manual scrolling must not be overridden either.
    act(() => {
      fireEvent.scroll(getScroller());
    });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// --- Existing behaviour is unchanged under overflow --------------------------

describe("TabStrip overflow — existing behaviour still works", () => {
  it("closes a visible tab through the close guard", async () => {
    setup(makeTabs(8));
    layout({ tabWidth: 100, clientWidth: 350 });

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Close table_1"));
    });

    expect(mockClose).toHaveBeenCalledWith("t1");
  });

  it("a refusing close guard keeps the tab open", async () => {
    registerCloseHandler("t1", () => false);
    try {
      setup(makeTabs(8));
      layout({ tabWidth: 100, clientWidth: 350 });

      await act(async () => {
        fireEvent.click(screen.getByLabelText("Close table_1"));
      });

      expect(mockClose).not.toHaveBeenCalled();
    } finally {
      unregisterCloseHandler("t1");
    }
  });

  it("clicking a tab activates it through the switch guard", async () => {
    setup(makeTabs(8), "t0");
    layout({ tabWidth: 100, clientWidth: 350 });

    await act(async () => {
      fireEvent.click(screen.getByText("table_2"));
    });

    expect(mockActivate).toHaveBeenCalledWith("t2");
  });

  // Reordering is pointer-based (`@dnd-kit`), which jsdom cannot drive end to
  // end; the id→index mapping is covered by `TabStrip.dnd.test.tsx`. What this
  // asserts is that the overflow wiring leaves the sortable wiring attached to
  // every tab, and that no tab fell back to native HTML5 DnD.
  it("keeps every tab sortable under overflow", () => {
    setup(makeTabs(8));
    layout({ tabWidth: 100, clientWidth: 350 });

    const tabEls = screen.getAllByRole("tab");
    expect(tabEls).toHaveLength(8);
    for (const el of tabEls) {
      expect(el).toHaveAttribute("aria-roledescription", "sortable");
      expect(el).not.toHaveAttribute("draggable");
    }
  });

  it("renders the full title as a tooltip so truncated labels stay readable", () => {
    setup([
      {
        id: "t0",
        kind: "table",
        title: "public.a_very_long_table_name_that_truncates",
        closable: true,
        payload: null,
      },
    ]);
    expect(
      screen.getByTitle("public.a_very_long_table_name_that_truncates"),
    ).toBeTruthy();
  });

  it("renders nothing when there are no tabs", () => {
    const { container } = setup([]);
    expect(container.firstChild).toBeNull();
  });
});
