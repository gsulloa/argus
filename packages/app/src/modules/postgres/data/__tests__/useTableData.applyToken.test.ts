/**
 * Tests for "Filter Apply always refetches" requirement.
 *
 * Spec: openspec/changes/fix-reapply-same-filter-refetch/specs/postgres-data-grid
 * Design: openspec/changes/fix-reapply-same-filter-refetch/design.md (Decision 1)
 *
 * Verifies that bumping `applyToken` with a structurally-identical `applied`
 * filter model still causes a second `postgres_query_table` IPC call.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useTableData } from "../useTableData";
import type { FilterModel } from "../types";

// ---------------------------------------------------------------------------
// Mock the dataApi so we control what queryTable returns without IPC.
// ---------------------------------------------------------------------------

vi.mock("@/modules/postgres/data/api", () => ({
  dataApi: {
    queryTable: vi.fn().mockResolvedValue({
      rows: [],
      columns: [],
      query_ms: 1,
      truncated_columns: [],
    }),
  },
}));

// Also mock the schema cache — not under test here.
vi.mock("@/modules/postgres/schema/globalSchemaCache", () => ({
  globalSchemaCache: {
    recordColumns: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const APPLIED_FILTER: FilterModel = {
  rows: [
    {
      enabled: true,
      column: { kind: "named", name: "n" },
      op: "=",
      value: "1",
    },
  ],
  combinator: "AND",
};

function makeParams(applyToken = 0) {
  return {
    connectionId: "conn-1",
    schema: "public",
    relation: "users",
    pageSize: 100,
    orderBy: [],
    applied: APPLIED_FILTER,
    enabled: true,
    applyToken,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useTableData — applyToken triggers refetch on re-apply (postgres)", () => {
  let origTauri: unknown;

  beforeEach(async () => {
    // Simulate Tauri runtime so isTauriRuntime() returns true.
    origTauri = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};

    // Reset mock call counts before each test.
    const { dataApi } = await import("@/modules/postgres/data/api");
    vi.mocked(dataApi.queryTable).mockClear();
  });

  afterEach(() => {
    if (origTauri === undefined) {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    } else {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = origTauri;
    }
  });

  it("calls queryTable twice when applyToken is bumped with the same applied filter", async () => {
    const { dataApi } = await import("@/modules/postgres/data/api");
    const queryTableMock = vi.mocked(dataApi.queryTable);

    const { rerender } = renderHook((props) => useTableData(props), {
      initialProps: makeParams(0),
    });

    // Wait for the initial fetch.
    await waitFor(() => expect(queryTableMock).toHaveBeenCalledTimes(1));

    // Re-render with the same `applied` but a bumped `applyToken`.
    act(() => {
      rerender(makeParams(1));
    });

    // A second call must have been issued even though `applied` is unchanged.
    await waitFor(() => expect(queryTableMock).toHaveBeenCalledTimes(2));
  });

  it("does NOT call queryTable a second time when neither applied nor applyToken changes", async () => {
    const { dataApi } = await import("@/modules/postgres/data/api");
    const queryTableMock = vi.mocked(dataApi.queryTable);

    const { rerender } = renderHook((props) => useTableData(props), {
      initialProps: makeParams(0),
    });

    // Wait for the initial fetch.
    await waitFor(() => expect(queryTableMock).toHaveBeenCalledTimes(1));

    // Re-render with identical params — no bump.
    act(() => {
      rerender(makeParams(0));
    });

    // Still only one call.
    await waitFor(() => expect(queryTableMock).toHaveBeenCalledTimes(1));
  });
});
