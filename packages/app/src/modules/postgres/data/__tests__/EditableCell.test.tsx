import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { EditableCell } from "../EditableCell";
import type { DataColumn } from "../types";

const jsonbCol: DataColumn = {
  name: "metadata",
  data_type: "jsonb",
  ordinal_position: 1,
  is_nullable: true,
};

const textCol: DataColumn = {
  name: "description",
  data_type: "text",
  ordinal_position: 2,
  is_nullable: true,
};

function renderEditing(column: DataColumn, initial: string | null, onCommit = vi.fn(), onCancel = vi.fn()) {
  return render(
    <EditableCell
      column={column}
      displayValue={initial}
      dirty={false}
      readOnly={false}
      editing={true}
      onStartEdit={vi.fn()}
      onCommitEdit={onCommit}
      onCancelEdit={onCancel}
    />,
  );
}

describe("EditableCell - jsonb column", () => {
  it("renders textarea with autocorrect-off attributes for jsonb column", () => {
    renderEditing(jsonbCol, '{"foo":"bar"}');
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta.getAttribute("autocorrect")).toBe("off");
    expect(ta.getAttribute("autocapitalize")).toBe("off");
    expect(ta.getAttribute("spellcheck")).toBe("false");
    expect(ta.getAttribute("autocomplete")).toBe("off");
  });

  it("does NOT set autocorrect-off on a text column", () => {
    renderEditing(textCol, "hello world");
    const input = screen.getByRole("textbox");
    expect(input.getAttribute("autocorrect")).toBeNull();
  });

  it("commits valid JSON as canonical form", () => {
    const onCommit = vi.fn();
    renderEditing(jsonbCol, null, onCommit);
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: '{ "foo": "bar"  }' } });
    fireEvent.blur(ta);
    expect(onCommit).toHaveBeenCalledWith('{"foo":"bar"}');
  });

  it("keeps editor open with error message when JSON is invalid", () => {
    const onCommit = vi.fn();
    renderEditing(jsonbCol, null, onCommit);
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: '{ "foo": "bar"' } });
    fireEvent.blur(ta);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText(/JSON at position|Unexpected token|Expected|End of JSON/i)).toBeInTheDocument();
  });

  it("pressing Escape cancels even when there is a JSON error", () => {
    const onCancel = vi.fn();
    const onCommit = vi.fn();
    renderEditing(jsonbCol, null, onCommit, onCancel);
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: '{ bad json' } });
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits empty input as null (no parse error)", () => {
    const onCommit = vi.fn();
    renderEditing(jsonbCol, '{"x":1}', onCommit);
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "" } });
    fireEvent.blur(ta);
    expect(onCommit).toHaveBeenCalledWith(null);
    expect(screen.queryByText(/Unexpected token/i)).toBeNull();
    expect(screen.queryByText(/SyntaxError/i)).toBeNull();
  });

  it("shows smart-quote warning chip for JSON with smart quotes but still commits", () => {
    const onCommit = vi.fn();
    renderEditing(jsonbCol, null, onCommit);
    const ta = screen.getByRole("textbox");
    // Build with actual smart quote codepoints so the file writer doesn't convert them.
    const lsq = String.fromCodePoint(0x201c);
    const rsq = String.fromCodePoint(0x201d);
    const smartInput = `{"name":"John ${lsq}Doe${rsq} Smith"}`;
    fireEvent.change(ta, { target: { value: smartInput } });
    fireEvent.blur(ta);
    expect(onCommit).toHaveBeenCalled();
    expect(screen.getByText(/Contains smart quotes/i)).toBeInTheDocument();
  });

  it("clears error on next keystroke after invalid input", () => {
    const onCommit = vi.fn();
    renderEditing(jsonbCol, null, onCommit);
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: '{ bad' } });
    fireEvent.blur(ta);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(ta, { target: { value: '{"x":' } });
    expect(screen.queryByText(/JSON at position|Unexpected/i)).toBeNull();
  });
});
