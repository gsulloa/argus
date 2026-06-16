/**
 * Tests for useDynamoItems hook.
 *
 * Covers:
 * - Happy path: run() populates items + lastEvaluatedKey
 * - loadMore() appends items and updates lastEvaluatedKey
 * - Failure flips autoScrollDisabled; triggerAutoLoadMore is a no-op until
 *   manual loadMore
 * - dynamo:credentials-refreshed:ui auto-replays the last failed request
 * - Manual loadMore after failure clears autoScrollDisabled and re-fires
 *
 * We use renderHook from @testing-library/react and vi.mock to mock api.ts
 * so no real Tauri IPC is invoked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { AppError } from "@/platform/errors/AppError";

// ---------------------------------------------------------------------------
// Mock api.ts BEFORE importing the hook (vi.mock is hoisted)
// ---------------------------------------------------------------------------

const mockDynamoScan = vi.fn();
const mockDynamoQuery = vi.fn();

vi.mock("./api", () => ({
  dynamoScan: (...args: unknown[]) => mockDynamoScan(...args),
  dynamoQuery: (...args: unknown[]) => mockDynamoQuery(...args),
}));

// Also mock @tauri-apps/api/core (used transitively, but we import api.ts via
// the mock above so this is a safety net).
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Now import the hook (AFTER the mocks are declared)
// ---------------------------------------------------------------------------

import { useDynamoItems } from "./useDynamoItems";
import type { AttributeMap, BuilderState } from "./types";
import type { TableDescription } from "@/modules/dynamo/tables/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONN_ID = "conn-1";
const TABLE_NAME = "events";

const makeDescribe = (): TableDescription => ({
  table_name: TABLE_NAME,
  table_arn: "arn:aws:dynamodb:us-east-1:123:table/events",
  table_status: "ACTIVE",
  item_count: 0,
  table_size_bytes: 0,
  billing_mode: "PAY_PER_REQUEST",
  key_schema: [{ attribute_name: "pk", key_type: "HASH" }],
  attribute_definitions: [{ attribute_name: "pk", attribute_type: "S" }],
  global_secondary_indexes: [],
  local_secondary_indexes: [],
});

const defaultBuilder = (): BuilderState => ({
  mode: "scan",
  indexName: null,
  pageSize: 10,
  consistentRead: false,
  scanIndexForward: true,
  filters: [],
});

const makeItem = (id: string): AttributeMap => ({ pk: { S: id } });

const makeKey = (id: string): AttributeMap => ({ pk: { S: id } });

function makeResponse(
  items: AttributeMap[],
  lastKey: AttributeMap | null = null,
) {
  return {
    items,
    last_evaluated_key: lastKey,
    scanned_count: items.length,
    count: items.length,
    consumed_capacity: null,
  };
}

function makeHookParams(overrides?: Partial<Parameters<typeof useDynamoItems>[0]>) {
  return {
    connectionId: CONN_ID,
    tableName: TABLE_NAME,
    builder: defaultBuilder(),
    describe: makeDescribe(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAwsError(code: string, message = "error"): AppError {
  return new AppError("Aws", message, undefined, { code, message, retryable: false });
}

function fireCredentialsRefreshed(connectionId: string) {
  window.dispatchEvent(
    new CustomEvent("dynamo:credentials-refreshed:ui", {
      detail: { id: connectionId },
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useDynamoItems", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Task 7.2: Happy path — run() populates items and lastEvaluatedKey
  // -------------------------------------------------------------------------

  it("happy path: run() sets items, lastEvaluatedKey, page, scannedCount", async () => {
    const items = [makeItem("a"), makeItem("b")];
    const lastKey = makeKey("b");
    mockDynamoScan.mockResolvedValueOnce(makeResponse(items, lastKey));

    const { result } = renderHook(() => useDynamoItems(makeHookParams()));

    expect(result.current.status).toBe("idle");
    expect(result.current.items).toHaveLength(0);

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.items).toEqual(items);
    expect(result.current.lastEvaluatedKey).toEqual(lastKey);
    expect(result.current.page).toBe(1);
    expect(result.current.count).toBe(2);
    expect(result.current.scannedCount).toBe(2);
    expect(result.current.error).toBeUndefined();
    expect(result.current.autoScrollDisabled).toBe(false);

    expect(mockDynamoScan).toHaveBeenCalledTimes(1);
    // Verify origin defaults to "user"
    const firstCallOrigin = (mockDynamoScan.mock.calls[0] as unknown[])[3];
    expect(firstCallOrigin).toBe("user");
  });

  it("happy path: run() with no more pages sets lastEvaluatedKey to null", async () => {
    mockDynamoScan.mockResolvedValueOnce(makeResponse([makeItem("only")]));

    const { result } = renderHook(() => useDynamoItems(makeHookParams()));

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.lastEvaluatedKey).toBeNull();
    expect(result.current.status).toBe("ready");
  });

  // -------------------------------------------------------------------------
  // Task 7.2: loadMore() appends items and updates lastEvaluatedKey
  // -------------------------------------------------------------------------

  it("loadMore() appends items, increments page, sums scannedCount", async () => {
    const page1 = [makeItem("a"), makeItem("b")];
    const page1Key = makeKey("b");
    const page2 = [makeItem("c")];
    const page2Key = makeKey("c");

    mockDynamoScan
      .mockResolvedValueOnce(makeResponse(page1, page1Key))
      .mockResolvedValueOnce(makeResponse(page2, page2Key));

    const { result } = renderHook(() => useDynamoItems(makeHookParams()));

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.page).toBe(1);
    expect(result.current.items).toHaveLength(2);
    expect(result.current.scannedCount).toBe(2);

    await act(async () => {
      await result.current.loadMore("user");
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.items).toHaveLength(3);
    expect(result.current.items[2]).toEqual(makeItem("c"));
    expect(result.current.lastEvaluatedKey).toEqual(page2Key);
    expect(result.current.page).toBe(2);
    expect(result.current.scannedCount).toBe(3); // 2 + 1
    expect(result.current.count).toBe(3);

    // Verify exclusive_start_key was passed in the second call.
    const secondCallReq = ((mockDynamoScan.mock.calls[1] as unknown[])[2]) as Record<string, unknown>;
    expect(secondCallReq.exclusive_start_key).toEqual(page1Key);
  });

  it("loadMore() is a no-op when lastEvaluatedKey is null", async () => {
    mockDynamoScan.mockResolvedValueOnce(makeResponse([makeItem("a")]));

    const { result } = renderHook(() => useDynamoItems(makeHookParams()));

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.lastEvaluatedKey).toBeNull();

    await act(async () => {
      await result.current.loadMore("user");
    });

    // Should not have triggered another scan call.
    expect(mockDynamoScan).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Task 7.2: compile error sets status to "error"
  // -------------------------------------------------------------------------

  it("compile error (query mode without partition key) sets status to error", async () => {
    const queryBuilder: BuilderState = {
      mode: "query",
      indexName: null,
      pageSize: 10,
      consistentRead: false,
      scanIndexForward: true,
      // No .query field → compile returns { kind: 'error' }
      filters: [],
    };

    const { result } = renderHook(() =>
      useDynamoItems(makeHookParams({ builder: queryBuilder })),
    );

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toBeTruthy();
    expect(mockDynamoScan).not.toHaveBeenCalled();
    expect(mockDynamoQuery).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Task 7.3: autoScrollDisabled behaviour
  // -------------------------------------------------------------------------

  it("failed run sets autoScrollDisabled=true; triggerAutoLoadMore is a no-op", async () => {
    mockDynamoScan.mockRejectedValueOnce(
      buildAwsError("ValidationException", "bad filter"),
    );

    const { result } = renderHook(() => useDynamoItems(makeHookParams()));

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.autoScrollDisabled).toBe(true);

    // triggerAutoLoadMore should be a no-op.
    act(() => {
      result.current.triggerAutoLoadMore();
    });

    // No additional calls.
    expect(mockDynamoScan).toHaveBeenCalledTimes(1);
  });

  it("failed loadMore sets autoScrollDisabled=true; subsequent triggerAutoLoadMore is a no-op", async () => {
    const page1 = [makeItem("a")];
    const page1Key = makeKey("a");

    mockDynamoScan
      .mockResolvedValueOnce(makeResponse(page1, page1Key))
      .mockRejectedValueOnce(buildAwsError("ThrottlingException", "throttled"));

    const { result } = renderHook(() => useDynamoItems(makeHookParams()));

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.autoScrollDisabled).toBe(false);

    // loadMore fails.
    await act(async () => {
      await result.current.loadMore("user");
    });

    expect(result.current.status).toBe("error");
    expect(result.current.autoScrollDisabled).toBe(true);

    // triggerAutoLoadMore — should be a no-op.
    act(() => {
      result.current.triggerAutoLoadMore();
    });

    // Only 2 calls total (run + failed loadMore).
    expect(mockDynamoScan).toHaveBeenCalledTimes(2);
  });

  it("manual loadMore after failure clears autoScrollDisabled and re-fires", async () => {
    const page1 = [makeItem("a")];
    const page1Key = makeKey("a");
    const page2 = [makeItem("b")];

    mockDynamoScan
      .mockResolvedValueOnce(makeResponse(page1, page1Key))
      .mockRejectedValueOnce(buildAwsError("ThrottlingException", "throttled"))
      .mockResolvedValueOnce(makeResponse(page2));

    const { result } = renderHook(() => useDynamoItems(makeHookParams()));

    await act(async () => {
      await result.current.run();
    });

    // First loadMore fails.
    await act(async () => {
      await result.current.loadMore("user");
    });

    expect(result.current.autoScrollDisabled).toBe(true);
    expect(result.current.status).toBe("error");

    // Manual retry — should reset the flag and re-fire.
    await act(async () => {
      await result.current.loadMore("user");
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.autoScrollDisabled).toBe(false);
    expect(result.current.items).toHaveLength(2);
    expect(mockDynamoScan).toHaveBeenCalledTimes(3);
  });

  it("triggerAutoLoadMore fires when autoScrollDisabled=false and lastEvaluatedKey != null", async () => {
    const page1 = [makeItem("a")];
    const page1Key = makeKey("a");
    const page2 = [makeItem("b")];

    mockDynamoScan
      .mockResolvedValueOnce(makeResponse(page1, page1Key))
      .mockResolvedValueOnce(makeResponse(page2));

    const { result } = renderHook(() => useDynamoItems(makeHookParams()));

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.lastEvaluatedKey).toEqual(page1Key);
    expect(result.current.autoScrollDisabled).toBe(false);

    act(() => {
      result.current.triggerAutoLoadMore();
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.items).toHaveLength(2);
    expect(mockDynamoScan).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Task 7.4: credentials-refreshed auto-resume
  // -------------------------------------------------------------------------

  it("credentials-refreshed replays a failed run() with ExpiredToken", async () => {
    const expiredErr = buildAwsError("ExpiredToken", "token expired");
    const items = [makeItem("x")];

    mockDynamoScan
      .mockRejectedValueOnce(expiredErr)
      .mockResolvedValueOnce(makeResponse(items));

    const { result } = renderHook(() => useDynamoItems(makeHookParams()));

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error?.code).toBe("ExpiredToken");

    // Simulate credentials refresh for this connection.
    await act(async () => {
      fireCredentialsRefreshed(CONN_ID);
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.items).toEqual(items);
    expect(mockDynamoScan).toHaveBeenCalledTimes(2);
  });

  it("credentials-refreshed does NOT replay when error is not ExpiredToken", async () => {
    const throttleErr = buildAwsError("ThrottlingException", "throttled");

    mockDynamoScan.mockRejectedValueOnce(throttleErr);

    const { result } = renderHook(() => useDynamoItems(makeHookParams()));

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.status).toBe("error");

    await act(async () => {
      fireCredentialsRefreshed(CONN_ID);
    });

    // Status stays error — no replay fired.
    expect(result.current.status).toBe("error");
    expect(mockDynamoScan).toHaveBeenCalledTimes(1);
  });

  it("credentials-refreshed event for a different connection is ignored", async () => {
    const expiredErr = buildAwsError("ExpiredToken", "token expired");
    mockDynamoScan.mockRejectedValueOnce(expiredErr);

    const { result } = renderHook(() => useDynamoItems(makeHookParams()));

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.status).toBe("error");

    // Different connection id — should not replay.
    await act(async () => {
      fireCredentialsRefreshed("other-conn");
    });

    expect(result.current.status).toBe("error");
    expect(mockDynamoScan).toHaveBeenCalledTimes(1);
  });

  it("credentials-refreshed replays a failed loadMore with ExpiredToken", async () => {
    const page1 = [makeItem("a")];
    const page1Key = makeKey("a");
    const page2 = [makeItem("b")];

    const expiredErr = buildAwsError("ExpiredTokenException", "token expired");

    mockDynamoScan
      .mockResolvedValueOnce(makeResponse(page1, page1Key))
      .mockRejectedValueOnce(expiredErr)
      .mockResolvedValueOnce(makeResponse(page2));

    const { result } = renderHook(() => useDynamoItems(makeHookParams()));

    await act(async () => {
      await result.current.run();
    });

    await act(async () => {
      await result.current.loadMore("user");
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error?.code).toBe("ExpiredTokenException");

    // Credentials refreshed — replays the loadMore.
    await act(async () => {
      fireCredentialsRefreshed(CONN_ID);
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.items).toHaveLength(2);
    expect(mockDynamoScan).toHaveBeenCalledTimes(3);
  });

  // -------------------------------------------------------------------------
  // reset()
  // -------------------------------------------------------------------------

  it("reset() returns to idle state and clears all data", async () => {
    mockDynamoScan.mockResolvedValueOnce(
      makeResponse([makeItem("a")], makeKey("a")),
    );

    const { result } = renderHook(() => useDynamoItems(makeHookParams()));

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.items).toHaveLength(1);

    act(() => {
      result.current.reset();
    });

    expect(result.current.status).toBe("idle");
    expect(result.current.items).toHaveLength(0);
    expect(result.current.lastEvaluatedKey).toBeNull();
    expect(result.current.page).toBe(0);
    expect(result.current.scannedCount).toBe(0);
    expect(result.current.autoScrollDisabled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Query mode dispatch
  // -------------------------------------------------------------------------

  it("dispatches dynamoQuery when builder mode is query", async () => {
    const items = [makeItem("q1")];
    mockDynamoQuery.mockResolvedValueOnce(makeResponse(items));

    const describe = makeDescribe();
    const queryBuilder: BuilderState = {
      mode: "query",
      indexName: null,
      pageSize: 10,
      consistentRead: false,
      scanIndexForward: true,
      query: {
        partitionKey: { name: "pk", value: { type: "S", value: "user-1" } },
      },
      filters: [],
    };

    const { result } = renderHook(() =>
      useDynamoItems({
        connectionId: CONN_ID,
        tableName: TABLE_NAME,
        builder: queryBuilder,
        describe,
      }),
    );

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.items).toEqual(items);
    expect(mockDynamoQuery).toHaveBeenCalledTimes(1);
    expect(mockDynamoScan).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Stale response guard: double run()
  // -------------------------------------------------------------------------

  it("second run() while first is in flight discards first response", async () => {
    let resolveFirst!: (value: ReturnType<typeof makeResponse>) => void;
    const firstPromise = new Promise<ReturnType<typeof makeResponse>>(
      (res) => (resolveFirst = res),
    );
    const page2Items = [makeItem("second")];

    mockDynamoScan
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce(makeResponse(page2Items));

    const { result } = renderHook(() => useDynamoItems(makeHookParams()));

    // Start first run (won't resolve yet).
    const firstRunPromise = act(async () => {
      void result.current.run();
    });

    // Immediately start second run.
    await act(async () => {
      await result.current.run();
    });

    // Now resolve the first (stale) promise.
    await act(async () => {
      resolveFirst(makeResponse([makeItem("first")], makeKey("first")));
      await firstRunPromise;
    });

    // State should reflect the second run's result.
    expect(result.current.items).toEqual(page2Items);
    expect(result.current.lastEvaluatedKey).toBeNull();
  });
});
