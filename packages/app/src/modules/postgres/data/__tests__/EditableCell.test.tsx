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

const dateCol: DataColumn = {
  name: "delivery_date",
  data_type: "date",
  ordinal_position: 3,
  is_nullable: true,
};

const notNullTextCol: DataColumn = {
  name: "name",
  data_type: "text",
  ordinal_position: 4,
  is_nullable: false,
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

  it("sets autocorrect-off on a text column too", () => {
    renderEditing(textCol, "hello world");
    const input = screen.getByRole("textbox");
    expect(input.getAttribute("autocorrect")).toBe("off");
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

describe("EditableCell - in-editor mousedown isolation (issue #246)", () => {
  it("does not propagate mousedown to the row drag-select handler and keeps the editor open", () => {
    // The parent onMouseDown stands in for the grid row's drag-select handler
    // (DataGrid row onMouseDown), which preventDefaults + arms drag and would
    // otherwise steal focus / commit the editor on an in-editor click.
    const rowMouseDown = vi.fn();
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(
      <div onMouseDown={rowMouseDown}>
        <EditableCell
          column={textCol}
          displayValue="hello world"
          dirty={false}
          readOnly={false}
          editing={true}
          onStartEdit={vi.fn()}
          onCommitEdit={onCommit}
          onCancelEdit={onCancel}
        />
      </div>,
    );

    const input = screen.getByRole("textbox");
    fireEvent.mouseDown(input);

    // Row-level drag-select handler is never reached (machinery not engaged).
    expect(rowMouseDown).not.toHaveBeenCalled();
    // Edit mode is retained and nothing was committed or cancelled.
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("still lets a mousedown on the display cell reach the row handler", () => {
    // Sanity check: the isolation applies only to the active editor, not the
    // read/display path where drag-select must still work.
    const rowMouseDown = vi.fn();
    render(
      <div onMouseDown={rowMouseDown}>
        <EditableCell
          column={textCol}
          displayValue="hello world"
          dirty={false}
          readOnly={false}
          editing={false}
          onStartEdit={vi.fn()}
          onCommitEdit={vi.fn()}
          onCancelEdit={vi.fn()}
        />
      </div>,
    );

    fireEvent.mouseDown(screen.getByText("hello world"));
    expect(rowMouseDown).toHaveBeenCalledTimes(1);
  });
});

describe("EditableCell - explicit NULL toggle", () => {
  it("commits null when the NULL toggle is activated on a nullable date column", () => {
    const onCommit = vi.fn();
    renderEditing(dateCol, "2026-06-19", onCommit);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "NULL" }));
    // Input now reflects the NULL state (cleared with a NULL placeholder).
    expect(input.value).toBe("");
    expect(input.getAttribute("placeholder")).toBe("NULL");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it("does not render the NULL toggle for a non-nullable column", () => {
    renderEditing(notNullTextCol, "hello");
    expect(screen.queryByRole("button", { name: "NULL" })).toBeNull();
  });

  it("commits an empty string (not null) for a nullable text column without the toggle", () => {
    const onCommit = vi.fn();
    renderEditing(textCol, "hello", onCommit);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith("");
  });

  it("restores the typed text when the NULL toggle is turned back off", () => {
    const onCommit = vi.fn();
    renderEditing(textCol, "", onCommit);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    const nullBtn = screen.getByRole("button", { name: "NULL" });
    fireEvent.click(nullBtn); // NULL on
    expect(input.value).toBe("");
    fireEvent.click(nullBtn); // NULL off
    expect(input.value).toBe("hello");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("hello");
  });
});

// ---------------------------------------------------------------------------
// No-op edit does not commit (issue #245)
// ---------------------------------------------------------------------------

const numericCol: DataColumn = {
  name: "amount",
  data_type: "numeric",
  ordinal_position: 5,
  is_nullable: true,
};

describe("EditableCell - entering edit mode without a change does not commit", () => {
  it("does not commit an unchanged numeric cell on blur (calls onCancel)", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    // Server value for a numeric column is the string "100.00".
    renderEditing(numericCol, "100.00", onCommit, onCancel);
    const input = screen.getByRole("textbox");
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("does not commit an unchanged numeric cell on Enter or Tab", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    renderEditing(numericCol, "100.00", onCommit, onCancel);
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("does not commit an unchanged jsonb cell on blur", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    renderEditing(jsonbCol, '{"foo": "bar"}', onCommit, onCancel);
    const ta = screen.getByRole("textbox");
    fireEvent.blur(ta);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("still commits when the numeric value is actually changed", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    renderEditing(numericCol, "100.00", onCommit, onCancel);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "101" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(101);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
