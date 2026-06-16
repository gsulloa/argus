import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { FilterBarShell } from "../FilterBarShell";

describe("FilterBarShell", () => {
  it("renders children inside a div with the shell class", () => {
    const { container } = render(
      <FilterBarShell>
        <span>hello</span>
      </FilterBarShell>,
    );
    const div = container.firstElementChild as HTMLElement;
    expect(div.tagName).toBe("DIV");
    expect(div.className).toMatch(/shell/);
    expect(div.textContent).toBe("hello");
  });

  it("merges an extra className onto the shell element", () => {
    const { container } = render(
      <FilterBarShell className="extra">content</FilterBarShell>,
    );
    const div = container.firstElementChild as HTMLElement;
    expect(div.className).toMatch(/shell/);
    expect(div.className).toMatch(/extra/);
  });
});
