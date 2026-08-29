/**
 * QueryTab result-grid edit tests (issue #279).
 *
 * Covers the tab-level concerns the panel and grid can't: the Save/Discard
 * controls, the apply call shape, the op-failure banner, and the loss guards
 * that stand between a dirty result buffer and any action that would replace
 * the rows it refers to.
 *
 * QueryTab pulls in the whole shell (tabs, connection registry, CodeMirror,
 * AI readiness), so those are stubbed down to the minimum that lets the
 * component mount. Everything under test is real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Shell / environment stubs
// ---------------------------------------------------------------------------

const { applyTableEdits, runSqlStream } = vi.hoisted(() => ({
  applyTableEdits: vi.fn(),
  runSqlStream: vi.fn(),
}));

vi.mock("../data/api", () => ({
  dataApi: { applyTableEdits },
}));

vi.mock("./api", () => ({
  sqlApi: {
    runSqlStream,
    runSqlMany: vi.fn(),
    runSql: vi.fn(),
    cancelQuery: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/platform/settings/api", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/platform/toast", () => ({
  useToast: () => ({ show: vi.fn() }),
}));

const setTabDirty = vi.fn();
const closeTab = vi.fn();
vi.mock("@/platform/shell/tabs/TabsContext", () => ({
  useTabs: () => ({ setTabTitle: vi.fn(), setTabDirty, close: closeTab }),
}));

// Capture the close-confirm handler so the test can invoke it the way
// TabStrip would.
let closeConfirmHandler: (() => boolean | Promise<boolean>) | null = null;
vi.mock("@/platform/shell/tabs/useCloseConfirm", () => ({
  useCloseConfirm: (_tabId: string, handler: () => boolean | Promise<boolean>) => {
    closeConfirmHandler = handler;
  },
  // useQueryBuffer registers its own handler through this; QueryTab's
  // useCloseConfirm overrides it in the real app, so a no-op is faithful.
  registerCloseHandler: vi.fn(),
  unregisterCloseHandler: vi.fn(),
  shouldCloseTab: vi.fn().mockResolvedValue(true),
}));

const dirtySummaries: Array<unknown> = [];
vi.mock("@/platform/shell/tabs/useDirtySummary", () => ({
  useDirtySummary: (_tabId: string, summary: unknown) => {
    dirtySummaries.push(summary);
  },
}));

vi.mock("../useActiveConnections", () => ({
  useActiveConnections: () => ({
    getActive: () => ({ id: CONN_ID, name: "local-pg", read_only: false }),
    items: [],
  }),
}));

vi.mock("@/platform/connection-registry/useConnections", () => ({
  useConnections: () => ({ items: [] }),
}));

vi.mock("@/modules/ai/useAiReadiness", () => ({
  useAiReadiness: () => ({ level: "not-configured" }),
}));

vi.mock("../FormController", () => ({
  usePostgresForm: () => ({ openEdit: vi.fn() }),
}));

vi.mock("@/modules/ai/components/ChatPanel", () => ({
  ChatPanel: () => null,
}));

vi.mock("@/modules/saved-queries/store", () => ({
  savedQueriesStore: { updateQuery: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("@/modules/saved-queries/SaveAsModal", () => ({
  SaveAsModal: () => null,
}));

vi.mock("@/modules/context/api", () => ({
  contextApi: { listObjects: vi.fn().mockResolvedValue([]) },
}));

// The connection picker needs the groups provider; nothing under test touches it.
vi.mock("./ConnectionSelector", () => ({
  ConnectionSelector: () => null,
}));

vi.mock("@/platform/sql/RowCapSelector", () => ({
  RowCapSelector: () => null,
}));

// CodeMirror editor — replaced by a handle-only stub. `⌘↩` is a CodeMirror
// keymap in the real editor, so the test triggers a run by invoking the
// captured `onRun` prop instead of dispatching a key event at the window.
const editorProps: { onRun?: () => void; onSave?: () => void } = {};
vi.mock("./QueryEditor", async () => {
  const React = await import("react");
  return {
    QueryEditor: React.forwardRef(function QueryEditorStub(
      props: { onRun?: () => void; onSave?: () => void },
      ref: React.Ref<unknown>,
    ) {
      editorProps.onRun = props.onRun;
      editorProps.onSave = props.onSave;
      React.useImperativeHandle(ref, () => ({
        getSql: () => "SELECT id, email FROM users",
        getSelectionRange: () => ({ from: 0, to: 0 }),
        getCursor: () => 0,
        setCursor: vi.fn(),
        reconfigureAutocomplete: vi.fn(),
        focus: vi.fn(),
      }));
      return null;
    }),
  };
});

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => {
    const size = estimateSize();
    return {
      scrollToIndex: vi.fn(),
      getVirtualItems: () =>
        Array.from({ length: count }, (_, i) => ({
          index: i,
          key: i,
          start: i * size,
          size,
          lane: 0,
        })),
      getTotalSize: () => count * size,
    };
  },
}));

Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: vi.fn() }, platform: "MacIntel" },
  writable: true,
  configurable: true,
});

// QueryTab reads the AI panel width straight off localStorage on mount.
const localStorageStub = (() => {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
})();
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageStub,
  writable: true,
  configurable: true,
});

import { QueryTab } from "./QueryTab";
import type { StreamEvent } from "./api";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONN_ID = "11111111-1111-1111-1111-111111111111";

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

function streamEditableRows() {
  return async (
    _id: string,
    _sql: string,
    _origin: string,
    _token: string,
    onEvent: (ev: StreamEvent) => void,
  ) => {
    onEvent({ event: "columns", columns: COLUMNS, editability: EDITABLE });
    onEvent({ event: "batch", rows: [[7, "ana@example.com"]] as never });
    onEvent({
      event: "done",
      row_count: 1,
      truncated: false,
      query_ms: 3,
      truncated_columns: [],
      row_cap: 10_000,
      row_cap_source: "setting",
    });
  };
}

function renderTab() {
  return render(
    <QueryTab
      tabId="pgquery:test:1"
      payload={{
        initialConnectionId: CONN_ID,
        initialConnectionName: "local-pg",
        initialSql: "SELECT id, email FROM users",
      }}
    />,
  );
}

/** Run the query, then edit the `email` cell of the single returned row. */
async function runAndEdit(container: HTMLElement) {
  await act(async () => {
    editorProps.onRun?.();
  });
  await waitFor(() => expect(container.querySelector("[data-selected]")).not.toBeNull());

  const cells = Array.from(
    container.querySelector("[data-selected]")!.querySelectorAll<HTMLElement>("[data-col]"),
  );
  fireEvent.doubleClick(cells[1]!);
  const input = container.querySelector("input") as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { value: "new@example.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
  });
}

