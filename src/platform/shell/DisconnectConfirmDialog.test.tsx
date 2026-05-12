import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DisconnectConfirmDialog } from "./DisconnectConfirmDialog";

// ---------------------------------------------------------------------------
// Radix Dialog renders into a portal, so we need the full jsdom + @testing-library/react
// The component itself has no Tauri deps — no mocks needed beyond noop handlers.
// ---------------------------------------------------------------------------

function renderDialog(tabCount: number, dirtyLabels: string[] = []) {
  const onOpenChange = vi.fn();
  const onConfirm = vi.fn();

  const { container } = render(
    <DisconnectConfirmDialog
      open={true}
      onOpenChange={onOpenChange}
      subject="my-dynamo"
      tabCount={tabCount}
      dirtyLabels={dirtyLabels}
      onConfirm={onConfirm}
    />,
  );

  return { container, onOpenChange, onConfirm };
}

describe("DisconnectConfirmDialog — body text adaptation (§12.2)", () => {
  /**
   * §12.4 snapshot 1: zero tabs — "N tab(s) will close." must NOT be shown.
   */
  it("zero tabs: does not render tab-close sentence", () => {
    renderDialog(0);

    expect(
      screen.queryByText(/tab.*will close/i),
    ).not.toBeInTheDocument();
  });

  it("zero tabs: renders fallback 'release the pool' sentence", () => {
    renderDialog(0);

    expect(
      screen.getByText(/release the pool/i),
    ).toBeInTheDocument();
  });

  /**
   * §12.4 snapshot 2: multiple tabs — "3 tab(s) will close." IS shown.
   */
  it("multiple tabs: renders tab-close sentence with correct count", () => {
    renderDialog(3);

    // "3 tabs will close." — the component renders "N tab{N===1?'':'s'} will close."
    expect(screen.getByText(/3 tabs will close/i)).toBeInTheDocument();
  });

  it("multiple tabs: does NOT render the 'release the pool' fallback", () => {
    renderDialog(3);

    expect(screen.queryByText(/release the pool/i)).not.toBeInTheDocument();
  });

  /**
   * Edge: single tab uses singular form.
   */
  it("single tab: renders singular 'tab will close'", () => {
    renderDialog(1);

    expect(screen.getByText(/1 tab will close/i)).toBeInTheDocument();
  });

  /**
   * §12.3 — heading always shows the subject.
   */
  it("heading: always includes the subject name", () => {
    renderDialog(0);

    expect(
      screen.getByRole("heading", { name: /disconnect my-dynamo/i }),
    ).toBeInTheDocument();
  });

  /**
   * §12.3 — footer contains Disconnect and Cancel affordances.
   */
  it("footer: renders Cancel and Disconnect buttons", () => {
    renderDialog(0);

    expect(
      screen.getByRole("button", { name: /cancel/i }),
    ).toBeInTheDocument();

    expect(
      screen.getByRole("button", { name: /disconnect/i }),
    ).toBeInTheDocument();
  });
});
