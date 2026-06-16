import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Inspector } from "../Inspector";
import type { DataColumn } from "../types";
import type { UseEditBufferResult } from "../useEditBuffer";

const idCol: DataColumn = {
  name: "id",
  data_type: "int4",
  ordinal_position: 1,
  is_nullable: false,
};

const jsonbCol: DataColumn = {
  name: "metadata",
  data_type: "jsonb",
  ordinal_position: 2,
  is_nullable: true,
};

const textCol: DataColumn = {
  name: "description",
  data_type: "text",
  ordinal_position: 3,
  is_nullable: true,
};

function makeBuffer(setCellEdit = vi.fn()): UseEditBufferResult {
  return {
    rows: new Map(),
    hasDirty: false,
    dirtyCounts: { updates: 0, inserts: 0, deletes: 0 },
    getRowEdits: vi.fn().mockReturnValue(undefined),
    getDisplayValue: vi.fn().mockReturnValue(null),
    isCellDirty: vi.fn().mockReturnValue(false),
    isRowDeleted: vi.fn().mockReturnValue(false),
    setCellEdit,
    bulkSetCellEdit: vi.fn(),
    markRowDelete: vi.fn(),
    markRowUndelete: vi.fn(),
    bulkDeleteToggle: vi.fn(),
    addInsertRow: vi.fn(),
    removeInsertRow: vi.fn(),
    undo: vi.fn(),
    clear: vi.fn(),
    commitSuccess: vi.fn(),
    toEditOps: vi.fn().mockReturnValue([]),
    toRowKeys: vi.fn().mockReturnValue([]),
  };
}

// Helper: build a single-row selectedRows array (single-row inspector mode).
function makeSelectedRows(row: (string | number | null)[], rowKey = "row-1") {
  return [
    {
      rowKey,
      row: row as import("../types").CellValue[],
      pk: { id: row[0] } as Record<string, import("../types").EditValue>,
      source: "server" as const,
      isDeleted: false,
    },
  ];
}

// Renders with id=1 as PK so metadata is editable (not a PK column).
function renderWithJsonb(jsonbValue: string | null, buffer = makeBuffer()) {
  return render(
    <Inspector
      columns={[idCol, jsonbCol]}
      selectedRows={makeSelectedRows([1, jsonbValue])}
      bulkEditAvailable={true}
      isReadOnly={false}
      pkColumns={["id"]}
      enumValuesByColumn={{}}
      buffer={buffer}
    />,
  );
}

function renderWithText(textValue: string | null, buffer = makeBuffer()) {
  return render(
    <Inspector
      columns={[idCol, textCol]}
      selectedRows={makeSelectedRows([1, textValue])}
      bulkEditAvailable={true}
      isReadOnly={false}
      pkColumns={["id"]}
      enumValuesByColumn={{}}
      buffer={buffer}
    />,
  );
}

describe("Inspector - jsonb column", () => {
  it("renders textarea with autocorrect-off attributes for jsonb column", () => {
    renderWithJsonb('{"foo":"bar"}');
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta.getAttribute("autocorrect")).toBe("off");
    expect(ta.getAttribute("autocapitalize")).toBe("off");
    expect(ta.getAttribute("spellcheck")).toBe("false");
    expect(ta.getAttribute("autocomplete")).toBe("off");
  });

  it("does NOT set autocorrect-off on a text column", () => {
    renderWithText("hello world");
    const input = screen.getByRole("textbox");
    expect(input.getAttribute("autocorrect")).toBeNull();
  });

  it("commits raw JSON text to buffer on every change (no canonicalization)", () => {
    const setCellEdit = vi.fn();
    const buffer = makeBuffer(setCellEdit);
    renderWithJsonb(null, buffer);
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: '{ "foo": "bar"  }' } });
    expect(setCellEdit).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: '{ "foo": "bar"  }' }),
    );
    fireEvent.blur(ta);
    // Blur does NOT re-dispatch a canonical value; raw text remains in the buffer.
    expect(setCellEdit).toHaveBeenCalledTimes(1);
  });

  it("commits invalid JSON raw text and surfaces inline error on blur", () => {
    const setCellEdit = vi.fn();
    const buffer = makeBuffer(setCellEdit);
    renderWithJsonb(null, buffer);
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: '{ "foo": "bar"' } });
    expect(setCellEdit).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: '{ "foo": "bar"' }),
    );
    fireEvent.blur(ta);
    expect(screen.getByText(/JSON at position|Unexpected token|Expected|End of JSON/i)).toBeInTheDocument();
  });

  it("commits empty input as empty string for jsonb column (raw text passthrough)", () => {
    const setCellEdit = vi.fn();
    const buffer = makeBuffer(setCellEdit);
    renderWithJsonb('{"x":1}', buffer);
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "" } });
    expect(setCellEdit).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: "" }),
    );
    fireEvent.blur(ta);
    expect(screen.queryByText(/Unexpected token/i)).toBeNull();
    expect(screen.queryByText(/SyntaxError/i)).toBeNull();
  });

  it("shows smart-quote warning chip for JSON with smart quotes but still commits", () => {
    const setCellEdit = vi.fn();
    const buffer = makeBuffer(setCellEdit);
    renderWithJsonb(null, buffer);
    const ta = screen.getByRole("textbox");
    // Build with actual smart quote codepoints so the file writer does not convert them.
    const lsq = String.fromCodePoint(0x201c);
    const rsq = String.fromCodePoint(0x201d);
    const smartInput = `{"name":"John ${lsq}Doe${rsq} Smith"}`;
    fireEvent.change(ta, { target: { value: smartInput } });
    fireEvent.blur(ta);
    expect(setCellEdit).toHaveBeenCalled();
    expect(screen.getByText(/Contains smart quotes/i)).toBeInTheDocument();
  });

  it("clears error on next keystroke after invalid input", () => {
    const setCellEdit = vi.fn();
    const buffer = makeBuffer(setCellEdit);
    renderWithJsonb(null, buffer);
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: '{ bad' } });
    fireEvent.blur(ta);
    const errorEl =
      screen.queryByText(/JSON at position/i) ||
      screen.queryByText(/Unexpected/i) ||
      screen.queryByText(/End of JSON/i) ||
      screen.queryByText(/Expected/i);
    expect(errorEl).toBeTruthy();
    fireEvent.change(ta, { target: { value: '{"x":1}' } });
    expect(screen.queryByText(/JSON at position|Unexpected/i)).toBeNull();
  });
});

describe("Inspector - empty state", () => {
  it("shows select a row message when no rows are selected", () => {
    render(
      <Inspector
        columns={[idCol, jsonbCol]}
        selectedRows={[]}
        bulkEditAvailable={true}
        isReadOnly={false}
        pkColumns={["id"]}
        enumValuesByColumn={{}}
        buffer={makeBuffer()}
      />,
    );
    expect(screen.getByText(/Select a row to inspect/i)).toBeInTheDocument();
  });
});
