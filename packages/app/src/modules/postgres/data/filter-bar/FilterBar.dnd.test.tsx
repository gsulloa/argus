import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import type { DataColumn, FilterModel } from "../types";

// Capture the onDragEnd callback from the DndContext so we can simulate a drop.
const capturedOnDragEnd: { current: ((e: unknown) => void) | null } = {
  current: null,
};

vi.mock("@dnd-kit/core", async () => {
  const actual = await vi.importActual<typeof import("@dnd-kit/core")>(
    "@dnd-kit/core",
  );
  return {
    ...actual,
    DndContext: ({
      children,
      onDragEnd,
    }: {
      children: React.ReactNode;
      onDragEnd: (e: unknown) => void;
    }) => {
      capturedOnDragEnd.current = onDragEnd;
      return React.createElement(React.Fragment, null, children);
    },
  };
});

vi.mock("@dnd-kit/sortable", async () => {
  const actual = await vi.importActual<typeof import("@dnd-kit/sortable")>(
    "@dnd-kit/sortable",
  );
  return {
    ...actual,
    SortableContext: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useSortable: () => ({
      attributes: {},
      listeners: {},
      setNodeRef: () => undefined,
      transform: null,
      transition: null,
      isDragging: false,
    }),
  };
});

// Import AFTER the mocks so FilterBar picks up the mocked dnd-kit modules.
const { FilterBar } = await import("./FilterBar");

const cols: DataColumn[] = [
  { name: "id", data_type: "int4", ordinal_position: 1, is_nullable: false },
  { name: "country", data_type: "text", ordinal_position: 2, is_nullable: true },
  { name: "status", data_type: "text", ordinal_position: 3, is_nullable: true },
];

function makeProps(overrides: Partial<React.ComponentProps<typeof FilterBar>> = {}) {
  return {
    draft: threeRowDraft(),
    applied: threeRowDraft(),
    columns: cols,
    onDraftChange: vi.fn(),
    onApplyAll: vi.fn(),
    onApplyOnlyRow: vi.fn(),
    onSqlClick: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

function threeRowDraft(): FilterModel {
  return {
    rows: [
      { id: "A", enabled: true, column: { kind: "named", name: "id" }, op: "=", value: "1" },
      { id: "B", enabled: true, column: { kind: "named", name: "country" }, op: "=", value: "CL" },
      { id: "C", enabled: true, column: { kind: "named", name: "status" }, op: "=", value: "ok" },
    ],
    combinator: "AND",
  };
}

beforeEach(() => {
  capturedOnDragEnd.current = null;
});

describe("FilterBar — drag reordering", () => {
  it("renders a reorder handle per row", () => {
    render(<FilterBar {...makeProps()} />);
    expect(screen.getAllByRole("button", { name: /Reorder filter row/i })).toHaveLength(3);
  });

  it("dropping row C above row A reorders draft to [C, A, B] and leaves applied untouched", () => {
    const onDraftChange = vi.fn();
    render(<FilterBar {...makeProps({ onDraftChange })} />);

    // Simulate dnd-kit reporting: dragged C dropped onto A.
    capturedOnDragEnd.current?.({ active: { id: "C" }, over: { id: "A" } });

    expect(onDraftChange).toHaveBeenCalledTimes(1);
    const next = onDraftChange.mock.calls[0]![0] as FilterModel;
    expect(next.rows.map((r) => r.id)).toEqual(["C", "A", "B"]);
    // The callback only mutates draft; applied is owned by the parent and is
    // never touched here.
    expect(next.combinator).toBe("AND");
  });

  it("no-op drop (over === active) does not call onDraftChange", () => {
    const onDraftChange = vi.fn();
    render(<FilterBar {...makeProps({ onDraftChange })} />);
    capturedOnDragEnd.current?.({ active: { id: "B" }, over: { id: "B" } });
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("drop with no target (over === null) does not call onDraftChange", () => {
    const onDraftChange = vi.fn();
    render(<FilterBar {...makeProps({ onDraftChange })} />);
    capturedOnDragEnd.current?.({ active: { id: "B" }, over: null });
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("clicking an inline control edits that row rather than reordering", () => {
    // Proves the row's controls stay interactive alongside the drag handle;
    // the 5px pointer activation distance (dnd-kit) is what keeps a click from
    // starting a drag.
    const onDraftChange = vi.fn();
    render(<FilterBar {...makeProps({ onDraftChange })} />);

    const checkboxes = screen.getAllByRole("checkbox", { name: /Include in Apply All/i });
    fireEvent.click(checkboxes[1]!);

    expect(onDraftChange).toHaveBeenCalledTimes(1);
    const next = onDraftChange.mock.calls[0]![0] as FilterModel;
    // Same rows in the same order — this was an edit, not a reorder.
    expect(next.rows.map((r) => r.id)).toEqual(["A", "B", "C"]);
    expect(next.rows[1]!.enabled).toBe(false);
  });
});
