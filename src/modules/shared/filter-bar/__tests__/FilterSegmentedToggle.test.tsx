import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { FilterSegmentedToggle } from "../FilterSegmentedToggle";

const options = [
  { id: "a", label: "Option A" },
  { id: "b", label: "Option B" },
  { id: "c", label: "Option C" },
];

describe("FilterSegmentedToggle", () => {
  it("renders a radiogroup with one button per option", () => {
    const { getByRole, getAllByRole } = render(
      <FilterSegmentedToggle options={options} value="a" onChange={vi.fn()} />,
    );
    expect(getByRole("radiogroup")).toBeInTheDocument();
    const radios = getAllByRole("radio");
    expect(radios).toHaveLength(3);
  });

  it("marks the active option aria-checked=true and inactive options false", () => {
    const { getAllByRole } = render(
      <FilterSegmentedToggle options={options} value="b" onChange={vi.fn()} />,
    );
    const radios = getAllByRole("radio");
    expect(radios[0]!.getAttribute("aria-checked")).toBe("false");
    expect(radios[1]!.getAttribute("aria-checked")).toBe("true");
    expect(radios[2]!.getAttribute("aria-checked")).toBe("false");
  });

  it("applies the optionActive class only to the active option", () => {
    const { getAllByRole } = render(
      <FilterSegmentedToggle options={options} value="c" onChange={vi.fn()} />,
    );
    const radios = getAllByRole("radio");
    expect(radios[0]!.className).not.toMatch(/optionActive/);
    expect(radios[1]!.className).not.toMatch(/optionActive/);
    expect(radios[2]!.className).toMatch(/optionActive/);
  });

  it("calls onChange with the clicked option id", () => {
    const onChange = vi.fn();
    const { getAllByRole } = render(
      <FilterSegmentedToggle options={options} value="a" onChange={onChange} />,
    );
    fireEvent.click(getAllByRole("radio")[2]!);
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("applies optionNotLast to all except the last option", () => {
    const { getAllByRole } = render(
      <FilterSegmentedToggle options={options} value="a" onChange={vi.fn()} />,
    );
    const radios = getAllByRole("radio");
    expect(radios[0]!.className).toMatch(/optionNotLast/);
    expect(radios[1]!.className).toMatch(/optionNotLast/);
    expect(radios[2]!.className).not.toMatch(/optionNotLast/);
    expect(radios[2]!.className).toMatch(/optionLast/);
  });

  it("applies optionFirst only to the first option", () => {
    const { getAllByRole } = render(
      <FilterSegmentedToggle options={options} value="a" onChange={vi.fn()} />,
    );
    const radios = getAllByRole("radio");
    expect(radios[0]!.className).toMatch(/optionFirst/);
    expect(radios[1]!.className).not.toMatch(/optionFirst/);
  });

  it("passes ariaLabel to the radiogroup", () => {
    const { getByRole } = render(
      <FilterSegmentedToggle
        options={options}
        value="a"
        onChange={vi.fn()}
        ariaLabel="Mode selector"
      />,
    );
    expect(getByRole("radiogroup", { name: "Mode selector" })).toBeInTheDocument();
  });
});
