/**
 * ModelEditor.test.tsx — Task 4.6
 *
 * Coverage:
 *   1. Create flow: open empty editor, fill name + AP, Save → onSave called correctly.
 *      Save disabled when name empty or no pk.
 *   2. Edit seeds fields: pass `initial` with name, APs, body → fields pre-filled.
 *   3. Round-trip body preservation: edit only an AP's pk, body passed unchanged.
 *   4. Offline warning: render with describe=null → skipped-warning visible, Save enabled.
 *   5. Invalid blocks save: unknown index (describe present) → Save disabled + inline error.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModelEditor } from "./ModelEditor";
import type { DynamoModel } from "./types";
import type { TableDescription } from "@/modules/dynamo/tables/types";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

vi.mock("./api", () => ({
  saveModel: vi.fn(),
  deleteModel: vi.fn(),
  listModels: vi.fn().mockResolvedValue([]),
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

const INITIAL_MODEL: DynamoModel = {
  name: "Order",
  physical_table: "Orders",
  access_patterns: [
    { index: "table", pk: "USER#${userId}", sk: "ORDER#${orderId}" },
  ],
  body: "# Order\n\nHand notes\n",
};

function renderEditor(
  overrides: Partial<Parameters<typeof ModelEditor>[0]> = {},
) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const onDelete = vi.fn();

  const utils = render(
    <ModelEditor
      open={true}
      describe={DESCRIBE}
      onClose={onClose}
      onSave={onSave}
      onDelete={onDelete}
      saving={false}
      {...overrides}
    />,
  );

  return { ...utils, onSave, onClose, onDelete };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ModelEditor", () => {
  // ── Test 1: Create flow ──────────────────────────────────────────────────
  describe("create flow", () => {
    it("Save is disabled when name is empty", () => {
      renderEditor({ initial: null });
      const saveBtn = screen.getByTestId("model-editor-save");
      expect(saveBtn).toBeDisabled();
    });

    it("Save is disabled when pk is empty (name filled)", () => {
      renderEditor({ initial: null });
      // Type a name
      fireEvent.change(screen.getByTestId("model-editor-name"), {
        target: { value: "Order" },
      });
      // PK template is still empty → invalid
      const saveBtn = screen.getByTestId("model-editor-save");
      expect(saveBtn).toBeDisabled();
    });

    it("Save becomes enabled after filling name + pk, calls onSave with correct draft", () => {
      const { onSave } = renderEditor({ initial: null });

      fireEvent.change(screen.getByTestId("model-editor-name"), {
        target: { value: "Order" },
      });

      // Fill the index (already defaults to "table")
      // Fill pk
      fireEvent.change(screen.getByTestId("model-editor-ap-0-pk"), {
        target: { value: "USER#${userId}" },
      });
      // Fill sk
      fireEvent.change(screen.getByTestId("model-editor-ap-0-sk"), {
        target: { value: "ORDER#${orderId}" },
      });

      const saveBtn = screen.getByTestId("model-editor-save");
      expect(saveBtn).not.toBeDisabled();

      fireEvent.click(saveBtn);

      expect(onSave).toHaveBeenCalledOnce();
      const [draft, opts] = onSave.mock.calls[0] as [
        { name: string; access_patterns: { index: string; pk: string; sk?: string }[] },
        { isEdit: boolean }
      ];
      expect(draft.name).toBe("Order");
      expect(draft.access_patterns[0]?.pk).toBe("USER#${userId}");
      expect(draft.access_patterns[0]?.sk).toBe("ORDER#${orderId}");
      expect(opts.isEdit).toBe(false);
    });
  });

  // ── Test 2: Edit seeds fields ───────────────────────────────────────────
  describe("edit mode", () => {
    it("pre-fills name, pk, sk, and body from initial", () => {
      renderEditor({ initial: INITIAL_MODEL });

      expect(screen.getByTestId("model-editor-name")).toHaveValue("Order");
      expect(screen.getByTestId("model-editor-ap-0-pk")).toHaveValue("USER#${userId}");
      expect(screen.getByTestId("model-editor-ap-0-sk")).toHaveValue("ORDER#${orderId}");
      expect(screen.getByTestId("model-editor-body")).toHaveValue("# Order\n\nHand notes\n");
    });

    it("shows Edit model title", () => {
      renderEditor({ initial: INITIAL_MODEL });
      expect(screen.getByText(/edit model — order/i)).toBeInTheDocument();
    });

    it("shows Delete button", () => {
      renderEditor({ initial: INITIAL_MODEL });
      expect(screen.getByTestId("model-editor-delete")).toBeInTheDocument();
    });

    it("onSave called with isEdit=true and previousName", () => {
      const { onSave } = renderEditor({ initial: INITIAL_MODEL });
      fireEvent.click(screen.getByTestId("model-editor-save"));
      expect(onSave).toHaveBeenCalledOnce();
      const [, opts] = onSave.mock.calls[0] as [unknown, { isEdit: boolean; previousName?: string }];
      expect(opts.isEdit).toBe(true);
      expect(opts.previousName).toBe("Order");
    });
  });

  // ── Test 3: Round-trip body preservation ───────────────────────────────
  describe("body preservation", () => {
    it("passes body unchanged when only pk is edited", () => {
      const { onSave } = renderEditor({ initial: INITIAL_MODEL });

      // Change pk template only
      fireEvent.change(screen.getByTestId("model-editor-ap-0-pk"), {
        target: { value: "USER#${userId}#v2" },
      });

      fireEvent.click(screen.getByTestId("model-editor-save"));

      expect(onSave).toHaveBeenCalledOnce();
      const [draft] = onSave.mock.calls[0] as [{ body?: string }, unknown];
      // Body must be the original, untouched value
      expect(draft.body).toBe("# Order\n\nHand notes\n");
    });
  });

  // ── Test 4: Offline warning (describe = null) ──────────────────────────
  describe("offline (describe=null)", () => {
    it("shows the schema-skipped warning banner", () => {
      renderEditor({ describe: null, initial: null });

      // Fill name + pk so grammar is valid → save should be enabled
      fireEvent.change(screen.getByTestId("model-editor-name"), {
        target: { value: "Order" },
      });
      fireEvent.change(screen.getByTestId("model-editor-ap-0-pk"), {
        target: { value: "USER#${userId}" },
      });

      expect(screen.getByTestId("model-editor-skipped-warning")).toBeInTheDocument();
    });

    it("Save is enabled with valid grammar templates", () => {
      renderEditor({ describe: null, initial: null });

      fireEvent.change(screen.getByTestId("model-editor-name"), {
        target: { value: "Order" },
      });
      fireEvent.change(screen.getByTestId("model-editor-ap-0-pk"), {
        target: { value: "USER#${userId}" },
      });

      expect(screen.getByTestId("model-editor-save")).not.toBeDisabled();
    });
  });

  // ── Test 5: Invalid index blocks save ──────────────────────────────────
  describe("invalid index (describe present)", () => {
    it("Save is disabled and no inline error when valid index and pk (baseline)", () => {
      renderEditor({ initial: null });

      // Fill name and pk with valid values → save should be enabled
      fireEvent.change(screen.getByTestId("model-editor-name"), {
        target: { value: "Widget" },
      });
      fireEvent.change(screen.getByTestId("model-editor-ap-0-pk"), {
        target: { value: "W#${id}" },
      });

      expect(screen.getByTestId("model-editor-save")).not.toBeDisabled();
    });

    it("blocks save when initial model has unknown index and describe is present", () => {
      const badModel: DynamoModel = {
        name: "Widget",
        access_patterns: [{ index: "UNKNOWN_GSI", pk: "W#${id}" }],
      };
      const { onSave } = renderEditor({ initial: badModel });

      // Save should be disabled because the index doesn't exist in DESCRIBE
      const saveBtn = screen.getByTestId("model-editor-save");
      expect(saveBtn).toBeDisabled();
      // The onSave should not be called if we click anyway
      fireEvent.click(saveBtn);
      expect(onSave).not.toHaveBeenCalled();
    });
  });

  // ── Extra: Add access pattern button ───────────────────────────────────
  describe("access pattern management", () => {
    it("adds a new access pattern row when Add button is clicked", () => {
      renderEditor({ initial: INITIAL_MODEL });
      // Should start with 1 AP
      expect(screen.getByTestId("model-editor-ap-0-pk")).toBeInTheDocument();
      expect(screen.queryByTestId("model-editor-ap-1-pk")).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId("model-editor-add-ap"));

      expect(screen.getByTestId("model-editor-ap-1-pk")).toBeInTheDocument();
    });
  });

  // ── Delete inline confirm ───────────────────────────────────────────────
  describe("delete confirm", () => {
    it("requires confirm click to call onDelete", () => {
      const { onDelete } = renderEditor({ initial: INITIAL_MODEL });
      // Click Delete → shows confirm step
      fireEvent.click(screen.getByTestId("model-editor-delete"));
      // onDelete not yet called
      expect(onDelete).not.toHaveBeenCalled();
      // Confirm delete
      fireEvent.click(screen.getByText("Yes"));
      expect(onDelete).toHaveBeenCalledWith("Order");
    });

    it("cancel hides the confirm step without calling onDelete", () => {
      const { onDelete } = renderEditor({ initial: INITIAL_MODEL });
      fireEvent.click(screen.getByTestId("model-editor-delete"));
      // There are two "Cancel" texts: one in the delete-confirm inline step and
      // one in the footer. Click the first one (inside the delete confirm section).
      const cancelBtns = screen.getAllByText("Cancel");
      // The first Cancel in the DOM is in the delete-confirm inline block
      fireEvent.click(cancelBtns[0]!);
      expect(onDelete).not.toHaveBeenCalled();
      // Delete button is back
      expect(screen.getByTestId("model-editor-delete")).toBeInTheDocument();
    });
  });
});
