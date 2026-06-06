/**
 * InspectorReview.test.tsx
 *
 * Coverage:
 *   1. A streamed proposal renders with its name and provenance text.
 *   2. Accepting a VALID proposal calls onAccept with { name, access_patterns, body }
 *      (no AI metadata fields).
 *   3. A proposal that fails validation has its Save button disabled and shows
 *      the validation error.
 *   4. Discard calls onDiscard with the name.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InspectorReview } from "./InspectorReview";
import type { InspectedModel } from "./types";
import type { TableDescription } from "@/modules/dynamo/tables/types";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

vi.mock("./api", () => ({
  saveModel: vi.fn(),
  deleteModel: vi.fn(),
  listModels: vi.fn().mockResolvedValue([]),
  inspectModels: vi.fn(),
  getProjectSource: vi.fn().mockResolvedValue(null),
  setProjectSource: vi.fn(),
  dynamoPutItem: vi.fn(),
  dynamoUpdateItem: vi.fn(),
  dynamoScan: vi.fn(),
  dynamoQuery: vi.fn(),
  dynamoCountItems: vi.fn(),
  dynamoDeleteItem: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DESCRIBE: TableDescription = {
  table_name: "Orders",
  table_arn: "",
  table_status: "ACTIVE",
  item_count: 0,
  table_size_bytes: 0,
  billing_mode: "PAY_PER_REQUEST",
  key_schema: [
    { attribute_name: "pk", key_type: "HASH" },
    { attribute_name: "sk", key_type: "RANGE" },
  ],
  attribute_definitions: [
    { attribute_name: "pk", attribute_type: "S" },
    { attribute_name: "sk", attribute_type: "S" },
  ],
  global_secondary_indexes: [],
  local_secondary_indexes: [],
};

const VALID_PROPOSAL: InspectedModel = {
  name: "Order",
  access_patterns: [
    { index: "table", pk: "USER#${userId}", sk: "ORDER#${orderId}" },
  ],
  body: "# Order\n\nAI-generated notes.",
  confidence: 0.85,
  provenance: [
    { file: "src/models/order.ts", lines: "12-45", reason: "EntityModel class detected" },
  ],
  warnings: [],
};

const INVALID_PROPOSAL: InspectedModel = {
  name: "BadModel",
  access_patterns: [
    { index: "NONEXISTENT_GSI", pk: "X#${id}" },
  ],
  body: null,
  confidence: 0.3,
  provenance: [
    { file: "src/models/bad.ts", lines: null, reason: "Partial match" },
  ],
  warnings: ["Index NONEXISTENT_GSI does not exist on the table"],
};

function renderReview(
  overrides: Partial<Parameters<typeof InspectorReview>[0]> = {},
) {
  const onClose = vi.fn();
  const onEdit = vi.fn();
  const onAccept = vi.fn().mockResolvedValue(undefined);
  const onDiscard = vi.fn();

  const utils = render(
    <InspectorReview
      open={true}
      describe={DESCRIBE}
      status="done"
      statusMessage={null}
      proposals={[VALID_PROPOSAL]}
      error={null}
      existingNames={[]}
      saving={false}
      onClose={onClose}
      onEdit={onEdit}
      onAccept={onAccept}
      onDiscard={onDiscard}
      {...overrides}
    />,
  );

  return { ...utils, onClose, onEdit, onAccept, onDiscard };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InspectorReview", () => {
  // ── Test 1: Proposal renders with name and provenance ───────────────────
  describe("rendering a proposal", () => {
    it("renders the proposal name", () => {
      renderReview();
      expect(screen.getByTestId("proposal-name-Order")).toBeInTheDocument();
      expect(screen.getByTestId("proposal-name-Order")).toHaveTextContent("Order");
    });

    it("renders provenance file and lines", () => {
      renderReview();
      const prov = screen.getByTestId("proposal-provenance-Order-0");
      expect(prov).toBeInTheDocument();
      expect(prov).toHaveTextContent("src/models/order.ts");
      expect(prov).toHaveTextContent("12-45");
      expect(prov).toHaveTextContent("EntityModel class detected");
    });

    it("renders a confidence badge", () => {
      renderReview();
      const badge = screen.getByTestId("proposal-confidence-Order");
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveTextContent("85%");
    });

    it("renders a valid badge for a valid proposal", () => {
      renderReview();
      expect(screen.getByTestId("proposal-valid-badge-Order")).toHaveTextContent("Valid");
    });
  });

  // ── Test 2: Accepting a valid proposal calls onAccept with clean draft ──
  describe("accepting a valid proposal", () => {
    it("calls onAccept with { name, access_patterns, body } — no AI metadata", async () => {
      const { onAccept } = renderReview();
      const saveBtn = screen.getByTestId("proposal-save-Order");
      expect(saveBtn).not.toBeDisabled();

      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(onAccept).toHaveBeenCalledOnce();
      });

      const [draft] = onAccept.mock.calls[0] as [{ name: string; access_patterns: unknown; body: unknown }];
      expect(draft.name).toBe("Order");
      expect(draft.access_patterns).toEqual(VALID_PROPOSAL.access_patterns);
      expect(draft.body).toBe("# Order\n\nAI-generated notes.");

      // AI metadata must NOT be present on the draft
      expect((draft as Record<string, unknown>).confidence).toBeUndefined();
      expect((draft as Record<string, unknown>).provenance).toBeUndefined();
      expect((draft as Record<string, unknown>).warnings).toBeUndefined();
    });
  });

  // ── Test 3: Invalid proposal → Save disabled + validation error shown ───
  describe("invalid proposal", () => {
    it("Save button is disabled when validation fails", () => {
      renderReview({
        proposals: [INVALID_PROPOSAL],
      });

      const saveBtn = screen.getByTestId("proposal-save-BadModel");
      expect(saveBtn).toBeDisabled();
    });

    it("shows a validation error for the invalid proposal", () => {
      renderReview({
        proposals: [INVALID_PROPOSAL],
      });

      const errorEl = screen.getByTestId("proposal-validation-error-BadModel");
      expect(errorEl).toBeInTheDocument();
      // Should mention the unknown index
      expect(errorEl).toHaveTextContent(/NONEXISTENT_GSI/i);
    });

    it("shows 'Invalid' badge for invalid proposal", () => {
      renderReview({ proposals: [INVALID_PROPOSAL] });
      expect(screen.getByTestId("proposal-valid-badge-BadModel")).toHaveTextContent("Invalid");
    });
  });

  // ── Test 4: Discard calls onDiscard with the name ──────────────────────
  describe("discarding a proposal", () => {
    it("calls onDiscard with the model name", () => {
      const { onDiscard } = renderReview();
      fireEvent.click(screen.getByTestId("proposal-discard-Order"));
      expect(onDiscard).toHaveBeenCalledOnce();
      expect(onDiscard).toHaveBeenCalledWith("Order");
    });
  });

  // ── Test 5: Edit button calls onEdit ────────────────────────────────────
  describe("editing a proposal", () => {
    it("calls onEdit with the full InspectedModel", () => {
      const { onEdit } = renderReview();
      fireEvent.click(screen.getByTestId("proposal-edit-Order"));
      expect(onEdit).toHaveBeenCalledOnce();
      expect(onEdit).toHaveBeenCalledWith(VALID_PROPOSAL);
    });
  });

  // ── Test 6: Running state shows spinner ──────────────────────────────────
  describe("running state", () => {
    it("shows spinner when status=running", () => {
      renderReview({ status: "running", proposals: [], statusMessage: "Reading repo…" });
      expect(screen.getByTestId("inspector-running")).toBeInTheDocument();
      expect(screen.getByText("Reading repo…")).toBeInTheDocument();
    });
  });

  // ── Test 7: Error state shows error banner ───────────────────────────────
  describe("error state", () => {
    it("shows error message when status=error", () => {
      renderReview({
        status: "error",
        proposals: [],
        error: "Something went wrong",
      });
      expect(screen.getByTestId("inspector-error")).toBeInTheDocument();
      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    });
  });

  // ── Test 8: Multiple proposals rendered together ──────────────────────────
  describe("multiple proposals", () => {
    it("renders both proposals when provided", () => {
      renderReview({
        proposals: [VALID_PROPOSAL, INVALID_PROPOSAL],
      });
      expect(screen.getByTestId("proposal-name-Order")).toBeInTheDocument();
      expect(screen.getByTestId("proposal-name-BadModel")).toBeInTheDocument();
    });
  });
});
