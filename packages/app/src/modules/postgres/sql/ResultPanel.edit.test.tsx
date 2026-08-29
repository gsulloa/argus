/**
 * ResultPanel edit-gating tests (issue #279).
 *
 * The panel decides *whether* the result grid is editable; the grid itself is
 * covered by AdhocResultGrid.edit.test.tsx. What matters here is the gating
 * precedence — a read-only connection must win over an "editable" payload, and
 * a run that is still streaming or came from a multi-statement batch must never
 * offer editing regardless of what the backend said.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook } from "@testing-library/react";
import { ResultPanel } from "./ResultPanel";
import { useEditBuffer } from "../data/useEditBuffer";
import type { ResultEditability } from "../data/types";
import type { RunState } from "./useQueryRun";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/platform/toast", () => ({
  useToast: () => ({ show: vi.fn() }),
}));

vi.mock("@/platform/settings/api", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

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
  value: { clipboard: { writeText: vi.fn() } },
  writable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COLUMNS = [
  { name: "id", data_type: "int4", ordinal_position: 1, is_nullable: false },
  { name: "email", data_type: "text", ordinal_position: 2, is_nullable: true },
];

const ROWS = [
  [7, "ana@example.com"],
  [8, "bea@example.com"],
];

const EDITABLE: ResultEditability = {
  status: "editable",
  schema: "public",
  relation: "users",
  pk_columns: ["id"],
  pk_column_indexes: [0],
  column_sources: ["id", "email"],
  enums: {},
};

function doneRows(editability: ResultEditability): RunState {
  return {
    status: "done",
    mode: "single",
    sql: "SELECT id, email FROM users",
    startOffset: 0,
    error: null,
    result: {
      kind: "rows",
      columns: COLUMNS,
      rows: ROWS,
      truncated_columns: [],
      truncated: false,
      query_ms: 4,
      row_cap: 10_000,
      row_cap_source: "setting",
      editability,
    },
  };
}

function Harness({
  state,
  connectionWritable = true,
}: {
  state: RunState;
  connectionWritable?: boolean;
}) {
  const buffer = useEditBuffer();
  return (
    <ResultPanel
      state={state}
      onShowInEditor={() => {}}
      edit={{ buffer, connectionWritable }}
    />
  );
}

function dataCells(container: HTMLElement): HTMLElement[] {
  const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-selected]"));
  return Array.from(rows[0]!.querySelectorAll<HTMLElement>("[data-col]"));
}

// ---------------------------------------------------------------------------

describe("ResultPanel edit gating", () => {
  it("allows editing an editable result on a writable connection", () => {
    const { container } = render(<Harness state={doneRows(EDITABLE)} />);
    const emailCell = dataCells(container)[1]!;
    expect(emailCell.getAttribute("title")).toBeNull();
    fireEvent.doubleClick(emailCell);
    expect(container.querySelector("input")).not.toBeNull();
  });

  it("blocks editing and names the reason for a non-editable result", () => {
    const { container } = render(
      <Harness state={doneRows({ status: "not_editable", reason: "pk_not_selected" })} />,
    );
    const emailCell = dataCells(container)[1]!;
    expect(emailCell.getAttribute("title")).toBe(
      "Not editable — add the primary key to the SELECT list to edit these rows",
    );
    fireEvent.doubleClick(emailCell);
    expect(container.querySelector("input")).toBeNull();
  });

  it("maps every block reason to its copy", () => {
    const cases: Array<[ResultEditability, string]> = [
      [
        { status: "not_editable", reason: "no_base_table" },
        "Not editable — this result isn't a plain table projection",
      ],
      [
        { status: "not_editable", reason: "multiple_tables" },
        "Not editable — the result mixes columns from more than one table",
      ],
      [
        { status: "not_editable", reason: "not_a_table" },
        "Not editable — views and materialized views can't be edited here",
      ],
      [
        { status: "not_editable", reason: "duplicate_projection" },
        "Not editable — the same column is selected more than once",
      ],
    ];
    for (const [editability, copy] of cases) {
      const { container, unmount } = render(<Harness state={doneRows(editability)} />);
      expect(dataCells(container)[1]!.getAttribute("title")).toBe(copy);
      unmount();
    }
  });

  it("lets a read-only connection override an editable payload", () => {
    const { container } = render(
      <Harness state={doneRows(EDITABLE)} connectionWritable={false} />,
    );
    for (const cell of dataCells(container)) {
      expect(cell.getAttribute("title")).toBe("Read-only connection — edits disabled");
    }
    fireEvent.doubleClick(dataCells(container)[1]!);
    expect(container.querySelector("input")).toBeNull();
  });

  it("never allows editing while a run is still streaming", () => {
    const streaming: RunState = {
      status: "streaming",
      mode: "single",
      sql: "SELECT id, email FROM users",
      startOffset: 0,
      columns: COLUMNS,
      rows: ROWS,
      loadedCount: 2,
      editability: EDITABLE,
    };
    const { container } = render(<Harness state={streaming} />);
    const emailCell = dataCells(container)[1]!;
    expect(emailCell.getAttribute("title")).toBe(
      "Not editable while the query is still loading",
    );
    fireEvent.doubleClick(emailCell);
    expect(container.querySelector("input")).toBeNull();
  });

  it("never allows editing a multi-statement outcome", () => {
    const multi: RunState = {
      status: "done",
      mode: "multi",
      statements: [
        { sql: "SELECT id, email FROM users", startOffset: 0, endOffset: 27 },
      ],
      outcomes: [
        {
          status: "ok",
          statement_index: 0,
          result: {
            kind: "rows",
            columns: COLUMNS,
            rows: ROWS,
            truncated_columns: [],
            truncated: false,
            query_ms: 4,
            row_cap: 10_000,
            row_cap_source: "setting",
            editability: EDITABLE,
          },
        },
      ],
    };
    const { container } = render(<Harness state={multi} />);
    const emailCell = dataCells(container)[1]!;
    expect(emailCell.getAttribute("title")).toBe(
      "Not editable — results from a multi-statement run are read-only",
    );
    fireEvent.doubleClick(emailCell);
    expect(container.querySelector("input")).toBeNull();
  });

  it("renders a dismissable save-error banner", () => {
    function ErrHarness() {
      const buffer = useEditBuffer();
      return (
        <ResultPanel
          state={doneRows(EDITABLE)}
          onShowInEditor={() => {}}
          edit={{ buffer, connectionWritable: true }}
          saveError="Op #1 failed: [23505] duplicate key value"
          onDismissSaveError={() => {}}
        />
      );
    }
    const { getByRole, getByLabelText } = render(<ErrHarness />);
    expect(getByRole("alert").textContent).toContain(
      "Op #1 failed: [23505] duplicate key value",
    );
    expect(getByLabelText("Dismiss save error")).toBeTruthy();
  });

  it("keeps the inspector read-only even on an editable result", () => {
    const { container } = render(<Harness state={doneRows(EDITABLE)} />);
    // Select a row so the inspector has something to show.
    const gutter = container.querySelectorAll("[data-selected]")[0]!
      .firstElementChild as HTMLElement;
    fireEvent.mouseDown(gutter, { button: 0, clientX: 5, clientY: 5 });
    fireEvent.mouseUp(document, { clientX: 5, clientY: 5 });
    // No editor is open anywhere, and the inspector renders no inputs of its own.
    expect(container.querySelector("input")).toBeNull();
  });

  it("renders a read-only grid when no edit context is supplied", () => {
    // Guards the other consumers / existing tests: omitting `edit` must leave
    // cells without any title and without an editor.
    const { container } = render(
      <ResultPanel state={doneRows(EDITABLE)} onShowInEditor={() => {}} />,
    );
    const emailCell = dataCells(container)[1]!;
    expect(emailCell.getAttribute("title")).toBeNull();
    fireEvent.doubleClick(emailCell);
    expect(container.querySelector("input")).toBeNull();
  });

  it("clears pending edits when the column shape changes", () => {
    // A new query shape means the buffered rows are no longer on screen;
    // carrying edits forward would let a save write invisible values.
    const { result } = renderHook(() => useEditBuffer());
    const buffer = result.current;
    const { rerender } = render(
      <ResultPanel
        state={doneRows(EDITABLE)}
        onShowInEditor={() => {}}
        edit={{ buffer, connectionWritable: true }}
      />,
    );
    act(() => {
      buffer.setCellEdit({
        rowKey: JSON.stringify({ id: 7 }),
        column: "email",
        value: "x@example.com",
        pk: { id: 7 },
        originalRow: [7, "ana@example.com"],
        originalColumns: ["id", "email"],
      });
    });
    // Precondition: without this the assertion below would pass vacuously.
    expect(result.current.hasDirty).toBe(true);

    const nextShape = doneRows(EDITABLE);
    if (nextShape.status === "done" && nextShape.mode === "single" && nextShape.result?.kind === "rows") {
      nextShape.result.columns = [
        ...COLUMNS,
        { name: "status", data_type: "text", ordinal_position: 3, is_nullable: true },
      ];
      nextShape.result.rows = [[7, "ana@example.com", "new"]];
    }
    rerender(
      <ResultPanel
        state={nextShape}
        onShowInEditor={() => {}}
        edit={{ buffer, connectionWritable: true }}
      />,
    );
    expect(result.current.hasDirty).toBe(false);
  });
});
