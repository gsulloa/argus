/**
 * Tests for the PK-descending default order + first-fetch gating — MSSQL engine.
 *
 * Spec: openspec/changes/table-viewer-default-pk-desc-order/specs/mssql-data-grid
 * Design: openspec/changes/table-viewer-default-pk-desc-order/design.md (D3)
 *
 * Mirrors the MySQL coverage. For a heap/view the frontend sends no `order_by`,
 * leaving the backend's PK-ascending / SELECT NULL fallback in place.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useTableData } from "../useTableData";
import type { OrderBy } from "../../types";

vi.mock("@/modules/mssql/data/api", () => ({
  dataApi: {
    queryTable: vi.fn().mockResolvedValue({
      rows: [],
      columns: [],
      query_ms: 1,
      truncated_columns: [],
    }),
  },
}));

const pkDesc: OrderBy[] = [{ column: "id", direction: "desc" }];

describe("useTableData — PK-descending default + gating (mssql)", () => {
  let origTauri: unknown;

  beforeEach(async () => {
    origTauri = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const { dataApi } = await import("@/modules/mssql/data/api");
    vi.mocked(dataApi.queryTable).mockClear();
  });

  afterEach(() => {
    if (origTauri === undefined) {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    } else {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = origTauri;
    }
  });

  it("defers the first fetch while disabled, then opens with one PK-DESC fetch", async () => {
    const { dataApi } = await import("@/modules/mssql/data/api");
    const queryTableMock = vi.mocked(dataApi.queryTable);

    const { rerender } = renderHook(
      ({ initialOrderBy, enabled }: { initialOrderBy: OrderBy[]; enabled: boolean }) =>
        useTableData({
          connectionId: "conn-1",
          schema: "sales",
          relation: "orders",
          relationKind: "table",
          initialOrderBy,
          enabled,
        }),
      { initialProps: { initialOrderBy: [] as OrderBy[], enabled: false } },
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(queryTableMock).not.toHaveBeenCalled();

    rerender({ initialOrderBy: pkDesc, enabled: true });

    await waitFor(() => expect(queryTableMock).toHaveBeenCalledTimes(1));
    const [, , , options] = queryTableMock.mock.calls[0]!;
    expect((options as { order_by?: OrderBy[] }).order_by).toEqual(pkDesc);
  });

  it("sends no order_by for a heap/view (backend fallback applies)", async () => {
    const { dataApi } = await import("@/modules/mssql/data/api");
    const queryTableMock = vi.mocked(dataApi.queryTable);

    renderHook(() =>
      useTableData({
        connectionId: "conn-1",
        schema: "sales",
        relation: "orders_heap",
        relationKind: "table",
        initialOrderBy: [],
        enabled: true,
      }),
    );

    await waitFor(() => expect(queryTableMock).toHaveBeenCalledTimes(1));
    const [, , , options] = queryTableMock.mock.calls[0]!;
    expect((options as { order_by?: OrderBy[] }).order_by).toBeUndefined();
  });

  it("does not overwrite a user-chosen order when the PK default arrives late", async () => {
    const { dataApi } = await import("@/modules/mssql/data/api");
    const queryTableMock = vi.mocked(dataApi.queryTable);

    const { result, rerender } = renderHook(
      ({ initialOrderBy, enabled }: { initialOrderBy: OrderBy[]; enabled: boolean }) =>
        useTableData({
          connectionId: "conn-1",
          schema: "sales",
          relation: "orders",
          relationKind: "table",
          initialOrderBy,
          enabled,
        }),
      { initialProps: { initialOrderBy: [] as OrderBy[], enabled: true } },
    );

    await waitFor(() => expect(queryTableMock).toHaveBeenCalledTimes(1));

    const userOrder: OrderBy[] = [{ column: "name", direction: "asc" }];
    act(() => result.current.setOrderBy(userOrder));
    await waitFor(() => expect(result.current.orderBy).toEqual(userOrder));

    rerender({ initialOrderBy: pkDesc, enabled: true });
    expect(result.current.orderBy).toEqual(userOrder);
  });
});
