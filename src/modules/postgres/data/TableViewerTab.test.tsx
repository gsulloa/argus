import React from "react";
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
      filter_tree: filterTreePresent ? { children: [] } : null,
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

describe("TableViewerTab — filter persistence (jsdom, memory-cache lane)", () => {
  beforeEach(() => {
    queryTableMock.mockReset();
    tablePrimaryKeyMock.mockReset();
    getSettingMock.mockReset();
    setSettingMock.mockReset();
    getSettingMock.mockResolvedValue(null);
    setSettingMock.mockResolvedValue(undefined);
    queryTableMock.mockResolvedValue(makeResult(1));
    // jsdom default: not a Tauri runtime — useSetting goes synchronous.
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("4.3 / 4.6: applied + draft survive unmount→remount on the same (conn,schema,relation)", async () => {
    const args = {
      connectionId: "conn-43",
      schema: "public",
      relation: "users-43",
    } as const;
    const { unmount } = renderViewer(args);

    // Build a structured filter via the bar UI: + AND row → leaves a
    // condition with default op `=` and any-column.
    fireEvent.click(screen.getByRole("button", { name: /AND row/ }));

    // Pick a real column (so the predicate isn't any-column) by selecting
    // "country" in the column picker. The bar surfaces a select with column
    // names — fall back to typing into the value to mark draft dirty.
    const valueInputs = await screen.findAllByPlaceholderText(/value/i);
    fireEvent.change(valueInputs[0]!, { target: { value: "CL" } });

    // Apply commits draft → applied. When draft is dirty the button label is
    // "Apply (unsaved changes)"; we use the exact label to avoid ambiguity
    // with the per-row "Apply only this row" button added in Wave 2.
    fireEvent.click(screen.getByRole("button", { name: "Apply (unsaved changes)" }));

    // Sanity: the bar should show the filter row.
    expect(valueInputs[0]).toHaveValue("CL");

    unmount();
    // Remount with the same key.
    renderViewer(args);

    // The persisted draft is restored — the value input shows the same value.
    const restored = await screen.findAllByPlaceholderText(/value/i);
    expect(restored[0]).toHaveValue("CL");

    // applied is restored too: the Apply button is in its non-dirty state
    // (which is true iff draft equals applied).
    expect(
      screen.getByRole("button", { name: "Apply" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Apply \(unsaved changes\)/ }),
    ).toBeNull();
  });

  it("3.1-strict: same as 3.1 but under React.StrictMode (mirrors the live app)", async () => {
    const baseProps = {
      tabId: "tab-1",
      connectionId: "conn-3-1-strict",
      connectionName: "Test",
      schema: "public",
      relationKind: "table" as const,
    };
    const { rerender } = render(
      <React.StrictMode>
        <TabsProvider>
          <TableViewer {...baseProps} relation="rel-A-strict" />
        </TabsProvider>
      </React.StrictMode>,
    );

    fireEvent.click(screen.getByRole("button", { name: /AND row/ }));
    const valueInputsA = await screen.findAllByPlaceholderText(/value/i);
    fireEvent.change(valueInputsA[0]!, { target: { value: "CL" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply (unsaved changes)" }));

    rerender(
      <React.StrictMode>
        <TabsProvider>
          <TableViewer {...baseProps} relation="rel-B-strict" />
        </TabsProvider>
      </React.StrictMode>,
    );
    expect(screen.queryByPlaceholderText(/value/i)).toBeNull();
    expect(screen.getByText(/No filters yet/i)).toBeInTheDocument();

    rerender(
      <React.StrictMode>
        <TabsProvider>
          <TableViewer {...baseProps} relation="rel-A-strict" />
        </TabsProvider>
      </React.StrictMode>,
    );
    const restored = await screen.findAllByPlaceholderText(/value/i);
    expect(restored[0]).toHaveValue("CL");
  });

  it("3.1: re-rendering the SAME instance with a different relation does not bleed filter state", async () => {
    // Drives the bug we're fixing: TabContent reuses the TableViewerTab
    // instance when switching between two postgres-table-data tabs of
    // different relations. The bar must reflect the new relation's
    // persisted state on first paint, not the previous relation's.
    const baseProps = {
      tabId: "tab-1",
      connectionId: "conn-3-1",
      connectionName: "Test",
      schema: "public",
      relationKind: "table" as const,
    };
    const { rerender } = render(
      <TabsProvider>
        <TableViewer {...baseProps} relation="rel-A-3-1" />
      </TabsProvider>,
    );

    // Apply a filter on relation A.
    fireEvent.click(screen.getByRole("button", { name: /AND row/ }));
    const valueInputsA = await screen.findAllByPlaceholderText(/value/i);
    fireEvent.change(valueInputsA[0]!, { target: { value: "CL" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply (unsaved changes)" }));

    // Now switch the SAME instance to relation B (no unmount — TabsContent
    // reuse pattern). Bar must be empty.
    rerender(
      <TabsProvider>
        <TableViewer {...baseProps} relation="rel-B-3-1" />
      </TabsProvider>,
    );
    expect(screen.queryByPlaceholderText(/value/i)).toBeNull();
    expect(screen.getByText(/No filters yet/i)).toBeInTheDocument();

    // Switch back to relation A → cached filter resurrects.
    rerender(
      <TabsProvider>
        <TableViewer {...baseProps} relation="rel-A-3-1" />
      </TabsProvider>,
    );
    const restored = await screen.findAllByPlaceholderText(/value/i);
    expect(restored[0]).toHaveValue("CL");
  });

  it("4.4: switching connectionId between mounts shows the empty model", async () => {
    const baseArgs = { schema: "public", relation: "users-44" };
    const { unmount } = renderViewer({ ...baseArgs, connectionId: "conn-A" });

    fireEvent.click(screen.getByRole("button", { name: /AND row/ }));
    const valueInputs = await screen.findAllByPlaceholderText(/value/i);
    fireEvent.change(valueInputs[0]!, { target: { value: "CL" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply (unsaved changes)" }));

    unmount();
    renderViewer({ ...baseArgs, connectionId: "conn-B" });

    // The bar should be empty (no value inputs) for the new connection.
    expect(screen.queryByPlaceholderText(/value/i)).toBeNull();
    expect(screen.getByText(/No filters yet/i)).toBeInTheDocument();
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

  it("4.5: defers queryTable until persisted filter has loaded, then fires once with filter_tree", async () => {
    const persisted = {
      draft: {
        mode: "structured",
        tree: {
          children: [
            {
              kind: "condition",
              column: { kind: "named", name: "country" },
              op: "=",
              value: "CL",
            },
          ],
        },
        raw: "",
      },
      applied: {
        mode: "structured",
        tree: {
          children: [
            {
              kind: "condition",
              column: { kind: "named", name: "country" },
              op: "=",
              value: "CL",
            },
          ],
        },
        raw: "",
      },
    };

    // Hold the filter read open so the first render sees `isLoaded === false`.
    let resolveFilter: ((v: string | null) => void) | undefined;
    const filterReadPromise = new Promise<string | null>((resolve) => {
      resolveFilter = resolve;
    });

    getSettingMock.mockImplementation((key: string) => {
      if (key.startsWith("pgTableFilter:")) return filterReadPromise;
      // Other keys (orderBy, page size, inspector width, …) settle synchronously.
      return Promise.resolve(null);
    });

    renderViewer({
      connectionId: "conn-45",
      schema: "public",
      relation: "users-45",
    });

    // Before the persisted filter resolves, no queryTable call should fire —
    // the data hook is gated on filterLoaded && orderByLoaded.
    expect(queryTableMock).not.toHaveBeenCalled();

    // Resolve the disk read with the persisted filter.
    await act(async () => {
      resolveFilter!(JSON.stringify(persisted));
      // Let microtasks flush so React commits the loaded state.
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(queryTableMock).toHaveBeenCalledTimes(1);
    });

    const args = queryTableMock.mock.calls[0]!;
    const options = args[3] as { filter_tree?: unknown };
    expect(options.filter_tree).toBeDefined();
  });
});
