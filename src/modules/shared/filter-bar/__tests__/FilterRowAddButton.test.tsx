import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { FilterRowAddButton } from "../FilterRowAddButton";

describe("FilterRowAddButton", () => {
  it("renders a button with the addButton class", () => {
    const { container } = render(
      <FilterRowAddButton onClick={vi.fn()}>+ Add row</FilterRowAddButton>,
    );
    const btn = container.firstElementChild as HTMLElement;
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.className).toMatch(/addButton/);
    expect(btn.textContent).toBe("+ Add row");
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    const { getByRole } = render(
      <FilterRowAddButton onClick={onClick}>+ Add</FilterRowAddButton>,
    );
    fireEvent.click(getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("defaults type to button", () => {
    const { container } = render(
      <FilterRowAddButton onClick={vi.fn()}>+ Add</FilterRowAddButton>,
    );
    const btn = container.firstElementChild as HTMLButtonElement;
    expect(btn.type).toBe("button");
  });

  it("is disabled when disabled prop is set", () => {
    const { container } = render(
      <FilterRowAddButton onClick={vi.fn()} disabled>
        + Add
      </FilterRowAddButton>,
    );
    const btn = container.firstElementChild as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("merges an extra className", () => {
    const { container } = render(
      <FilterRowAddButton onClick={vi.fn()} className="extra">
        + Add
      </FilterRowAddButton>,
    );
    const btn = container.firstElementChild as HTMLElement;
    expect(btn.className).toMatch(/addButton/);
    expect(btn.className).toMatch(/extra/);
  });
});
