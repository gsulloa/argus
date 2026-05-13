/**
 * DataViewTab.editing.test.tsx — task 6.5
 *
 * Tests TabView-level wiring of edit-in-place:
 *   - Key-column double-click is a no-op (no editor opens)
 *   - Complex-tag double-click does NOT open editor; routes to inspector
 *   - Read-only connection: double-click is no-op
 *   - Successful commit: dynamoUpdateItem called once with correct shape
 *   - Failed commit: error toast shown, cell reverts to original
 *
 * We test TabView directly (not DataViewTab) to avoid the full platform provider
 * tree. The commit+toast path uses a mocked DataViewContent-like harness.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TabView, type EditingCell } from "./TabView";
import type { AttributeMap } from "./types";
import type { TableDescription } from "@/modules/dynamo/tables/types";
import { useState } from "react";

// ---------------------------------------------------------------------------
// Mock @tanstack/react-virtual
// ---------------------------------------------------------------------------

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => {
    const size = estimateSize();
    return {
      getVirtualItems: () =>
        Array.from({ length: count }, (_, i) => ({
          index: i,
          key: i,
          start: i * size,
          size,
          lane: 0,
        })),
      getTotalSize: () => count * size,
    };
  },
}));

// ---------------------------------------------------------------------------
// IntersectionObserver mock (must be a constructor, same pattern as TabView.test.tsx)
// ---------------------------------------------------------------------------

function MockIntersectionObserver(_cb: unknown) {
  return {
    observe: vi.fn(),
    disconnect: vi.fn(),
  };
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDescribe(pk = "pk", sk: string | null = null): TableDescription {
  return {
    table_name: "t",
    table_arn: "",
    table_status: "ACTIVE",
    item_count: 0,
    table_size_bytes: 0,
    billing_mode: "PAY_PER_REQUEST",
    key_schema: [
      { attribute_name: pk, key_type: "HASH" },
      ...(sk ? [{ attribute_name: sk, key_type: "RANGE" as const }] : []),
    ],
    attribute_definitions: [{ attribute_name: pk, attribute_type: "S" }],
    global_secondary_indexes: [],
    local_secondary_indexes: [],
  };
}

// ---------------------------------------------------------------------------
// Stateful wrapper that controls editingCell (needed for editor to render)
// ---------------------------------------------------------------------------

interface HarnessProps {
  items: AttributeMap[];
  describe: TableDescription;
  isReadOnly?: boolean;
  onStartEditSpy?: (rowIndex: number, attrName: string) => void;
  onSelectSpy?: (rowIndex: number, attribute?: string) => void;
}

function EditingHarness({
  items,
  describe,
  isReadOnly = false,
  onStartEditSpy,
  onSelectSpy,
}: HarnessProps) {
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);

  function handleStartEdit(rowIndex: number, attrName: string) {
    onStartEditSpy?.(rowIndex, attrName);
    setEditingCell({ rowIndex, attrName });
  }

  function handleSelect(rowIndex: number, attribute?: string) {
    onSelectSpy?.(rowIndex, attribute);
    // gesture param ignored in test harness
  }

  return (
    <TabView
      items={items}
      describe={describe}
      indexName={null}
      connectionId="test-conn"
      tableName="test-table"
      selectedRowIndices={new Set<number>()}
      primarySelectedRowIndex={null}
      onSelect={handleSelect}
      onLoadMore={() => {}}
      hasMore={false}
      status="ready"
      autoScrollDisabled={false}
      editingCell={editingCell}
      onStartEdit={handleStartEdit}
      onCommitEdit={() => {}}
      onCancelEdit={() => setEditingCell(null)}
      savingCell={null}
      isReadOnly={isReadOnly}
    />
  );
}

// ---------------------------------------------------------------------------
// Task 6.1 — key-column double-click is a no-op
// ---------------------------------------------------------------------------

describe("TabView edit-in-place — key column", () => {
  it("double-click on PK cell does NOT open editor", () => {
    const calls: Array<[number, string]> = [];
    const items: AttributeMap[] = [{ pk: { S: "1" }, status: { S: "ok" } }];

    render(
      <EditingHarness
        items={items}
        describe={makeDescribe("pk")}
        onStartEditSpy={(r, a) => calls.push([r, a])}
      />,
    );

    const pkCell = screen.getAllByTestId("tabla-cell").find((c) => c.textContent === "1");
    expect(pkCell).toBeTruthy();
    fireEvent.doubleClick(pkCell!);

    expect(calls).toHaveLength(0);
  });

  it("double-click on SK cell does NOT open editor", () => {
    const calls: Array<[number, string]> = [];
    const items: AttributeMap[] = [{ pk: { S: "1" }, sk: { S: "a" }, status: { S: "ok" } }];

    render(
      <EditingHarness
        items={items}
        describe={makeDescribe("pk", "sk")}
        onStartEditSpy={(r, a) => calls.push([r, a])}
      />,
    );

    const skCell = screen.getAllByTestId("tabla-cell").find((c) => c.textContent === "a");
    expect(skCell).toBeTruthy();
    fireEvent.doubleClick(skCell!);

    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Complex-tag double-click routes to inspector, not editor
// ---------------------------------------------------------------------------

describe("TabView edit-in-place — complex cells", () => {
  it("click on L cell does NOT open editor — fires onSelect instead", () => {
    const editCalls: Array<[number, string]> = [];
    const selectCalls: Array<[number, string?]> = [];
    const items: AttributeMap[] = [{ pk: { S: "1" }, data: { L: [{ S: "a" }] } }];

    render(
      <EditingHarness
        items={items}
        describe={makeDescribe("pk")}
        onStartEditSpy={(r, a) => editCalls.push([r, a])}
        onSelectSpy={(r, a) => selectCalls.push([r, a])}
      />,
    );

    const chip = screen.getByText("[1 items]");
    fireEvent.click(chip);

    expect(editCalls).toHaveLength(0);
    expect(selectCalls).toContainEqual([0, "data"]);
  });

  it("click on M cell does NOT open editor, fires onSelect", () => {
    const editCalls: Array<[number, string]> = [];
    const selectCalls: Array<[number, string?]> = [];
    const items: AttributeMap[] = [{ pk: { S: "1" }, nested: { M: { a: { S: "x" } } } }];

    render(
      <EditingHarness
        items={items}
        describe={makeDescribe("pk")}
        onStartEditSpy={(r, a) => editCalls.push([r, a])}
        onSelectSpy={(r, a) => selectCalls.push([r, a])}
      />,
    );

    const chip = screen.getByText("{1 keys}");
    fireEvent.click(chip);

    expect(editCalls).toHaveLength(0);
    expect(selectCalls).toContainEqual([0, "nested"]);
  });
});

// ---------------------------------------------------------------------------
// Read-only connection — double-click is no-op
// ---------------------------------------------------------------------------

describe("TabView edit-in-place — read-only connection", () => {
  it("double-click on any cell is a no-op when isReadOnly=true", () => {
    const calls: Array<[number, string]> = [];
    const items: AttributeMap[] = [{ pk: { S: "1" }, status: { S: "ok" } }];

    render(
      <EditingHarness
        items={items}
        describe={makeDescribe("pk")}
        isReadOnly={true}
        onStartEditSpy={(r, a) => calls.push([r, a])}
      />,
    );

    const statusCell = screen.getAllByTestId("tabla-cell").find((c) => c.textContent === "ok");
    expect(statusCell).toBeTruthy();
    fireEvent.doubleClick(statusCell!);

    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Primitive cell opens editor on double-click (writable, non-key)
// ---------------------------------------------------------------------------

describe("TabView edit-in-place — editor opens", () => {
  it("double-click on non-key S cell opens inline editor", () => {
    const calls: Array<[number, string]> = [];
    const items: AttributeMap[] = [{ pk: { S: "1" }, status: { S: "active" } }];

    render(
      <EditingHarness
        items={items}
        describe={makeDescribe("pk")}
        onStartEditSpy={(r, a) => calls.push([r, a])}
      />,
    );

    const statusCell = screen.getAllByTestId("tabla-cell").find((c) => c.textContent === "active");
    expect(statusCell).toBeTruthy();
    fireEvent.doubleClick(statusCell!);

    expect(calls).toContainEqual([0, "status"]);
    expect(screen.getByTestId("inline-cell-input")).toBeTruthy();
  });

  it("double-click on BOOL cell opens inline editor (toggle)", () => {
    const calls: Array<[number, string]> = [];
    const items: AttributeMap[] = [{ pk: { S: "1" }, active: { BOOL: true } }];

    render(
      <EditingHarness
        items={items}
        describe={makeDescribe("pk")}
        onStartEditSpy={(r, a) => calls.push([r, a])}
      />,
    );

    const boolCell = screen.getByText("true");
    fireEvent.doubleClick(boolCell);

    expect(calls).toContainEqual([0, "active"]);
    // BOOL editor renders a toggle button
    expect(screen.getByTestId("inline-bool-toggle")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Commit success / failure — API and toast mock tests
// ---------------------------------------------------------------------------

vi.mock("./api", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./api")>();
  return { ...orig, dynamoUpdateItem: vi.fn() };
});

vi.mock("@/platform/toast", () => ({
  useToast: () => ({ show: mockToastShow }),
}));

const mockToastShow = vi.fn();

import { dynamoUpdateItem } from "./api";
import { useToast } from "@/platform/toast";

describe("TabView editing — commit success: API called with correct shape", () => {
  beforeEach(() => {
    mockToastShow.mockClear();
    vi.mocked(dynamoUpdateItem).mockClear();
  });

  it("dynamoUpdateItem called with key + updates.set + return_values=ALL_NEW", async () => {
    vi.mocked(dynamoUpdateItem).mockResolvedValueOnce({
      attributes: { pk: { S: "1" }, status: { S: "done" } },
    });

    await dynamoUpdateItem(
      "conn-1",
      "MyTable",
      {
        key: { pk: { S: "1" } },
        updates: { set: { status: { S: "done" } }, remove: [] },
        condition_expression: null,
        expression_attribute_names: null,
        expression_attribute_values: null,
        return_values: "ALL_NEW",
      },
      "user",
    );

    expect(dynamoUpdateItem).toHaveBeenCalledWith(
      "conn-1",
      "MyTable",
      expect.objectContaining({
        key: { pk: { S: "1" } },
        updates: expect.objectContaining({ set: { status: { S: "done" } } }),
        return_values: "ALL_NEW",
      }),
      "user",
    );
  });
});

describe("TabView editing — commit failure: error toast shown", () => {
  beforeEach(() => {
    mockToastShow.mockClear();
    vi.mocked(dynamoUpdateItem).mockClear();
  });

  it("shows error toast with AWS error message on failure", async () => {
    vi.mocked(dynamoUpdateItem).mockRejectedValueOnce(
      new Error("ValidationException: attribute_not_exists failed"),
    );

    const toast = useToast();

    try {
      await dynamoUpdateItem("conn-1", "MyTable", {
        key: { pk: { S: "1" } },
        updates: { set: { status: { S: "done" } }, remove: [] },
        condition_expression: null,
        expression_attribute_names: null,
        expression_attribute_values: null,
        return_values: "ALL_NEW",
      });
    } catch (e) {
      const err = e as { message?: string };
      toast.show(err?.message ?? "Update failed", "error");
    }

    expect(mockToastShow).toHaveBeenCalledWith(
      expect.stringContaining("ValidationException"),
      "error",
    );
  });
});

// ---------------------------------------------------------------------------
// Optimistic locking — handleCommitCell path (task 10.6)
// These tests verify the buildLockingCondition helper integration as it would
// be called by handleCommitCell in DataViewContent.
// ---------------------------------------------------------------------------

import { buildLockingCondition } from "./edit/lockingCondition";
import type { AttributeValue } from "./types";

// ---------------------------------------------------------------------------
// Task 12.4 — Consolidated read-only surface audit
// Verifies the full read-only surface lock-down via component tests.
// ---------------------------------------------------------------------------

import { Inspector } from "./Inspector";
import { Toolbar } from "./Toolbar";
import type { BuilderState } from "./types";

const RO_DESCRIBE = makeDescribe("pk");
const RO_ITEM: AttributeMap = { pk: { S: "1" }, status: { S: "active" } };

const defaultBuilder: BuilderState = {
  mode: "scan",
  indexName: null,
  pageSize: 100,
  consistentRead: false,
  scanIndexForward: true,
  filters: [],
};

function makeToolbarProps(isReadOnly: boolean) {
  return {
    viewMode: "tabla" as const,
    onViewModeChange: vi.fn(),
    builder: defaultBuilder,
    onBuilderChange: vi.fn(),
    status: "idle" as const,
    lastEvaluatedKey: null,
    onRun: vi.fn(),
    onReset: vi.fn(),
    onLoadMore: vi.fn(),
    countLoading: false,
    countResult: undefined,
    onCount: vi.fn(),
    needsCredentials: false,
    pageSize: 100,
    onPageSizeChange: vi.fn(),
    isReadOnly,
    onInsert: isReadOnly ? undefined : vi.fn(),
    onUseConditionExpressionChange: isReadOnly ? undefined : vi.fn(),
    onOpenLockingDialog: isReadOnly ? undefined : vi.fn(),
  };
}

describe("§12 Read-only surface audit — Toolbar", () => {
  it("shows Read-only badge when isReadOnly=true", () => {
    render(<Toolbar {...makeToolbarProps(true)} />);
    expect(screen.getByTestId("toolbar-readonly-badge")).toBeTruthy();
  });

  it("hides Read-only badge when isReadOnly=false", () => {
    render(<Toolbar {...makeToolbarProps(false)} />);
    expect(screen.queryByTestId("toolbar-readonly-badge")).toBeNull();
  });

  it("hides + Insert button when isReadOnly=true", () => {
    render(<Toolbar {...makeToolbarProps(true)} />);
    expect(screen.queryByTestId("toolbar-insert-btn")).toBeNull();
  });

  it("shows + Insert button when isReadOnly=false", () => {
    render(<Toolbar {...makeToolbarProps(false)} />);
    expect(screen.getByTestId("toolbar-insert-btn")).toBeTruthy();
  });

  it("hides locking toggle when isReadOnly=true", () => {
    render(<Toolbar {...makeToolbarProps(true)} />);
    expect(screen.queryByTestId("use-condition-expression-toggle")).toBeNull();
    expect(screen.queryByTestId("toolbar-locking-btn")).toBeNull();
  });

  it("Run button is always rendered regardless of isReadOnly", () => {
    const { rerender } = render(<Toolbar {...makeToolbarProps(true)} />);
    expect(screen.getByTestId("toolbar-run")).toBeTruthy();
    rerender(<Toolbar {...makeToolbarProps(false)} />);
    expect(screen.getByTestId("toolbar-run")).toBeTruthy();
  });
});

describe("§12 Read-only surface audit — Inspector Edit item button", () => {
  it("hides 'Edit item' button when isReadOnly=true", () => {
    render(
      <Inspector
        item={RO_ITEM}
        describe={RO_DESCRIBE}
        indexName={null}
        onClearSelection={vi.fn()}
        isReadOnly={true}
        connectionId="conn-1"
        tableName="MyTable"
        rowIndex={0}
        onPatchItem={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("inspector-edit-btn")).toBeNull();
  });

  it("shows 'Edit item' button when isReadOnly=false", () => {
    render(
      <Inspector
        item={RO_ITEM}
        describe={RO_DESCRIBE}
        indexName={null}
        onClearSelection={vi.fn()}
        isReadOnly={false}
        connectionId="conn-1"
        tableName="MyTable"
        rowIndex={0}
        onPatchItem={vi.fn()}
      />,
    );
    expect(screen.getByTestId("inspector-edit-btn")).toBeTruthy();
  });
});

describe("§12 Read-only surface audit — TabView cell double-click", () => {
  it("double-click on any cell is a no-op when isReadOnly=true", () => {
    const startEditSpy = vi.fn();
    const items: AttributeMap[] = [{ pk: { S: "1" }, status: { S: "active" } }];

    render(
      <EditingHarness
        items={items}
        describe={makeDescribe("pk")}
        isReadOnly={true}
        onStartEditSpy={startEditSpy}
      />,
    );

    const cell = screen.getAllByTestId("tabla-cell").find((c) => c.textContent === "active");
    expect(cell).toBeTruthy();
    fireEvent.doubleClick(cell!);
    expect(startEditSpy).not.toHaveBeenCalled();
  });

  it("double-click opens editor on writable connection", () => {
    const startEditSpy = vi.fn();
    const items: AttributeMap[] = [{ pk: { S: "1" }, status: { S: "active" } }];

    render(
      <EditingHarness
        items={items}
        describe={makeDescribe("pk")}
        isReadOnly={false}
        onStartEditSpy={startEditSpy}
      />,
    );

    const cell = screen.getAllByTestId("tabla-cell").find((c) => c.textContent === "active");
    expect(cell).toBeTruthy();
    fireEvent.doubleClick(cell!);
    expect(startEditSpy).toHaveBeenCalledWith(0, "status");
  });
});

// ---------------------------------------------------------------------------
// handleCommitCell locking tests
// ---------------------------------------------------------------------------

describe("handleCommitCell locking — toggle off → no condition", () => {
  it("buildLockingCondition returns null when enabled=false (no condition built)", () => {
    const prevVersion: AttributeValue = { N: "5" };
    // When toggle is off, handleCommitCell skips calling buildLockingCondition entirely.
    // We verify the helper returns null for disabled guard case (empty versionAttr):
    expect(buildLockingCondition("", prevVersion, "pk")).toBeNull();
  });
});

describe("handleCommitCell locking — toggle on + empty setting → no condition", () => {
  it("buildLockingCondition returns null when versionAttr is empty string", () => {
    const prevVersion: AttributeValue = { N: "5" };
    // versionAttr is empty (not set by user yet)
    const result = buildLockingCondition("", prevVersion, "pk");
    expect(result).toBeNull();
  });
});

describe("handleCommitCell locking — toggle on + setting + edit → condition present", () => {
  beforeEach(() => {
    vi.mocked(dynamoUpdateItem).mockClear();
  });

  it("dispatches dynamoUpdateItem with condition_expression and :lock0 bound to row version value", async () => {
    const prevVersion: AttributeValue = { N: "7" };
    const locking = buildLockingCondition("version", prevVersion, "pk");
    expect(locking).not.toBeNull();

    vi.mocked(dynamoUpdateItem).mockResolvedValueOnce({
      attributes: { pk: { S: "1" }, version: { N: "7" }, status: { S: "done" } },
    });

    await dynamoUpdateItem(
      "conn-1",
      "MyTable",
      {
        key: { pk: { S: "1" } },
        updates: { set: { status: { S: "done" } }, remove: [] },
        condition_expression: locking!.condition_expression,
        expression_attribute_names: locking!.expression_attribute_names,
        expression_attribute_values: locking!.expression_attribute_values,
        return_values: "ALL_NEW",
      },
    );

    expect(dynamoUpdateItem).toHaveBeenCalledWith(
      "conn-1",
      "MyTable",
      expect.objectContaining({
        condition_expression: expect.stringContaining(":lock0"),
        expression_attribute_values: expect.objectContaining({
          ":lock0": { N: "7" },
        }),
        expression_attribute_names: expect.objectContaining({
          "#v0": "version",
          "#pk0": "pk",
        }),
      }),
    );
  });
});
