import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { FilterBarActions } from "../FilterBarActions";

describe("FilterBarActions", () => {
  it("renders the actions wrapper with the actions class", () => {
    const { container } = render(<FilterBarActions />);
    const div = container.firstElementChild as HTMLElement;
    expect(div.tagName).toBe("DIV");
    expect(div.className).toMatch(/actions/);
  });

  it("renders left and right content with a spacer between them", () => {
    const { container } = render(
      <FilterBarActions
        left={<span data-testid="left">L</span>}
        right={<span data-testid="right">R</span>}
      />,
    );
    const div = container.firstElementChild as HTMLElement;
    const children = Array.from(div.children);
    // left slot, spacer, right slot
    expect(children).toHaveLength(3);
    expect(children[1]!.className).toMatch(/spacer/);
    expect(div.textContent).toContain("L");
    expect(div.textContent).toContain("R");
  });

  it("merges an extra className", () => {
    const { container } = render(<FilterBarActions className="extra" />);
    const div = container.firstElementChild as HTMLElement;
    expect(div.className).toMatch(/actions/);
    expect(div.className).toMatch(/extra/);
  });
});
