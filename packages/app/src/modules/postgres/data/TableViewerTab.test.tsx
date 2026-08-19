import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TabsProvider } from "@/platform/shell/tabs/TabsContext";
import { TableViewer } from "./TableViewerTab";
import type { QueryTableResult } from "./types";
import dataGridStyles from "./DataGrid.module.css";

// Mocked Tauri data API — counts queryTable calls and lets each test arrange
// what they want returned.
vi.mock("./api", () => ({
  dataApi: {
    queryTable: vi.fn(),
    countTable: vi.fn(),
    tablePrimaryKey: vi.fn(),
    applyTableEdits: vi.fn(),
  },
}));

vi.mock("../schema/globalSchemaCache", () => ({
  globalSchemaCache: {
    recordColumns: vi.fn(),
  },
}));

// useActiveConnections pulls from a Tauri command and a Tauri event listener.
// In tests we short-circuit the whole hook to a no-op shape.
vi.mock("../useActiveConnections", () => ({
  useActiveConnections: () => ({
    items: [],
    loading: false,
    refresh: vi.fn(),
    isActive: () => false,
    getActive: () => undefined,
  }),
}));

// Settings API used by `useSetting` (the persistence pipeline). Each test sets
// the implementation it needs; the default is "no value persisted".
vi.mock("@/platform/settings/api", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

// useConnections — TableViewer now reads context_path from the connection list.
vi.mock("@/platform/connection-registry/useConnections", () => ({
  useConnections: vi.fn(() => ({
    items: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    move: vi.fn(),
    remove: vi.fn(),
  })),
}));

// Context hooks — stub out so TableViewer doesn't need ContextEventBusProvider.
vi.mock("@/modules/context/hooks", () => ({
  useContextObjects: vi.fn(() => ({ data: [], loading: false, error: null, refresh: vi.fn() })),
  useContextObject: vi.fn(() => ({ data: null, loading: false, error: null, refresh: vi.fn() })),
}));

import { dataApi } from "./api";
import { getSetting, setSetting } from "@/platform/settings/api";

const queryTableMock = vi.mocked(dataApi.queryTable);
const tablePrimaryKeyMock = vi.mocked(dataApi.tablePrimaryKey);
const getSettingMock = vi.mocked(getSetting);
const setSettingMock = vi.mocked(setSetting);

function makeResult(rowCount: number, filterTreePresent = false): QueryTableResult {
  return {
    columns: [
      { name: "id", data_type: "int4", ordinal_position: 1, is_nullable: false },
      { name: "country", data_type: "text", ordinal_position: 2, is_nullable: true },
    ],
    rows: Array.from({ length: rowCount }, (_, i) => [i + 1, "CL"]),
    applied: {
      limit: 200,
      offset: 0,
      order_by: [],
      filter_tree: filterTreePresent
        ? { children: [], combinator: "AND" }
        : null,
      raw_where: null,
    },
    query_ms: 7,
    truncated_columns: [],
  };
}

function renderViewer(
  props: Partial<{
    connectionId: string;
    schema: string;
    relation: string;
  }> = {},
) {
  const merged = {
    tabId: "tab-1",
    connectionId: props.connectionId ?? "conn-1",
    connectionName: "Test",
    schema: props.schema ?? "public",
    relation: props.relation ?? "users",
    relationKind: "table" as const,
  };
  return render(
    <TabsProvider>
      <TableViewer {...merged} />
    </TabsProvider>,
  );
}

// Helper: open the filter bar by clicking the toggle button in SubtabHeader.
function openFilterBar() {
  const filterToggle = screen.getByRole("button", { name: /Toggle filter bar/i });
  fireEvent.click(filterToggle);
}

// Helper: check for "Apply All" primary button (exact label, not the chevron).
function queryApplyAllPrimary() {
  // Use getAllByRole to handle multiple and pick by exact text content.
  const btns = screen.queryAllByRole("button");
  return btns.find((b) => b.textContent?.trim() === "Apply All") ?? null;
}

// Helper: the primary Apply All button (never the chevron beside it).
function clickApplyAll() {
  return screen
    .getAllByRole("button")
    .find(
      (b) =>
        b.textContent?.trim() === "Apply All" ||
        b.textContent?.trim() === "Apply All (OR)",
    )!;
}

let toggleCounter = 0;
function uniqueToggleViewer() {
  toggleCounter++;
  return renderViewer({
    connectionId: `conn-toggle-${toggleCounter}`,
    schema: "public",
    relation: `table-toggle-${toggleCounter}`,
  });
}

describe("TableViewerTab — filter bar toggle (jsdom, memory-cache lane)", () => {
  beforeEach(() => {
    queryTableMock.mockReset();
    tablePrimaryKeyMock.mockReset();
    getSettingMock.mockReset();
    setSettingMock.mockReset();
    getSettingMock.mockResolvedValue(null);
    setSettingMock.mockResolvedValue(undefined);
    queryTableMock.mockResolvedValue(makeResult(1));
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("filter bar is hidden by default; toggle button shows it", () => {
    uniqueToggleViewer();
    // Bar should not be visible initially — Apply All button not rendered.
    expect(queryApplyAllPrimary()).toBeNull();
    // Click the toggle button.
    openFilterBar();
    // Now the bar is visible — Apply All button is rendered.
    expect(queryApplyAllPrimary()).toBeInTheDocument();
  });

  it("Filter toggle button has aria-pressed=false when bar is hidden", () => {
    uniqueToggleViewer();
    const btn = screen.getByRole("button", { name: /Toggle filter bar/i });
    expect(btn).toHaveAttribute("aria-pressed", "false");
  });

  it("Filter toggle button has aria-pressed=true when bar is visible", () => {
    uniqueToggleViewer();
    openFilterBar();
    const btn = screen.getByRole("button", { name: /Toggle filter bar/i });
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });

  it("toggle hides bar when clicked again", () => {
    uniqueToggleViewer();
    openFilterBar();
    expect(queryApplyAllPrimary()).toBeInTheDocument();
    openFilterBar();
    expect(queryApplyAllPrimary()).toBeNull();
  });

  it("filter bar not shown on Structure subtab", () => {
    uniqueToggleViewer();
    // Switch to Structure subtab.
    fireEvent.click(screen.getByRole("tab", { name: /Structure/i }));
    // Toggle button should not appear on structure subtab.
    expect(screen.queryByRole("button", { name: /Toggle filter bar/i })).toBeNull();
  });
});

let stateCounter = 0;
function uniqueStateViewer() {
  stateCounter++;
  return renderViewer({
    connectionId: `conn-state-${stateCounter}`,
    schema: "public",
    relation: `table-state-${stateCounter}`,
  });
}

describe("TableViewerTab — filter state (jsdom, memory-cache lane)", () => {
  beforeEach(() => {
    queryTableMock.mockReset();
    tablePrimaryKeyMock.mockReset();
    getSettingMock.mockReset();
    setSettingMock.mockReset();
    getSettingMock.mockResolvedValue(null);
    setSettingMock.mockResolvedValue(undefined);
    queryTableMock.mockResolvedValue(makeResult(1));
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("filter bar shows one default row when first opened", () => {
    uniqueStateViewer();
    openFilterBar();
    // The default row should be present — checkbox + condition row.
    const checkboxes = screen.getAllByRole("checkbox", { name: /Include in Apply All/i });
    expect(checkboxes.length).toBeGreaterThanOrEqual(1);
  });

  it("editing the value input makes the dirty indicator appear", () => {
    uniqueStateViewer();
    openFilterBar();
    // Find the value input by aria-label.
    const valueInput = screen.getByRole("textbox", { name: /Value/i });
    fireEvent.change(valueInput, { target: { value: "CL" } });
    // The dirty pip should be visible when draft !== applied.
    expect(screen.getByTitle(/Unsaved changes/i)).toBeInTheDocument();
  });

  it("Apply All commits draft to applied and clears dirty indicator", () => {
    uniqueStateViewer();
    openFilterBar();
    const valueInput = screen.getByRole("textbox", { name: /Value/i });
    fireEvent.change(valueInput, { target: { value: "CL" } });
    // Click the primary Apply All button (not the chevron).
    const allBtns = screen.getAllByRole("button");
    const applyAllPrimary = allBtns.find((b) => b.textContent?.trim() === "Apply All" || b.textContent?.trim() === "Apply All (OR)")!;
    fireEvent.click(applyAllPrimary);
    // Dirty pip should be gone once draft equals applied.
    expect(screen.queryByTitle(/Unsaved changes/i)).toBeNull();
  });

  it("Unset leaves the filter form exactly as it was, operators included", () => {
    uniqueStateViewer();
    openFilterBar();
    fireEvent.change(screen.getByRole("textbox", { name: /Value/i }), {
      target: { value: "hello" },
    });
    fireEvent.click(clickApplyAll());
    expect(screen.queryByTitle(/Unsaved changes/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Unset$/i }));

    // The form keeps its value AND its operator — nothing is deselected.
    expect(screen.getByRole("textbox", { name: /Value/i })).toHaveValue("hello");
    const opSelect = screen.getByRole("combobox", { name: /Operator/i }) as HTMLSelectElement;
    expect(opSelect.value).toBe("Contains");
    expect(screen.queryByRole("option", { name: "—" })).toBeNull();
    // …but it is no longer in force, so the bar reads as dirty again.
    expect(screen.getByTitle(/Unsaved changes/i)).toBeInTheDocument();
  });

  it("Unset clears the bottom-bar filter chip but keeps the filter rows", () => {
    uniqueStateViewer();
    openFilterBar();
    fireEvent.change(screen.getByRole("textbox", { name: /Value/i }), {
      target: { value: "hello" },
    });
    fireEvent.click(clickApplyAll());
    expect(screen.getByRole("button", { name: /Clear filters/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Unset$/i }));

    expect(screen.queryByRole("button", { name: /Clear filters/i })).toBeNull();
    expect(screen.getByRole("textbox", { name: /Value/i })).toHaveValue("hello");
  });

  it("Clear all resets the draft rows to a single empty row", () => {
    uniqueStateViewer();
    openFilterBar();
    const valueInput = screen.getByRole("textbox", { name: /Value/i });
    fireEvent.change(valueInput, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: /Clear all/i }));
    expect(screen.getAllByRole("checkbox", { name: /Include in Apply All/i })).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: /Value/i })).toHaveValue("");
  });

  it("switching connectionId between mounts shows the empty model", () => {
    stateCounter++;
    const baseArgs = { schema: "public", relation: `table-iso-${stateCounter}` };
    const { unmount } = renderViewer({ ...baseArgs, connectionId: `conn-iso-A-${stateCounter}` });

    openFilterBar();
    const valueInput = screen.getByRole("textbox", { name: /Value/i });
    fireEvent.change(valueInput, { target: { value: "CL" } });
    const applyAllPrimary = screen.getAllByRole("button").find((b) => b.textContent?.trim() === "Apply All" || b.textContent?.trim() === "Apply All (OR)")!;
    fireEvent.click(applyAllPrimary);

    unmount();
    renderViewer({ ...baseArgs, connectionId: `conn-iso-B-${stateCounter}` });

    // Bar is hidden by default after new mount — toggle to check emptiness.
    openFilterBar();
    expect(screen.getByRole("textbox", { name: /Value/i })).toHaveValue("");
  });

  it("3.1: re-rendering with a different relation does not bleed filter state", () => {
    stateCounter++;
    const baseProps = {
      tabId: "tab-1",
      connectionId: `conn-bleed-tab-${stateCounter}`,
      connectionName: "Test",
      schema: "public",
      relationKind: "table" as const,
    };
    const { rerender } = render(
      <TabsProvider>
        <TableViewer {...baseProps} relation={`rel-A-bleed-${stateCounter}`} />
      </TabsProvider>,
    );

    openFilterBar();
    const valueInput = screen.getByRole("textbox", { name: /Value/i });
    fireEvent.change(valueInput, { target: { value: "CL" } });
    const applyAllPrimary = screen.getAllByRole("button").find((b) => b.textContent?.trim() === "Apply All" || b.textContent?.trim() === "Apply All (OR)")!;
    fireEvent.click(applyAllPrimary);

    rerender(
      <TabsProvider>
        <TableViewer {...baseProps} relation={`rel-B-bleed-${stateCounter}`} />
      </TabsProvider>,
    );

    // Bar resets to hidden on relation change — toggle to confirm empty.
    openFilterBar();
    expect(screen.getByRole("textbox", { name: /Value/i })).toHaveValue("");
  });
});

