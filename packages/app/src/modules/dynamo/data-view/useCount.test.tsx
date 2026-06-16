/**
 * useCount.test.tsx — task 13.4
 *
 * Covers:
 *   - Count never fires automatically (no call on mount, no call on loadMore, etc.)
 *   - Double-click Count doesn't double-fire (the second click is no-op while in flight)
 *   - Result clears when builder mode changes
 *   - Result clears when builder indexName changes
 *   - Result clears when builder filters change
 *   - Result clears when builder query (key-condition shape) changes
 *   - Result PERSISTS when only pageSize changes
 *   - Result PERSISTS when only consistentRead changes
 *   - Result PERSISTS when only scanIndexForward changes
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mock dynamoCountItems BEFORE importing useCount
// ---------------------------------------------------------------------------

const mockDynamoCountItems = vi.fn();

vi.mock("./api", () => ({
  dynamoCountItems: (...args: unknown[]) => mockDynamoCountItems(...args),
  dynamoScan: vi.fn(),
  dynamoQuery: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { useCount } from "./useCount";
import type { BuilderState } from "./types";
import type { TableDescription } from "@/modules/dynamo/tables/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONN_ID = "conn-1";
const TABLE_NAME = "test-table";

const DESCRIBE: TableDescription = {
  table_name: TABLE_NAME,
  table_arn: "arn:aws:dynamodb:us-east-1:123:table/test",
  table_status: "ACTIVE",
  item_count: 1000,
  table_size_bytes: 0,
  billing_mode: "PAY_PER_REQUEST",
  key_schema: [
    { attribute_name: "pk", key_type: "HASH" },
    { attribute_name: "sk", key_type: "RANGE" },
  ],
  attribute_definitions: [
    { attribute_name: "pk", attribute_type: "S" },
    { attribute_name: "sk", attribute_type: "S" },
  ],
  global_secondary_indexes: [],
  local_secondary_indexes: [],
};

const SCAN_BUILDER: BuilderState = {
  mode: "scan",
  indexName: null,
  pageSize: 100,
  consistentRead: false,
  scanIndexForward: true,
  filters: [],
};

function makeCountResponse(total = 42, scanned = 100) {
  return {
    total_count: total,
    total_scanned_count: scanned,
    page_count: 1,
    consumed_capacity: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useCount", () => {
  beforeEach(() => {
    mockDynamoCountItems.mockReset();
  });

  // ── Never fires automatically ─────────────────────────────────────────────

  it("13.4: does NOT call dynamoCountItems on mount", () => {
    renderHook(() =>
      useCount(CONN_ID, TABLE_NAME, SCAN_BUILDER, DESCRIBE),
    );

    expect(mockDynamoCountItems).not.toHaveBeenCalled();
  });

  it("13.4: does NOT auto-fire when builder changes", async () => {
    const { rerender } = renderHook(
      ({ builder }: { builder: BuilderState }) =>
        useCount(CONN_ID, TABLE_NAME, builder, DESCRIBE),
      { initialProps: { builder: SCAN_BUILDER } },
    );

    const next = { ...SCAN_BUILDER, mode: "scan" as const, filters: [] };
    rerender({ builder: next });

    expect(mockDynamoCountItems).not.toHaveBeenCalled();
  });

  // ── Manual trigger works ──────────────────────────────────────────────────

  it("13.4: calls dynamoCountItems when triggerCount is called", async () => {
    mockDynamoCountItems.mockResolvedValueOnce(makeCountResponse());

    const { result } = renderHook(() =>
      useCount(CONN_ID, TABLE_NAME, SCAN_BUILDER, DESCRIBE),
    );

    act(() => {
      result.current.triggerCount();
    });

    await waitFor(() => {
      expect(result.current.countLoading).toBe(false);
    });

    expect(mockDynamoCountItems).toHaveBeenCalledTimes(1);
    expect(result.current.countResult).toEqual({
      totalCount: 42,
      totalScannedCount: 100,
    });
  });

  // ── Double-click guard ────────────────────────────────────────────────────

  it("13.4: double-click does NOT fire twice (in-flight guard)", async () => {
    let resolveFirst!: (val: unknown) => void;
    const firstPromise = new Promise((res) => {
      resolveFirst = res;
    });
    mockDynamoCountItems.mockReturnValueOnce(firstPromise);

    const { result } = renderHook(() =>
      useCount(CONN_ID, TABLE_NAME, SCAN_BUILDER, DESCRIBE),
    );

    // First click
    act(() => {
      result.current.triggerCount();
    });

    // Second click while first is in flight
    act(() => {
      result.current.triggerCount();
    });

    // Resolve the first call.
    act(() => {
      resolveFirst(makeCountResponse());
    });

    await waitFor(() => {
      expect(result.current.countLoading).toBe(false);
    });

    expect(mockDynamoCountItems).toHaveBeenCalledTimes(1);
  });

  // ── Clear on mode change ──────────────────────────────────────────────────

  it("13.4: clears result when builder.mode changes", async () => {
    mockDynamoCountItems.mockResolvedValueOnce(makeCountResponse());

    const { result, rerender } = renderHook(
      ({ builder }: { builder: BuilderState }) =>
        useCount(CONN_ID, TABLE_NAME, builder, DESCRIBE),
      { initialProps: { builder: SCAN_BUILDER } },
    );

    act(() => {
      result.current.triggerCount();
    });

    await waitFor(() => {
      expect(result.current.countResult?.totalCount).toBe(42);
    });

    // Change the mode — should clear.
    act(() => {
      rerender({
        builder: {
          ...SCAN_BUILDER,
          mode: "query",
          query: {
            partitionKey: { name: "pk", value: { type: "S", value: "x" } },
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.countResult).toBeUndefined();
    });
  });

  // ── Clear on indexName change ─────────────────────────────────────────────

  it("13.4: clears result when builder.indexName changes", async () => {
    mockDynamoCountItems.mockResolvedValueOnce(makeCountResponse());

    const { result, rerender } = renderHook(
      ({ builder }: { builder: BuilderState }) =>
        useCount(CONN_ID, TABLE_NAME, builder, DESCRIBE),
      { initialProps: { builder: SCAN_BUILDER } },
    );

    act(() => {
      result.current.triggerCount();
    });

    await waitFor(() => {
      expect(result.current.countResult?.totalCount).toBe(42);
    });

    act(() => {
      rerender({ builder: { ...SCAN_BUILDER, indexName: "byGsi" } });
    });

    await waitFor(() => {
      expect(result.current.countResult).toBeUndefined();
    });
  });

  // ── Clear on filter change ────────────────────────────────────────────────

  it("13.4: clears result when builder.filters changes", async () => {
    mockDynamoCountItems.mockResolvedValueOnce(makeCountResponse());

    const { result, rerender } = renderHook(
      ({ builder }: { builder: BuilderState }) =>
        useCount(CONN_ID, TABLE_NAME, builder, DESCRIBE),
      { initialProps: { builder: SCAN_BUILDER } },
    );

    act(() => {
      result.current.triggerCount();
    });

    await waitFor(() => {
      expect(result.current.countResult?.totalCount).toBe(42);
    });

    act(() => {
      rerender({
        builder: {
          ...SCAN_BUILDER,
          filters: [
            {
              kind: "compare",
              attribute: "status",
              op: "=",
              value: { type: "S", value: "active" },
            },
          ],
        },
      });
    });

    await waitFor(() => {
      expect(result.current.countResult).toBeUndefined();
    });
  });

  // ── Clear on query (key-condition) change ────────────────────────────────

  it("13.4: clears result when builder.query changes", async () => {
    const queryBuilder: BuilderState = {
      ...SCAN_BUILDER,
      mode: "query",
      query: {
        partitionKey: { name: "pk", value: { type: "S", value: "user-1" } },
      },
    };
    mockDynamoCountItems.mockResolvedValueOnce(makeCountResponse());

    const { result, rerender } = renderHook(
      ({ builder }: { builder: BuilderState }) =>
        useCount(CONN_ID, TABLE_NAME, builder, DESCRIBE),
      { initialProps: { builder: queryBuilder } },
    );

    act(() => {
      result.current.triggerCount();
    });

    await waitFor(() => {
      expect(result.current.countResult?.totalCount).toBe(42);
    });

    // Change the PK value in the query → key-condition shape changes.
    act(() => {
      rerender({
        builder: {
          ...queryBuilder,
          query: {
            partitionKey: { name: "pk", value: { type: "S", value: "user-2" } },
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.countResult).toBeUndefined();
    });
  });

  // ── PERSISTS on pageSize change ──────────────────────────────────────────

  it("13.4: KEEPS result when only pageSize changes", async () => {
    mockDynamoCountItems.mockResolvedValueOnce(makeCountResponse());

    const { result, rerender } = renderHook(
      ({ builder }: { builder: BuilderState }) =>
        useCount(CONN_ID, TABLE_NAME, builder, DESCRIBE),
      { initialProps: { builder: SCAN_BUILDER } },
    );

    act(() => {
      result.current.triggerCount();
    });

    await waitFor(() => {
      expect(result.current.countResult?.totalCount).toBe(42);
    });

    act(() => {
      rerender({ builder: { ...SCAN_BUILDER, pageSize: 50 } });
    });

    // Give React a tick to process.
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.countResult?.totalCount).toBe(42);
  });

  // ── PERSISTS on consistentRead change ────────────────────────────────────

  it("13.4: KEEPS result when only consistentRead changes", async () => {
    mockDynamoCountItems.mockResolvedValueOnce(makeCountResponse());

    const { result, rerender } = renderHook(
      ({ builder }: { builder: BuilderState }) =>
        useCount(CONN_ID, TABLE_NAME, builder, DESCRIBE),
      { initialProps: { builder: SCAN_BUILDER } },
    );

    act(() => {
      result.current.triggerCount();
    });

    await waitFor(() => {
      expect(result.current.countResult?.totalCount).toBe(42);
    });

    act(() => {
      rerender({ builder: { ...SCAN_BUILDER, consistentRead: true } });
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.countResult?.totalCount).toBe(42);
  });

  // ── PERSISTS on scanIndexForward change ─────────────────────────────────

  it("13.4: KEEPS result when only scanIndexForward changes", async () => {
    mockDynamoCountItems.mockResolvedValueOnce(makeCountResponse());

    const { result, rerender } = renderHook(
      ({ builder }: { builder: BuilderState }) =>
        useCount(CONN_ID, TABLE_NAME, builder, DESCRIBE),
      { initialProps: { builder: SCAN_BUILDER } },
    );

    act(() => {
      result.current.triggerCount();
    });

    await waitFor(() => {
      expect(result.current.countResult?.totalCount).toBe(42);
    });

    act(() => {
      rerender({ builder: { ...SCAN_BUILDER, scanIndexForward: false } });
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.countResult?.totalCount).toBe(42);
  });

  // ── clearCount works ──────────────────────────────────────────────────────

  it("clearCount resets the result", async () => {
    mockDynamoCountItems.mockResolvedValueOnce(makeCountResponse());

    const { result } = renderHook(() =>
      useCount(CONN_ID, TABLE_NAME, SCAN_BUILDER, DESCRIBE),
    );

    act(() => {
      result.current.triggerCount();
    });

    await waitFor(() => {
      expect(result.current.countResult?.totalCount).toBe(42);
    });

    act(() => {
      result.current.clearCount();
    });

    expect(result.current.countResult).toBeUndefined();
  });

  // ── Does not fire when describe is null ───────────────────────────────────

  it("triggerCount is a no-op when describe is null", () => {
    const { result } = renderHook(() =>
      useCount(CONN_ID, TABLE_NAME, SCAN_BUILDER, null),
    );

    act(() => {
      result.current.triggerCount();
    });

    expect(mockDynamoCountItems).not.toHaveBeenCalled();
  });
});
