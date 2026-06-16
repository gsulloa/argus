import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { EmptyBodyRow } from "../EmptyBodyRow";

describe("EmptyBodyRow", () => {
  it("renders a div with the empty class and the label text", () => {
    const { container } = render(<EmptyBodyRow label="No filters" />);
    const div = container.firstElementChild as HTMLElement;
    expect(div.tagName).toBe("DIV");
    expect(div.className).toMatch(/empty/);
    expect(div.textContent).toContain("No filters");
  });

  it("renders label with no separators when children is undefined", () => {
    const { container } = render(<EmptyBodyRow label="No filters" />);
    const div = container.firstElementChild as HTMLElement;
    // No aria-hidden separators without children
    const seps = div.querySelectorAll("[aria-hidden='true']");
    expect(seps).toHaveLength(0);
  });

  it("renders one separator and one child when one child is passed", () => {
    const { container } = render(
      <EmptyBodyRow label="No filters">
        <button>+ Add</button>
      </EmptyBodyRow>,
    );
    const div = container.firstElementChild as HTMLElement;
    const seps = div.querySelectorAll("[aria-hidden='true']");
    expect(seps).toHaveLength(1);
    expect(seps[0]!.textContent).toBe("·");
    expect(div.querySelector("button")).toBeInTheDocument();
  });

  it("renders separators between each pair: label·child1·child2", () => {
    const { container } = render(
      <EmptyBodyRow label="No filters">
        <button>+ AND row</button>
        <button>+ OR group</button>
      </EmptyBodyRow>,
    );
    const div = container.firstElementChild as HTMLElement;
    const seps = div.querySelectorAll("[aria-hidden='true']");
    // one sep before each child
    expect(seps).toHaveLength(2);
    const buttons = div.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
  });

  it("merges an extra className", () => {
    const { container } = render(
      <EmptyBodyRow label="No filters" className="extra" />,
    );
    const div = container.firstElementChild as HTMLElement;
    expect(div.className).toMatch(/empty/);
    expect(div.className).toMatch(/extra/);
  });
});
