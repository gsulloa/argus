import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useTableStructureCache } from "./useTableStructureCache";
import type { TableStructureResult } from "../schema/types";

vi.mock("../schema/api", () => ({
  schemaApi: {
    tableStructure: vi.fn(),
  },
}));

import { schemaApi } from "../schema/api";

const FIXTURE: TableStructureResult = {
  schema: "public",
  relation: "users",
  relkind: "table",
  is_best_effort: false,
  columns: [],
  primary_key: null,
  foreign_keys: [],
  unique_constraints: [],
  check_constraints: [],
  indexes: [],
  triggers: [],
  ddl: "CREATE TABLE \"public\".\"users\" ();\n",
  failures: [],
};

describe("useTableStructureCache", () => {
  beforeEach(() => {
    vi.mocked(schemaApi.tableStructure).mockReset();
  });

  it("idle → loading → ready on first ensureLoaded", async () => {
    vi.mocked(schemaApi.tableStructure).mockResolvedValueOnce(FIXTURE);
    const { result } = renderHook(() =>
      useTableStructureCache("c1", "public", "users"),
    );

    expect(result.current.state.status).toBe("idle");

    await act(async () => {
      await result.current.ensureLoaded("user");
    });

    expect(result.current.state.status).toBe("ready");
    expect(result.current.state.response).toBe(FIXTURE);
    expect(schemaApi.tableStructure).toHaveBeenCalledTimes(1);
    expect(schemaApi.tableStructure).toHaveBeenCalledWith(
      "c1",
      "public",
      "users",
      "user",
    );
  });

  it("dedupes concurrent ensureLoaded calls into one fetch", async () => {
    let resolveCall: (v: TableStructureResult) => void = () => {};
    vi.mocked(schemaApi.tableStructure).mockImplementationOnce(
      () =>
        new Promise<TableStructureResult>((resolve) => {
          resolveCall = resolve;
        }),
    );

    const { result } = renderHook(() =>
      useTableStructureCache("c1", "public", "users"),
    );

    await act(async () => {
      // Two callers (Structure + Raw) hit the cache before it resolves.
      const a = result.current.ensureLoaded("user");
      const b = result.current.ensureLoaded("user");
      resolveCall(FIXTURE);
      await Promise.all([a, b]);
    });

    expect(schemaApi.tableStructure).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe("ready");
  });

  it("refresh dispatches a new call even when ready and replaces the cache atomically", async () => {
    const second: TableStructureResult = { ...FIXTURE, ddl: "-- updated\n" };
    vi.mocked(schemaApi.tableStructure)
      .mockResolvedValueOnce(FIXTURE)
      .mockResolvedValueOnce(second);

    const { result } = renderHook(() =>
      useTableStructureCache("c1", "public", "users"),
    );

    await act(async () => {
      await result.current.ensureLoaded("user");
    });
    expect(result.current.state.response).toBe(FIXTURE);

    await act(async () => {
      await result.current.refresh("user");
    });
    expect(schemaApi.tableStructure).toHaveBeenCalledTimes(2);
    expect(result.current.state.response).toBe(second);
  });

  it("resets to idle when (connectionId, schema, relation) changes between renders", async () => {
    vi.mocked(schemaApi.tableStructure).mockResolvedValueOnce(FIXTURE);

    const { result, rerender } = renderHook(
      ({ rel }: { rel: string }) =>
        useTableStructureCache("c1", "public", rel),
      { initialProps: { rel: "A" } },
    );

    await act(async () => {
      await result.current.ensureLoaded("user");
    });
    expect(result.current.state.status).toBe("ready");
    expect(result.current.state.response).toBe(FIXTURE);

    rerender({ rel: "B" });

    expect(result.current.state.status).toBe("idle");
    expect(result.current.state.response).toBe(null);
    expect(result.current.state.error).toBe(null);

    const second: TableStructureResult = { ...FIXTURE, relation: "B", ddl: "-- B\n" };
    vi.mocked(schemaApi.tableStructure).mockResolvedValueOnce(second);

    await act(async () => {
      await result.current.ensureLoaded("user");
    });

    expect(schemaApi.tableStructure).toHaveBeenCalledTimes(2);
    expect(schemaApi.tableStructure).toHaveBeenLastCalledWith(
      "c1",
      "public",
      "B",
      "user",
    );
    expect(result.current.state.response).toBe(second);
  });

  it("drops a late response from the previous (connectionId, schema, relation)", async () => {
    let resolveA: (v: TableStructureResult) => void = () => {};
    const aResponse: TableStructureResult = { ...FIXTURE, relation: "A", ddl: "-- A\n" };
    const bResponse: TableStructureResult = { ...FIXTURE, relation: "B", ddl: "-- B\n" };

    vi.mocked(schemaApi.tableStructure)
      .mockImplementationOnce(
        () =>
          new Promise<TableStructureResult>((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockResolvedValueOnce(bResponse);

    const { result, rerender } = renderHook(
      ({ rel }: { rel: string }) =>
        useTableStructureCache("c1", "public", rel),
      { initialProps: { rel: "A" } },
    );

    let aPromise: Promise<void>;
    act(() => {
      aPromise = result.current.ensureLoaded("user");
    });
    expect(result.current.state.status).toBe("loading");

    rerender({ rel: "B" });
    expect(result.current.state.status).toBe("idle");

    await act(async () => {
      await result.current.ensureLoaded("user");
    });
    expect(result.current.state.response).toBe(bResponse);

    await act(async () => {
      resolveA(aResponse);
      await aPromise;
    });

    // A's response must NOT replace B's cache.
    expect(result.current.state.response).toBe(bResponse);
    expect(result.current.state.status).toBe("ready");
  });

  it("error transition keeps prior response and surfaces the error", async () => {
    vi.mocked(schemaApi.tableStructure)
      .mockResolvedValueOnce(FIXTURE)
      .mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() =>
      useTableStructureCache("c1", "public", "users"),
    );

    await act(async () => {
      await result.current.ensureLoaded("user");
    });
    expect(result.current.state.status).toBe("ready");

    await act(async () => {
      await result.current.refresh("user");
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("error");
    });
    // Previous response is preserved so the UI can keep rendering while
    // surfacing the error banner separately.
    expect(result.current.state.response).toBe(FIXTURE);
    expect(result.current.state.error?.message).toMatch(/boom/);
  });
});
