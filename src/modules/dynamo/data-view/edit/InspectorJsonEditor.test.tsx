/**
 * InspectorJsonEditor.test.tsx — task 7.6
 *
 * Tests for the Inspector JSON editor. Strategy:
 *   1. Unit-test the pure `computeSaveAction` helper directly (no DOM needed).
 *   2. Integration-test the component with mocked CodeMirror + API.
 *
 * Required cases:
 *   - Parse failure → error, no AWS call.
 *   - Untagged value → tag error, no AWS call.
 *   - Key change → key error, no AWS call.
 *   - Diff path → dynamoUpdateItem called with correct diff.
 *   - Replace path → dynamoPutItem called.
 *   - ConditionalCheckFailed → Reload row button appears.
 *   - Reload row → dynamoQuery called, originalItem updated, draft preserved.
 *   - No-change Save → "No changes" toast, no AWS call, onClose called.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { AttributeMap } from "../types";
import { computeSaveAction, extractKey, buildKeyConditionPlaceholders } from "./InspectorJsonEditor";

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const { mockUpdateItem, mockPutItem, mockQuery, mockToastShow } = vi.hoisted(() => {
  return {
    mockUpdateItem: vi.fn(),
    mockPutItem: vi.fn(),
    mockQuery: vi.fn(),
    mockToastShow: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Mock API module
// ---------------------------------------------------------------------------

vi.mock("../api", () => ({
  dynamoUpdateItem: (...args: unknown[]) => mockUpdateItem(...args),
  dynamoPutItem: (...args: unknown[]) => mockPutItem(...args),
  dynamoQuery: (...args: unknown[]) => mockQuery(...args),
  dynamoScan: vi.fn(),
  dynamoCountItems: vi.fn(),
  dynamoDeleteItem: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock toast
// ---------------------------------------------------------------------------

vi.mock("@/platform/toast", () => ({
  useToast: () => ({ show: mockToastShow }),
}));

// ---------------------------------------------------------------------------
// Mock CodeMirror — minimal shim that makes EditorView constructable in jsdom
// ---------------------------------------------------------------------------

const { mockEditorViewConstructor } = vi.hoisted(() => {
  const ctor = vi.fn();
  return { mockEditorViewConstructor: ctor };
});

vi.mock("@codemirror/view", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codemirror/view")>();
  const mockState = {
    doc: { toString: () => "{}", length: 2 },
  };
  return {
    ...actual,
    EditorView: class MockEditorView {
      static editable = actual.EditorView.editable;
      static lineWrapping = actual.EditorView.lineWrapping;
      static theme = vi.fn().mockReturnValue([]);
      static updateListener = actual.EditorView.updateListener;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      state: any;
      destroy: () => void;
      dispatch: () => void;
      constructor(config: unknown) {
        mockEditorViewConstructor(config);
        this.state = mockState;
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
// Helper fixtures
// ---------------------------------------------------------------------------

function makeItem(): AttributeMap {
  return {
    pk: { S: "user-1" },
    sk: { S: "evt-1" },
    status: { S: "pending" },
    archived: { BOOL: false },
  };
}

// ---------------------------------------------------------------------------
// Unit tests: computeSaveAction (pure function)
// ---------------------------------------------------------------------------

describe("computeSaveAction — parse errors", () => {
  const item = makeItem();
  const keyNames = ["pk", "sk"];

  it("returns parse error for garbage JSON", () => {
    const action = computeSaveAction("NOT JSON", item, keyNames, false);
    expect(action.kind).toBe("error");
    if (action.kind === "error") {
      expect(action.error.kind).toBe("parse");
    }
  });

  it("returns parse error when root is not an object", () => {
    const action = computeSaveAction("[]", item, keyNames, false);
    expect(action.kind).toBe("error");
    if (action.kind === "error") {
      expect(action.error.kind).toBe("parse");
    }
  });

  it("returns parse error for null root", () => {
    const action = computeSaveAction("null", item, keyNames, false);
    expect(action.kind).toBe("error");
    if (action.kind === "error") {
      expect(action.error.kind).toBe("parse");
    }
  });
});

describe("computeSaveAction — tag errors", () => {
  const item = makeItem();
  const keyNames = ["pk", "sk"];

  it("returns tag error for untagged string value", () => {
    const draft = JSON.stringify({ pk: { S: "user-1" }, sk: { S: "evt-1" }, status: "ok" });
    const action = computeSaveAction(draft, item, keyNames, false);
    expect(action.kind).toBe("error");
    if (action.kind === "error") {
      expect(action.error.kind).toBe("tag");
    }
  });

  it("returns tag error for multi-key attribute value", () => {
    const draft = JSON.stringify({ pk: { S: "user-1" }, sk: { S: "evt-1" }, bad: { S: "a", N: "1" } });
    const action = computeSaveAction(draft, item, keyNames, false);
    expect(action.kind).toBe("error");
    if (action.kind === "error") {
      expect(action.error.kind).toBe("tag");
    }
  });

  it("returns tag error for unknown tag", () => {
    const draft = JSON.stringify({ pk: { S: "user-1" }, sk: { S: "evt-1" }, x: { X: "?" } });
    const action = computeSaveAction(draft, item, keyNames, false);
    expect(action.kind).toBe("error");
    if (action.kind === "error") {
      expect(action.error.kind).toBe("tag");
    }
  });
});

describe("computeSaveAction — key change errors", () => {
  const item = makeItem();
  const keyNames = ["pk", "sk"];

  it("returns key error when pk is changed", () => {
    const draft = JSON.stringify({ pk: { S: "different" }, sk: { S: "evt-1" }, status: { S: "pending" } });
    const action = computeSaveAction(draft, item, keyNames, false);
    expect(action.kind).toBe("error");
    if (action.kind === "error") {
      expect(action.error.kind).toBe("key");
      expect(action.error.message).toMatch(/primary key/i);
    }
  });

  it("returns key error when sk is missing from parsed", () => {
    const draft = JSON.stringify({ pk: { S: "user-1" }, status: { S: "pending" } });
    const action = computeSaveAction(draft, item, keyNames, false);
    expect(action.kind).toBe("error");
    if (action.kind === "error") {
      expect(action.error.kind).toBe("key");
    }
  });
});

describe("computeSaveAction — diff path", () => {
  const item = makeItem();
  const keyNames = ["pk", "sk"];

  it("returns update action with correct diff", () => {
    const edited: AttributeMap = {
      pk: { S: "user-1" },
      sk: { S: "evt-1" },
      status: { S: "ok" }, // changed
      // archived removed
    };
    const action = computeSaveAction(JSON.stringify(edited), item, keyNames, false);
    expect(action.kind).toBe("update");
    if (action.kind === "update") {
      expect(action.diff.set).toEqual({ status: { S: "ok" } });
      expect(action.diff.remove).toContain("archived");
      expect(Object.keys(action.key)).toEqual(expect.arrayContaining(["pk", "sk"]));
    }
  });

  it("returns no-change when item is identical", () => {
    const action = computeSaveAction(JSON.stringify(item), item, keyNames, false);
    expect(action.kind).toBe("no-change");
  });

  it("set equality is order-insensitive for SS", () => {
    const baseItem: AttributeMap = {
      pk: { S: "a" },
      tags: { SS: ["a", "b"] },
    };
    const edited: AttributeMap = {
      pk: { S: "a" },
      tags: { SS: ["b", "a"] },
    };
    const action = computeSaveAction(JSON.stringify(edited), baseItem, ["pk"], false);
    expect(action.kind).toBe("no-change");
  });
});

describe("computeSaveAction — replace path", () => {
  const item = makeItem();
  const keyNames = ["pk", "sk"];

  it("returns replace action when replaceEntireItem is true", () => {
    const edited: AttributeMap = {
      pk: { S: "user-1" },
      sk: { S: "evt-1" },
      status: { S: "ok" },
    };
    const action = computeSaveAction(JSON.stringify(edited), item, keyNames, true);
    expect(action.kind).toBe("replace");
    if (action.kind === "replace") {
      expect(action.parsed).toEqual(edited);
    }
  });

  it("replace also validates keys first", () => {
    const edited: AttributeMap = {
      pk: { S: "changed" },
      sk: { S: "evt-1" },
    };
    const action = computeSaveAction(JSON.stringify(edited), item, keyNames, true);
    // Should fail on key equality check
    expect(action.kind).toBe("error");
    if (action.kind === "error") {
      expect(action.error.kind).toBe("key");
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests: extractKey and buildKeyConditionPlaceholders
// ---------------------------------------------------------------------------

describe("extractKey", () => {
  it("extracts only named key attributes", () => {
    const item: AttributeMap = { pk: { S: "a" }, sk: { S: "b" }, extra: { N: "1" } };
    expect(extractKey(item, ["pk", "sk"])).toEqual({ pk: { S: "a" }, sk: { S: "b" } });
  });
});

describe("buildKeyConditionPlaceholders", () => {
  it("builds single-key expression", () => {
    const key: AttributeMap = { pk: { S: "a" } };
    const { expression, names, values } = buildKeyConditionPlaceholders(["pk"], key);
    expect(expression).toBe("#k0 = :k0");
    expect(names).toEqual({ "#k0": "pk" });
    expect(values).toEqual({ ":k0": { S: "a" } });
  });

  it("builds two-key expression joined by AND", () => {
    const key: AttributeMap = { pk: { S: "a" }, sk: { S: "b" } };
    const { expression, names, values } = buildKeyConditionPlaceholders(["pk", "sk"], key);
    expect(expression).toBe("#k0 = :k0 AND #k1 = :k1");
    expect(names["#k0"]).toBe("pk");
    expect(names["#k1"]).toBe("sk");
    expect(values[":k0"]).toEqual({ S: "a" });
    expect(values[":k1"]).toEqual({ S: "b" });
  });
});

// ---------------------------------------------------------------------------
// Integration tests: InspectorJsonEditor component
// ---------------------------------------------------------------------------

// We lazy-import the component AFTER the mocks are set up

async function importComponent() {
  const mod = await import("./InspectorJsonEditor");
  return mod.InspectorJsonEditor;
}

describe("InspectorJsonEditor component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const defaultProps = {
    item: makeItem(),
    keyNames: ["pk", "sk"],
    connectionId: "conn-1",
    tableName: "events",
    rowIndex: 0,
    onClose: vi.fn(),
    onPatchItem: vi.fn(),
  };

  it("renders Save and Cancel buttons", async () => {
    const InspectorJsonEditor = await importComponent();
    render(<InspectorJsonEditor {...defaultProps} />);
    expect(screen.getByTestId("editor-save-btn")).toBeTruthy();
    expect(screen.getByTestId("editor-cancel-btn")).toBeTruthy();
  });

  it("Cancel button calls onClose", async () => {
    const onClose = vi.fn();
    const InspectorJsonEditor = await importComponent();
    render(<InspectorJsonEditor {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("editor-cancel-btn"));
    expect(onClose).toHaveBeenCalled();
  });

  it("Replace entire item toggle is unchecked by default", async () => {
    const InspectorJsonEditor = await importComponent();
    render(<InspectorJsonEditor {...defaultProps} />);
    const toggle = screen.getByTestId("replace-entire-toggle") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it("Save with no changes shows 'No changes' toast and calls onClose without AWS call", async () => {
    const onClose = vi.fn();
    const InspectorJsonEditor = await importComponent();
    // The CM mock does NOT fire updateListener, so draft stays = originalSerialized.
    // Clicking Save on unchanged content → no-change path.
    render(<InspectorJsonEditor {...defaultProps} onClose={onClose} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("editor-save-btn"));
    });

    expect(mockToastShow).toHaveBeenCalledWith("No changes", "info");
    expect(onClose).toHaveBeenCalled();
    expect(mockUpdateItem).not.toHaveBeenCalled();
    expect(mockPutItem).not.toHaveBeenCalled();
  });

  it("diff path calls dynamoUpdateItem with correct diff", async () => {
    const onPatchItem = vi.fn();
    const onClose = vi.fn();
    mockUpdateItem.mockResolvedValue({
      attributes: makeItem(),
    });

    const InspectorJsonEditor = await importComponent();

    const originalItem: AttributeMap = {
      pk: { S: "u1" },
      sk: { S: "e1" },
      status: { S: "pending" },
      archived: { BOOL: false },
    };
    // Changed: status changed, archived removed
    const changedItem: AttributeMap = {
      pk: { S: "u1" },
      sk: { S: "e1" },
      status: { S: "ok" },
    };

    render(
      <InspectorJsonEditor
        item={originalItem}
        keyNames={["pk", "sk"]}
        connectionId="conn-1"
        tableName="events"
        rowIndex={2}
        onClose={onClose}
        onPatchItem={onPatchItem}
        _testInitialDraft={JSON.stringify(changedItem)}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("editor-save-btn"));
    });

    expect(mockUpdateItem).toHaveBeenCalledWith(
      "conn-1",
      "events",
      expect.objectContaining({
        key: { pk: { S: "u1" }, sk: { S: "e1" } },
        updates: {
          set: { status: { S: "ok" } },
          remove: ["archived"],
        },
        return_values: "ALL_NEW",
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("replace path calls dynamoPutItem with parsed item", async () => {
    const onPatchItem = vi.fn();
    const onClose = vi.fn();
    mockPutItem.mockResolvedValue({ attributes: null });

    const InspectorJsonEditor = await importComponent();

    const originalItem: AttributeMap = {
      pk: { S: "u1" },
      sk: { S: "e1" },
      status: { S: "pending" },
    };
    const changedItem: AttributeMap = {
      pk: { S: "u1" },
      sk: { S: "e1" },
      status: { S: "ok" },
      extra: { N: "42" },
    };

    render(
      <InspectorJsonEditor
        item={originalItem}
        keyNames={["pk", "sk"]}
        connectionId="conn-1"
        tableName="events"
        rowIndex={1}
        onClose={onClose}
        onPatchItem={onPatchItem}
        _testInitialDraft={JSON.stringify(changedItem)}
      />,
    );

    // Toggle Replace entire item on
    fireEvent.click(screen.getByTestId("replace-entire-toggle"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("editor-save-btn"));
    });

    expect(mockPutItem).toHaveBeenCalledWith(
      "conn-1",
      "events",
      expect.objectContaining({
        item: changedItem,
      }),
    );
    expect(onClose).toHaveBeenCalled();
    expect(mockUpdateItem).not.toHaveBeenCalled();
  });

  it("ConditionalCheckFailed error shows Reload row button", async () => {
    const { AppError } = await import("@/platform/errors/AppError");
    mockUpdateItem.mockRejectedValue(
      new AppError("Aws", "Condition failed", undefined, {
        code: "ConditionalCheckFailedException",
        message: "Condition failed",
        retryable: false,
      }),
    );

    const InspectorJsonEditor = await importComponent();
    const onClose = vi.fn();
    const onPatchItem = vi.fn();

    const originalItem: AttributeMap = {
      pk: { S: "u1" },
      sk: { S: "e1" },
      status: { S: "pending" },
    };
    // Changed draft: modify status to trigger a diff path
    const changedItem: AttributeMap = {
      pk: { S: "u1" },
      sk: { S: "e1" },
      status: { S: "ok" },
    };

    render(
      <InspectorJsonEditor
        item={originalItem}
        keyNames={["pk", "sk"]}
        connectionId="conn-1"
        tableName="events"
        rowIndex={0}
        onClose={onClose}
        onPatchItem={onPatchItem}
        _testInitialDraft={JSON.stringify(changedItem)}
      />,
    );

    // No error initially
    expect(screen.queryByTestId("editor-error")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("editor-save-btn"));
    });

    // Error panel should now show with reload button
    expect(screen.getByTestId("editor-error")).toBeTruthy();
    expect(screen.getByTestId("reload-row-btn")).toBeTruthy();
    // Save button should be available again
    expect(screen.getByTestId("editor-save-btn")).toBeTruthy();
  });

  it("Reload row button calls dynamoQuery and updates originalItem, preserves draft", async () => {
    const { AppError } = await import("@/platform/errors/AppError");

    // First save throws ConditionalCheckFailed
    mockUpdateItem.mockRejectedValueOnce(
      new AppError("Aws", "Condition check failed", undefined, {
        code: "ConditionalCheckFailedException",
        message: "Condition check failed",
        retryable: false,
      }),
    );

    // Mock query to return fresh item
    const freshItem: AttributeMap = {
      pk: { S: "u1" },
      sk: { S: "e1" },
      status: { S: "updated-by-someone-else" },
    };
    mockQuery.mockResolvedValue({
      items: [freshItem],
      last_evaluated_key: null,
      scanned_count: 1,
      count: 1,
      consumed_capacity: null,
    });

    const InspectorJsonEditor = await importComponent();
    const onPatchItem = vi.fn();
    const onClose = vi.fn();

    const originalItem: AttributeMap = {
      pk: { S: "u1" },
      sk: { S: "e1" },
      status: { S: "pending" },
    };
    const changedItem: AttributeMap = {
      pk: { S: "u1" },
      sk: { S: "e1" },
      status: { S: "ok" },
    };

    render(
      <InspectorJsonEditor
        item={originalItem}
        keyNames={["pk", "sk"]}
        connectionId="conn-1"
        tableName="events"
        rowIndex={0}
        onClose={onClose}
        onPatchItem={onPatchItem}
        _testInitialDraft={JSON.stringify(changedItem)}
      />,
    );

    // Trigger save — will fail with ConditionalCheckFailed
    await act(async () => {
      fireEvent.click(screen.getByTestId("editor-save-btn"));
    });

    expect(screen.getByTestId("reload-row-btn")).toBeTruthy();

    // Click reload row
    await act(async () => {
      fireEvent.click(screen.getByTestId("reload-row-btn"));
    });

    // dynamoQuery should have been called
    expect(mockQuery).toHaveBeenCalledWith(
      "conn-1",
      "events",
      expect.objectContaining({
        key_condition_expression: expect.stringContaining("="),
        consistent_read: true,
        limit: 1,
      }),
    );

    // onPatchItem should have been called with the fresh item
    expect(onPatchItem).toHaveBeenCalledWith(0, freshItem);

    // Error should be cleared
    expect(screen.queryByTestId("editor-error")).toBeNull();

    // Toast shown
    expect(mockToastShow).toHaveBeenCalledWith("Row reloaded — review and Save again", "info");
  });
});

// ---------------------------------------------------------------------------
// Inspector component integration: Edit item button visibility
// ---------------------------------------------------------------------------

describe("Inspector — Edit item button", () => {
  // These tests import Inspector which also uses CodeMirror through InspectorJsonEditor.
  // The mocks above already handle that.

  it("Edit item button not shown when isReadOnly=true", async () => {
    const { Inspector } = await import("../Inspector");
    const item: AttributeMap = { pk: { S: "a" }, sk: { S: "b" } };

    render(
      <Inspector
        item={item}
        describe={null}
        indexName={null}
        onClearSelection={vi.fn()}
        isReadOnly={true}
        connectionId="conn"
        tableName="t"
        rowIndex={0}
        onPatchItem={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("inspector-edit-btn")).toBeNull();
  });

  it("Edit item button shown when isReadOnly=false and connection props present", async () => {
    const { Inspector } = await import("../Inspector");
    const item: AttributeMap = { pk: { S: "a" }, sk: { S: "b" } };

    render(
      <Inspector
        item={item}
        describe={null}
        indexName={null}
        onClearSelection={vi.fn()}
        isReadOnly={false}
        connectionId="conn"
        tableName="t"
        rowIndex={0}
        onPatchItem={vi.fn()}
      />,
    );
    expect(screen.getByTestId("inspector-edit-btn")).toBeTruthy();
  });

  it("clicking Edit item enters editor mode", async () => {
    const { Inspector } = await import("../Inspector");
    const item: AttributeMap = { pk: { S: "a" }, sk: { S: "b" } };

    render(
      <Inspector
        item={item}
        describe={null}
        indexName={null}
        onClearSelection={vi.fn()}
        isReadOnly={false}
        connectionId="conn"
        tableName="t"
        rowIndex={0}
        onPatchItem={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("inspector-edit-btn"));
    // In editor mode, the InspectorJsonEditor is rendered
    expect(screen.getByTestId("inspector-json-editor")).toBeTruthy();
    // The tree is replaced by the editor
    expect(screen.queryByTestId("inspector-edit-btn")).toBeNull();
  });

  it("Edit item button not shown when connection props missing", async () => {
    const { Inspector } = await import("../Inspector");
    const item: AttributeMap = { pk: { S: "a" } };

    render(
      <Inspector
        item={item}
        describe={null}
        indexName={null}
        onClearSelection={vi.fn()}
        isReadOnly={false}
        // No connectionId, tableName, rowIndex, onPatchItem
      />,
    );
    expect(screen.queryByTestId("inspector-edit-btn")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Optimistic locking — InspectorJsonEditor (task 10.6)
// ---------------------------------------------------------------------------

describe("InspectorJsonEditor — optimistic locking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("toggle off → dispatched dynamoUpdateItem carries no condition", async () => {
    mockUpdateItem.mockResolvedValue({ attributes: null });
    const InspectorJsonEditor = await importComponent();

    const originalItem: AttributeMap = {
      pk: { S: "u1" },
      sk: { S: "e1" },
      version: { N: "1" },
      status: { S: "pending" },
    };
    const changedItem: AttributeMap = {
      pk: { S: "u1" },
      sk: { S: "e1" },
      version: { N: "1" },
      status: { S: "done" },
    };

    render(
      <InspectorJsonEditor
        item={originalItem}
        keyNames={["pk", "sk"]}
        connectionId="conn-1"
        tableName="events"
        rowIndex={0}
        onClose={vi.fn()}
        onPatchItem={vi.fn()}
        // locking.enabled = false
        locking={{ versionAttr: "version", enabled: false, pkAttr: "pk" }}
        _testInitialDraft={JSON.stringify(changedItem)}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("editor-save-btn"));
    });

    expect(mockUpdateItem).toHaveBeenCalledWith(
      "conn-1",
      "events",
      expect.objectContaining({
        condition_expression: null,
        expression_attribute_names: null,
        expression_attribute_values: null,
      }),
    );
  });

  it("toggle on + empty versionAttr → no condition", async () => {
    mockUpdateItem.mockResolvedValue({ attributes: null });
    const InspectorJsonEditor = await importComponent();

    const originalItem: AttributeMap = {
      pk: { S: "u1" },
      sk: { S: "e1" },
      status: { S: "pending" },
    };
    const changedItem: AttributeMap = {
      pk: { S: "u1" },
      sk: { S: "e1" },
      status: { S: "done" },
    };

    render(
      <InspectorJsonEditor
        item={originalItem}
        keyNames={["pk", "sk"]}
        connectionId="conn-1"
        tableName="events"
        rowIndex={0}
        onClose={vi.fn()}
        onPatchItem={vi.fn()}
        // locking.enabled = true but versionAttr is empty
        locking={{ versionAttr: "", enabled: true, pkAttr: "pk" }}
        _testInitialDraft={JSON.stringify(changedItem)}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("editor-save-btn"));
    });

    expect(mockUpdateItem).toHaveBeenCalledWith(
      "conn-1",
      "events",
      expect.objectContaining({
        condition_expression: null,
      }),
    );
  });

  it("toggle on + versionAttr set + diff → condition_expression and :lock0 present", async () => {
    mockUpdateItem.mockResolvedValue({ attributes: null });
    const InspectorJsonEditor = await importComponent();

    const originalItem: AttributeMap = {
      pk: { S: "u1" },
      sk: { S: "e1" },
      version: { N: "5" },
      status: { S: "pending" },
    };
    const changedItem: AttributeMap = {
      pk: { S: "u1" },
      sk: { S: "e1" },
      version: { N: "5" },
      status: { S: "done" },
    };

    render(
      <InspectorJsonEditor
        item={originalItem}
        keyNames={["pk", "sk"]}
        connectionId="conn-1"
        tableName="events"
        rowIndex={0}
        onClose={vi.fn()}
        onPatchItem={vi.fn()}
        locking={{ versionAttr: "version", enabled: true, pkAttr: "pk" }}
        _testInitialDraft={JSON.stringify(changedItem)}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("editor-save-btn"));
    });

    expect(mockUpdateItem).toHaveBeenCalledWith(
      "conn-1",
      "events",
      expect.objectContaining({
        condition_expression: expect.stringContaining(":lock0"),
        expression_attribute_values: expect.objectContaining({
          ":lock0": { N: "5" },
        }),
        expression_attribute_names: expect.objectContaining({
          "#v0": "version",
        }),
      }),
    );
  });

  it("ConditionalCheckFailed with locking → Reload row button appears", async () => {
    const { AppError } = await import("@/platform/errors/AppError");
    mockUpdateItem.mockRejectedValue(
      new AppError("Aws", "CCF", undefined, {
        code: "ConditionalCheckFailedException",
        message: "CCF",
        retryable: false,
      }),
    );

    const InspectorJsonEditor = await importComponent();

    const originalItem: AttributeMap = {
      pk: { S: "u1" },
      sk: { S: "e1" },
      version: { N: "1" },
      status: { S: "pending" },
    };
    const changedItem: AttributeMap = {
      pk: { S: "u1" },
      sk: { S: "e1" },
      version: { N: "1" },
      status: { S: "done" },
    };

    render(
      <InspectorJsonEditor
        item={originalItem}
        keyNames={["pk", "sk"]}
        connectionId="conn-1"
        tableName="events"
        rowIndex={0}
        onClose={vi.fn()}
        onPatchItem={vi.fn()}
        locking={{ versionAttr: "version", enabled: true, pkAttr: "pk" }}
        _testInitialDraft={JSON.stringify(changedItem)}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("editor-save-btn"));
    });

    // The existing CCF reload affordance should appear
    expect(screen.getByTestId("reload-row-btn")).toBeTruthy();
  });
});
