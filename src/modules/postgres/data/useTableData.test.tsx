import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { AppError } from "@/platform/errors/AppError";
import { useTableData } from "./useTableData";
import type { QueryTableResult } from "./types";

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
  filters: [],
};

function makeResult(rowCount: number): QueryTableResult {
  return {
    columns: [
      { name: "id", data_type: "int4", ordinal_position: 1, is_nullable: false },
    ],
    rows: Array.from({ length: rowCount }, (_, i) => [i + 1]),
    applied: { limit: 200, offset: 0, order_by: [], filters: [] },
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
});
