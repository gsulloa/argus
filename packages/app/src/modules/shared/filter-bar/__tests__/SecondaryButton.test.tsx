import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { SecondaryButton } from "../SecondaryButton";

describe("SecondaryButton", () => {
  it("renders a button with the button class", () => {
    const { container } = render(<SecondaryButton>Reset</SecondaryButton>);
    const btn = container.firstElementChild as HTMLElement;
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.className).toMatch(/button/);
    expect(btn.textContent).toBe("Reset");
  });

  it("is disabled when disabled prop is set", () => {
    const { container } = render(<SecondaryButton disabled>Reset</SecondaryButton>);
    const btn = container.firstElementChild as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    const { getByRole } = render(
      <SecondaryButton onClick={onClick}>Reset</SecondaryButton>,
    );
    fireEvent.click(getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("sets aria-label when ariaLabel is provided", () => {
    const { getByRole } = render(
      <SecondaryButton ariaLabel="Reset filters">Reset</SecondaryButton>,
    );
    expect(getByRole("button", { name: "Reset filters" })).toBeInTheDocument();
  });

  it("defaults type to button", () => {
    const { container } = render(<SecondaryButton>Reset</SecondaryButton>);
    const btn = container.firstElementChild as HTMLButtonElement;
    expect(btn.type).toBe("button");
  });

  it("merges an extra className", () => {
    const { container } = render(<SecondaryButton className="extra">Reset</SecondaryButton>);
    const btn = container.firstElementChild as HTMLElement;
    expect(btn.className).toMatch(/button/);
    expect(btn.className).toMatch(/extra/);
  });
});
