import { describe, expect, it, vi, beforeEach } from "vitest";
import { openContextQuery } from "../openContextQuery";
import type { QueryListItem } from "../types";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@/modules/context/api", () => ({
  contextApi: {
    getQuery: vi.fn(),
  },
}));

vi.mock("@/modules/postgres/sql", () => ({
  openQueryTab: vi.fn(),
}));

// Not exercised by these tests, but openContextQuery imports them directly —
// mock so importing the module under test never touches the real modules.
vi.mock("@/modules/mysql/openMysqlQueryTab", () => ({
  openMysqlQueryTab: vi.fn(),
}));
vi.mock("@/modules/mssql/openMssqlQueryTab", () => ({
  openMssqlQueryTab: vi.fn(),
}));
vi.mock("@/modules/dynamo/openDynamoQuery", () => ({
  openDynamoQuery: vi.fn(),
}));
vi.mock("@/modules/athena/openAthenaQueryTab", () => ({
  openAthenaQueryTab: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import mocks after vi.mock calls
// ---------------------------------------------------------------------------

import { contextApi } from "@/modules/context/api";
import { openQueryTab } from "@/modules/postgres/sql";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTabsStub() {
  return {
    tabs: [],
    open: vi.fn().mockReturnValue("t1"),
    activate: vi.fn(),
  };
}

function makeQueryItem(overrides: Partial<QueryListItem> = {}): QueryListItem {
  return {
    name: "Top customers",
    path: "top-customers",
    folder: "",
    params: [],
    description: null,
    tags: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(contextApi.getQuery).mockResolvedValue({
    name: "Top customers",
    description: null,
    params: [],
    tags: [],
    body: "SELECT 1;",
    path: "top-customers",
    folder: "",
  });
});

// ---------------------------------------------------------------------------
// #242 regression: opening a context query must focus its own connection
// before opening the tab, otherwise the tab lands in a hidden (non-focused)
// tab set and appears to do nothing.
// ---------------------------------------------------------------------------

describe("openContextQuery — focus switching (#242)", () => {
  it("switches focus to the query's connection when that connection is open, then opens the tab", async () => {
    const tabs = makeTabsStub();
    const focus = { setFocused: vi.fn(), isOpen: vi.fn(() => true) };
    const queryItem = makeQueryItem();

    await openContextQuery(tabs, "conn-1", "Conn 1", "postgres", queryItem, focus);

    expect(focus.isOpen).toHaveBeenCalledWith("conn-1");
    expect(focus.setFocused).toHaveBeenCalledWith("conn-1");
    expect(openQueryTab).toHaveBeenCalledOnce();
    const call = vi.mocked(openQueryTab).mock.calls[0];
    expect(call?.[1]).toMatchObject({
      initialConnectionId: "conn-1",
      initialSql: "SELECT 1;",
    });
  });

  it("does not switch focus when the query's connection is not open, but still opens the tab", async () => {
    const tabs = makeTabsStub();
    const focus = { setFocused: vi.fn(), isOpen: vi.fn(() => false) };
    const queryItem = makeQueryItem();

    await openContextQuery(tabs, "conn-1", "Conn 1", "postgres", queryItem, focus);

    expect(focus.isOpen).toHaveBeenCalledWith("conn-1");
    expect(focus.setFocused).not.toHaveBeenCalled();
    expect(openQueryTab).toHaveBeenCalledOnce();
    const call = vi.mocked(openQueryTab).mock.calls[0];
    expect(call?.[1]).toMatchObject({
      initialConnectionId: "conn-1",
      initialSql: "SELECT 1;",
    });
  });
});
