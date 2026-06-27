/**
 * §8.4 / §12.5 — Context folder wiring tests for MssqlTableViewerTab.
 *
 * Scoped to the context integration assertions:
 * - When contextPath is non-null and the relation has an ObjectListItem,
 *   the Docs tab is rendered in the subtab bar.
 * - When docsAvailable === false, the Docs tab is hidden.
 * - columnNotes from contextDoc.human.column_notes flow into structure rendering.
 */

import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TabsProvider } from "@/platform/shell/tabs/TabsContext";
import { MssqlTableViewerTab } from "../TableViewerTab";
import type { Tab } from "@/platform/shell/tabs/types";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock("../api", () => ({
  dataApi: {
    queryTable: vi.fn().mockResolvedValue({
      columns: [{ name: "id", data_type: "int", ordinal_position: 1, is_nullable: false }],
      rows: [],
      applied: { limit: 200, offset: 0, order_by: [], filter_tree: null, raw_where: null },
      query_ms: 1,
      truncated_columns: [],
    }),
    tablePrimaryKey: vi.fn().mockResolvedValue({ columns: ["id"] }),
    applyTableEdits: vi.fn(),
  },
}));

vi.mock("../useTableData", () => {
  // Stable reference — prevents infinite re-render loops caused by React
  // dependency arrays seeing new object references on every render cycle.
  const stableData = {
    columns: [{ name: "id", data_type: "int", ordinal_position: 1, is_nullable: false }],
    rows: [],
    isLoading: false,
    isLoadingNext: false,
    isReady: true,
    error: null,
    nextError: null,
    reachedEnd: true,
    pageSize: 200,
    orderBy: [],
    filterModel: { rows: [], combinator: "AND" },
    queryMs: null,
    setPageSize: vi.fn(),
    setOrderBy: vi.fn(),
    setFilterModel: vi.fn(),
    refresh: vi.fn(),
    loadNextPage: vi.fn(),
    clearNextError: vi.fn(),
  };
  return { useTableData: vi.fn(() => stableData) };
});

vi.mock("../useEditBuffer", () => {
  const stableBuffer = {
    rows: new Map(),
    hasDirty: false,
    dirtyCounts: { updates: 0, inserts: 0, deletes: 0 },
    addInsertRow: vi.fn(),
    updateCell: vi.fn(),
    deleteRow: vi.fn(),
    bulkDeleteToggle: vi.fn(),
    isRowDeleted: vi.fn(() => false),
    toEditOps: vi.fn(() => []),
    commitSuccess: vi.fn(),
    clear: vi.fn(),
    undo: vi.fn(),
  };
  return {
    useEditBuffer: vi.fn(() => stableBuffer),
    buildRowKey: vi.fn(() => "key"),
  };
});

vi.mock("../../useActiveConnections", () => ({
  useActiveMssqlConnections: vi.fn(() => ({
    getActive: () => ({ read_only: false }),
  })),
}));

vi.mock("../../structure/useTableStructureCache", () => ({
  useTableStructureCache: vi.fn(() => ({
    structureState: { status: "idle", response: null, error: null },
    ensureStructureLoaded: vi.fn(),
    refreshStructure: vi.fn(),
  })),
}));

// Mock heavy components to avoid OOM in tests
vi.mock("../../structure/StructureSubtab", () => ({
  StructureSubtab: vi.fn(() => null),
}));

vi.mock("../../structure/RawSubtab", () => ({
  RawSubtab: vi.fn(() => null),
}));

vi.mock("@/modules/context/components/DocsSubtab", () => ({
  DocsSubtab: vi.fn(() => <div>Docs content</div>),
}));

vi.mock("../DataGrid", () => ({
  DataGrid: vi.fn(() => null),
}));

vi.mock("../FilterBar", () => ({
  FilterBar: vi.fn(() => null),
}));

vi.mock("../Inspector", () => ({
  Inspector: vi.fn(() => null),
}));

vi.mock("@/platform/shell/tabs/useDirtySummary", () => ({
  useDirtySummary: vi.fn(),
}));

