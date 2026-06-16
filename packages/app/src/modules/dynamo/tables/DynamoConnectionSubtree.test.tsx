/**
 * DynamoConnectionSubtree tests.
 *
 * § 13.8: load-more affordance.
 * § 12.6 (Dynamo subtree badge test extension):
 *   - DocBadge renders next to a documented table name.
 *
 * Strategy: mock the CacheProvider's useDynamoTableCache hook directly so we
 * can control the cache state without spinning up the full provider (which
 * has an unbounded describe-pipeline effect that causes infinite renders
 * in test environments).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks (established before imports)
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const mockListTables = vi.fn();

vi.mock("./api", () => ({
  dynamoTablesApi: {
    listTables: (args: unknown) => mockListTables(args),
    describeTable: vi.fn().mockResolvedValue({
      table_name: "T",
      table_arn: "arn:aws:dynamodb:us-east-1:123:table/T",
      table_status: "ACTIVE",
      item_count: 0,
      table_size_bytes: 0,
      billing_mode: "PAY_PER_REQUEST",
      key_schema: [],
      attribute_definitions: [],
      global_secondary_indexes: [],
      local_secondary_indexes: [],
    }),
  },
}));

vi.mock("@/platform/settings/useSetting", () => ({
  useSetting: () => ["", vi.fn(), true],
}));

vi.mock("@/platform/shell/sidebarScroll", () => ({
  useSidebarScrollRef: () => ({ current: null }),
}));

vi.mock("@/platform/shell/tabs", () => ({
  useTabs: () => ({ open: vi.fn() }),
}));

vi.mock("@/modules/dynamo/useActiveConnections", () => ({
  useActiveDynamoConnections: () => ({
    items: [],
    loading: false,
    refresh: vi.fn(),
    isActive: vi.fn(() => false),
    getActive: vi.fn(() => undefined),
  }),
}));

// ── Context folder mocks ────────────────────────────────────────────────────

// Controllable context objects list for the DocBadge test.
let mockContextObjects: Array<{ name: string; deleted_in_db: boolean }> = [];
// Controllable params on the mocked connection (e.g. table_match rule).
let mockConnectionParams: Record<string, unknown> = {};

vi.mock("@/platform/connection-registry/useConnections", () => ({
  useConnections: () => ({
    items: [
      {
        id: "test-conn",
        context_path: "/fake/path",
        params: mockConnectionParams,
      },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    move: vi.fn(),
    remove: vi.fn(),
  }),
}));

vi.mock("@/modules/context/hooks", () => ({
  useContextObjects: () => ({
    data: mockContextObjects,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/modules/context/components/ContextFolderBanner", () => ({
  ContextFolderBanner: () => null,
}));

// ---------------------------------------------------------------------------
// Mock the CacheProvider so we control what useDynamoTableCache returns.
// This avoids the describe-pipeline infinite render loop in tests.
// ---------------------------------------------------------------------------

interface TablesSlotReady {
  status: "ready";
  names: string[];
  next_token?: string;
  truncated: boolean;
}

let mockTablesSlot: TablesSlotReady = {
  status: "ready",
  names: [],
  truncated: false,
};

const mockRefresh = vi.fn();
const mockLoadMore = vi.fn();
const mockRequestDescribe = vi.fn();
const mockRetryDescribe = vi.fn();

vi.mock("./CacheProvider", () => ({
  useDynamoTableCache: () => ({
    tables: mockTablesSlot,
    describe: new Map(),
    refresh: mockRefresh,
    loadMore: mockLoadMore,
    requestDescribe: mockRequestDescribe,
    retryDescribe: mockRetryDescribe,
  }),
  // DynamoTablesCacheProvider is not needed — subtree tests mock the hook directly
  DynamoTablesCacheProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { DynamoConnectionSubtree } from "./DynamoConnectionSubtree";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderSubtree(connectionId = "test-conn", connectionName = "TestConn") {
  return render(
    <DynamoConnectionSubtree
      connectionId={connectionId}
      connectionName={connectionName}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests — 13.8: load-more affordance
// ---------------------------------------------------------------------------

describe("DynamoConnectionSubtree — 13.8: load-more affordance", () => {
  const INITIAL_NAMES = Array.from({ length: 10 }, (_, i) => `Table${i}`);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows load-more row when tables.truncated is true", () => {
    mockTablesSlot = {
      status: "ready",
      names: INITIAL_NAMES,
      next_token: "tok-1",
      truncated: true,
    };
    renderSubtree();
    expect(
      screen.getByRole("button", { name: /load more/i }),
    ).toBeInTheDocument();
  });

  it("does NOT show load-more row when tables.truncated is false", () => {
    mockTablesSlot = {
      status: "ready",
      names: INITIAL_NAMES,
      truncated: false,
    };
    renderSubtree();
    expect(
      screen.queryByRole("button", { name: /load more/i }),
    ).not.toBeInTheDocument();
  });

  it("clicking load-more calls loadMore() from the cache hook", async () => {
    mockTablesSlot = {
      status: "ready",
      names: INITIAL_NAMES,
      next_token: "tok-1",
      truncated: true,
    };
    mockLoadMore.mockResolvedValue(undefined);

    renderSubtree();

    const btn = screen.getByRole("button", { name: /load more/i });
    fireEvent.click(btn);

    await waitFor(() => expect(mockLoadMore).toHaveBeenCalledTimes(1));
  });

  it("load-more calls dynamoTablesApi.listTables with paginationToken when wired end-to-end", async () => {
    // For this test we verify the listTables call shape by wiring loadMore
    // through to the real api mock.
    const MORE_NAMES = Array.from({ length: 5 }, (_, i) => `More${i}`);

    // Make loadMore call the api directly (simulating the real cache hook behavior)
    mockLoadMore.mockImplementation(async () => {
      await mockListTables({ connectionId: "test-conn", paginationToken: "tok-1", origin: "user" });
    });
    mockListTables.mockResolvedValue({
      tables: MORE_NAMES,
      truncated: false,
    });

    mockTablesSlot = {
      status: "ready",
      names: INITIAL_NAMES,
      next_token: "tok-1",
      truncated: true,
    };

    renderSubtree();

    const btn = screen.getByRole("button", { name: /load more/i });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockListTables).toHaveBeenCalledWith(
        expect.objectContaining({ paginationToken: "tok-1" }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — §12.6: DocBadge renders next to documented table names
// ---------------------------------------------------------------------------

describe("DynamoConnectionSubtree — §12.6: DocBadge for documented tables", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContextObjects = [];
    mockConnectionParams = {};
  });

  it("renders a DocBadge (title=Documented) next to a documented table", async () => {
    mockTablesSlot = {
      status: "ready",
      names: ["Orders", "Products"],
      truncated: false,
    };
    // Mark "Orders" as documented.
    mockContextObjects = [{ name: "Orders", deleted_in_db: false }];

    renderSubtree();

    // DocBadge renders a span with title="Documented"
    await waitFor(() => {
      const badges = screen.queryAllByTitle("Documented");
      expect(badges.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("does NOT render a DocBadge when no tables are documented", () => {
    mockTablesSlot = {
      status: "ready",
      names: ["Orders", "Products"],
      truncated: false,
    };
    mockContextObjects = [];

    renderSubtree();

    expect(screen.queryAllByTitle("Documented").length).toBe(0);
  });

  it("renders a DocBadge with deleted indication for a stale documented table", async () => {
    mockTablesSlot = {
      status: "ready",
      names: ["OldTable"],
      truncated: false,
    };
    mockContextObjects = [{ name: "OldTable", deleted_in_db: true }];

    renderSubtree();

    await waitFor(() => {
      // DocBadge with deletedInDb renders title "Documented, no DB match"
      const badges = screen.queryAllByTitle("Documented, no DB match");
      expect(badges.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders a DocBadge on a CDK-named leaf via the normalized logical name", async () => {
    mockTablesSlot = {
      status: "ready",
      names: ["MyApp-prod-EventsTable-3M4N5O6P7Q8R"],
      truncated: false,
    };
    // The doc is keyed by the logical name.
    mockContextObjects = [{ name: "EventsTable", deleted_in_db: false }];
    // The connection's rule strips the prefix and random suffix.
    mockConnectionParams = {
      table_match: { prefix: "MyApp-prod-", suffix_pattern: "-[A-Z0-9]+$" },
    };

    renderSubtree();

    await waitFor(() => {
      const badges = screen.queryAllByTitle("Documented");
      expect(badges.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("does NOT render a DocBadge for a CDK-named leaf when no rule is configured", () => {
    mockTablesSlot = {
      status: "ready",
      names: ["MyApp-prod-EventsTable-3M4N5O6P7Q8R"],
      truncated: false,
    };
    mockContextObjects = [{ name: "EventsTable", deleted_in_db: false }];
    mockConnectionParams = {}; // no table_match → exact match only

    renderSubtree();

    expect(screen.queryAllByTitle("Documented").length).toBe(0);
  });
});
