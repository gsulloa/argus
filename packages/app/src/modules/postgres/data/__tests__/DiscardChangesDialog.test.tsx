import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DiscardChangesDialog } from "../DiscardChangesDialog";

function renderDialog(
  props: Partial<React.ComponentProps<typeof DiscardChangesDialog>> = {},
) {
  const onCancel = props.onCancel ?? vi.fn();
  const onDiscard = props.onDiscard ?? vi.fn();
  return render(
    <DiscardChangesDialog
      count={props.count ?? 1}
      onCancel={onCancel}
      onDiscard={onDiscard}
      action={props.action}
    />,
  );
}

describe("DiscardChangesDialog — close (default)", () => {
  it("renders the default close header (singular)", () => {
    renderDialog({ count: 1 });
    expect(screen.getByText("Discard 1 change?")).toBeInTheDocument();
  });

  it("renders the default close header (plural)", () => {
    renderDialog({ count: 3 });
    expect(screen.getByText("Discard 3 changes?")).toBeInTheDocument();
  });

  it("renders the close body copy by default", () => {
    renderDialog({ count: 1 });
    expect(
      screen.getByText(
        /Closing this tab will lose your pending edits\. They have not been committed to the database\./,
      ),
    ).toBeInTheDocument();
  });
});

describe("DiscardChangesDialog — refresh action", () => {
  it("renders the refresh header with count 2", () => {
    renderDialog({ count: 2, action: "refresh" });
    expect(screen.getByText("Discard 2 changes and refresh?")).toBeInTheDocument();
  });

  it("renders the refresh header singular", () => {
    renderDialog({ count: 1, action: "refresh" });
    expect(screen.getByText("Discard 1 change and refresh?")).toBeInTheDocument();
  });

  it("renders the refresh body copy", () => {
    renderDialog({ count: 2, action: "refresh" });
    expect(
      screen.getByText(
        /Refreshing the table will lose your pending edits\. They have not been committed to the database\./,
      ),
    ).toBeInTheDocument();
  });
});

describe("DiscardChangesDialog — discard action", () => {
  it("renders discard header (no 'and refresh')", () => {
    renderDialog({ count: 4, action: "discard" });
    expect(screen.getByText("Discard 4 changes?")).toBeInTheDocument();
    expect(screen.queryByText(/and refresh/)).toBeNull();
  });

  it("renders the discard body copy", () => {
    renderDialog({ count: 1, action: "discard" });
    expect(
      screen.getByText(
        /Your pending edits have not been committed to the database\./,
      ),
    ).toBeInTheDocument();
  });
});

describe("DiscardChangesDialog — keyboard interaction", () => {
  it("calls onDiscard when Enter is pressed", () => {
    const onDiscard = vi.fn();
    renderDialog({ onDiscard });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when Escape is pressed", () => {
    const onCancel = vi.fn();
    renderDialog({ onCancel });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onDiscard when the Discard button is clicked", () => {
    const onDiscard = vi.fn();
    renderDialog({ onDiscard });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when the Cancel button is clicked", () => {
    const onCancel = vi.fn();
    renderDialog({ onCancel });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("DiscardChangesDialog — singular vs plural", () => {
  it("uses singular 'change' for count=1", () => {
    renderDialog({ count: 1, action: "close" });
    expect(screen.getByText("Discard 1 change?")).toBeInTheDocument();
  });

  it("uses plural 'changes' for count=0", () => {
    renderDialog({ count: 0, action: "close" });
    expect(screen.getByText("Discard 0 changes?")).toBeInTheDocument();
  });

  it("uses plural 'changes' for count=5", () => {
    renderDialog({ count: 5, action: "close" });
    expect(screen.getByText("Discard 5 changes?")).toBeInTheDocument();
  });
});