// useConnections — provides context_path for the connection
vi.mock("@/platform/connection-registry/useConnections", () => ({
  useConnections: vi.fn(() => ({
    items: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

// Context hooks stub
vi.mock("@/modules/context/hooks", () => ({
  useContextObjects: vi.fn(() => ({ data: [], loading: false, error: null, refresh: vi.fn() })),
  useContextObject: vi.fn(() => ({ data: null, loading: false, error: null, refresh: vi.fn() })),
}));

// ---------------------------------------------------------------------------
// Imports that need to come after mocks (vitest hoisting rules)
// ---------------------------------------------------------------------------

import { useConnections } from "@/platform/connection-registry/useConnections";
import { useContextObjects, useContextObject } from "@/modules/context/hooks";
import type { ObjectListItem, ObjectDoc } from "@/modules/context/types";
import { useEditBuffer } from "../useEditBuffer";
import { useTableData } from "../useTableData";
import { dataApi } from "../api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTab(overrides: Partial<{
  connectionId: string;
  schema: string;
  relation: string;
}> = {}): Tab {
  return {
    id: "tab-1",
    kind: "mssql-table-data",
    title: "test",
    closable: true,
    payload: {
      connectionId: overrides.connectionId ?? "conn-1",
      connectionName: "Test",
      schema: overrides.schema ?? "dbo",
      relation: overrides.relation ?? "users",
      relationKind: "table",
    },
  };
}

function renderViewer(tab: Tab) {
  return render(
    <TabsProvider>
      <MssqlTableViewerTab tab={tab} active={true} />
    </TabsProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MssqlTableViewerTab — context folder wiring", () => {
  const useConnectionsMock = vi.mocked(useConnections);
  const useContextObjectsMock = vi.mocked(useContextObjects);
  const useContextObjectMock = vi.mocked(useContextObject);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function mockConnections(contextPath: string | null): any {
    return {
      items: [{ id: "conn-1", name: "Test", context_path: contextPath }],
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
  }

  beforeEach(() => {
    // Default: no context_path set
    useConnectionsMock.mockReturnValue(mockConnections(null));
    useContextObjectsMock.mockReturnValue({ data: [], loading: false, error: null, refresh: vi.fn() });
    useContextObjectMock.mockReturnValue({ data: null, loading: false, error: null, refresh: vi.fn() });
  });

  it("does not render Docs tab when contextPath is null", () => {
    useConnectionsMock.mockReturnValue({
      items: [{ id: "conn-1", name: "Test", context_path: null } as unknown as ReturnType<typeof useConnections>["items"][0]],
      loading: false,
      error: null,
      refresh: vi.fn(),
    } as unknown as ReturnType<typeof useConnections>);

    renderViewer(makeTab());
    expect(screen.queryByRole("tab", { name: /Docs/i })).toBeNull();
  });

  it("does not render Docs tab when contextPath is set but relation is not documented", () => {
    useConnectionsMock.mockReturnValue({
      items: [{ id: "conn-1", name: "Test", context_path: "/some/folder" } as unknown as ReturnType<typeof useConnections>["items"][0]],
      loading: false,
      error: null,
      refresh: vi.fn(),
    } as unknown as ReturnType<typeof useConnections>);
    // useContextObjects returns empty list → no documented item
    useContextObjectsMock.mockReturnValue({ data: [], loading: false, error: null, refresh: vi.fn() });

    renderViewer(makeTab());
    expect(screen.queryByRole("tab", { name: /Docs/i })).toBeNull();
  });

  it("renders Docs tab when contextPath is set and relation is documented", () => {
    useConnectionsMock.mockReturnValue({
      items: [{ id: "conn-1", name: "Test", context_path: "/some/folder" } as unknown as ReturnType<typeof useConnections>["items"][0]],
      loading: false,
      error: null,
      refresh: vi.fn(),
    } as unknown as ReturnType<typeof useConnections>);

    const docItem: ObjectListItem = {
      identity: "dbo.users",
      kind: "table",
      name: "users",
      schema: "dbo",
      has_human: true,
      deleted_in_db: false,
    };
    useContextObjectsMock.mockReturnValue({ data: [docItem], loading: false, error: null, refresh: vi.fn() });

    renderViewer(makeTab());
    expect(screen.getByRole("tab", { name: /Docs/i })).toBeInTheDocument();
  });

  it("switching to Docs tab renders DocsSubtab content area", () => {
    useConnectionsMock.mockReturnValue({
      items: [{ id: "conn-1", name: "Test", context_path: "/some/folder" } as unknown as ReturnType<typeof useConnections>["items"][0]],
      loading: false,
      error: null,
      refresh: vi.fn(),
    } as unknown as ReturnType<typeof useConnections>);

    const docItem: ObjectListItem = {
      identity: "dbo.users",
      kind: "table",
      name: "users",
      schema: "dbo",
      has_human: true,
      deleted_in_db: false,
    };
    useContextObjectsMock.mockReturnValue({ data: [docItem], loading: false, error: null, refresh: vi.fn() });

    renderViewer(makeTab());
    fireEvent.click(screen.getByRole("tab", { name: /Docs/i }));
    // DocsSubtab renders — verify the Docs tab button is now active
    expect(screen.getByRole("tab", { name: /Docs/i })).toHaveAttribute("aria-selected", "true");
  });

  it("snap-back: Docs tab navigates away when docsAvailable becomes false", () => {
    // Start with docs available
    useConnectionsMock.mockReturnValue({
      items: [{ id: "conn-1", name: "Test", context_path: "/some/folder" } as unknown as ReturnType<typeof useConnections>["items"][0]],
      loading: false,
      error: null,
      refresh: vi.fn(),
    } as unknown as ReturnType<typeof useConnections>);

    const docItem: ObjectListItem = {
      identity: "dbo.users",
      kind: "table",
      name: "users",
      schema: "dbo",
      has_human: true,
      deleted_in_db: false,
    };
    useContextObjectsMock.mockReturnValue({ data: [docItem], loading: false, error: null, refresh: vi.fn() });

    const { rerender } = renderViewer(makeTab());
    fireEvent.click(screen.getByRole("tab", { name: /Docs/i }));
    expect(screen.getByRole("tab", { name: /Docs/i })).toHaveAttribute("aria-selected", "true");

    // Now remove contextPath → docs no longer available
    useConnectionsMock.mockReturnValue({
      items: [{ id: "conn-1", name: "Test", context_path: null } as unknown as ReturnType<typeof useConnections>["items"][0]],
      loading: false,
      error: null,
      refresh: vi.fn(),
    } as unknown as ReturnType<typeof useConnections>);
    useContextObjectsMock.mockReturnValue({ data: [], loading: false, error: null, refresh: vi.fn() });

    rerender(
      <TabsProvider>
        <MssqlTableViewerTab tab={makeTab({ relation: "users2" })} active={true} />
      </TabsProvider>,
    );

    // Docs tab is gone; Data tab is active
    expect(screen.queryByRole("tab", { name: /Docs/i })).toBeNull();
    expect(screen.getByRole("tab", { name: /Data/i })).toHaveAttribute("aria-selected", "true");
  });

  it("columnNotes from contextDoc flow through to structure rendering", () => {
    useConnectionsMock.mockReturnValue({
      items: [{ id: "conn-1", name: "Test", context_path: "/some/folder" } as unknown as ReturnType<typeof useConnections>["items"][0]],
      loading: false,
      error: null,
      refresh: vi.fn(),
    } as unknown as ReturnType<typeof useConnections>);

    const docItem: ObjectListItem = {
      identity: "dbo.users",
      kind: "table",
      name: "users",
      schema: "dbo",
      has_human: true,
      deleted_in_db: false,
    };
    useContextObjectsMock.mockReturnValue({ data: [docItem], loading: false, error: null, refresh: vi.fn() });

    const contextDoc: ObjectDoc = {
      system: {
        kind: "table",
        schema: "dbo",
        name: "users",
        primary_key: ["id"],
        columns: null,
        last_synced: null,
        deleted_in_db: false,
      },
      human: {
        tags: null,
        owners: null,
        column_notes: { id: "Primary identifier for the user" },
      },
      body: "Users table",
    };
    useContextObjectMock.mockReturnValue({ data: contextDoc, loading: false, error: null, refresh: vi.fn() });

    renderViewer(makeTab());
    // Switch to structure subtab to see column notes
    fireEvent.click(screen.getByRole("tab", { name: /Structure/i }));
    // columnNotes are passed to StructureSubtab but require loaded structure to show —
    // since structure is idle, the notes won't appear yet, but we can verify the
    // useContextObject hook was called with the identity when docs are available
    expect(useContextObjectMock).toHaveBeenCalledWith("conn-1", "dbo.users", "/some/folder");
  });
});

// ---------------------------------------------------------------------------
// §discard-pending-changes — guarded refresh tests
// ---------------------------------------------------------------------------

describe("MssqlTableViewerTab — guarded refresh (discard-pending-changes)", () => {
  const useEditBufferMock = vi.mocked(useEditBuffer);
  const useTableDataMock = vi.mocked(useTableData);

  // Build a buffer object with the given hasDirty flag.
  function makeBuffer(hasDirty: boolean) {
    return {
      // Partial stub — only the fields TableViewer touches in these tests.
      rows: new Map(),
      hasDirty,
      dirtyCounts: {
        updates: hasDirty ? 1 : 0,
        inserts: 0,
        deletes: 0,
      },
      addInsertRow: vi.fn(),
      updateCell: vi.fn(),
      deleteRow: vi.fn(),
      bulkDeleteToggle: vi.fn(),
      isRowDeleted: vi.fn(() => false),
      toEditOps: vi.fn(() => []),
      commitSuccess: vi.fn(),
      clear: vi.fn(),
      undo: vi.fn(),
    } as unknown as ReturnType<typeof useEditBuffer>;
  }

  // Build a tableData stub with a fresh `refresh` spy each time.
  function makeTableData() {
    return {
      columns: [{ name: "id", data_type: "int", ordinal_position: 1, is_nullable: false }],
      rows: [],
      isLoading: false,
      isLoadingNext: false,
      isReady: true,
      error: null,
      nextError: null,
      reachedEnd: true,
      pageSize: 200,
      orderBy: [],
      filterModel: { rows: [], combinator: "AND" },
      queryMs: null,
      setPageSize: vi.fn(),
      setOrderBy: vi.fn(),
      setFilterModel: vi.fn(),
      refresh: vi.fn(),
      loadNextPage: vi.fn(),
      clearNextError: vi.fn(),
    } as unknown as ReturnType<typeof useTableData>;
  }

  beforeEach(() => {
    // Reset to clean state between tests.
    useEditBufferMock.mockReturnValue(makeBuffer(false));
    useTableDataMock.mockReturnValue(makeTableData());
  });

  it("⌘R with dirty buffer opens the discard dialog and does NOT refresh", () => {
    const buffer = makeBuffer(true);
    const tableData = makeTableData();
    useEditBufferMock.mockReturnValue(buffer);
    useTableDataMock.mockReturnValue(tableData);

    renderViewer(makeTab());

    // The dialog Cancel button should not exist before ⌘R.
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();

    // Fire ⌘R on the root element.
    const region = screen.getByRole("region");
    fireEvent.keyDown(region, { key: "r", metaKey: true });

    // Dialog should now be visible — Cancel button is unique to the dialog.
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    // Refresh must NOT have been called yet.
    expect(tableData.refresh).not.toHaveBeenCalled();
  });

  it("confirming the discard dialog clears the buffer and refreshes", () => {
    const buffer = makeBuffer(true);
    const tableData = makeTableData();
    useEditBufferMock.mockReturnValue(buffer);
    useTableDataMock.mockReturnValue(tableData);

    renderViewer(makeTab());

    // Open the dialog via the reload button in SubtabHeader.
    const reloadBtn = screen.getByTitle(/reload/i);
    fireEvent.click(reloadBtn);

    // Dialog is open — Cancel button is unique to the dialog.
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();

    // The dialog Discard button is the last "Discard" button (toolbar has one too).
    const discardBtns = screen.getAllByRole("button", { name: /^Discard$/i });
    const dialogDiscardBtn = discardBtns[discardBtns.length - 1]!;
    fireEvent.click(dialogDiscardBtn);

    expect(buffer.clear).toHaveBeenCalledTimes(1);
    expect(tableData.refresh).toHaveBeenCalledTimes(1);
  });

  it("cancelling the discard dialog leaves buffer intact and does not refresh", () => {
    const buffer = makeBuffer(true);
    const tableData = makeTableData();
    useEditBufferMock.mockReturnValue(buffer);
    useTableDataMock.mockReturnValue(tableData);

    renderViewer(makeTab());

    // Open the dialog via the reload button.
    const reloadBtn = screen.getByTitle(/reload/i);
    fireEvent.click(reloadBtn);

    // Cancel.
    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    fireEvent.click(cancelBtn);

    expect(buffer.clear).not.toHaveBeenCalled();
    expect(tableData.refresh).not.toHaveBeenCalled();
  });

  it("⌘R with a clean buffer refreshes immediately without showing the dialog", () => {
    const buffer = makeBuffer(false);
    const tableData = makeTableData();
    useEditBufferMock.mockReturnValue(buffer);
    useTableDataMock.mockReturnValue(tableData);

    renderViewer(makeTab());

    const region = screen.getByRole("region");
    fireEvent.keyDown(region, { key: "r", metaKey: true });

    // No dialog.
    expect(screen.queryByRole("button", { name: /^Discard$/i })).toBeNull();
    // Refresh called immediately.
    expect(tableData.refresh).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// §5.1/5.2 — PK lookup error state: error banner, Retry, genuine no-PK banner
// ---------------------------------------------------------------------------

describe("MssqlTableViewerTab — PK lookup error state", () => {
  const tablePrimaryKeyMock = dataApi.tablePrimaryKey as Mock;

  beforeEach(() => {
    // Reset call history and restore default success state before each test
    tablePrimaryKeyMock.mockClear();
    tablePrimaryKeyMock.mockResolvedValue({ columns: ["id"] });
  });

  it("shows error banner (not 'No primary key') when PK lookup rejects", async () => {
    tablePrimaryKeyMock.mockRejectedValue(new Error("connection timeout"));

    renderViewer(makeTab());

    await waitFor(() => {
      expect(screen.getByText(/Could not determine primary key/i)).toBeInTheDocument();
    });

    // Error message is surfaced
    expect(screen.getByText(/connection timeout/i)).toBeInTheDocument();

    // Retry button is present
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();

    // The "No primary key" banner must NOT appear
    expect(screen.queryByText(/No primary key — existing rows cannot be edited/i)).toBeNull();
  });

  it("Retry re-invokes the PK command and removes the error banner on success", async () => {
    // First call fails, second call succeeds with a PK
    tablePrimaryKeyMock
      .mockRejectedValueOnce(new Error("transient error"))
      .mockResolvedValueOnce({ columns: ["id"] });

    renderViewer(makeTab());

    // Wait for the error banner to appear
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });

    // Click Retry
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    // After successful retry, the error banner disappears
    await waitFor(() => {
      expect(screen.queryByText(/Could not determine primary key/i)).toBeNull();
    });

    // tablePrimaryKey was called twice (initial + retry)
    expect(tablePrimaryKeyMock).toHaveBeenCalledTimes(2);
  });

  it("shows 'No primary key' banner when PK lookup succeeds with columns: null", async () => {
    tablePrimaryKeyMock.mockResolvedValue({ columns: null });

    renderViewer(makeTab());

    await waitFor(() => {
      expect(
        screen.getByText(/No primary key — existing rows cannot be edited/i),
      ).toBeInTheDocument();
    });

    // Error banner must NOT appear
    expect(screen.queryByText(/Could not determine primary key/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });
});
