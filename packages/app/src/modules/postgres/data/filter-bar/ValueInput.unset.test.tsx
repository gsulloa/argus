import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ValueInput } from "./ValueInput";
import type { ColumnRef, DataColumn, FilterValue } from "../types";

const cols: DataColumn[] = [
  { name: "id", data_type: "int4", ordinal_position: 1, is_nullable: false },
  { name: "country", data_type: "text", ordinal_position: 2, is_nullable: true },
  { name: "email_verified", data_type: "boolean", ordinal_position: 3, is_nullable: false },
];

function renderUnset(column: ColumnRef, value: FilterValue | undefined) {
  const onChange = vi.fn();
  render(
    <ValueInput
      column={column}
      columns={cols}
      op={null}
      value={value}
      onChange={onChange}
    />,
  );
  return onChange;
}

// With no operator to derive the control from, ValueInput falls back to the
// SHAPE of the retained value — the whole point of Unset is that the user's
// value stays visible and editable.
describe("ValueInput — unset operator", () => {
  it("renders the chip input for an array value", () => {
    renderUnset({ kind: "named", name: "id" }, ["1", "2"]);
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders the range inputs for a {min, max} value", () => {
    renderUnset({ kind: "named", name: "id" }, { min: 1, max: 10 });
    expect(screen.getByRole("textbox", { name: /Minimum/i })).toHaveValue("1");
    expect(screen.getByRole("textbox", { name: /Maximum/i })).toHaveValue("10");
  });

  it("renders the scalar input for a scalar value", () => {
    renderUnset({ kind: "named", name: "country" }, "CL");
    expect(screen.getByRole("textbox", { name: /Value/i })).toHaveValue("CL");
  });

  it("renders the scalar input (not nothing) for an empty value", () => {
    renderUnset({ kind: "any_column" }, "");
    expect(screen.getByRole("textbox", { name: /Value/i })).toHaveValue("");
  });

  it("does not eagerly commit a boolean while the operator is unset", () => {
    const onChange = renderUnset({ kind: "named", name: "email_verified" }, "");
    expect(screen.getByRole("combobox", { name: /Value/i })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("still eagerly commits a boolean once an operator is set", () => {
    const onChange = vi.fn();
    render(
      <ValueInput
        column={{ kind: "named", name: "email_verified" }}
        columns={cols}
        op="="
        value=""
        onChange={onChange}
      />,
    );
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
