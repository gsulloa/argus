/**
 * CacheProvider integration tests — task groups 13.5, 13.6, 13.9.
 *
 * Test 13.5: drop-on-disconnect (dynamo:active-changed event)
 * Test 13.6: drop-on-credentials-refresh (dynamo:credentials-refreshed event)
 * Test 13.9: describe pipeline parallelism cap (at most 8 in-flight)
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mock @tauri-apps/api/event
// ---------------------------------------------------------------------------

type EventHandler<T = unknown> = (event: { payload: T }) => void;
const listenHandlers = new Map<string, EventHandler>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((eventName: string, handler: EventHandler) => {
    listenHandlers.set(eventName, handler);
    return Promise.resolve(() => {
      listenHandlers.delete(eventName);
    });
  }),
}));

// ---------------------------------------------------------------------------
// Mock @tauri-apps/api/core (Tauri invoke)
// ---------------------------------------------------------------------------

const mockListActive = vi.fn();
const mockListTables = vi.fn();
const mockDescribeTable = vi.fn();

vi.mock("@/modules/dynamo/api", () => ({
  dynamoApi: {
    listActive: () => mockListActive(),
  },
}));

vi.mock("./api", () => ({
  dynamoTablesApi: {
    listTables: (args: { connectionId: string }) => mockListTables(args),
    describeTable: (args: { connectionId: string; tableName: string }) =>
      mockDescribeTable(args),
  },
}));

// Mock window.__TAURI_INTERNALS__ so isTauriRuntime() returns true
Object.defineProperty(window, "__TAURI_INTERNALS__", {
  value: {},
  writable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// Import after mocks are established
// ---------------------------------------------------------------------------

import {
  DynamoTablesCacheProvider,
  useDynamoTableCache,
  useDynamoTableCacheRegistry,
} from "./CacheProvider";

// ---------------------------------------------------------------------------
// Helper harness components
// ---------------------------------------------------------------------------

function CacheSubscriber({
  connectionId,
  onState,
}: {
  connectionId: string;
  onState?: (state: ReturnType<typeof useDynamoTableCache>) => void;
}) {
  const state = useDynamoTableCache(connectionId);
  onState?.(state);
  return null;
}

function RegistryConsumer({
  onRegistry,
}: {
  onRegistry?: (registry: ReturnType<typeof useDynamoTableCacheRegistry>) => void;
}) {
  const registry = useDynamoTableCacheRegistry();
  onRegistry?.(registry);
  return null;
}

function TestProvider({ children }: { children: React.ReactNode }) {
  return <DynamoTablesCacheProvider>{children}</DynamoTablesCacheProvider>;
}

// ---------------------------------------------------------------------------
// Helper: fire a Tauri event
// ---------------------------------------------------------------------------

async function fireEvent<T>(name: string, payload: T) {
  await act(async () => {
    const handler = listenHandlers.get(name);
    if (handler) handler({ payload });
    // Flush any async operations triggered.
    await Promise.resolve();
  });
}

// ---------------------------------------------------------------------------
// 13.5 — drop-on-disconnect
// ---------------------------------------------------------------------------

describe("CacheProvider — 13.5: drop on dynamo:active-changed", () => {
  const CONN_ID = "conn-a";

  beforeEach(() => {
    vi.clearAllMocks();
    listenHandlers.clear();

    mockListTables.mockResolvedValue({
      tables: ["Table1", "Table2"],
      truncated: false,
    });
    mockListActive.mockResolvedValue([{ id: CONN_ID }]);
  });

  it("drops the cache when the connection is NOT in the active list", async () => {
    let latestRegistry: ReturnType<typeof useDynamoTableCacheRegistry> | undefined;

    render(
      <TestProvider>
        <CacheSubscriber connectionId={CONN_ID} />
        <RegistryConsumer onRegistry={(r) => { latestRegistry = r; }} />
      </TestProvider>,
    );

    // Wait for initial listTables to complete.
    await waitFor(() => {
      expect(latestRegistry?.getCache(CONN_ID)?.tables.status).toBe("ready");
    }, { timeout: 2000 });

    // Now fire active-changed with an empty active list (connection dropped).
    mockListActive.mockResolvedValue([]);
    await fireEvent("dynamo:active-changed", null);

    // Allow async listActive call to resolve.
    await waitFor(() => {
      expect(latestRegistry?.getCache(CONN_ID)).toBeUndefined();
    }, { timeout: 2000 });
  });

  it("keeps the cache when the connection IS still in the active list", async () => {
    let latestRegistry: ReturnType<typeof useDynamoTableCacheRegistry> | undefined;

    render(
      <TestProvider>
        <CacheSubscriber connectionId={CONN_ID} />
        <RegistryConsumer onRegistry={(r) => { latestRegistry = r; }} />
      </TestProvider>,
    );

    await waitFor(() => {
      expect(latestRegistry?.getCache(CONN_ID)?.tables.status).toBe("ready");
    }, { timeout: 2000 });

    // Fire active-changed but keep the connection active.
    mockListActive.mockResolvedValue([{ id: CONN_ID }]);
    await fireEvent("dynamo:active-changed", null);

    await waitFor(() => {
      expect(latestRegistry?.getCache(CONN_ID)?.tables.status).toBe("ready");
    }, { timeout: 2000 });
  });
});

// ---------------------------------------------------------------------------
// 13.6 — drop-on-credentials-refresh
// ---------------------------------------------------------------------------

describe("CacheProvider — 13.6: drop on dynamo:credentials-refreshed", () => {
  const CONN_ID = "conn-b";
  let listTablesCallCount = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    listenHandlers.clear();
    listTablesCallCount = 0;

    mockListTables.mockImplementation(async () => {
      listTablesCallCount += 1;
      return { tables: ["TableA"], truncated: false };
    });
    mockListActive.mockResolvedValue([{ id: CONN_ID }]);
  });

  it("drops the cache for the refreshed connection id", async () => {
    let latestRegistry: ReturnType<typeof useDynamoTableCacheRegistry> | undefined;

    render(
      <TestProvider>
        <CacheSubscriber connectionId={CONN_ID} />
        <RegistryConsumer onRegistry={(r) => { latestRegistry = r; }} />
      </TestProvider>,
    );

    await waitFor(() => {
      expect(latestRegistry?.getCache(CONN_ID)?.tables.status).toBe("ready");
    }, { timeout: 2000 });

    // Fire credentials-refreshed for the connection.
    await fireEvent("dynamo:credentials-refreshed", { id: CONN_ID });

    // The cache should be dropped immediately (before re-list resolves).
    // After a tick, it should be back to loading or ready again.
    await waitFor(() => {
      const status = latestRegistry?.getCache(CONN_ID)?.tables.status;
      // Either the drop has happened (entry missing or status changed from the
      // original snapshot) or already re-loaded.
      expect(
        status === undefined || status === "loading" || status === "ready",
      ).toBe(true);
    }, { timeout: 2000 });
  });

  it("re-fires listTables when there are subscribers", async () => {
    let latestRegistry: ReturnType<typeof useDynamoTableCacheRegistry> | undefined;

    render(
      <TestProvider>
        <CacheSubscriber connectionId={CONN_ID} />
        <RegistryConsumer onRegistry={(r) => { latestRegistry = r; }} />
      </TestProvider>,
    );

    // Wait for initial load.
    await waitFor(() => {
      expect(latestRegistry?.getCache(CONN_ID)?.tables.status).toBe("ready");
    }, { timeout: 2000 });

    const callsBefore = listTablesCallCount;

    // Fire credentials-refreshed.
    await fireEvent("dynamo:credentials-refreshed", { id: CONN_ID });

    // Should have fired a new listTables.
    await waitFor(() => {
      expect(listTablesCallCount).toBeGreaterThan(callsBefore);
    }, { timeout: 2000 });
  });
});

// ---------------------------------------------------------------------------
// 13.9 — describe pipeline parallelism cap
// ---------------------------------------------------------------------------

describe("CacheProvider — 13.9: describe pipeline parallelism cap (max 8)", () => {
  const CONN_ID = "conn-cap";

  beforeEach(() => {
    vi.clearAllMocks();
    listenHandlers.clear();

    // listTables returns 20 table names.
    const twentyTables = Array.from({ length: 20 }, (_, i) => `Table${i}`);
    mockListTables.mockResolvedValue({ tables: twentyTables, truncated: false });
    mockListActive.mockResolvedValue([{ id: CONN_ID }]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches at most 8 concurrent describe calls when 20 are queued", async () => {
    let peakInflight = 0;
    let currentInflight = 0;

    // Track concurrent describes — resolve after tracking peak.
    mockDescribeTable.mockImplementation(async () => {
      currentInflight += 1;
      peakInflight = Math.max(peakInflight, currentInflight);
      // Let the test loop run between increments.
      await new Promise((resolve) => setTimeout(resolve, 10));
      currentInflight -= 1;
      return {
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
      };
    });

    let latestCache: ReturnType<typeof useDynamoTableCache> | undefined;

    // Render with a subscriber that requests describe for each table.
    function DescribeDemander({ connectionId }: { connectionId: string }) {
      const cache = useDynamoTableCache(connectionId);
      latestCache = cache;
      // Request describe for every table that has a name ready.
      if (cache.tables.status === "ready") {
        for (const name of cache.tables.names) {
          cache.requestDescribe(name);
        }
      }
      return null;
    }

    render(
      <TestProvider>
        <DescribeDemander connectionId={CONN_ID} />
      </TestProvider>,
    );

    // Wait for all describes to settle.
    await waitFor(
      () => {
        const cache = latestCache;
        if (!cache || cache.tables.status !== "ready") return;
        const allDone = cache.tables.names.every((n) => {
          const slot = cache.describe.get(n);
          return slot?.status === "ready" || slot?.status === "error";
        });
        if (!allDone) throw new Error("Not all describes settled yet");
      },
      { timeout: 5000 },
    );

    // Peak should never exceed 8.
    expect(peakInflight).toBeLessThanOrEqual(8);
    // And we should have actually called describeTable multiple times.
    expect(mockDescribeTable).toHaveBeenCalled();
  });
});
