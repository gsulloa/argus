/**
 * AdhocResultGrid inline-edit tests (issue #279).
 *
 * The read-only grid's behaviour is guarded by the three pre-existing
 * AdhocResultGrid suites; this file covers only what the optional `edit` prop
 * adds — and, critically, that omitting it changes nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { AdhocResultGrid, type AdhocGridEdit } from "./AdhocResultGrid";
import { useEditBuffer } from "./useEditBuffer";
import type { CellValue, DataColumn } from "./types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { toastShow } = vi.hoisted(() => ({ toastShow: vi.fn() }));

vi.mock("@/platform/toast", () => ({
  useToast: () => ({ show: toastShow }),
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

const writeText = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText } },
  writable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COLUMNS: DataColumn[] = [
  { name: "id", data_type: "int4", ordinal_position: 1, is_nullable: false },
  { name: "email", data_type: "text", ordinal_position: 2, is_nullable: true },
];

const ROWS: CellValue[][] = [
  [7, "ana@example.com"],
  [8, "bea@example.com"],
];

/** Render the grid with a live edit buffer and return both. */
function renderEditable(
  overrides: Partial<AdhocGridEdit> = {},
  props: { columns?: DataColumn[]; rows?: CellValue[][] } = {},
) {
  let harnessBuffer: ReturnType<typeof useEditBuffer> | null = null;

  function Harness({ rows }: { rows: CellValue[][] }) {
    const buffer = useEditBuffer();
    // Expose the live buffer for assertions.
    harnessBuffer = buffer;
    const edit: AdhocGridEdit = {
      buffer,
      columnSources: ["id", "email"],
      pkColumns: ["id"],
      pkColumnIndexes: [0],
      enumValuesByColumn: {},
      blockedReason: "",
      ...overrides,
    };
    return (
      <AdhocResultGrid columns={props.columns ?? COLUMNS} rows={rows} edit={edit} />
    );
  }

  const view = render(<Harness rows={props.rows ?? ROWS} />);
  return {
    ...view,
    rerenderRows: (rows: CellValue[][]) => view.rerender(<Harness rows={rows} />),
    getBuffer: () => {
      if (!harnessBuffer) throw new Error("harness has not rendered yet");
      return harnessBuffer;
    },
  };
}

function cellsOfRow(container: HTMLElement, rowIndex: number): HTMLElement[] {
  const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-selected]"));
  const row = rows[rowIndex]!;
  return Array.from(row.querySelectorAll<HTMLElement>("[data-col]"));
}

// ---------------------------------------------------------------------------

