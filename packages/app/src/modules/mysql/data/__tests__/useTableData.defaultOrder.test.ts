/**
 * Tests for the PK-descending default order + first-fetch gating — MySQL engine.
 *
 * Spec: openspec/changes/table-viewer-default-pk-desc-order/specs/mysql-data-grid
 * Design: openspec/changes/table-viewer-default-pk-desc-order/design.md (D3)
 *
 * The component passes `enabled` (PK lookup settled) and an `initialOrderBy`
 * derived from the resolved PK. The hook must:
 *  - defer the first fetch while `enabled` is false,
 *  - open with a single fetch carrying the PK-derived order once enabled,
 *  - never overwrite a user-chosen order with a late `initialOrderBy`.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useTableData } from "../useTableData";
import type { OrderBy } from "../../types";

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

const pkDesc: OrderBy[] = [{ column: "id", direction: "desc" }];

describe("useTableData — PK-descending default + gating (mysql)", () => {
  let origTauri: unknown;

  beforeEach(async () => {
    origTauri = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
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

  it("defers the first fetch while disabled, then opens with one PK-DESC fetch", async () => {
    const { dataApi } = await import("@/modules/mysql/data/api");
    const queryTableMock = vi.mocked(dataApi.queryTable);

    const { rerender } = renderHook(
      ({ initialOrderBy, enabled }: { initialOrderBy: OrderBy[]; enabled: boolean }) =>
        useTableData({
          connectionId: "conn-1",
          schema: "mydb",
          relation: "events",
          relationKind: "table",
          initialOrderBy,
          enabled,
        }),
      { initialProps: { initialOrderBy: [] as OrderBy[], enabled: false } },
    );

    // PK not yet settled → no fetch.
    await new Promise((r) => setTimeout(r, 0));
    expect(queryTableMock).not.toHaveBeenCalled();

    // PK resolves: enabled flips true and the PK-derived default arrives.
    rerender({ initialOrderBy: pkDesc, enabled: true });

    await waitFor(() => expect(queryTableMock).toHaveBeenCalledTimes(1));
    const [, , , options] = queryTableMock.mock.calls[0]!;
    expect((options as { order_by?: OrderBy[] }).order_by).toEqual(pkDesc);
  });

  it("sends no order_by for a relation with no PK (empty default)", async () => {
    const { dataApi } = await import("@/modules/mysql/data/api");
    const queryTableMock = vi.mocked(dataApi.queryTable);

    renderHook(() =>
      useTableData({
        connectionId: "conn-1",
        schema: "mydb",
        relation: "heap",
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
    const { dataApi } = await import("@/modules/mysql/data/api");
    const queryTableMock = vi.mocked(dataApi.queryTable);

    const { result, rerender } = renderHook(
      ({ initialOrderBy, enabled }: { initialOrderBy: OrderBy[]; enabled: boolean }) =>
        useTableData({
          connectionId: "conn-1",
          schema: "mydb",
          relation: "events",
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

    // A late PK default must NOT clobber the user's choice.
    rerender({ initialOrderBy: pkDesc, enabled: true });
    expect(result.current.orderBy).toEqual(userOrder);
  });
});
