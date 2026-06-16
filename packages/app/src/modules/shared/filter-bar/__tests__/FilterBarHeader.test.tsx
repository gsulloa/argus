import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { FilterBarHeader } from "../FilterBarHeader";

describe("FilterBarHeader", () => {
  it("renders children inside a div with the header class", () => {
    const { container } = render(
      <FilterBarHeader>
        <span>header content</span>
      </FilterBarHeader>,
    );
    const div = container.firstElementChild as HTMLElement;
    expect(div.tagName).toBe("DIV");
    expect(div.className).toMatch(/header/);
    expect(div.textContent).toBe("header content");
  });

  it("merges an extra className", () => {
    const { container } = render(
      <FilterBarHeader className="extra">content</FilterBarHeader>,
    );
    const div = container.firstElementChild as HTMLElement;
    expect(div.className).toMatch(/header/);
    expect(div.className).toMatch(/extra/);
  });
});
