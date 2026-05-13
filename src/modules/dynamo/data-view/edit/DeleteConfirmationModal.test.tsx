/**
 * DeleteConfirmationModal.test.tsx — task 9.6
 *
 * Coverage:
 *   - Confirmation phase lists all rows' key labels.
 *   - Sequential dispatch: 3 rows → dynamoDeleteItem called 3 times, in order.
 *   - Partial failure: row[1] rejects → "2 of 3 deleted" summary + per-row error.
 *   - Escape during flight is a no-op (modal stays open).
 *   - All 3 succeed → onComplete([rowIndex0, rowIndex1, rowIndex2]).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { DeleteConfirmationModal, type DeleteRow } from "./DeleteConfirmationModal";
import { AppError } from "@/platform/errors/AppError";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockDeleteItem } = vi.hoisted(() => ({
  mockDeleteItem: vi.fn(),
}));

vi.mock("../api", () => ({
  dynamoDeleteItem: (...args: unknown[]) => mockDeleteItem(...args),
  dynamoPutItem: vi.fn(),
  dynamoUpdateItem: vi.fn(),
  dynamoScan: vi.fn(),
  dynamoQuery: vi.fn(),
  dynamoCountItems: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRows(n: number): DeleteRow[] {
  return Array.from({ length: n }, (_, i) => ({
    rowIndex: i,
    key: { pk: { S: `user-${i}` }, sk: { S: `evt-${i}` } },
    label: `pk=user-${i}, sk=evt-${i}`,
  }));
}

function renderModal(
  rows: DeleteRow[],
  {
    onClose = vi.fn(),
    onComplete = vi.fn(),
  }: { onClose?: () => void; onComplete?: (indices: number[]) => void } = {},
) {
  return render(
    <DeleteConfirmationModal
      open={true}
      rows={rows}
      connectionId="conn-1"
      tableName="my-table"
      onClose={onClose}
      onComplete={onComplete}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DeleteConfirmationModal — confirm phase", () => {
  beforeEach(() => {
    mockDeleteItem.mockReset();
  });

  it("lists all rows' key labels in the confirmation phase", () => {
    const rows = makeRows(3);
    renderModal(rows);

    expect(screen.getByText("Delete 3 items?")).toBeTruthy();

    const labels = screen.getAllByTestId("delete-row-label");
    expect(labels).toHaveLength(3);
    expect(labels[0]?.textContent).toContain("pk=user-0, sk=evt-0");
    expect(labels[1]?.textContent).toContain("pk=user-1, sk=evt-1");
    expect(labels[2]?.textContent).toContain("pk=user-2, sk=evt-2");
  });

  it("shows Cancel and Delete N items buttons", () => {
    renderModal(makeRows(2));
    expect(screen.getByTestId("delete-cancel-btn")).toBeTruthy();
    expect(screen.getByTestId("delete-confirm-btn")).toBeTruthy();
    expect(screen.getByTestId("delete-confirm-btn").textContent).toContain("Delete 2 items");
  });

  it("Cancel calls onClose", () => {
    const onClose = vi.fn();
    renderModal(makeRows(2), { onClose });
    fireEvent.click(screen.getByTestId("delete-cancel-btn"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape calls onClose in confirm phase", () => {
    const onClose = vi.fn();
    renderModal(makeRows(2), { onClose });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("DeleteConfirmationModal — sequential dispatch (all succeed)", () => {
  beforeEach(() => {
    mockDeleteItem.mockReset();
  });

  it("calls dynamoDeleteItem 3 times in order and fires onComplete with all rowIndices", async () => {
    // Each call resolves immediately; we track call order
    const callOrder: string[] = [];
    mockDeleteItem.mockImplementation(
      (_conn: string, _table: string, req: { key: { pk: { S: string } } }) => {
        callOrder.push(req.key.pk.S);
        return Promise.resolve({ attributes: null, consumed_capacity: null });
      },
    );

    const rows = makeRows(3);
    const onComplete = vi.fn();
    renderModal(rows, { onComplete });

    await act(async () => {
      fireEvent.click(screen.getByTestId("delete-confirm-btn"));
    });

    // Wait for done phase
    await waitFor(() => screen.getByTestId("delete-close-btn"));

    // Called exactly 3 times
    expect(mockDeleteItem).toHaveBeenCalledTimes(3);

    // Calls were in order
    expect(callOrder).toEqual(["user-0", "user-1", "user-2"]);

    // onComplete called with all rowIndices
    expect(onComplete).toHaveBeenCalledWith([0, 1, 2]);

    // Summary shows 3 of 3
    expect(screen.getByText("3 of 3 deleted")).toBeTruthy();
  });
});

describe("DeleteConfirmationModal — partial failure", () => {
  beforeEach(() => {
    mockDeleteItem.mockReset();
  });

  it("row[1] fails → 2 of 3 deleted summary + per-row error for row 1", async () => {
    mockDeleteItem
      .mockResolvedValueOnce({ attributes: null, consumed_capacity: null }) // row 0 ok
      .mockRejectedValueOnce(
        new AppError("Aws", "Provisioned throughput exceeded", undefined, {
          code: "ProvisionedThroughputExceededException",
          message: "Provisioned throughput exceeded",
          retryable: true,
        }),
      ) // row 1 fail
      .mockResolvedValueOnce({ attributes: null, consumed_capacity: null }); // row 2 ok

    const rows = makeRows(3);
    const onComplete = vi.fn();
    renderModal(rows, { onComplete });

    await act(async () => {
      fireEvent.click(screen.getByTestId("delete-confirm-btn"));
    });

    await waitFor(() => screen.getByTestId("delete-close-btn"));

    // Summary
    expect(screen.getByText("2 of 3 deleted")).toBeTruthy();

    // onComplete called with rowIndices 0 and 2 (not 1)
    expect(onComplete).toHaveBeenCalledWith([0, 2]);

    // Per-row error for row 1
    const errorMsgs = screen.getAllByTestId("row-error-msg");
    expect(errorMsgs).toHaveLength(1);
    expect(errorMsgs[0]?.textContent).toContain("ProvisionedThroughputExceededException");
    expect(errorMsgs[0]?.textContent).toContain("Provisioned throughput exceeded");
  });
});

describe("DeleteConfirmationModal — Escape during flight", () => {
  beforeEach(() => {
    mockDeleteItem.mockReset();
  });

  it("Escape is a no-op while sequential dispatch is running", async () => {
    // Use a deferred promise so dispatch stays in flight
    let resolveRow0!: () => void;
    const row0Promise = new Promise<{ attributes: null; consumed_capacity: null }>(
      (res) => {
        resolveRow0 = () => res({ attributes: null, consumed_capacity: null });
      },
    );
    mockDeleteItem.mockReturnValueOnce(row0Promise);

    const onClose = vi.fn();
    const rows = makeRows(1);
    renderModal(rows, { onClose });

    // Start the flight
    act(() => {
      fireEvent.click(screen.getByTestId("delete-confirm-btn"));
    });

    // Fire Escape while in flight
    fireEvent.keyDown(window, { key: "Escape" });

    // onClose should NOT have been called
    expect(onClose).not.toHaveBeenCalled();

    // Resolve the dispatch so the component doesn't hang
    await act(async () => {
      resolveRow0();
    });

    await waitFor(() => screen.getByTestId("delete-close-btn"));
  });
});

describe("DeleteConfirmationModal — done phase", () => {
  beforeEach(() => {
    mockDeleteItem.mockReset();
  });

  it("Close button calls onClose after all dispatches finish", async () => {
    mockDeleteItem.mockResolvedValue({ attributes: null, consumed_capacity: null });

    const onClose = vi.fn();
    renderModal(makeRows(2), { onClose });

    await act(async () => {
      fireEvent.click(screen.getByTestId("delete-confirm-btn"));
    });

    await waitFor(() => screen.getByTestId("delete-close-btn"));

    fireEvent.click(screen.getByTestId("delete-close-btn"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
