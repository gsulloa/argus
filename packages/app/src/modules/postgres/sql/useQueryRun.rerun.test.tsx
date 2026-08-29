import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("./api", () => ({
  sqlApi: {
    runSqlStream: vi.fn(),
    runSqlMany: vi.fn(),
    runSql: vi.fn(),
    cancelQuery: vi.fn().mockResolvedValue(undefined),
  },
}));

import { sqlApi, type StreamEvent } from "./api";
import { useQueryRun } from "./useQueryRun";

const runSqlStreamMock = vi.mocked(sqlApi.runSqlStream);
const runSqlManyMock = vi.mocked(sqlApi.runSqlMany);

const COLUMNS = [
  { name: "id", data_type: "int4", ordinal_position: 1, is_nullable: false },
  { name: "email", data_type: "text", ordinal_position: 2, is_nullable: true },
];

const EDITABLE = {
  status: "editable" as const,
  schema: "public",
  relation: "users",
  pk_columns: ["id"],
  pk_column_indexes: [0],
  column_sources: ["id", "email"] as (string | null)[],
  enums: {},
};

/** Drive a full successful rows stream through the runner's channel. */
function streamRows(rows: unknown[][]) {
  return async (
    _id: string,
    _sql: string,
    _origin: string,
    _token: string,
    onEvent: (ev: StreamEvent) => void,
  ) => {
    onEvent({ event: "columns", columns: COLUMNS, editability: EDITABLE });
    onEvent({ event: "batch", rows: rows as never });
    onEvent({
      event: "done",
      row_count: rows.length,
      truncated: false,
      query_ms: 4,
      truncated_columns: [],
      row_cap: 10_000,
      row_cap_source: "setting",
    });
  };
}

describe("useQueryRun.rerunLast", () => {
  beforeEach(() => {
    runSqlStreamMock.mockReset();
    runSqlManyMock.mockReset();
  });

  it("re-dispatches the same SQL and preserves the original startOffset", async () => {
    runSqlStreamMock.mockImplementation(streamRows([[1, "a@example.com"]]) as never);

    const { result } = renderHook(() => useQueryRun());

    // Two statements in the document; the cursor sits inside the second, so
    // the run resolves to a non-zero startOffset.
    const fullSql = "SELECT 1;\nSELECT id, email FROM users";
    const secondStart = fullSql.indexOf("SELECT id");

    await act(async () => {
      await result.current.run({
        connectionId: "conn-1",
        fullSql,
        selectionFrom: 0,
        selectionTo: 0,
        cursor: secondStart + 3,
        forceAll: false,
      });
    });

    await waitFor(() => expect(result.current.state.status).toBe("done"));
    const first = result.current.state;
    if (first.status !== "done" || first.mode !== "single") throw new Error("expected single run");
    expect(first.sql).toBe("SELECT id, email FROM users");
    expect(first.startOffset).toBe(secondStart);
    expect(runSqlStreamMock).toHaveBeenCalledTimes(1);

    // Re-run without touching editor offsets — the cursor may have moved since.
    await act(async () => {
      await result.current.rerunLast();
    });

    await waitFor(() => expect(result.current.state.status).toBe("done"));
    expect(runSqlStreamMock).toHaveBeenCalledTimes(2);
    expect(runSqlStreamMock.mock.calls[1]![1]).toBe("SELECT id, email FROM users");
    expect(runSqlStreamMock.mock.calls[1]![0]).toBe("conn-1");

    const second = result.current.state;
    if (second.status !== "done" || second.mode !== "single") throw new Error("expected single run");
    // The offset survives, so the error panel's "Show in editor" still lands
    // on the right statement after a save-triggered refresh.
    expect(second.startOffset).toBe(secondStart);
    expect(second.sql).toBe("SELECT id, email FROM users");
  });

  it("carries editability from the columns event onto the terminal state", async () => {
    runSqlStreamMock.mockImplementation(streamRows([[1, "a@example.com"]]) as never);

    const { result } = renderHook(() => useQueryRun());
    await act(async () => {
      await result.current.run({
        connectionId: "conn-1",
        fullSql: "SELECT id, email FROM users",
        selectionFrom: 0,
        selectionTo: 0,
        cursor: 0,
      });
    });

    await waitFor(() => expect(result.current.state.status).toBe("done"));
    const s = result.current.state;
    if (s.status !== "done" || s.mode !== "single" || s.result?.kind !== "rows") {
      throw new Error("expected a rows result");
    }
    expect(s.result.editability).toEqual(EDITABLE);
  });

  it("is a no-op before any run", async () => {
    const { result } = renderHook(() => useQueryRun());
    await act(async () => {
      await result.current.rerunLast();
    });
    expect(runSqlStreamMock).not.toHaveBeenCalled();
    expect(result.current.state.status).toBe("idle");
  });

  it("does not replay a multi-statement run", async () => {
    runSqlManyMock.mockResolvedValue([
      { status: "ok", statement_index: 0, result: { kind: "affected", command_tag: "UPDATE 1", affected_rows: 1, query_ms: 2 } },
      { status: "ok", statement_index: 1, result: { kind: "affected", command_tag: "UPDATE 2", affected_rows: 2, query_ms: 3 } },
    ]);

    const { result } = renderHook(() => useQueryRun());
    await act(async () => {
      await result.current.run({
        connectionId: "conn-1",
        fullSql: "UPDATE a SET x = 1; UPDATE b SET y = 2;",
        selectionFrom: 0,
        selectionTo: 0,
        cursor: 0,
        forceAll: true,
      });
    });
    await waitFor(() => expect(result.current.state.status).toBe("done"));

    // Replaying a batch after a row edit would re-fire every DML statement in
    // it — `rerunLast` must refuse rather than do that.
    await act(async () => {
      await result.current.rerunLast();
    });
    expect(runSqlStreamMock).not.toHaveBeenCalled();
    expect(runSqlManyMock).toHaveBeenCalledTimes(1);
  });
});
