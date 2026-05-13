import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { RootCombinatorToggle } from "../RootCombinatorToggle";

describe("RootCombinatorToggle", () => {
  it("renders both AND and OR options", () => {
    const { getAllByRole } = render(
      <RootCombinatorToggle value="AND" onChange={vi.fn()} />,
    );
    const radios = getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios[0]!.textContent).toBe("AND");
    expect(radios[1]!.textContent).toBe("OR");
  });

  it("renders a radiogroup with the default aria-label", () => {
    const { getByRole } = render(
      <RootCombinatorToggle value="AND" onChange={vi.fn()} />,
    );
    expect(getByRole("radiogroup", { name: "Root combinator" })).toBeInTheDocument();
  });

  it("accepts a custom aria-label", () => {
    const { getByRole } = render(
      <RootCombinatorToggle value="AND" onChange={vi.fn()} aria-label="Combinator" />,
    );
    expect(getByRole("radiogroup", { name: "Combinator" })).toBeInTheDocument();
  });

  it("marks the active option aria-checked=true", () => {
    const { getAllByRole } = render(
      <RootCombinatorToggle value="AND" onChange={vi.fn()} />,
    );
    const [andBtn, orBtn] = getAllByRole("radio") as [HTMLElement, HTMLElement];
    expect(andBtn.getAttribute("aria-checked")).toBe("true");
    expect(orBtn.getAttribute("aria-checked")).toBe("false");
  });

  it("marks OR as active when value is OR", () => {
    const { getAllByRole } = render(
      <RootCombinatorToggle value="OR" onChange={vi.fn()} />,
    );
    const [andBtn, orBtn] = getAllByRole("radio") as [HTMLElement, HTMLElement];
    expect(andBtn.getAttribute("aria-checked")).toBe("false");
    expect(orBtn.getAttribute("aria-checked")).toBe("true");
  });

  it("calls onChange with OR when the inactive OR button is clicked", () => {
    const onChange = vi.fn();
    const { getAllByRole } = render(
      <RootCombinatorToggle value="AND" onChange={onChange} />,
    );
    fireEvent.click(getAllByRole("radio")[1]!);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("OR");
  });

  it("calls onChange with AND when the inactive AND button is clicked", () => {
    const onChange = vi.fn();
    const { getAllByRole } = render(
      <RootCombinatorToggle value="OR" onChange={onChange} />,
    );
    fireEvent.click(getAllByRole("radio")[0]!);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("AND");
  });

  it("does not call onChange when the already-active option is clicked", () => {
    const onChange = vi.fn();
    const { getAllByRole } = render(
      <RootCombinatorToggle value="AND" onChange={onChange} />,
    );
    fireEvent.click(getAllByRole("radio")[0]!);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("moves to OR on ArrowRight when AND is active", () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <RootCombinatorToggle value="AND" onChange={onChange} />,
    );
    fireEvent.keyDown(getByRole("radiogroup"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("OR");
  });

  it("moves to AND on ArrowLeft when OR is active", () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <RootCombinatorToggle value="OR" onChange={onChange} />,
    );
    fireEvent.keyDown(getByRole("radiogroup"), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("AND");
  });

  it("wraps around on ArrowLeft when AND is active", () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <RootCombinatorToggle value="AND" onChange={onChange} />,
    );
    fireEvent.keyDown(getByRole("radiogroup"), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("OR");
  });

  it("wraps around on ArrowRight when OR is active", () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <RootCombinatorToggle value="OR" onChange={onChange} />,
    );
    fireEvent.keyDown(getByRole("radiogroup"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("AND");
  });
});
