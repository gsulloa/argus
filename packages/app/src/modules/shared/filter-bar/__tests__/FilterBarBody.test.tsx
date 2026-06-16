import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { FilterBarBody } from "../FilterBarBody";

describe("FilterBarBody", () => {
  it("renders children inside a div with the body class", () => {
    const { container } = render(
      <FilterBarBody>
        <span>body content</span>
      </FilterBarBody>,
    );
    const div = container.firstElementChild as HTMLElement;
    expect(div.tagName).toBe("DIV");
    expect(div.className).toMatch(/body/);
    expect(div.textContent).toBe("body content");
  });

  it("merges an extra className", () => {
    const { container } = render(
      <FilterBarBody className="extra">content</FilterBarBody>,
    );
    const div = container.firstElementChild as HTMLElement;
    expect(div.className).toMatch(/body/);
    expect(div.className).toMatch(/extra/);
  });
});