describe("AdhocResultGrid inline editing", () => {
  it("does not open an editor when no edit prop is supplied", () => {
    const { container } = render(<AdhocResultGrid columns={COLUMNS} rows={ROWS} />);
    const emailCell = cellsOfRow(container, 0)[1]!;
    fireEvent.doubleClick(emailCell);
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("opens an editor on double-click when the result is editable", () => {
    const { container } = renderEditable();
    const emailCell = cellsOfRow(container, 0)[1]!;
    fireEvent.doubleClick(emailCell);
    const input = container.querySelector("input");
    expect(input).not.toBeNull();
    expect((input as HTMLInputElement).value).toBe("ana@example.com");
  });

  it("is inert and explains itself when blockedReason is set", () => {
    const reason = "Read-only connection — edits disabled";
    const { container } = renderEditable({ blockedReason: reason });
    const cells = cellsOfRow(container, 0);
    for (const cell of cells) {
      expect(cell.getAttribute("title")).toBe(reason);
    }
    fireEvent.doubleClick(cells[1]!);
    expect(container.querySelector("input")).toBeNull();
  });

  it("keeps primary-key and computed cells read-only with their own reason", () => {
    const { container } = renderEditable(
      { columnSources: ["id", "email", null] },
      {
        columns: [
          ...COLUMNS,
          { name: "shout", data_type: "text", ordinal_position: 3, is_nullable: true },
        ],
        rows: [[7, "ana@example.com", "ANA@EXAMPLE.COM"]],
      },
    );
    const cells = cellsOfRow(container, 0);

    // PK column — the row's identity, never editable.
    expect(cells[0]!.getAttribute("title")).toBe("Primary key — not editable");
    fireEvent.doubleClick(cells[0]!);
    expect(container.querySelector("input")).toBeNull();

    // Computed column — no base column to write to.
    expect(cells[2]!.getAttribute("title")).toBe("Computed column — not editable");
    fireEvent.doubleClick(cells[2]!);
    expect(container.querySelector("input")).toBeNull();

    // The ordinary column in between is still editable.
    expect(cells[1]!.getAttribute("title")).toBeNull();
    fireEvent.doubleClick(cells[1]!);
    expect(container.querySelector("input")).not.toBeNull();
  });

  it("keeps binary and oversized-envelope cells read-only", () => {
    const { container } = renderEditable(
      { columnSources: ["id", "blob", "note"] },
      {
        columns: [
          COLUMNS[0]!,
          { name: "blob", data_type: "bytea", ordinal_position: 2, is_nullable: true },
          { name: "note", data_type: "text", ordinal_position: 3, is_nullable: true },
        ],
        rows: [[7, "\\x00", { kind: "truncated", preview: "…", byte_length: 5300 }]],
      },
    );
    const cells = cellsOfRow(container, 0);
    expect(cells[1]!.getAttribute("title")).toBe("binary, not editable inline");
    expect(cells[2]!.getAttribute("title")).toBe("value too large to edit inline");
    fireEvent.doubleClick(cells[1]!);
    fireEvent.doubleClick(cells[2]!);
    expect(container.querySelector("input")).toBeNull();
  });

  it("commits an edit keyed by base column and primary key", async () => {
    // Aliased projection: the grid shows `mail`, but the write targets `email`.
    const aliased: DataColumn[] = [
      { name: "pk", data_type: "int4", ordinal_position: 1, is_nullable: false },
      { name: "mail", data_type: "text", ordinal_position: 2, is_nullable: true },
    ];
    const { container, getBuffer } = renderEditable({}, { columns: aliased });

    const mailCell = cellsOfRow(container, 0)[1]!;
    fireEvent.doubleClick(mailCell);
    const input = container.querySelector("input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "new@example.com" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });

    await waitFor(() => {
      const ops = getBuffer().toEditOps();
      expect(ops).toHaveLength(1);
      expect(ops[0]).toEqual({
        kind: "update",
        pk: { id: 7 },
        changes: { email: "new@example.com" },
      });
    });
  });

  it("does not dirty a cell when the editor is opened and closed unchanged", async () => {
    const { container, getBuffer } = renderEditable();
    const emailCell = cellsOfRow(container, 0)[1]!;
    fireEvent.doubleClick(emailCell);
    const input = container.querySelector("input") as HTMLInputElement;
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(getBuffer().hasDirty).toBe(false);
  });

  it("cancels on Escape without dirtying", async () => {
    const { container, getBuffer } = renderEditable();
    const emailCell = cellsOfRow(container, 0)[1]!;
    fireEvent.doubleClick(emailCell);
    const input = container.querySelector("input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "typed but abandoned" } });
      fireEvent.keyDown(input, { key: "Escape" });
    });
    expect(getBuffer().hasDirty).toBe(false);
    expect(container.querySelector("input")).toBeNull();
  });

  it("follows the primary key when the rows prop is reordered", async () => {
    const { container, rerenderRows, getBuffer } = renderEditable();

    // Edit the row whose id is 7 (currently first).
    fireEvent.doubleClick(cellsOfRow(container, 0)[1]!);
    const input = container.querySelector("input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "moved@example.com" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() => expect(getBuffer().hasDirty).toBe(true));

    // Re-sort: id 7 is now the SECOND row.
    await act(async () => {
      rerenderRows([ROWS[1]!, ROWS[0]!]);
    });

    // The pending value must have travelled with id 7, not stayed at index 0.
    await waitFor(() => {
      expect(cellsOfRow(container, 1)[1]!.textContent).toContain("moved@example.com");
      expect(cellsOfRow(container, 0)[1]!.textContent).toContain("bea@example.com");
    });
    // And the op still addresses id 7.
    expect(getBuffer().toEditOps()[0]).toMatchObject({ pk: { id: 7 } });
  });

  it("copies the pending edit rather than the server value", async () => {
    writeText.mockClear();
    const { container } = renderEditable();

    fireEvent.doubleClick(cellsOfRow(container, 0)[1]!);
    const input = container.querySelector("input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "copied@example.com" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });

    // Select that cell, then ⌘C.
    const cell = cellsOfRow(container, 0)[1]!;
    fireEvent.mouseDown(cell, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseUp(document, { clientX: 10, clientY: 10 });
    const root = container.querySelector("[tabindex]") as HTMLElement;
    fireEvent.keyDown(root, { key: "c", metaKey: true });

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("copied@example.com");
    });
  });

  it("never marks rows for deletion", async () => {
    const { container, getBuffer } = renderEditable();
    const root = container.querySelector("[tabindex]") as HTMLElement;
    // Select a row via the gutter, then press Backspace / Delete.
    const gutter = container.querySelectorAll("[data-selected]")[0]!
      .firstElementChild as HTMLElement;
    fireEvent.mouseDown(gutter, { button: 0, clientX: 5, clientY: 5 });
    fireEvent.mouseUp(document, { clientX: 5, clientY: 5 });
    fireEvent.keyDown(root, { key: "Backspace" });
    fireEvent.keyDown(root, { key: "Delete" });
    expect(getBuffer().dirtyCounts.deletes).toBe(0);
    expect(getBuffer().hasDirty).toBe(false);
  });
});
