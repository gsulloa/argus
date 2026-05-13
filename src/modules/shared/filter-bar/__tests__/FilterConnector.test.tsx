import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { FilterConnector } from "../FilterConnector";

describe("FilterConnector", () => {
  it("renders a span with the connector class showing AND", () => {
    const { container } = render(<FilterConnector label="AND" />);
    const span = container.firstElementChild as HTMLElement;
    expect(span.tagName).toBe("SPAN");
    expect(span.className).toMatch(/connector/);
    expect(span.textContent).toBe("AND");
  });

  it("renders OR label correctly", () => {
    const { container } = render(<FilterConnector label="OR" />);
    const span = container.firstElementChild as HTMLElement;
    expect(span.textContent).toBe("OR");
  });

  it("merges an extra className", () => {
    const { container } = render(<FilterConnector label="AND" className="extra" />);
    const span = container.firstElementChild as HTMLElement;
    expect(span.className).toMatch(/connector/);
    expect(span.className).toMatch(/extra/);
  });
});
