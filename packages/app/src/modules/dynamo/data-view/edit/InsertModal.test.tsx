/**
 * InsertModal.test.tsx — task 8.9
 *
 * Tests for the InsertModal component.
 *
 * Coverage:
 *   - Form validation: Confirm disabled when key fields empty; inline messages.
 *   - Paste-JSON validation: untagged value → tag error visible; Confirm disabled.
 *   - Default condition: Allow overwrite OFF → condition_expression sent.
 *   - Allow overwrite ON → condition_expression null.
 *   - Success refresh: onSuccess + onClose called on success.
 *   - Conflict UI: ConditionalCheckFailedException shows inline error + highlights Allow-overwrite.
 *
 * Also includes unit tests for pure helpers: buildFormItem, parseJsonDraft.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { AttributeMap } from "../types";
import type { TableDescription } from "@/modules/dynamo/tables/types";
import { buildFormItem, parseJsonDraft } from "./InsertModal";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockPutItem, mockToastShow } = vi.hoisted(() => ({
  mockPutItem: vi.fn(),
  mockToastShow: vi.fn(),
}));

vi.mock("../api", () => ({
  dynamoPutItem: (...args: unknown[]) => mockPutItem(...args),
  dynamoUpdateItem: vi.fn(),
  dynamoScan: vi.fn(),
  dynamoQuery: vi.fn(),
  dynamoCountItems: vi.fn(),
  dynamoDeleteItem: vi.fn(),
}));

vi.mock("@/platform/toast", () => ({
  useToast: () => ({ show: mockToastShow }),
}));

// Mock CodeMirror to avoid jsdom issues
vi.mock("@codemirror/view", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codemirror/view")>();
  return {
    ...actual,
    EditorView: class MockEditorView {
      static editable = actual.EditorView.editable;
      static lineWrapping = actual.EditorView.lineWrapping;
      static theme = vi.fn().mockReturnValue([]);
      static updateListener = actual.EditorView.updateListener;
      state: { doc: { toString: () => string } };
      destroy: () => void;
      dispatch: () => void;
      constructor() {
        this.state = { doc: { toString: () => "{}" } };
        this.destroy = vi.fn();
        this.dispatch = vi.fn();
      }
    },
    keymap: { of: vi.fn().mockReturnValue([]) },
  };
});

vi.mock("@codemirror/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codemirror/state")>();
  return {
    ...actual,
    EditorState: {
      ...actual.EditorState,
      create: vi.fn().mockReturnValue({
        doc: { toString: () => "{}", length: 2 },
      }),
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDescribe(pk = "pk", sk: string | null = null): TableDescription {
  return {
    table_name: "events",
    table_arn: "",
    table_status: "ACTIVE",
    item_count: 0,
    table_size_bytes: 0,
    billing_mode: "PAY_PER_REQUEST",
    key_schema: [
      { attribute_name: pk, key_type: "HASH" },
      ...(sk ? [{ attribute_name: sk, key_type: "RANGE" as const }] : []),
    ],
    attribute_definitions: [
      { attribute_name: pk, attribute_type: "S" },
      ...(sk ? [{ attribute_name: sk, attribute_type: "S" as const }] : []),
    ],
    global_secondary_indexes: [],
    local_secondary_indexes: [],
  };
}

const defaultProps = {
  open: true,
  describe: makeDescribe("pk", "sk"),
  indexName: null,
  connectionId: "conn-1",
  tableName: "events",
  onClose: vi.fn(),
  onSuccess: vi.fn(),
};

async function importModal() {
  const { InsertModal } = await import("./InsertModal");
  return InsertModal;
}

// ---------------------------------------------------------------------------
// Unit tests: buildFormItem
// ---------------------------------------------------------------------------

describe("buildFormItem", () => {
  it("returns null when a key field is empty", () => {
    const result = buildFormItem(
      [
        { name: "pk", type: "S", value: "" },
        { name: "sk", type: "S", value: "e1" },
      ],
      [],
    );
    expect(result).toBeNull();
  });

  it("returns item when all key fields are filled", () => {
    const result = buildFormItem(
      [
        { name: "pk", type: "S", value: "u1" },
        { name: "sk", type: "S", value: "e1" },
      ],
      [],
    );
    expect(result).toEqual({ pk: { S: "u1" }, sk: { S: "e1" } });
  });

  it("includes N-typed key as { N: value }", () => {
    const result = buildFormItem(
      [{ name: "count", type: "N", value: "42" }],
      [],
    );
    expect(result).toEqual({ count: { N: "42" } });
  });

  it("includes extra S attr", () => {
    const result = buildFormItem(
      [{ name: "pk", type: "S", value: "u1" }],
      [{ id: "1", name: "status", type: "S", value: "ok", boolValue: false }],
    );
    expect(result).toEqual({ pk: { S: "u1" }, status: { S: "ok" } });
  });

  it("includes extra BOOL attr", () => {
    const result = buildFormItem(
      [{ name: "pk", type: "S", value: "u1" }],
      [{ id: "1", name: "active", type: "BOOL", value: "", boolValue: true }],
    );
    expect(result).toEqual({ pk: { S: "u1" }, active: { BOOL: true } });
  });

  it("includes extra NULL attr", () => {
    const result = buildFormItem(
      [{ name: "pk", type: "S", value: "u1" }],
      [{ id: "1", name: "deleted", type: "NULL", value: "", boolValue: false }],
    );
    expect(result).toEqual({ pk: { S: "u1" }, deleted: { NULL: true } });
  });

  it("returns null when extra attr name is empty", () => {
    const result = buildFormItem(
      [{ name: "pk", type: "S", value: "u1" }],
      [{ id: "1", name: "", type: "S", value: "val", boolValue: false }],
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit tests: parseJsonDraft
// ---------------------------------------------------------------------------

describe("parseJsonDraft", () => {
  it("returns error on invalid JSON", () => {
    const result = parseJsonDraft("NOT JSON", ["pk"]);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/Invalid JSON/i);
    }
  });

  it("returns error on array input", () => {
    const result = parseJsonDraft("[]", ["pk"]);
    expect("error" in result).toBe(true);
  });

  it("returns error on untagged value", () => {
    const draft = JSON.stringify({ pk: { S: "u1" }, status: "ok" });
    const result = parseJsonDraft(draft, ["pk"]);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/Untagged value/i);
    }
  });

  it("returns error on missing required key", () => {
    const draft = JSON.stringify({ pk: { S: "u1" } });
    const result = parseJsonDraft(draft, ["pk", "sk"]);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/Missing key: sk/);
    }
  });

  it("returns item on valid tagged JSON with all keys", () => {
    const item: AttributeMap = { pk: { S: "u1" }, sk: { S: "e1" }, status: { S: "ok" } };
    const result = parseJsonDraft(JSON.stringify(item), ["pk", "sk"]);
    expect("item" in result).toBe(true);
    if ("item" in result) {
      expect(result.item).toEqual(item);
    }
  });
});

// ---------------------------------------------------------------------------
// Component tests
// ---------------------------------------------------------------------------

describe("InsertModal — form validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Confirm button is disabled when key fields are empty", async () => {
    const InsertModal = await importModal();
    render(<InsertModal {...defaultProps} />);

    const confirmBtn = screen.getByTestId("insert-confirm-btn") as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });

  it("shows inline error messages for empty key fields", async () => {
    const InsertModal = await importModal();
    render(<InsertModal {...defaultProps} />);

    // Both pk and sk are empty — show error messages
    expect(screen.getByTestId("key-error-pk")).toBeTruthy();
    expect(screen.getByTestId("key-error-sk")).toBeTruthy();
  });

  it("Confirm enabled after filling key fields", async () => {
    const InsertModal = await importModal();
    render(<InsertModal {...defaultProps} />);

    const pkInput = screen.getByTestId("key-input-pk");
    const skInput = screen.getByTestId("key-input-sk");
    fireEvent.change(pkInput, { target: { value: "user-1" } });
    fireEvent.change(skInput, { target: { value: "evt-1" } });

    const confirmBtn = screen.getByTestId("insert-confirm-btn") as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);
  });
});

describe("InsertModal — paste-JSON validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows tag error for untagged value, Confirm disabled", async () => {
    const InsertModal = await importModal();
    // Provide a test JSON draft with untagged value
    const badDraft = JSON.stringify({ pk: { S: "u1" }, sk: { S: "e1" }, bad: "raw" });

    render(
      <InsertModal
        {...defaultProps}
        _testJsonDraft={badDraft}
      />,
    );

    // Switch to JSON tab
    fireEvent.click(screen.getByTestId("insert-tab-json"));

    // Validation error should appear
    const errEl = await screen.findByTestId("json-validation-error");
    expect(errEl.textContent).toMatch(/Untagged value/i);

    const confirmBtn = screen.getByTestId("insert-confirm-btn") as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });

  it("Confirm enabled for valid JSON with all keys", async () => {
    const InsertModal = await importModal();
    const goodDraft = JSON.stringify({
      pk: { S: "u1" },
      sk: { S: "e1" },
      status: { S: "ok" },
    });

    render(
      <InsertModal
        {...defaultProps}
        _testJsonDraft={goodDraft}
      />,
    );

    fireEvent.click(screen.getByTestId("insert-tab-json"));

    const confirmBtn = screen.getByTestId("insert-confirm-btn") as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);
  });
});

describe("InsertModal — default condition (Allow overwrite OFF)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dynamoPutItem called with attribute_not_exists condition when Allow overwrite is OFF", async () => {
    mockPutItem.mockResolvedValue({ attributes: null });

    const InsertModal = await importModal();
    const onSuccess = vi.fn();
    const onClose = vi.fn();

    render(
      <InsertModal
        {...defaultProps}
        onSuccess={onSuccess}
        onClose={onClose}
      />,
    );

    // Fill key fields
    fireEvent.change(screen.getByTestId("key-input-pk"), {
      target: { value: "user-1" },
    });
    fireEvent.change(screen.getByTestId("key-input-sk"), {
      target: { value: "evt-1" },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("insert-confirm-btn"));
    });

    expect(mockPutItem).toHaveBeenCalledWith(
      "conn-1",
      "events",
      expect.objectContaining({
        item: { pk: { S: "user-1" }, sk: { S: "evt-1" } },
        condition_expression: "attribute_not_exists(#n0)",
        expression_attribute_names: { "#n0": "pk" },
      }),
    );
  });
});

describe("InsertModal — allow overwrite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dynamoPutItem called without condition when Allow overwrite is ON", async () => {
    mockPutItem.mockResolvedValue({ attributes: null });

    const InsertModal = await importModal();
    const onSuccess = vi.fn();
    const onClose = vi.fn();

    render(
      <InsertModal
        {...defaultProps}
        onSuccess={onSuccess}
        onClose={onClose}
      />,
    );

    // Fill key fields
    fireEvent.change(screen.getByTestId("key-input-pk"), {
      target: { value: "user-1" },
    });
    fireEvent.change(screen.getByTestId("key-input-sk"), {
      target: { value: "evt-1" },
    });

    // Toggle Allow overwrite ON
    fireEvent.click(screen.getByTestId("allow-overwrite-checkbox"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("insert-confirm-btn"));
    });

    expect(mockPutItem).toHaveBeenCalledWith(
      "conn-1",
      "events",
      expect.objectContaining({
        condition_expression: null,
        expression_attribute_names: null,
      }),
    );
  });
});

describe("InsertModal — success refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("onSuccess and onClose called after successful insert", async () => {
    mockPutItem.mockResolvedValue({ attributes: null });

    const InsertModal = await importModal();
    const onSuccess = vi.fn();
    const onClose = vi.fn();

    render(
      <InsertModal
        {...defaultProps}
        onSuccess={onSuccess}
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByTestId("key-input-pk"), {
      target: { value: "user-1" },
    });
    fireEvent.change(screen.getByTestId("key-input-sk"), {
      target: { value: "evt-1" },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("insert-confirm-btn"));
    });

    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(mockToastShow).toHaveBeenCalledWith("Item inserted", "success");
  });
});

describe("InsertModal — ConditionalCheckFailed UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stays open with conflict message and highlights Allow-overwrite when ConditionalCheckFailedException", async () => {
    const { AppError } = await import("@/platform/errors/AppError");
    mockPutItem.mockRejectedValue(
      new AppError("Aws", "Conditional check failed", undefined, {
        code: "ConditionalCheckFailedException",
        message: "Condition check failed",
        retryable: false,
      }),
    );

    const InsertModal = await importModal();
    const onClose = vi.fn();
    const onSuccess = vi.fn();

    render(
      <InsertModal
        {...defaultProps}
        onClose={onClose}
        onSuccess={onSuccess}
      />,
    );

    fireEvent.change(screen.getByTestId("key-input-pk"), {
      target: { value: "user-1" },
    });
    fireEvent.change(screen.getByTestId("key-input-sk"), {
      target: { value: "evt-1" },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("insert-confirm-btn"));
    });

    // Modal stays open — onClose not called
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();

    // Inline error shown
    const errEl = screen.getByTestId("insert-error");
    expect(errEl).toBeTruthy();
    expect(errEl.textContent).toMatch(/already exists/i);

    // Allow overwrite label should have accent border styling (highlightAllowOverwrite=true)
    const allowOverwriteLabel = screen.getByTestId("allow-overwrite-label");
    expect(allowOverwriteLabel.style.border).toContain("var(--accent");
  });
});
