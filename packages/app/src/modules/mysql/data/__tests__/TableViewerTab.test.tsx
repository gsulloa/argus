/**
 * §7.6 / §12.5 — Context folder wiring tests for MysqlTableViewerTab.
 *
 * Scoped to the context integration assertions:
 * - When contextPath is non-null and the relation has an ObjectListItem,
 *   the Docs tab is rendered in the subtab bar.
 * - When docsAvailable === false, the Docs tab is hidden.
 * - columnNotes from contextDoc.human.column_notes flow into the context
 *   object hook calls.
 *
 * NOTE: The useTableData and useEditBuffer mocks MUST return stable object
 * references (defined inside the factory, not re-created per call). Returning
 * new objects on each render causes React dependency arrays to see changes on
 * every render cycle, producing an infinite re-render loop that exhausts the
 * Node.js heap. See the vi.mock factories below for the correct pattern.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TabsProvider } from "@/platform/shell/tabs/TabsContext";

// ---------------------------------------------------------------------------
// Module-level mocks — vitest hoists these before any static imports
// ---------------------------------------------------------------------------

vi.mock("@/modules/mysql/data/DataGrid", () => ({ DataGrid: vi.fn(() => null) }));
vi.mock("@/modules/mysql/data/FilterBar", () => ({ FilterBar: vi.fn(() => null) }));
vi.mock("@/modules/mysql/data/Inspector", () => ({ Inspector: vi.fn(() => null) }));
vi.mock("@/modules/mysql/structure/StructureSubtab", () => ({ StructureSubtab: vi.fn(() => null) }));
vi.mock("@/modules/mysql/structure/RawSubtab", () => ({ RawSubtab: vi.fn(() => null) }));
vi.mock("@/modules/context/components/DocsSubtab", () => ({
  DocsSubtab: vi.fn(() => null),
}));
vi.mock("@/modules/context/components/ContextFolderBanner", () => ({
  ContextFolderBanner: vi.fn(() => null),
}));

vi.mock("@/modules/mysql/data/api", () => ({
  dataApi: {
    tablePrimaryKey: vi.fn().mockResolvedValue({ columns: ["id"] }),
    applyTableEdits: vi.fn(),
  },
}));

vi.mock("@/modules/mysql/data/useTableData", () => {
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

vi.mock("@/modules/mysql/data/useEditBuffer", () => {
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

vi.mock("@/modules/mysql/useActiveConnections", () => ({
  useActiveMysqlConnections: vi.fn(() => ({
    getActive: () => ({ read_only: false }),
  })),
}));

vi.mock("@/modules/mysql/structure/useTableStructureCache", () => ({
  useTableStructureCache: vi.fn(() => ({
    structureState: { status: "idle", response: null, error: null },
    ensureStructureLoaded: vi.fn(),
    refreshStructure: vi.fn(),
  })),
}));

vi.mock("@/platform/shell/tabs/useDirtySummary", () => ({
  useDirtySummary: vi.fn(),
}));

vi.mock("@/platform/settings/api", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/platform/connection-registry/useConnections", () => ({
  useConnections: vi.fn(() => ({
    items: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

vi.mock("@/modules/context/hooks", () => ({
  useContextObjects: vi.fn(() => ({
    data: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
  useContextObject: vi.fn(() => ({
    data: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports — after all vi.mock declarations
// ---------------------------------------------------------------------------

import { MysqlTableViewerTab } from "@/modules/mysql/data/TableViewerTab";
import type { Tab } from "@/platform/shell/tabs/types";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { useContextObjects, useContextObject } from "@/modules/context/hooks";
import type { ObjectListItem, ObjectDoc } from "@/modules/context/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockConnections(contextPath: string | null): any {
  return {
    items: [{ id: "conn-1", name: "Test", context_path: contextPath }],
    loading: false,
    error: null,
    refresh: vi.fn(),
  };
}

function makeTab(overrides: Partial<{
  connectionId: string;
  schema: string;
  relation: string;
}> = {}): Tab {
  return {
    id: "tab-1",
    kind: "mysql-table-data",
    title: "test",
    closable: true,
    payload: {
      connectionId: overrides.connectionId ?? "conn-1",
      connectionName: "Test",
      schema: overrides.schema ?? "mydb",
      relation: overrides.relation ?? "users",
      relationKind: "table",
    },
  };
}

function renderViewer(tab: Tab) {
  return render(
    <TabsProvider>
      <MysqlTableViewerTab tab={tab} active={true} />
    </TabsProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MysqlTableViewerTab — context folder wiring", () => {
  const useConnectionsMock = vi.mocked(useConnections);
  const useContextObjectsMock = vi.mocked(useContextObjects);
  const useContextObjectMock = vi.mocked(useContextObject);

  beforeEach(() => {
    useConnectionsMock.mockReturnValue(mockConnections(null));
    useContextObjectsMock.mockReturnValue({
      data: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    useContextObjectMock.mockReturnValue({
      data: null,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  it("renders Data tab as active by default", () => {
    renderViewer(makeTab());
    expect(screen.getByRole("tab", { name: /Data/i })).toHaveAttribute("aria-selected", "true");
  });

  it("does not render Docs tab when contextPath is null", () => {
    useConnectionsMock.mockReturnValue(mockConnections(null));
    renderViewer(makeTab());
    expect(screen.queryByRole("tab", { name: /Docs/i })).toBeNull();
  });

  it("does not render Docs tab when contextPath is set but relation is not documented", () => {
    useConnectionsMock.mockReturnValue(mockConnections("/some/folder"));
    useContextObjectsMock.mockReturnValue({
      data: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    renderViewer(makeTab());
    expect(screen.queryByRole("tab", { name: /Docs/i })).toBeNull();
  });

  it("renders Docs tab when contextPath is set and relation is documented", () => {
    useConnectionsMock.mockReturnValue(mockConnections("/some/folder"));
    const docItem: ObjectListItem = {
      identity: "mydb.users",
      kind: "table",
      name: "users",
      schema: "mydb",
      has_human: true,
      deleted_in_db: false,
    };
    useContextObjectsMock.mockReturnValue({
      data: [docItem],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    renderViewer(makeTab());
    expect(screen.getByRole("tab", { name: /Docs/i })).toBeInTheDocument();
  });

  it("Docs tab is selectable when docsAvailable is true", () => {
    useConnectionsMock.mockReturnValue(mockConnections("/some/folder"));
    const docItem: ObjectListItem = {
      identity: "mydb.users",
      kind: "table",
      name: "users",
      schema: "mydb",
      has_human: true,
      deleted_in_db: false,
    };
    useContextObjectsMock.mockReturnValue({
      data: [docItem],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    renderViewer(makeTab());
    fireEvent.click(screen.getByRole("tab", { name: /Docs/i }));
    expect(screen.getByRole("tab", { name: /Docs/i })).toHaveAttribute("aria-selected", "true");
  });

  it("calls useContextObject with identity when docs are available", () => {
    useConnectionsMock.mockReturnValue(mockConnections("/some/folder"));
    const docItem: ObjectListItem = {
      identity: "mydb.users",
      kind: "table",
      name: "users",
      schema: "mydb",
      has_human: true,
      deleted_in_db: false,
    };
    useContextObjectsMock.mockReturnValue({
      data: [docItem],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    const contextDoc: ObjectDoc = {
      system: {
        kind: "table",
        schema: "mydb",
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
    useContextObjectMock.mockReturnValue({
      data: contextDoc,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    renderViewer(makeTab());
    // Verify that useContextObject was called with the correct identity
    expect(useContextObjectMock).toHaveBeenCalledWith("conn-1", "mydb.users", "/some/folder");
  });

  it("calls useContextObject with null identity when docs are not available", () => {
    useConnectionsMock.mockReturnValue(mockConnections(null));
    useContextObjectsMock.mockReturnValue({
      data: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    renderViewer(makeTab());
    expect(useContextObjectMock).toHaveBeenCalledWith("conn-1", null, null);
  });
});
