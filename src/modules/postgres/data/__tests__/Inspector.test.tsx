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
    markRowDelete: vi.fn(),
    markRowUndelete: vi.fn(),
    addInsertRow: vi.fn(),
    removeInsertRow: vi.fn(),
    undo: vi.fn(),
    clear: vi.fn(),
    commitSuccess: vi.fn(),
    toEditOps: vi.fn().mockReturnValue([]),
    toRowKeys: vi.fn().mockReturnValue([]),
  };
}

// Renders with id=1 as PK so metadata is editable (not a PK column).
function renderWithJsonb(jsonbValue: string | null, buffer = makeBuffer()) {
  return render(
    <Inspector
      columns={[idCol, jsonbCol]}
      row={[1, jsonbValue]}
      rowKey="row-1"
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
      row={[1, textValue]}
      rowKey="row-1"
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

  it("calls onChange with canonical JSON on valid blur", () => {
    const setCellEdit = vi.fn();
    const buffer = makeBuffer(setCellEdit);
    renderWithJsonb(null, buffer);
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: '{ "foo": "bar"  }' } });
    fireEvent.blur(ta);
    expect(setCellEdit).toHaveBeenCalledWith(
      expect.objectContaining({ value: '{"foo":"bar"}' }),
    );
  });

  it("keeps editor open with error message when JSON is invalid", () => {
    const setCellEdit = vi.fn();
    const buffer = makeBuffer(setCellEdit);
    renderWithJsonb(null, buffer);
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: '{ "foo": "bar"' } });
    fireEvent.blur(ta);
    expect(setCellEdit).not.toHaveBeenCalled();
    expect(screen.getByText(/JSON at position|Unexpected token|Expected|End of JSON/i)).toBeInTheDocument();
  });

  it("commits empty input as null for jsonb column", () => {
    const setCellEdit = vi.fn();
    const buffer = makeBuffer(setCellEdit);
    renderWithJsonb('{"x":1}', buffer);
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "" } });
    fireEvent.blur(ta);
    expect(setCellEdit).toHaveBeenCalledWith(
      expect.objectContaining({ value: null }),
    );
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
