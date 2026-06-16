import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { PrimaryButton } from "../PrimaryButton";

describe("PrimaryButton", () => {
  it("renders a button with the button class", () => {
    const { container } = render(<PrimaryButton>Apply</PrimaryButton>);
    const btn = container.firstElementChild as HTMLElement;
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.className).toMatch(/button/);
    expect(btn.textContent).toBe("Apply");
  });

  it("adds the dirty class when dirty prop is true", () => {
    const { container } = render(<PrimaryButton dirty>Apply</PrimaryButton>);
    const btn = container.firstElementChild as HTMLElement;
    expect(btn.className).toMatch(/dirty/);
  });

  it("does NOT have the dirty class when dirty prop is false", () => {
    const { container } = render(<PrimaryButton dirty={false}>Apply</PrimaryButton>);
    const btn = container.firstElementChild as HTMLElement;
    // class string should contain "button" but not "dirty" as a distinct class
    expect(btn.className).not.toMatch(/\bdirty\b/);
  });

  it("is disabled when disabled prop is set", () => {
    const { container } = render(<PrimaryButton disabled>Apply</PrimaryButton>);
    const btn = container.firstElementChild as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    const { getByRole } = render(
      <PrimaryButton onClick={onClick}>Apply</PrimaryButton>,
    );
    fireEvent.click(getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("sets aria-label when ariaLabel is provided", () => {
    const { getByRole } = render(
      <PrimaryButton ariaLabel="Apply (unsaved changes)">Apply</PrimaryButton>,
    );
    expect(getByRole("button", { name: "Apply (unsaved changes)" })).toBeInTheDocument();
  });

  it("defaults type to button", () => {
    const { container } = render(<PrimaryButton>Apply</PrimaryButton>);
    const btn = container.firstElementChild as HTMLButtonElement;
    expect(btn.type).toBe("button");
  });

  it("merges an extra className", () => {
    const { container } = render(<PrimaryButton className="extra">Apply</PrimaryButton>);
    const btn = container.firstElementChild as HTMLElement;
    expect(btn.className).toMatch(/button/);
    expect(btn.className).toMatch(/extra/);
  });
});
