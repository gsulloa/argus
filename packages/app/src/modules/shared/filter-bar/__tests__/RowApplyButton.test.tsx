import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { RowApplyButton } from "../RowApplyButton";

describe("RowApplyButton", () => {
  it("renders a button with the provided aria-label", () => {
    const { getByRole } = render(
      <RowApplyButton onClick={vi.fn()} aria-label="Apply only this row" />,
    );
    expect(getByRole("button", { name: "Apply only this row" })).toBeInTheDocument();
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    const { getByRole } = render(
      <RowApplyButton onClick={onClick} aria-label="Apply only this row" />,
    );
    fireEvent.click(getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is disabled when the disabled prop is set", () => {
    const { getByRole } = render(
      <RowApplyButton onClick={vi.fn()} aria-label="Apply only this row" disabled />,
    );
    expect(getByRole("button")).toBeDisabled();
  });

  it("does not call onClick when disabled and clicked", () => {
    const onClick = vi.fn();
    const { getByRole } = render(
      <RowApplyButton onClick={onClick} aria-label="Apply only this row" disabled />,
    );
    fireEvent.click(getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders the title attribute when provided", () => {
    const { getByRole } = render(
      <RowApplyButton
        onClick={vi.fn()}
        aria-label="Apply only this row"
        title="Apply only this row (replaces active filter)"
      />,
    );
    expect(getByRole("button").getAttribute("title")).toBe(
      "Apply only this row (replaces active filter)",
    );
  });

  it("has type=button to avoid accidental form submission", () => {
    const { getByRole } = render(
      <RowApplyButton onClick={vi.fn()} aria-label="Apply only this row" />,
    );
    expect((getByRole("button") as HTMLButtonElement).type).toBe("button");
  });
});