// ---------------------------------------------------------------------------

describe("QueryTab result-grid edits", () => {
  beforeEach(() => {
    applyTableEdits.mockReset();
    runSqlStream.mockReset();
    setTabDirty.mockReset();
    closeTab.mockReset();
    dirtySummaries.length = 0;
    closeConfirmHandler = null;
    runSqlStream.mockImplementation(streamEditableRows() as never);
  });

  it("saves pending edits through applyTableEdits and clears the buffer", async () => {
    applyTableEdits.mockResolvedValue({
      outcome: "ok",
      committed: 1,
      refreshed_rows: [],
      query_ms: 5,
    });

    const { container } = renderTab();
    await runAndEdit(container);

    const save = await screen.findByRole("button", { name: /Save \(1\)/ });
    await act(async () => {
      fireEvent.click(save);
    });

    await waitFor(() => {
      expect(applyTableEdits).toHaveBeenCalledTimes(1);
    });
    const [connId, schema, relation, edits, origin] = applyTableEdits.mock.calls[0]!;
    expect(connId).toBe(CONN_ID);
    expect(schema).toBe("public");
    expect(relation).toBe("users");
    expect(origin).toBe("user");
    expect(edits).toEqual([
      { kind: "update", pk: { id: 7 }, changes: { email: "new@example.com" } },
    ]);

    // Buffer cleared, and the statement re-run so committed values are visible.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Save \(1\)/ })).toBeNull();
      expect(runSqlStream).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps the buffer and shows a banner when an op fails", async () => {
    applyTableEdits.mockResolvedValue({
      outcome: "op_failed",
      code: "23505",
      message: "duplicate key value violates unique constraint",
      failed_op_index: 0,
    });

    const { container } = renderTab();
    await runAndEdit(container);

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /Save \(1\)/ }));
    });

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "Op #1 failed: [23505] duplicate key value violates unique constraint",
      );
    });
    // The edit survives so the user can correct it.
    expect(screen.getByRole("button", { name: /Save \(1\)/ })).toBeTruthy();
    // And no re-run was triggered.
    expect(runSqlStream).toHaveBeenCalledTimes(1);
  });

  it("discards pending edits without confirmation from the Discard control", async () => {
    const { container } = renderTab();
    await runAndEdit(container);

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Save \(1\)/ })).toBeNull();
    });
    expect(applyTableEdits).not.toHaveBeenCalled();
  });

  it("prompts before closing the tab with pending result edits", async () => {
    const { container } = renderTab();
    await runAndEdit(container);

    let closeResult: Promise<boolean> | boolean = false;
    await act(async () => {
      closeResult = closeConfirmHandler!() as Promise<boolean>;
    });

    // The dialog is up and the close is parked, not resolved.
    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeTruthy();
    });
    expect(screen.getByRole("alertdialog").textContent).toContain("Discard 1 change");
    // Exactly one dialog — the query-dirty confirm must not stack on top.
    expect(screen.queryByRole("dialog")).toBeNull();

    // Scope to the dialog — the result toolbar has its own "Discard" button.
    const dialog = screen.getByRole("alertdialog");
    const confirm = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent === "Discard",
    )!;
    await act(async () => {
      fireEvent.click(confirm);
    });
    await expect(closeResult).resolves.toBe(true);
  });

  it("prompts before re-running with pending result edits, and cancelling keeps them", async () => {
    const { container } = renderTab();
    await runAndEdit(container);
    expect(runSqlStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      editorProps.onRun?.();
    });

    // Query not dispatched; dialog shown instead.
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeTruthy());
    expect(runSqlStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    // Edits intact.
    expect(screen.getByRole("button", { name: /Save \(1\)/ })).toBeTruthy();
    expect(runSqlStream).toHaveBeenCalledTimes(1);
  });

  it("leaves ⌘S bound to saving the query, not the rows", async () => {
    const { container } = renderTab();
    await runAndEdit(container);

    await act(async () => {
      editorProps.onSave?.();
    });

    // The query-save flow ran; the result buffer was not touched.
    expect(applyTableEdits).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Save \(1\)/ })).toBeTruthy();
  });

  it("publishes a dirty summary naming the relation", async () => {
    const { container } = renderTab();
    await runAndEdit(container);

    const last = dirtySummaries[dirtySummaries.length - 1] as {
      connectionId: string;
      label: string;
    } | null;
    expect(last).toMatchObject({
      connectionId: CONN_ID,
      label: "public.users (result)",
    });
  });

  it("renders no Save control when the result is not editable", async () => {
    runSqlStream.mockImplementation((async (
      _id: string,
      _sql: string,
      _origin: string,
      _token: string,
      onEvent: (ev: StreamEvent) => void,
    ) => {
      onEvent({
        event: "columns",
        columns: COLUMNS,
        editability: { status: "not_editable", reason: "pk_not_selected" },
      });
      onEvent({ event: "batch", rows: [[7, "ana@example.com"]] as never });
      onEvent({
        event: "done",
        row_count: 1,
        truncated: false,
        query_ms: 3,
        truncated_columns: [],
        row_cap: 10_000,
        row_cap_source: "setting",
      });
    }) as never);

    const { container } = renderTab();
    await act(async () => {
      editorProps.onRun?.();
    });
    await waitFor(() => expect(container.querySelector("[data-selected]")).not.toBeNull());

    expect(screen.queryByRole("button", { name: /^Save$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Save \(/ })).toBeNull();
  });
});