let unsetCounter = 0;
function uniqueUnsetViewer() {
  unsetCounter++;
  return renderViewer({
    connectionId: `conn-unset-${unsetCounter}`,
    schema: "public",
    relation: `table-unset-${unsetCounter}`,
  });
}

// `useTableData` only fetches inside the Tauri runtime, so every assertion on
// the query payload has to live in this lane.
describe("TableViewerTab — Unset unapplies the filter (Tauri lane)", () => {
  beforeEach(() => {
    queryTableMock.mockReset();
    tablePrimaryKeyMock.mockReset();
    getSettingMock.mockReset();
    setSettingMock.mockReset();
    getSettingMock.mockResolvedValue(null);
    setSettingMock.mockResolvedValue(undefined);
    queryTableMock.mockResolvedValue(makeResult(1));
    tablePrimaryKeyMock.mockResolvedValue({ pk_columns: ["id"], enums: {} });
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  function lastFilterTree() {
    return queryTableMock.mock.calls.at(-1)?.[3]?.filter_tree;
  }

  it("Unset drops the predicate and refetches, without touching the form", async () => {
    uniqueUnsetViewer();
    await waitFor(() => expect(queryTableMock).toHaveBeenCalled());
    openFilterBar();
    fireEvent.change(screen.getByRole("textbox", { name: /Value/i }), {
      target: { value: "hello" },
    });
    fireEvent.click(clickApplyAll());
    await waitFor(() => expect(lastFilterTree()).toBeDefined());

    queryTableMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^Unset$/i }));

    await waitFor(() => expect(queryTableMock).toHaveBeenCalled());
    expect(lastFilterTree()).toBeUndefined();
    expect(screen.getByRole("textbox", { name: /Value/i })).toHaveValue("hello");
    expect(
      (screen.getByRole("combobox", { name: /Operator/i }) as HTMLSelectElement).value,
    ).toBe("Contains");
  });

  it("Apply All right after Unset restores the identical filter with no re-selection", async () => {
    uniqueUnsetViewer();
    await waitFor(() => expect(queryTableMock).toHaveBeenCalled());
    openFilterBar();
    fireEvent.change(screen.getByRole("textbox", { name: /Value/i }), {
      target: { value: "hello" },
    });
    fireEvent.click(clickApplyAll());
    await waitFor(() => expect(lastFilterTree()).toBeDefined());
    const before = lastFilterTree();

    fireEvent.click(screen.getByRole("button", { name: /^Unset$/i }));
    await waitFor(() => expect(lastFilterTree()).toBeUndefined());

    // No edits in between — one Apply All puts the same predicate back.
    fireEvent.click(clickApplyAll());
    await waitFor(() => expect(lastFilterTree()).toEqual(before));
    expect(screen.queryByTitle(/Unsaved changes/i)).toBeNull();
  });

  it("Unset refetches even when nothing was applied", async () => {
    uniqueUnsetViewer();
    await waitFor(() => expect(queryTableMock).toHaveBeenCalled());
    openFilterBar();

    queryTableMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^Unset$/i }));

    await waitFor(() => expect(queryTableMock).toHaveBeenCalled());
    expect(lastFilterTree()).toBeUndefined();
  });
});

