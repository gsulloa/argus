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

  it("Unset resets value input to empty and clears draft rows", () => {
    uniqueStateViewer();
    openFilterBar();
    const valueInput = screen.getByRole("textbox", { name: /Value/i });
    fireEvent.change(valueInput, { target: { value: "hello" } });
    // Click Unset.
    fireEvent.click(screen.getByRole("button", { name: /^Unset$/i }));
    // Value should be cleared.
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
