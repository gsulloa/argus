import { describe, expect, it, vi, beforeEach } from "vitest";
import { openSavedQuery, openSavedQueryInNew } from "./openSavedQuery";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@/modules/postgres/sql/openQueryTab", () => ({
  openQueryTab: vi.fn().mockReturnValue("tab-pg"),
  openSavedQueryInNewTab: vi.fn().mockReturnValue("tab-pg-new"),
}));

vi.mock("@/modules/mysql/openMysqlQueryTab", () => ({
  openMysqlQueryTab: vi.fn(),
}));

vi.mock("@/modules/mssql/openMssqlQueryTab", () => ({
  openMssqlQueryTab: vi.fn(),
}));

vi.mock("./store", () => ({
  savedQueriesStore: {
    getSnapshot: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import mocks after vi.mock calls
// ---------------------------------------------------------------------------

import { openQueryTab, openSavedQueryInNewTab } from "@/modules/postgres/sql/openQueryTab";
import { openMysqlQueryTab } from "@/modules/mysql/openMysqlQueryTab";
import { openMssqlQueryTab } from "@/modules/mssql/openMssqlQueryTab";
import { savedQueriesStore } from "./store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTabsApi() {
  return {
    tabs: [],
    open: vi.fn().mockReturnValue("new-tab-id"),
    activate: vi.fn(),
  };
}

function makeCtx(overrides: Partial<{
  focusedConnectionId: string | null;
  setFocused: (id: string) => void;
  isOpen: (connectionId: string) => boolean;
}> = {}) {
  const setFocused = vi.fn<(id: string) => void>();
  const isOpen = vi.fn<(id: string) => boolean>().mockReturnValue(false);
  return {
    focusedConnectionId: null as string | null,
    setFocused,
    isOpen,
    ...overrides,
  };
}


function seedStore(queries: Array<{ id: string; name: string; sql: string; last_connection_id: string | null }>) {
  vi.mocked(savedQueriesStore.getSnapshot).mockReturnValue({
    queries,
    folders: [],
    tree: [],
    loading: false,
    error: null,
  } as never);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Query bound to a live (open) connection — focus switch + correct helper
// ---------------------------------------------------------------------------

describe("query bound to a live open connection (not currently focused)", () => {
  const QUERY_ID = "q-live";
  const SQL = "SELECT 1";

  it("Postgres: sets focus first, calls openQueryTab with conn args, returns 'opened'", () => {
    seedStore([{ id: QUERY_ID, name: "My query", sql: SQL, last_connection_id: "conn-pg" }]);
    const tabs = makeTabsApi();
    const ctx = makeCtx({
      focusedConnectionId: "conn-other",
      isOpen: vi.fn((id) => id === "conn-pg"),
    });
    const connections = { items: [{ id: "conn-pg", name: "Prod PG", kind: "postgres" }] };

    const result = openSavedQuery(tabs, connections, QUERY_ID, ctx);

    expect(result).toBe("opened");
    expect(ctx.setFocused).toHaveBeenCalledOnce();
    expect(ctx.setFocused).toHaveBeenCalledWith("conn-pg");
    expect(openQueryTab).toHaveBeenCalledOnce();
    expect(openQueryTab).toHaveBeenCalledWith(tabs, {
      initialConnectionId: "conn-pg",
      initialConnectionName: "Prod PG",
      initialSql: SQL,
      savedQueryId: QUERY_ID,
    });
    expect(openMysqlQueryTab).not.toHaveBeenCalled();
    expect(openMssqlQueryTab).not.toHaveBeenCalled();
  });

  it("MySQL: sets focus first, calls openMysqlQueryTab, returns 'opened'", () => {
    seedStore([{ id: QUERY_ID, name: "My query", sql: SQL, last_connection_id: "conn-mysql" }]);
    const tabs = makeTabsApi();
    const ctx = makeCtx({
      focusedConnectionId: "conn-other",
      isOpen: vi.fn((id) => id === "conn-mysql"),
    });
    const connections = { items: [{ id: "conn-mysql", name: "Prod MySQL", kind: "mysql" }] };

    const result = openSavedQuery(tabs, connections, QUERY_ID, ctx);

    expect(result).toBe("opened");
    expect(ctx.setFocused).toHaveBeenCalledOnce();
    expect(ctx.setFocused).toHaveBeenCalledWith("conn-mysql");
    expect(openMysqlQueryTab).toHaveBeenCalledOnce();
    expect(openMysqlQueryTab).toHaveBeenCalledWith(tabs, {
      connectionId: "conn-mysql",
      connectionName: "Prod MySQL",
      sql: SQL,
    });
    expect(openQueryTab).not.toHaveBeenCalled();
    expect(openMssqlQueryTab).not.toHaveBeenCalled();
  });

  it("MSSQL: sets focus first, calls openMssqlQueryTab, returns 'opened'", () => {
    seedStore([{ id: QUERY_ID, name: "My query", sql: SQL, last_connection_id: "conn-mssql" }]);
    const tabs = makeTabsApi();
    const ctx = makeCtx({
      focusedConnectionId: "conn-other",
      isOpen: vi.fn((id) => id === "conn-mssql"),
    });
    const connections = { items: [{ id: "conn-mssql", name: "Prod MSSQL", kind: "mssql" }] };

    const result = openSavedQuery(tabs, connections, QUERY_ID, ctx);

    expect(result).toBe("opened");
    expect(ctx.setFocused).toHaveBeenCalledOnce();
    expect(ctx.setFocused).toHaveBeenCalledWith("conn-mssql");
    expect(openMssqlQueryTab).toHaveBeenCalledOnce();
    expect(openMssqlQueryTab).toHaveBeenCalledWith(tabs, {
      connectionId: "conn-mssql",
      connectionName: "Prod MSSQL",
      sql: SQL,
    });
    expect(openQueryTab).not.toHaveBeenCalled();
    expect(openMysqlQueryTab).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Fallback path: no live connection, focused connection exists
// ---------------------------------------------------------------------------

describe("fallback: no live connection, focused connection exists", () => {
  const QUERY_ID = "q-no-live";
  const SQL = "SELECT 2";

  it("openSavedQuery: opens Postgres tab with undefined initialConnectionId, returns 'opened', setFocused NOT called", () => {
    seedStore([{ id: QUERY_ID, name: "Orphan query", sql: SQL, last_connection_id: "conn-gone" }]);
    const tabs = makeTabsApi();
    const ctx = makeCtx({
      focusedConnectionId: "conn-active",
      isOpen: vi.fn().mockReturnValue(false), // conn-gone is not open
    });
    // Connection not in the registry either (simulating the case where it disappeared)
    const connections = { items: [] };

    const result = openSavedQuery(tabs, connections, QUERY_ID, ctx);

    expect(result).toBe("opened");
    expect(ctx.setFocused).not.toHaveBeenCalled();
    expect(openQueryTab).toHaveBeenCalledOnce();
    expect(openQueryTab).toHaveBeenCalledWith(tabs, {
      initialConnectionId: undefined,
      initialConnectionName: undefined,
      initialSql: SQL,
      savedQueryId: QUERY_ID,
    });
  });

  it("openSavedQueryInNew: uses openSavedQueryInNewTab for Postgres fallback path", () => {
    seedStore([{ id: QUERY_ID, name: "Orphan query", sql: SQL, last_connection_id: null }]);
    const tabs = makeTabsApi();
    const ctx = makeCtx({
      focusedConnectionId: "conn-active",
      isOpen: vi.fn().mockReturnValue(false),
    });
    const connections = { items: [] };

    const result = openSavedQueryInNew(tabs, connections, QUERY_ID, ctx);

    expect(result).toBe("opened");
    expect(ctx.setFocused).not.toHaveBeenCalled();
    expect(openSavedQueryInNewTab).toHaveBeenCalledOnce();
    expect(openSavedQueryInNewTab).toHaveBeenCalledWith(tabs, {
      initialConnectionId: undefined,
      initialConnectionName: undefined,
      initialSql: SQL,
      savedQueryId: QUERY_ID,
    });
    expect(openQueryTab).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. No live connection AND no focused connection → "no-target"
// ---------------------------------------------------------------------------

describe("no live connection AND focusedConnectionId is null", () => {
  it("returns 'no-target', no tab opened, setFocused NOT called", () => {
    seedStore([{ id: "q-1", name: "Lonely query", sql: "SELECT 3", last_connection_id: null }]);
    const tabs = makeTabsApi();
    const ctx = makeCtx({
      focusedConnectionId: null,
      isOpen: vi.fn().mockReturnValue(false),
    });
    const connections = { items: [] };

    const result = openSavedQuery(tabs, connections, "q-1", ctx);

    expect(result).toBe("no-target");
    expect(ctx.setFocused).not.toHaveBeenCalled();
    expect(tabs.open).not.toHaveBeenCalled();
    expect(openQueryTab).not.toHaveBeenCalled();
    expect(openMysqlQueryTab).not.toHaveBeenCalled();
    expect(openMssqlQueryTab).not.toHaveBeenCalled();
  });

  it("openSavedQueryInNew also returns 'no-target' when no focused connection", () => {
    seedStore([{ id: "q-2", name: "Lonely query 2", sql: "SELECT 4", last_connection_id: null }]);
    const tabs = makeTabsApi();
    const ctx = makeCtx({ focusedConnectionId: null, isOpen: vi.fn().mockReturnValue(false) });
    const connections = { items: [] };

    const result = openSavedQueryInNew(tabs, connections, "q-2", ctx);

    expect(result).toBe("no-target");
    expect(ctx.setFocused).not.toHaveBeenCalled();
    expect(openSavedQueryInNewTab).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Query not found in store → "not-found"
// ---------------------------------------------------------------------------

describe("query not found in store", () => {
  it("returns 'not-found' and does nothing", () => {
    seedStore([]); // empty store
    const tabs = makeTabsApi();
    const ctx = makeCtx({ focusedConnectionId: "conn-active", isOpen: vi.fn().mockReturnValue(true) });
    const connections = { items: [{ id: "conn-active", name: "Prod", kind: "postgres" }] };

    const result = openSavedQuery(tabs, connections, "missing-id", ctx);

    expect(result).toBe("not-found");
    expect(ctx.setFocused).not.toHaveBeenCalled();
    expect(tabs.open).not.toHaveBeenCalled();
    expect(openQueryTab).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. openSavedQueryInNew: live connection path uses openSavedQueryInNewTab
// ---------------------------------------------------------------------------

describe("openSavedQueryInNew: live-connection path uses openSavedQueryInNewTab (not openQueryTab)", () => {
  it("Postgres live connection: uses openSavedQueryInNewTab", () => {
    const QUERY_ID = "q-new";
    seedStore([{ id: QUERY_ID, name: "New tab query", sql: "SELECT 5", last_connection_id: "conn-pg" }]);
    const tabs = makeTabsApi();
    const ctx = makeCtx({
      focusedConnectionId: null,
      isOpen: vi.fn((id) => id === "conn-pg"),
    });
    const connections = { items: [{ id: "conn-pg", name: "Prod PG", kind: "postgres" }] };

    const result = openSavedQueryInNew(tabs, connections, QUERY_ID, ctx);

    expect(result).toBe("opened");
    expect(ctx.setFocused).toHaveBeenCalledWith("conn-pg");
    expect(openSavedQueryInNewTab).toHaveBeenCalledOnce();
    expect(openQueryTab).not.toHaveBeenCalled();
  });
});
