import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DocBadge } from "../DocBadge";

describe("DocBadge", () => {
  it("renders the icon with default documented label", () => {
    render(<DocBadge />);
    const badge = screen.getByTitle("Documented");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("aria-label", "Documented");
    // data-deleted attribute should NOT be present
    expect(badge).not.toHaveAttribute("data-deleted");
  });

  it("renders warning title when deletedInDb is true", () => {
    render(<DocBadge deletedInDb={true} />);
    const badge = screen.getByTitle("Documented, no DB match");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("aria-label", "Documented, no DB match");
  });

  it("sets data-deleted attribute when deletedInDb is true", () => {
    render(<DocBadge deletedInDb={true} />);
    const badge = screen.getByTitle("Documented, no DB match");
    // data-deleted is set (truthy value present in DOM)
    expect(badge.hasAttribute("data-deleted")).toBe(true);
  });

  it("does not set data-deleted attribute when deletedInDb is false", () => {
    render(<DocBadge deletedInDb={false} />);
    const badge = screen.getByTitle("Documented");
    expect(badge).not.toHaveAttribute("data-deleted");
  });

  it("does not set data-deleted attribute when deletedInDb is undefined", () => {
    render(<DocBadge />);
    const badge = screen.getByTitle("Documented");
    expect(badge).not.toHaveAttribute("data-deleted");
  });
});
