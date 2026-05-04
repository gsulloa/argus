import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { VersionIndicatorView } from "./VersionIndicator";

const baseProps = {
  currentVersion: "0.1.5",
  pendingVersion: null,
  availableVersion: null,
  skippedVersion: null,
  onForceCheck: vi.fn(),
  onSkip: vi.fn(),
  onClearSkip: vi.fn(),
};

describe("VersionIndicatorView", () => {
  it("renders only the current version when no update is pending", () => {
    render(<VersionIndicatorView {...baseProps} />);
    const trigger = screen.getByRole("button", { name: /Argus Beta v0\.1\.5/ });
    expect(trigger).toBeInTheDocument();
    expect(trigger.textContent).toContain("v0.1.5");
    expect(trigger.textContent).not.toContain("→");
    expect(trigger.dataset.pending).toBe("false");
  });

  it("renders both current and pending with arrow when update is pending", () => {
    render(<VersionIndicatorView {...baseProps} pendingVersion="0.1.7" />);
    const trigger = screen.getByRole("button", {
      name: /Restart Argus Beta to apply v0\.1\.7/,
    });
    expect(trigger).toBeInTheDocument();
    expect(trigger.textContent).toContain("v0.1.5");
    expect(trigger.textContent).toContain("v0.1.7");
    expect(trigger.textContent).toContain("→");
    expect(trigger.dataset.pending).toBe("true");
  });

  it("renders nothing when current version is empty (still loading)", () => {
    const { container } = render(
      <VersionIndicatorView {...baseProps} currentVersion="" />,
    );
    expect(container.firstChild).toBeNull();
  });
});
