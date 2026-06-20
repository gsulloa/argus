/**
 * DataViewTab.refresh-guard.test.tsx — task 6.4 (refresh guard extension)
 *
 * Tests for the guardedRefresh / resetDrafts logic that was added to protect
 * the ⌘R (soft-refresh) and ⌘⇧R (hard-reset) paths when an unsaved draft
 * exists. Because DataViewContent requires the full platform/Tauri provider
 * tree we test the logic via a lightweight harness that replicates the
 * guardedRefresh + DiscardChangesDialog wiring in isolation.
 *
 * Coverage:
 *  - ⌘R with unsaved draft → shows "Discard changes?" dialog, no refresh yet.
 *  - Confirm → discards the draft and calls the refresh action.
 *  - Cancel → leaves draft intact, does NOT call the refresh action.
 *  - ⌘R with no draft → refreshes immediately, no dialog.
 *  - ⌘⇧R (hard-reset) with unsaved draft → same prompt behaviour.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState, useCallback } from "react";
import { DiscardChangesDialog } from "./edit/DiscardChangesDialog";
import { useUnsavedDraft } from "./edit/useUnsavedDraft";

// ---------------------------------------------------------------------------
// Minimal harness that replicates the guardedRefresh wiring from DataViewContent
// ---------------------------------------------------------------------------

type DiscardReason = "tab-close" | "tab-switch" | "row-change" | "refresh";

interface RefreshGuardHarnessProps {
  onRun?: () => void;
  onReset?: () => void;
}

function RefreshGuardHarness({
  onRun = vi.fn(),
  onReset = vi.fn(),
}: RefreshGuardHarnessProps) {
  const {
    hasUnsavedDraft,
    setInlineCellDirty,
    setInspectorDirty,
    setInsertModalDirty,
  } = useUnsavedDraft();

  const [discardDialog, setDiscardDialog] = useState<{
    reason: DiscardReason;
    context: string;
    onConfirm: () => void;
  } | null>(null);

  // Mirror resetDrafts from DataViewContent
  const resetDrafts = useCallback(() => {
    setInspectorDirty(false);
    setInlineCellDirty(false);
    setInsertModalDirty(false);
  }, [setInspectorDirty, setInlineCellDirty, setInsertModalDirty]);

  // Mirror guardedRefresh from DataViewContent
  const guardedRefresh = useCallback(
    (doRefresh: () => void) => {
      if (!hasUnsavedDraft) {
        doRefresh();
        return;
      }
      setDiscardDialog({
        reason: "refresh",
        context: "refresh the table",
        onConfirm: () => {
          resetDrafts();
          setDiscardDialog(null);
          doRefresh();
        },
      });
    },
    [hasUnsavedDraft, resetDrafts],
  );

  return (
    <div>
      {/* Controls to inject draft state */}
      <button
        data-testid="make-inline-dirty"
        onClick={() => setInlineCellDirty(true)}
      >
        Make inline dirty
      </button>
      <button
        data-testid="make-inspector-dirty"
        onClick={() => setInspectorDirty(true)}
      >
        Make inspector dirty
      </button>

      {/* Simulate toolbar Run / Reset buttons */}
      <button
        data-testid="toolbar-run"
        onClick={() => guardedRefresh(onRun)}
      >
        Run
      </button>
      <button
        data-testid="toolbar-reset"
        onClick={() => guardedRefresh(onReset)}
      >
        Reset
      </button>

      {/* Draft status indicator */}
      <span data-testid="has-draft">{hasUnsavedDraft ? "dirty" : "clean"}</span>

      {/* Discard dialog — mirrors DataViewContent wiring */}
      {discardDialog && (
        <DiscardChangesDialog
          context={discardDialog.context}
          onDiscard={discardDialog.onConfirm}
          onCancel={() => {
            // "refresh" has no suspended promise — just close.
            setDiscardDialog(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("guardedRefresh — ⌘R with unsaved draft", () => {
  it("surfaces the Discard dialog and does NOT call onRun yet", () => {
    const onRun = vi.fn();
    render(<RefreshGuardHarness onRun={onRun} />);

    // Inject a draft
    fireEvent.click(screen.getByTestId("make-inline-dirty"));
    expect(screen.getByTestId("has-draft").textContent).toBe("dirty");

    // Click Run (⌘R equivalent)
    fireEvent.click(screen.getByTestId("toolbar-run"));

    // Dialog should appear with the refresh context
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText(/refresh the table/)).toBeTruthy();

    // onRun must NOT have been called yet
    expect(onRun).not.toHaveBeenCalled();
  });
});

describe("guardedRefresh — confirm discards draft and calls onRun", () => {
  it("clicking Discard clears draft state and calls onRun", () => {
    const onRun = vi.fn();
    render(<RefreshGuardHarness onRun={onRun} />);

    // Inject a draft and open dialog
    fireEvent.click(screen.getByTestId("make-inline-dirty"));
    fireEvent.click(screen.getByTestId("toolbar-run"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    // Confirm discard
    fireEvent.click(screen.getByTestId("discard-confirm-btn"));

    // Dialog should be gone
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // onRun should have been called once
    expect(onRun).toHaveBeenCalledOnce();

    // Draft should be cleared
    expect(screen.getByTestId("has-draft").textContent).toBe("clean");
  });
});

describe("guardedRefresh — cancel leaves draft intact and does NOT call onRun", () => {
  it("clicking Cancel dismisses dialog without refreshing or clearing draft", () => {
    const onRun = vi.fn();
    render(<RefreshGuardHarness onRun={onRun} />);

    // Inject a draft and open dialog
    fireEvent.click(screen.getByTestId("make-inline-dirty"));
    fireEvent.click(screen.getByTestId("toolbar-run"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    // Cancel
    fireEvent.click(screen.getByTestId("discard-cancel-btn"));

    // Dialog dismissed
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // onRun must NOT have been called
    expect(onRun).not.toHaveBeenCalled();

    // Draft must still be dirty
    expect(screen.getByTestId("has-draft").textContent).toBe("dirty");
  });
});

describe("guardedRefresh — no draft refreshes immediately, no dialog", () => {
  it("calls onRun immediately when no draft exists", () => {
    const onRun = vi.fn();
    render(<RefreshGuardHarness onRun={onRun} />);

    // No draft injected
    expect(screen.getByTestId("has-draft").textContent).toBe("clean");

    fireEvent.click(screen.getByTestId("toolbar-run"));

    // No dialog
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // onRun called immediately
    expect(onRun).toHaveBeenCalledOnce();
  });
});

describe("guardedRefresh — ⌘⇧R (hard-reset) with unsaved draft also prompts", () => {
  it("shows Discard dialog for reset action and calls onReset on confirm", () => {
    const onReset = vi.fn();
    render(<RefreshGuardHarness onReset={onReset} />);

    // Inject a draft (inspector)
    fireEvent.click(screen.getByTestId("make-inspector-dirty"));
    expect(screen.getByTestId("has-draft").textContent).toBe("dirty");

    // Click Reset (⌘⇧R equivalent)
    fireEvent.click(screen.getByTestId("toolbar-reset"));

    // Dialog shown
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText(/refresh the table/)).toBeTruthy();
    expect(onReset).not.toHaveBeenCalled();

    // Confirm
    fireEvent.click(screen.getByTestId("discard-confirm-btn"));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onReset).toHaveBeenCalledOnce();
    expect(screen.getByTestId("has-draft").textContent).toBe("clean");
  });
});
