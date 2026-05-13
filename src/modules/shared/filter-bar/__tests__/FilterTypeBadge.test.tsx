import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { FilterTypeBadge } from "../FilterTypeBadge";

describe("FilterTypeBadge", () => {
  it("renders a span with the badge class containing the label", () => {
    const { container } = render(<FilterTypeBadge>S</FilterTypeBadge>);
    const span = container.firstElementChild as HTMLElement;
    expect(span.tagName).toBe("SPAN");
    expect(span.className).toMatch(/badge/);
    expect(span.textContent).toBe("S");
  });

  it("merges an extra className", () => {
    const { container } = render(
      <FilterTypeBadge className="extra">N</FilterTypeBadge>,
    );
    const span = container.firstElementChild as HTMLElement;
    expect(span.className).toMatch(/badge/);
    expect(span.className).toMatch(/extra/);
  });
});
