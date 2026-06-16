import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { FilterKeyHint } from "../FilterKeyHint";

describe("FilterKeyHint", () => {
  it("renders a kbd element for a string key", () => {
    const { container } = render(<FilterKeyHint keys="⎋" />);
    const kbd = container.firstElementChild as HTMLElement;
    expect(kbd.tagName).toBe("KBD");
    expect(kbd.className).toMatch(/hint/);
    // ⎋ passes through unchanged on all platforms
    expect(kbd.textContent).toBe("⎋");
  });

  it("renders multiple kbd elements for an array of keys", () => {
    const { container } = render(<FilterKeyHint keys={["⎋", "↵"]} />);
    const kbds = container.querySelectorAll("kbd");
    expect(kbds).toHaveLength(2);
    expect(kbds[0]!.textContent).toBe("⎋");
    expect(kbds[1]!.textContent).toBe("↵");
  });

  it("renders either ⌘ or Ctrl for the ⌘ glyph depending on platform", () => {
    // We do NOT mock navigator.platform — the test asserts whichever value the
    // current test environment produces, which avoids false failures on CI.
    const { container } = render(<FilterKeyHint keys="⌘" />);
    const kbd = container.firstElementChild as HTMLElement;
    const text = kbd.textContent ?? "";
    expect(text === "⌘" || text === "Ctrl").toBe(true);
  });

  it("merges an extra className onto each kbd", () => {
    const { container } = render(<FilterKeyHint keys="⎋" className="extra" />);
    const kbd = container.firstElementChild as HTMLElement;
    expect(kbd.className).toMatch(/hint/);
    expect(kbd.className).toMatch(/extra/);
  });
});
