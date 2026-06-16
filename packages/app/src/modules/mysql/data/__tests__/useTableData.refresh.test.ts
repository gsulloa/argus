/**
 * Tests for "Filter Apply always refetches" requirement — MySQL engine.
 *
 * Spec: openspec/changes/fix-reapply-same-filter-refetch/specs/mysql-data-grid
 * Design: openspec/changes/fix-reapply-same-filter-refetch/design.md (Decision 2)
 *
 * Verifies that calling `refresh()` with a structurally-identical `filterModel`
 * still causes a second `mysql_query_table` IPC call.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useTableData } from "../useTableData";

// ---------------------------------------------------------------------------
// Mock the dataApi so we control what queryTable returns without IPC.
// ---------------------------------------------------------------------------

vi.mock("@/modules/mysql/data/api", () => ({
  dataApi: {
    queryTable: vi.fn().mockResolvedValue({
      rows: [],
      columns: [],
      query_ms: 1,
      truncated_columns: [],
    }),
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useTableData.refresh() — always refetches (mysql)", () => {
  let origTauri: unknown;

  beforeEach(async () => {
    // Simulate Tauri runtime so isTauriRuntime() returns true.
    origTauri = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};

    // Reset mock call counts before each test.
    const { dataApi } = await import("@/modules/mysql/data/api");
    vi.mocked(dataApi.queryTable).mockClear();
  });

  afterEach(() => {
    if (origTauri === undefined) {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    } else {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = origTauri;
    }
  });

  it("calls queryTable a second time when refresh() is invoked with unchanged filterModel", async () => {
    const { dataApi } = await import("@/modules/mysql/data/api");
    const queryTableMock = vi.mocked(dataApi.queryTable);

    const { result } = renderHook(() =>
      useTableData({
        connectionId: "conn-1",
        schema: "mydb",
        relation: "users",
        relationKind: "table",
      }),
    );

    // Wait for the initial fetch.
    await waitFor(() => expect(queryTableMock).toHaveBeenCalledTimes(1));

    // Apply the same filterModel (no change), then call refresh().
    act(() => {
      result.current.setFilterModel({ rows: [], combinator: "AND" });
    });
    act(() => {
      result.current.refresh();
    });

    // A second call must have been issued even though filterModel is unchanged.
    await waitFor(() => expect(queryTableMock).toHaveBeenCalledTimes(2));
  });

  it("calls queryTable a second time when refresh() is invoked without any filter changes", async () => {
    const { dataApi } = await import("@/modules/mysql/data/api");
    const queryTableMock = vi.mocked(dataApi.queryTable);

    const { result } = renderHook(() =>
      useTableData({
        connectionId: "conn-1",
        schema: "mydb",
        relation: "users",
        relationKind: "table",
      }),
    );

    // Wait for the initial fetch.
    await waitFor(() => expect(queryTableMock).toHaveBeenCalledTimes(1));

    // Call refresh() directly — no filterModel change at all.
    act(() => {
      result.current.refresh();
    });

    // A second call must have been issued.
    await waitFor(() => expect(queryTableMock).toHaveBeenCalledTimes(2));
  });
});