describe("TableViewerTab — first-mount fetch gating (Tauri lane)", () => {
  beforeEach(() => {
    queryTableMock.mockReset();
    tablePrimaryKeyMock.mockReset();
    getSettingMock.mockReset();
    setSettingMock.mockReset();
    setSettingMock.mockResolvedValue(undefined);
    queryTableMock.mockResolvedValue(makeResult(1, true));
    tablePrimaryKeyMock.mockResolvedValue({ pk_columns: ["id"], enums: {} });
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("4.5: defers queryTable until persisted filter has loaded, then fires once", async () => {
    // Persisted filter in the new flat-row model — filter_tree should be emitted.
    const persistedNewShape = {
      draft: {
        rows: [
          {
            enabled: true,
            column: { kind: "named", name: "country" },
            op: "=",
            value: "CL",
          },
        ],
        combinator: "AND",
      },
      applied: {
        rows: [
          {
            enabled: true,
            column: { kind: "named", name: "country" },
            op: "=",
            value: "CL",
          },
        ],
        combinator: "AND",
      },
    };

    let resolveFilter: ((v: string | null) => void) | undefined;
    const filterReadPromise = new Promise<string | null>((resolve) => {
      resolveFilter = resolve;
    });

    getSettingMock.mockImplementation((key: string) => {
      if (key.startsWith("pgTableFilter:")) return filterReadPromise;
      return Promise.resolve(null);
    });

    renderViewer({
      connectionId: "conn-45",
      schema: "public",
      relation: "users-45",
    });

    // Before the persisted filter resolves, no queryTable call should fire.
    expect(queryTableMock).not.toHaveBeenCalled();

    // Resolve the disk read with the persisted new-shape filter.
    await act(async () => {
      resolveFilter!(JSON.stringify(persistedNewShape));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(queryTableMock).toHaveBeenCalledTimes(1);
    });

    const args = queryTableMock.mock.calls[0]!;
    const options = args[3] as { filter_tree?: { children: unknown[]; combinator: string } };
    // The applied model has one enabled+complete row → filter_tree should be present.
    expect(options.filter_tree).toBeDefined();
    expect(options.filter_tree?.combinator).toBe("AND");
    expect(options.filter_tree?.children).toHaveLength(1);
    expect(options.filter_tree?.children[0]).toMatchObject({
      kind: "condition",
      column: { kind: "named", name: "country" },
      op: "=",
      value: "CL",
    });
  });

  it("4.5b: defers queryTable until loaded; legacy persisted filter migrates to empty (no filter_tree)", async () => {
    const legacyPersistedFilter = {
      draft: {
        mode: "structured",
        tree: {
          children: [
            { kind: "condition", column: { kind: "named", name: "country" }, op: "=", value: "CL" },
          ],
        },
        raw: "",
      },
      applied: {
        mode: "structured",
        tree: {
          children: [
            { kind: "condition", column: { kind: "named", name: "country" }, op: "=", value: "CL" },
          ],
        },
        raw: "",
      },
    };

    let resolveFilter: ((v: string | null) => void) | undefined;
    const filterReadPromise = new Promise<string | null>((resolve) => {
      resolveFilter = resolve;
    });

    getSettingMock.mockImplementation((key: string) => {
      if (key.startsWith("pgTableFilter:")) return filterReadPromise;
      return Promise.resolve(null);
    });

    renderViewer({
      connectionId: "conn-45b",
      schema: "public",
      relation: "users-45b",
    });

    expect(queryTableMock).not.toHaveBeenCalled();

    // Resolve with the legacy shape — should migrate to EMPTY_FILTER_MODEL.
    await act(async () => {
      resolveFilter!(JSON.stringify(legacyPersistedFilter));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(queryTableMock).toHaveBeenCalledTimes(1);
    });

    const args = queryTableMock.mock.calls[0]!;
    const options = args[3] as { filter_tree?: unknown };
    // Legacy filter migrated to empty → no filter_tree in payload.
    expect(options.filter_tree).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PK error-state banner tests (task 3.4)
// ---------------------------------------------------------------------------

let pkErrorCounter = 0;
function uniquePkErrorViewer() {
  pkErrorCounter++;
  return renderViewer({
    connectionId: `conn-pkerr-${pkErrorCounter}`,
    schema: "public",
    relation: `table-pkerr-${pkErrorCounter}`,
  });
}

describe("TableViewerTab — PK lookup error state (Tauri lane)", () => {
  beforeEach(() => {
    queryTableMock.mockReset();
    tablePrimaryKeyMock.mockReset();
    getSettingMock.mockReset();
    setSettingMock.mockReset();
    getSettingMock.mockResolvedValue(null);
    setSettingMock.mockResolvedValue(undefined);
    queryTableMock.mockResolvedValue(makeResult(1));
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("3.4a: rejected tablePrimaryKey shows the PK error banner and NOT the no-PK banner", async () => {
    tablePrimaryKeyMock.mockRejectedValue(new Error("connection reset by peer"));

    uniquePkErrorViewer();

    await waitFor(() => {
      // The retry banner must mention the error cause.
      expect(screen.getByText(/connection reset by peer/i)).toBeInTheDocument();
    });

    // Must have a Retry button.
    expect(screen.getByRole("button", { name: /Retry primary key lookup/i })).toBeInTheDocument();

    // Must NOT show the "No primary key" banner.
    expect(screen.queryByText(/No primary key/i)).toBeNull();
  });

  it("3.4b: clicking Retry re-invokes tablePrimaryKey and, on success, removes the error banner", async () => {
    // First call fails.
    tablePrimaryKeyMock.mockRejectedValueOnce(new Error("timeout"));
    // Second call (after Retry) succeeds with a real PK.
    tablePrimaryKeyMock.mockResolvedValue({ pk_columns: ["id"], enums: {} });

    uniquePkErrorViewer();

    // Wait for the error banner to appear.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Retry primary key lookup/i })).toBeInTheDocument();
    });

    // Click Retry.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Retry primary key lookup/i }));
      await Promise.resolve();
    });

    // After successful retry, the error banner should be gone.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Retry primary key lookup/i })).toBeNull();
    });

    // The no-PK banner should also not be visible (PK is now known).
    expect(screen.queryByText(/No primary key/i)).toBeNull();

    // tablePrimaryKey was called twice total (initial + retry).
    expect(tablePrimaryKeyMock).toHaveBeenCalledTimes(2);
  });

  it("3.4c: genuine pk_columns: null success still shows the no-PK banner (not the error banner)", async () => {
    tablePrimaryKeyMock.mockResolvedValue({ pk_columns: null, enums: {} });

    uniquePkErrorViewer();

    await waitFor(() => {
      expect(screen.getByText(/No primary key/i)).toBeInTheDocument();
    });

    // Must NOT show the retry/error banner.
    expect(screen.queryByRole("button", { name: /Retry primary key lookup/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Auto-focus-on-activation tests (issue #280, tasks 4.1-4.4).
//
// Renders the *real* DataGrid (this file mocks `./api`, schema-cache, active
// connections, settings, connections registry, and context hooks — but never
// DataGrid), so `@tanstack/react-virtual` is mocked here the same way
// `DataGrid.copy.test.tsx` (~line 29) does, to get real rows in jsdom.
// ---------------------------------------------------------------------------

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

const nextFrame = () =>
  act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  });

/** The DataGrid root is the only `tabIndex={0}` element in this component tree. */
function gridRootOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[tabindex="0"]');
}

async function waitForGridMounted(container: HTMLElement) {
  await waitFor(() => {
    expect(gridRootOf(container)).not.toBeNull();
  });
}

describe("TableViewerTab — auto-focus on activation (issue #280)", () => {
  let focusCounter = 0;
  function uniqueFocusViewer() {
    focusCounter++;
    return renderViewer({
      connectionId: `conn-focus-${focusCounter}`,
      schema: "public",
      relation: `table-focus-${focusCounter}`,
    });
  }

  // Elements appended directly to document.body (outside RTL's render
  // container) to stand in for surfaces the auto-focus hook must not steal
  // from (a bare input, a quick-switcher palette input). Not covered by
  // RTL's automatic per-test cleanup, so we track and remove them ourselves.
  const extraNodes: HTMLElement[] = [];
  function appendStandalone<T extends HTMLElement>(el: T): T {
    document.body.appendChild(el);
    extraNodes.push(el);
    return el;
  }

  beforeEach(() => {
    queryTableMock.mockReset();
    tablePrimaryKeyMock.mockReset();
    getSettingMock.mockReset();
    setSettingMock.mockReset();
    getSettingMock.mockResolvedValue(null);
    setSettingMock.mockResolvedValue(undefined);
    queryTableMock.mockResolvedValue(makeResult(3));
    tablePrimaryKeyMock.mockResolvedValue({ pk_columns: ["id"], enums: {} });
    // Tauri lane: `useTableData.fetchFirstPage` no-ops entirely (returns
    // before ever dispatching) when `__TAURI_INTERNALS__` is absent, so the
    // grid never leaves the first-load spinner in the memory-cache lane used
    // by the other describe blocks in this file. These tests need the real
    // DataGrid mounted, so they run in the Tauri lane instead.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    for (const el of extraNodes.splice(0)) {
      el.remove();
    }
  });

  it("4.1: focuses the grid root on activation, then ⌘F opens the filter bar and focuses its first value input without a click", async () => {
    const { container } = uniqueFocusViewer();

    await waitForGridMounted(container);
    await nextFrame();

    const gridRoot = gridRootOf(container);
    expect(gridRoot).not.toBeNull();
    expect(document.activeElement).toBe(gridRoot);

    // The issue's literal repro: no click, just the shortcut.
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    // The handler shows the bar and schedules the FilterBar's own focus in a RAF.
    await nextFrame();

    expect(queryApplyAllPrimary()).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Value/i })).toBe(document.activeElement);
  });

  it("4.2: does not steal focus from a real <input> focused before activation", async () => {
    const outsideInput = appendStandalone(document.createElement("input"));
    outsideInput.value = "hello world";
    outsideInput.focus();
    outsideInput.setSelectionRange(2, 5);

    const { container } = uniqueFocusViewer();

    await waitForGridMounted(container);
    await nextFrame();

    expect(document.activeElement).toBe(outsideInput);
    expect(outsideInput.selectionStart).toBe(2);
    expect(outsideInput.selectionEnd).toBe(5);
  });

  it("4.3: quick-switcher regression — a focused palette input keeps focus on activation; a later activation lands on the grid root once the palette is gone", async () => {
    // Stand-in for PaletteShell.tsx's autoFocus input (issue #280 repro path).
    const paletteInput = appendStandalone(document.createElement("input"));
    paletteInput.focus();

    focusCounter++;
    const connectionId = `conn-focus-palette-${focusCounter}`;
    const relation = `table-focus-palette-${focusCounter}`;
    const baseProps = {
      tabId: "tab-palette",
      connectionId,
      connectionName: "Test",
      schema: "public",
      relation,
      relationKind: "table" as const,
    };

    const { container, rerender } = render(
      <TabsProvider>
        <TableViewer {...baseProps} active={false} />
      </TabsProvider>,
    );

    // First activation while the palette input still holds focus — must not
    // steal it (no intervening click, exactly the ⌘P dismiss path).
    rerender(
      <TabsProvider>
        <TableViewer {...baseProps} active={true} />
      </TabsProvider>,
    );
    await nextFrame();

    expect(document.activeElement).toBe(paletteInput);

    // Palette dismisses: nothing restores focus (per design.md, that's a
    // separate concern) — it just goes away.
    paletteInput.blur();
    paletteInput.remove();
    extraNodes.splice(extraNodes.indexOf(paletteInput), 1);

    // Let the grid actually mount before the next activation edge, so this
    // exercises "lands on the grid" rather than the loading-fallback case.
    await waitForGridMounted(container);

    // A fresh false -> true activation edge (re-opening the tab).
    rerender(
      <TabsProvider>
        <TableViewer {...baseProps} active={false} />
      </TabsProvider>,
    );
    rerender(
      <TabsProvider>
        <TableViewer {...baseProps} active={true} />
      </TabsProvider>,
    );
    await nextFrame();

    const gridRoot = gridRootOf(container);
    expect(gridRoot).not.toBeNull();
    expect(document.activeElement).toBe(gridRoot);
  });

  it("4.4: auto-focus does not set an active cell or a row-range selection", async () => {
    const { container } = uniqueFocusViewer();

    await waitForGridMounted(container);
    await nextFrame();

    expect(document.activeElement).toBe(gridRootOf(container));

    // No cell carries the active-cell ring class.
    expect(container.querySelectorAll(`.${dataGridStyles.cellActive}`)).toHaveLength(0);

    // No row is rendered selected — makeResult(3) guarantees rows exist to check.
    const rows = container.querySelectorAll("[data-selected]");
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((row) => {
      expect(row).toHaveAttribute("data-selected", "false");
    });
  });
});
