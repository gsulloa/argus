import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { AppError } from "@/platform/errors/AppError";
import { useTableData } from "./useTableData";
import { EMPTY_FILTER_MODEL, type FilterModel, type QueryTableResult } from "./types";

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

import { dataApi } from "./api";

const queryTableMock = vi.mocked(dataApi.queryTable);

const StrictWrapper = ({ children }: { children: React.ReactNode }) => (
  <React.StrictMode>{children}</React.StrictMode>
);

const baseParams = {
  connectionId: "conn-1",
  schema: "public",
  relation: "users",
  pageSize: 200,
  orderBy: [],
  applied: EMPTY_FILTER_MODEL,
};

function makeResult(rowCount: number): QueryTableResult {
  return {
    columns: [
      { name: "id", data_type: "int4", ordinal_position: 1, is_nullable: false },
    ],
    rows: Array.from({ length: rowCount }, (_, i) => [i + 1]),
    applied: { limit: 200, offset: 0, order_by: [], filter_tree: null, raw_where: null },
    query_ms: 7,
    truncated_columns: [],
  };
}

describe("useTableData", () => {
  beforeEach(() => {
    queryTableMock.mockReset();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("transitions to ready and populates rows on first mount under StrictMode", async () => {
    queryTableMock.mockResolvedValue(makeResult(3));

    const { result } = renderHook(() => useTableData(baseParams), {
      wrapper: StrictWrapper,
    });

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current.rows).toHaveLength(3);
    expect(result.current.error).toBeNull();
    expect(queryTableMock).toHaveBeenCalled();
  });

  it("transitions to ready with an empty rows array when the query returns zero rows", async () => {
    queryTableMock.mockResolvedValue(makeResult(0));

    const { result } = renderHook(() => useTableData(baseParams), {
      wrapper: StrictWrapper,
    });

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current.rows).toEqual([]);
    expect(result.current.reachedEnd).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("transitions to error and surfaces the AppError when the query rejects", async () => {
    const failure = new AppError("Postgres", "relation does not exist", {
      code: "42P01",
      message: "relation does not exist",
    });
    queryTableMock.mockRejectedValue(failure);

    const { result } = renderHook(() => useTableData(baseParams), {
      wrapper: StrictWrapper,
    });

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.error).toBeInstanceOf(AppError);
    expect(result.current.error?.message).toBe("relation does not exist");
    expect(result.current.rows).toEqual([]);
  });

  it("recovers from cold-mount disk-load race where settings resolve in different microtasks", async () => {
    // Simulate the cold-mount race: mount with default (empty) settings, then
    // apply filter, orderBy, and pageSize arriving from disk in separate async
    // microtask cycles (as useSetting does on cold Tauri mounts).
    queryTableMock.mockResolvedValue(makeResult(5));

    const initialParams = {
      ...baseParams,
      applied: EMPTY_FILTER_MODEL,
      orderBy: [] as ReturnType<typeof baseParams.orderBy.slice>,
      pageSize: 200,
    };

    const { result, rerender } = renderHook(
      (props: Parameters<typeof useTableData>[0]) => useTableData(props),
      {
        wrapper: StrictWrapper,
        initialProps: initialParams,
      },
    );

    // Simulate filter arriving from disk in first microtask cycle.
    const filterFromDisk: FilterModel = EMPTY_FILTER_MODEL;
    await act(async () => {
      rerender({ ...initialParams, applied: filterFromDisk });
    });

    // Simulate orderBy arriving from disk in second microtask cycle.
    await act(async () => {
      rerender({ ...initialParams, applied: filterFromDisk, orderBy: [] });
    });

    // Simulate pageSize arriving from disk in third microtask cycle.
    await act(async () => {
      rerender({ ...initialParams, applied: filterFromDisk, orderBy: [], pageSize: 100 });
    });

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current.rows.length).toBeGreaterThan(0);
  });

  it("discards stale in-flight response when params change before response arrives", async () => {
    // Params-A response is delayed; params-B response resolves immediately.
    // After rerendering with params-B mid-flight (pageSize change triggers reset),
    // the params-A response must be discarded and only the params-B rows applied.
    const rowsA = makeResult(3);
    const rowsB = makeResult(7);

    let resolveA!: (v: QueryTableResult) => void;
    const pendingA = new Promise<QueryTableResult>((res) => {
      resolveA = res;
    });

    queryTableMock
      .mockReturnValueOnce(pendingA)
      .mockResolvedValue(rowsB);

    const { result, rerender } = renderHook(
      (props: Parameters<typeof useTableData>[0]) => useTableData(props),
      {
        wrapper: StrictWrapper,
        initialProps: baseParams,
      },
    );

    // Wait until the first fetch is in-flight (loading-first).
    await waitFor(() => {
      expect(["loading-first", "loading-first-retrying"]).toContain(result.current.status);
    });

    // Change pageSize mid-flight — triggers a reset and a new fetch with params-B.
    await act(async () => {
      rerender({ ...baseParams, pageSize: 50 });
    });

    // Wait for params-B's fetch to settle.
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    // Now resolve params-A's stale response — it must be discarded.
    await act(async () => {
      resolveA(rowsA);
    });

    // Only params-B's rows (7) should be visible, not params-A's (3).
    expect(result.current.rows).toHaveLength(7);
  });
});
