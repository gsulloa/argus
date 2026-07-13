import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { EditableCell } from "../EditableCell";
import type { ColumnInfo } from "../../types";

function col(overrides: Partial<ColumnInfo>): ColumnInfo {
  return {
    name: "c",
    data_type: "nvarchar",
    base_type: "nvarchar",
    ordinal_position: 1,
    is_nullable: true,
    column_default: null,
    is_identity: false,
    is_computed: false,
    character_max_length: null,
    ...overrides,
  };
}

const decimalCol = col({ name: "amount", data_type: "decimal", base_type: "decimal" });
const textCol = col({ name: "note", data_type: "nvarchar", base_type: "nvarchar" });

function renderEditing(
  column: ColumnInfo,
  value: string | number | null,
  onCommit = vi.fn(),
  onCancel = vi.fn(),
) {
  render(
    <EditableCell
      column={column}
      value={value}
      isPkColumn={false}
      isReadOnly={false}
      editing={true}
      onCommit={onCommit}
      onCancel={onCancel}
      onStartEdit={vi.fn()}
    />,
  );
  return { onCommit, onCancel };
}

describe("MSSQL EditableCell - entering edit mode without a change does not commit", () => {
  it("does not commit an unchanged decimal cell on blur (server value is a string)", () => {
    const { onCommit, onCancel } = renderEditing(decimalCol, "100.00");
    fireEvent.blur(screen.getByRole("textbox"));
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("does not commit an unchanged text cell on Tab", () => {
    const { onCommit, onCancel } = renderEditing(textCol, "hello");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Tab" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("still commits when the value is actually changed", () => {
    const { onCommit, onCancel } = renderEditing(textCol, "hello");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "world" } });
    fireEvent.blur(screen.getByRole("textbox"));
    expect(onCommit).toHaveBeenCalledWith("world");
    expect(onCancel).not.toHaveBeenCalled();
  });
});
