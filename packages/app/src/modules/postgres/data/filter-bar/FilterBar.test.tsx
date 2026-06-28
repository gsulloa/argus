import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
// waitFor is used in the "No filters enabled" transient status test
import { FilterBar } from "./FilterBar";
import {
  EMPTY_FILTER_MODEL,
  EMPTY_FILTER_ROW,
  type DataColumn,
  type FilterModel,
} from "../types";
import type { FilterBarHandle } from "../../../shared/filter-bar";

const cols: DataColumn[] = [
  { name: "id", data_type: "int4", ordinal_position: 1, is_nullable: false },
  { name: "country", data_type: "text", ordinal_position: 2, is_nullable: true },
  { name: "status", data_type: "text", ordinal_position: 3, is_nullable: true },
];

function makeProps(overrides: Partial<React.ComponentProps<typeof FilterBar>> = {}) {
  return {
    draft: EMPTY_FILTER_MODEL,
    applied: EMPTY_FILTER_MODEL,
    columns: cols,
    onDraftChange: vi.fn(),
    onApplyAll: vi.fn(),
    onApplyOnlyRow: vi.fn(),
    onSqlClick: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

function modelWithRows(count: number): FilterModel {
  return {
    rows: Array.from({ length: count }, () => ({ ...EMPTY_FILTER_ROW })),
    combinator: "AND",
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("FilterBar — rendering", () => {
  it("renders one default row when draft has zero rows (EMPTY_FILTER_MODEL)", () => {
    render(<FilterBar {...makeProps()} />);
    // At least one condition row must be rendered (defensive fallback).
    expect(screen.getAllByRole("checkbox", { name: /Include in Apply All/i })).toHaveLength(1);
  });

  it("renders N rows for N draft rows", () => {
    const draft = modelWithRows(3);
    render(<FilterBar {...makeProps({ draft })} />);
    expect(screen.getAllByRole("checkbox", { name: /Include in Apply All/i })).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Checkbox
// ---------------------------------------------------------------------------

describe("FilterBar — checkbox", () => {
  it("toggling calls onDraftChange with updated enabled flag", () => {
    const onDraftChange = vi.fn();
    const draft: FilterModel = {
      rows: [{ enabled: true, column: { kind: "any_column" }, op: "Contains", value: "x" }],
      combinator: "AND",
    };
    render(<FilterBar {...makeProps({ draft, onDraftChange })} />);
    const checkbox = screen.getByRole("checkbox", { name: /Include in Apply All/i });
    fireEvent.click(checkbox);
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    const next = onDraftChange.mock.calls[0]![0] as FilterModel;
    expect(next.rows[0]!.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-row Apply button
// ---------------------------------------------------------------------------

describe("FilterBar — per-row Apply button", () => {
  it("clicking calls onApplyOnlyRow with the row index", () => {
    const onApplyOnlyRow = vi.fn();
    const draft = modelWithRows(2);
    render(<FilterBar {...makeProps({ draft, onApplyOnlyRow })} />);
    const applyBtns = screen.getAllByRole("button", { name: /Apply only this row|Applied — click to re-apply/i });
    expect(applyBtns).toHaveLength(2);
    fireEvent.click(applyBtns[1]!);
    expect(onApplyOnlyRow).toHaveBeenCalledWith(1);
  });

  it("button reads 'Applied' (green) when row is structurally equal to an applied row", () => {
    const sharedRow = { enabled: true, column: { kind: "named" as const, name: "country" }, op: "=" as const, value: "CL" };
    const draft: FilterModel = { rows: [sharedRow], combinator: "AND" };
    const applied: FilterModel = { rows: [sharedRow], combinator: "AND" };
    render(<FilterBar {...makeProps({ draft, applied })} />);
    expect(screen.getByRole("button", { name: /Applied/i })).toBeInTheDocument();
  });

  it("button label flips back to Apply when an applied row is edited", () => {
    const sharedRow = { enabled: true, column: { kind: "named" as const, name: "country" }, op: "=" as const, value: "CL" };
    const applied: FilterModel = { rows: [sharedRow], combinator: "AND" };
    // Draft has the same row.
    const { rerender } = render(
      <FilterBar {...makeProps({ draft: { rows: [sharedRow], combinator: "AND" }, applied })} />,
    );
    expect(screen.getByRole("button", { name: /Applied/i })).toBeInTheDocument();

    // Draft changes — value edited.
    const dirtyDraft: FilterModel = {
      rows: [{ ...sharedRow, value: "US" }],
      combinator: "AND",
    };
    rerender(<FilterBar {...makeProps({ draft: dirtyDraft, applied })} />);
    // No longer Applied (structural equality broken).
    expect(screen.queryByRole("button", { name: /Applied — click/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Apply only this row/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Row insert and remove buttons
// ---------------------------------------------------------------------------

describe("FilterBar — + and − buttons", () => {
  it("+ button calls onDraftChange inserting a new row below", () => {
    const onDraftChange = vi.fn();
    const draft: FilterModel = {
      rows: [{ enabled: true, column: { kind: "any_column" }, op: "Contains", value: "a" }],
      combinator: "AND",
    };
    render(<FilterBar {...makeProps({ draft, onDraftChange })} />);
    fireEvent.click(screen.getByRole("button", { name: /Insert row below/i }));
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    const next = onDraftChange.mock.calls[0]![0] as FilterModel;
    expect(next.rows).toHaveLength(2);
  });

  it("− button calls onDraftChange removing the row", () => {
    const onDraftChange = vi.fn();
    const draft = modelWithRows(2);
    render(<FilterBar {...makeProps({ draft, onDraftChange })} />);
    const removeBtns = screen.getAllByRole("button", { name: /Remove row/i });
    fireEvent.click(removeBtns[0]!);
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    const next = onDraftChange.mock.calls[0]![0] as FilterModel;
    expect(next.rows).toHaveLength(1);
  });

  it("− button on last row clears to defaults instead of removing", () => {
    const onDraftChange = vi.fn();
    const draft: FilterModel = {
      rows: [{ enabled: false, column: { kind: "named", name: "id" }, op: "=", value: "42" }],
      combinator: "AND",
    };
    render(<FilterBar {...makeProps({ draft, onDraftChange })} />);
    fireEvent.click(screen.getByRole("button", { name: /Remove row/i }));
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    const next = onDraftChange.mock.calls[0]![0] as FilterModel;
    // Still has one row.
    expect(next.rows).toHaveLength(1);
    // Row is cleared to defaults.
    expect(next.rows[0]).toMatchObject({
      enabled: true,
      column: { kind: "any_column" },
      op: "Contains",
      value: "",
    });
  });
});

// ---------------------------------------------------------------------------
// Apply All button
// ---------------------------------------------------------------------------

describe("FilterBar — Apply All button", () => {
  it("clicking Apply All calls onApplyAll", () => {
    const onApplyAll = vi.fn();
    render(<FilterBar {...makeProps({ onApplyAll })} />);
    // Find the primary button by exact text content to avoid matching the chevron.
    const allBtns = screen.getAllByRole("button");
    const applyAllPrimary = allBtns.find((b) => b.textContent?.trim() === "Apply All" || b.textContent?.trim() === "Apply All (OR)");
    expect(applyAllPrimary).toBeTruthy();
    fireEvent.click(applyAllPrimary!);
    expect(onApplyAll).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Footer: SQL, Export, Unset
// ---------------------------------------------------------------------------

describe("FilterBar — footer buttons", () => {
  it("SQL button calls onSqlClick", () => {
    const onSqlClick = vi.fn();
    render(<FilterBar {...makeProps({ onSqlClick })} />);
    fireEvent.click(screen.getByRole("button", { name: /SQL/i }));
    expect(onSqlClick).toHaveBeenCalledTimes(1);
  });

  it("Export button is disabled and does not call any callback on click", () => {
    const onApplyAll = vi.fn();
    render(<FilterBar {...makeProps({ onApplyAll })} />);
    const exportBtn = screen.getByRole("button", { name: /Export/i });
    expect(exportBtn).toBeDisabled();
    fireEvent.click(exportBtn);
    expect(onApplyAll).not.toHaveBeenCalled();
  });

  it("Unset button calls onDraftChange with rows cleared to single empty row, combinator preserved", () => {
    const onDraftChange = vi.fn();
    const draft: FilterModel = {
      rows: [
        { enabled: true, column: { kind: "named", name: "id" }, op: "=", value: "1" },
        { enabled: true, column: { kind: "named", name: "country" }, op: "=", value: "CL" },
      ],
      combinator: "OR",
    };
    render(<FilterBar {...makeProps({ draft, onDraftChange })} />);
    fireEvent.click(screen.getByRole("button", { name: /Unset/i }));
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    const next = onDraftChange.mock.calls[0]![0] as FilterModel;
    expect(next.rows).toHaveLength(1);
    expect(next.rows[0]).toMatchObject({ enabled: true, column: { kind: "any_column" } });
    expect(next.combinator).toBe("OR");
  });
});

// ---------------------------------------------------------------------------
// Dirty pip
// ---------------------------------------------------------------------------

describe("FilterBar — dirty indicator", () => {
  it("dirty pip absent when draft equals applied", () => {
    render(<FilterBar {...makeProps()} />);
    expect(screen.queryByTitle(/Unsaved changes/i)).toBeNull();
  });

  it("dirty pip present when draft differs from applied", () => {
    const draft: FilterModel = {
      rows: [{ enabled: true, column: { kind: "named", name: "country" }, op: "=", value: "CL" }],
      combinator: "AND",
    };
    render(<FilterBar {...makeProps({ draft, applied: EMPTY_FILTER_MODEL })} />);
    expect(screen.getByTitle(/Unsaved changes/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Apply All chevron menu
// ---------------------------------------------------------------------------

describe("FilterBar — Apply All chevron menu", () => {
  it("chevron button is present and has role=button with accessible label", () => {
    render(<FilterBar {...makeProps()} />);
    const chevron = screen.getByRole("button", { name: /Apply All options/i });
    expect(chevron).toBeInTheDocument();
    expect(chevron).toHaveAttribute("aria-haspopup", "menu");
  });

  it("Apply All label shows '(OR)' suffix when draft.combinator is OR", () => {
    const draft: FilterModel = { rows: [], combinator: "OR" };
    render(<FilterBar {...makeProps({ draft })} />);
    const allBtns = screen.getAllByRole("button");
    const applyAllPrimary = allBtns.find((b) => b.textContent?.includes("Apply All"));
    expect(applyAllPrimary?.textContent?.trim()).toContain("OR");
  });

  it("⇧⌘↵ sets combinator to OR and calls onApplyAll", () => {
    const onDraftChange = vi.fn();
    const onApplyAll = vi.fn();
    const draft: FilterModel = { rows: [], combinator: "AND" };
    const { container } = render(<FilterBar {...makeProps({ draft, onDraftChange, onApplyAll })} />);
    const anyFocusable = container.querySelector("[data-filter-bar-root] button") as HTMLElement;
    anyFocusable?.focus();
    const barRoot = container.querySelector("[data-filter-bar-root]") as HTMLElement;
    fireEvent.keyDown(barRoot, { key: "Enter", metaKey: true, shiftKey: true });
    expect(onDraftChange).toHaveBeenCalled();
    const next = onDraftChange.mock.calls[0]![0] as FilterModel;
    expect(next.combinator).toBe("OR");
    expect(onApplyAll).toHaveBeenCalledTimes(1);
  });

  it("⌘↵ sets combinator to AND and calls onApplyAll", () => {
    const onDraftChange = vi.fn();
    const onApplyAll = vi.fn();
    const draft: FilterModel = { rows: [], combinator: "OR" };
    const { container } = render(<FilterBar {...makeProps({ draft, onDraftChange, onApplyAll })} />);
    const anyFocusable = container.querySelector("[data-filter-bar-root] button") as HTMLElement;
    anyFocusable?.focus();
    const barRoot = container.querySelector("[data-filter-bar-root]") as HTMLElement;
    fireEvent.keyDown(barRoot, { key: "Enter", metaKey: true, shiftKey: false });
    expect(onDraftChange).toHaveBeenCalled();
    const next = onDraftChange.mock.calls[0]![0] as FilterModel;
    expect(next.combinator).toBe("AND");
    expect(onApplyAll).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts (⌘I, ⌘⇧I, ⌘↑, ⌘↓, ⌘←, ⌘↵, ⇧⌘↵)
// ---------------------------------------------------------------------------

describe("FilterBar — keyboard shortcuts", () => {
  it("⌘I inserts a row below the focused row", () => {
    const onDraftChange = vi.fn();
    const draft = modelWithRows(1);
    const { container } = render(<FilterBar {...makeProps({ draft, onDraftChange })} />);
    const checkbox = container.querySelector("[data-filter-row-index='0'] input[type='checkbox']") as HTMLElement;
    checkbox?.focus();
    const barRoot = container.querySelector("[data-filter-bar-root]") as HTMLElement;
    fireEvent.keyDown(barRoot, { key: "i", metaKey: true, shiftKey: false });
    expect(onDraftChange).toHaveBeenCalled();
    const next = onDraftChange.mock.calls[0]![0] as FilterModel;
    expect(next.rows).toHaveLength(2);
  });

  it("⌘⇧I removes the focused row", () => {
    const onDraftChange = vi.fn();
    const draft = modelWithRows(2);
    const { container } = render(<FilterBar {...makeProps({ draft, onDraftChange })} />);
    const checkbox = container.querySelector("[data-filter-row-index='1'] input[type='checkbox']") as HTMLElement;
    checkbox?.focus();
    const barRoot = container.querySelector("[data-filter-bar-root]") as HTMLElement;
    fireEvent.keyDown(barRoot, { key: "i", metaKey: true, shiftKey: true });
    expect(onDraftChange).toHaveBeenCalled();
    const next = onDraftChange.mock.calls[0]![0] as FilterModel;
    expect(next.rows).toHaveLength(1);
  });

  it("⌘⇧I on single row clears it to defaults", () => {
    const onDraftChange = vi.fn();
    const draft: FilterModel = {
      rows: [{ enabled: true, column: { kind: "named", name: "id" }, op: "=", value: "99" }],
      combinator: "AND",
    };
    const { container } = render(<FilterBar {...makeProps({ draft, onDraftChange })} />);
    const checkbox = container.querySelector("[data-filter-row-index='0'] input[type='checkbox']") as HTMLElement;
    checkbox?.focus();
    const barRoot = container.querySelector("[data-filter-bar-root]") as HTMLElement;
    fireEvent.keyDown(barRoot, { key: "i", metaKey: true, shiftKey: true });
    expect(onDraftChange).toHaveBeenCalled();
    const next = onDraftChange.mock.calls[0]![0] as FilterModel;
    expect(next.rows).toHaveLength(1);
    expect(next.rows[0]).toMatchObject({ enabled: true, column: { kind: "any_column" } });
  });

  it("⌘↑ moves focus to same control on the row above", () => {
    const draft = modelWithRows(2);
    const { container } = render(<FilterBar {...makeProps({ draft })} />);
    const checkbox1 = container.querySelector("[data-filter-row-index='1'] input[type='checkbox']") as HTMLElement;
    checkbox1?.focus();
    const barRoot = container.querySelector("[data-filter-bar-root]") as HTMLElement;
    fireEvent.keyDown(barRoot, { key: "ArrowUp", metaKey: true });
    // Focus should move up — active element is somewhere in row 0.
    const row0 = container.querySelector("[data-filter-row-index='0']") as HTMLElement;
    expect(row0?.contains(document.activeElement)).toBe(true);
  });

  it("⌘↓ moves focus to same control on the row below", () => {
    const draft = modelWithRows(2);
    const { container } = render(<FilterBar {...makeProps({ draft })} />);
    const checkbox0 = container.querySelector("[data-filter-row-index='0'] input[type='checkbox']") as HTMLElement;
    checkbox0?.focus();
    const barRoot = container.querySelector("[data-filter-bar-root]") as HTMLElement;
    fireEvent.keyDown(barRoot, { key: "ArrowDown", metaKey: true });
    const row1 = container.querySelector("[data-filter-row-index='1']") as HTMLElement;
    expect(row1?.contains(document.activeElement)).toBe(true);
  });

  it("⌘↵ calls onApplyAll and sets combinator to AND", () => {
    const onApplyAll = vi.fn();
    const onDraftChange = vi.fn();
    const draft: FilterModel = { rows: [], combinator: "OR" };
    const { container } = render(<FilterBar {...makeProps({ draft, onApplyAll, onDraftChange })} />);
    const anyFocusable = container.querySelector("[data-filter-bar-root] button") as HTMLElement;
    anyFocusable?.focus();
    const barRoot = container.querySelector("[data-filter-bar-root]") as HTMLElement;
    fireEvent.keyDown(barRoot, { key: "Enter", metaKey: true, shiftKey: false });
    expect(onApplyAll).toHaveBeenCalled();
    expect(onDraftChange).toHaveBeenCalled();
    const next = onDraftChange.mock.calls[0]![0] as FilterModel;
    expect(next.combinator).toBe("AND");
  });

  it("⇧⌘↵ calls onApplyAll and sets combinator to OR", () => {
    const onApplyAll = vi.fn();
    const onDraftChange = vi.fn();
    const draft: FilterModel = { rows: [], combinator: "AND" };
    const { container } = render(<FilterBar {...makeProps({ draft, onApplyAll, onDraftChange })} />);
    const anyFocusable = container.querySelector("[data-filter-bar-root] button") as HTMLElement;
    anyFocusable?.focus();
    const barRoot = container.querySelector("[data-filter-bar-root]") as HTMLElement;
    fireEvent.keyDown(barRoot, { key: "Enter", metaKey: true, shiftKey: true });
    expect(onApplyAll).toHaveBeenCalled();
    expect(onDraftChange).toHaveBeenCalled();
    const next = onDraftChange.mock.calls[0]![0] as FilterModel;
    expect(next.combinator).toBe("OR");
  });
});

// ---------------------------------------------------------------------------
// Imperative focus handle
// ---------------------------------------------------------------------------

describe("FilterBar — forwardRef focus() handle", () => {
  it("focus() focuses the first row's value input when it exists", () => {
    const ref = createRef<FilterBarHandle>();
    const draft: FilterModel = {
      rows: [{ enabled: true, column: { kind: "any_column" }, op: "Contains", value: "" }],
      combinator: "AND",
    };
    const { container } = render(<FilterBar ref={ref} {...makeProps({ draft })} />);
    ref.current?.focus();
    const valueInput = container.querySelector(
      "[data-filter-row-index='0'] [data-filter-control='value'] input",
    ) as HTMLElement | null;
    if (valueInput) {
      expect(document.activeElement).toBe(valueInput);
    } else {
      // Fallback to column picker button — also acceptable.
      const colBtn = container.querySelector(
        "[data-filter-row-index='0'] [data-filter-control='column'] button",
      ) as HTMLElement | null;
      expect(document.activeElement).toBe(colBtn);
    }
  });
});

// ---------------------------------------------------------------------------
// RAW filter row
// ---------------------------------------------------------------------------

describe("FilterBar — RAW filter row", () => {
  it("picking Raw SQL shows the expression input and hides the operator picker", async () => {
    const onDraftChange = vi.fn();
    const draft: FilterModel = {
      rows: [{ enabled: true, column: { kind: "any_column" }, op: "Contains", value: "" }],
      combinator: "AND",
    };
    render(<FilterBar {...makeProps({ draft, onDraftChange })} />);

    // Open the column picker
    const columnTrigger = screen.getByRole("button", { name: /Any column/i });
    fireEvent.click(columnTrigger);

    // Click "Raw SQL"
    const rawSqlOption = screen.getByRole("button", { name: /Raw SQL/i });
    fireEvent.click(rawSqlOption);

    // onDraftChange should have been called with a RAW row
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    const next = onDraftChange.mock.calls[0]![0] as FilterModel;
    expect(next.rows[0]!.column).toEqual({ kind: "raw" });
    expect(next.rows[0]!.op).toBe("RAW");
  });

  it("RAW row renders expression input (aria-label 'Raw SQL expression') and hides operator picker", () => {
    const draft: FilterModel = {
      rows: [{ enabled: true, column: { kind: "raw" }, op: "RAW", value: "id > 0" }],
      combinator: "AND",
    };
    render(<FilterBar {...makeProps({ draft })} />);

    // Expression input must be present
    expect(screen.getByRole("textbox", { name: /Raw SQL expression/i })).toBeInTheDocument();
    // Operator picker must NOT be present (no combobox/select with aria-label "Operator")
    expect(screen.queryByRole("combobox", { name: /Operator/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Operator/i })).toBeNull();
  });

  it("switching back from Raw SQL to a named column restores the operator picker", async () => {
    const onDraftChange = vi.fn();
    const draft: FilterModel = {
      rows: [{ enabled: true, column: { kind: "raw" }, op: "RAW", value: "id > 0" }],
      combinator: "AND",
    };
    render(<FilterBar {...makeProps({ draft, onDraftChange })} />);

    // Open column picker (button shows "Raw SQL")
    const columnTrigger = screen.getByRole("button", { name: /Raw SQL/i });
    fireEvent.click(columnTrigger);

    // Pick a named column
    const countryOption = screen.getByRole("button", { name: /^country/i });
    fireEvent.click(countryOption);

    expect(onDraftChange).toHaveBeenCalledTimes(1);
    const next = onDraftChange.mock.calls[0]![0] as FilterModel;
    expect(next.rows[0]!.column).toEqual({ kind: "named", name: "country" });
    // op should no longer be RAW (coerced to a valid op for the named column)
    expect(next.rows[0]!.op).not.toBe("RAW");
  });

  it("RAW row can be removed via the − button without affecting sibling rows", () => {
    const onDraftChange = vi.fn();
    const draft: FilterModel = {
      rows: [
        { enabled: true, column: { kind: "named", name: "status" }, op: "=", value: "active" },
        { enabled: true, column: { kind: "raw" }, op: "RAW", value: "id > 0" },
      ],
      combinator: "AND",
    };
    render(<FilterBar {...makeProps({ draft, onDraftChange })} />);

    const removeBtns = screen.getAllByRole("button", { name: /Remove row/i });
    // Remove the second row (index 1, the RAW row)
    fireEvent.click(removeBtns[1]!);

    expect(onDraftChange).toHaveBeenCalledTimes(1);
    const next = onDraftChange.mock.calls[0]![0] as FilterModel;
    expect(next.rows).toHaveLength(1);
    expect(next.rows[0]!.column).toEqual({ kind: "named", name: "status" });
    expect(next.rows[0]!.value).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// No filters enabled transient status
// ---------------------------------------------------------------------------

describe("FilterBar — Apply All with no enabled rows", () => {
  it("shows 'No filters enabled' transient status when all rows are unchecked", async () => {
    const draft: FilterModel = {
      rows: [{ enabled: false, column: { kind: "any_column" }, op: "Contains", value: "x" }],
      combinator: "AND",
    };
    render(<FilterBar {...makeProps({ draft })} />);
    const allBtns = screen.getAllByRole("button");
    const applyAllPrimary = allBtns.find((b) => b.textContent?.trim() === "Apply All" || b.textContent?.trim() === "Apply All (OR)");
    fireEvent.click(applyAllPrimary!);
    await waitFor(() =>
      expect(screen.getByText(/No filters enabled/i)).toBeInTheDocument(),
    );
  });
});

// ---------------------------------------------------------------------------
// Plain Enter / Shift+Enter keyboard behavior (issue #198)
// ---------------------------------------------------------------------------

describe("FilterBar — plain Enter applies focused row", () => {
  // 3.1: Plain Enter with focus inside row 1 calls onApplyOnlyRow(1), not onApplyAll.
  it("plain Enter with focus inside row 1 calls onApplyOnlyRow(1) and not onApplyAll", () => {
    const onApplyOnlyRow = vi.fn();
    const onApplyAll = vi.fn();
    const draft = modelWithRows(2);
    const { container } = render(
      <FilterBar {...makeProps({ draft, onApplyOnlyRow, onApplyAll })} />,
    );
    // Focus an element inside row 1 (its checkbox).
    const checkbox1 = container.querySelector(
      "[data-filter-row-index='1'] input[type='checkbox']",
    ) as HTMLElement;
    checkbox1?.focus();
    const barRoot = container.querySelector("[data-filter-bar-root]") as HTMLElement;
    fireEvent.keyDown(barRoot, { key: "Enter" });
    expect(onApplyOnlyRow).toHaveBeenCalledWith(1);
    expect(onApplyAll).not.toHaveBeenCalled();
  });

  // 3.2: Plain Enter applies focused row even when that row's enabled checkbox is unchecked.
  it("plain Enter applies the focused row even when its enabled checkbox is unchecked", () => {
    const onApplyOnlyRow = vi.fn();
    const onDraftChange = vi.fn();
    const draft: FilterModel = {
      rows: [
        { enabled: true, column: { kind: "named", name: "id" }, op: "=", value: "1" },
        { enabled: false, column: { kind: "named", name: "country" }, op: "Contains", value: "CL" },
      ],
      combinator: "AND",
    };
    const { container } = render(
      <FilterBar {...makeProps({ draft, onApplyOnlyRow, onDraftChange })} />,
    );
    // Focus an element inside row 1 (the unchecked row).
    const checkbox1 = container.querySelector(
      "[data-filter-row-index='1'] input[type='checkbox']",
    ) as HTMLElement;
    checkbox1?.focus();
    const barRoot = container.querySelector("[data-filter-bar-root]") as HTMLElement;
    fireEvent.keyDown(barRoot, { key: "Enter" });
    expect(onApplyOnlyRow).toHaveBeenCalledWith(1);
    // enabled flag must NOT have been changed by the Enter gesture.
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  // 3.3: Shift+Enter (no meta) calls onApplyAll, not onApplyOnlyRow.
  it("Shift+Enter calls onApplyAll and does NOT call onApplyOnlyRow", () => {
    const onApplyOnlyRow = vi.fn();
    const onApplyAll = vi.fn();
    const draft = modelWithRows(2);
    const { container } = render(
      <FilterBar {...makeProps({ draft, onApplyOnlyRow, onApplyAll })} />,
    );
    const checkbox1 = container.querySelector(
      "[data-filter-row-index='1'] input[type='checkbox']",
    ) as HTMLElement;
    checkbox1?.focus();
    const barRoot = container.querySelector("[data-filter-bar-root]") as HTMLElement;
    fireEvent.keyDown(barRoot, { key: "Enter", shiftKey: true });
    expect(onApplyAll).toHaveBeenCalled();
    expect(onApplyOnlyRow).not.toHaveBeenCalled();
  });

  // 3.4: Enter in a chip input with non-empty value does NOT call onApplyOnlyRow or onApplyAll.
  it("Enter in a chip input with non-empty draft text does NOT call onApplyOnlyRow or onApplyAll", () => {
    const onApplyOnlyRow = vi.fn();
    const onApplyAll = vi.fn();
    const draft = modelWithRows(1);
    const { container } = render(
      <FilterBar {...makeProps({ draft, onApplyOnlyRow, onApplyAll })} />,
    );
    // Simulate a chip input: create a focused input inside the bar root with dataset.chipInput=true and a non-empty value.
    const barRoot = container.querySelector("[data-filter-bar-root]") as HTMLElement;
    const fakeChipInput = document.createElement("input");
    fakeChipInput.dataset.chipInput = "true";
    fakeChipInput.value = "some text";
    barRoot.appendChild(fakeChipInput);
    fakeChipInput.focus();
    fireEvent.keyDown(barRoot, { key: "Enter" });
    expect(onApplyOnlyRow).not.toHaveBeenCalled();
    expect(onApplyAll).not.toHaveBeenCalled();
    // Cleanup.
    barRoot.removeChild(fakeChipInput);
  });

  // 3.5: Footer renders both "Apply row: ↵" and "Apply All: ⇧↵" hints.
  it("footer hint strip renders 'Apply row:' with ↵ and 'Apply All:' with ⇧↵", () => {
    render(<FilterBar {...makeProps()} />);
    expect(screen.getByText(/Apply row:/i)).toBeInTheDocument();
    expect(screen.getByText(/Apply All:/i)).toBeInTheDocument();
    // FilterKeyHint renders keys as text inside <kbd> elements.
    // Check that both key hints exist in the document.
    const kbdEls = document.querySelectorAll("kbd");
    const kbdTexts = Array.from(kbdEls).map((el) => el.textContent);
    expect(kbdTexts).toContain("↵");
    expect(kbdTexts).toContain("⇧↵");
  });
});
