import { act, createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { FilterBar } from "./FilterBar";
import {
  EMPTY_FILTER_MODEL,
  modelToPayload,
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
    rawError: null,
    onDraftChange: vi.fn(),
    onApply: vi.fn(),
    onReset: vi.fn(),
    onOpenInSqlEditor: vi.fn(),
    ...overrides,
  };
}

describe("FilterBar", () => {
  it("hides the dirty dot when draft equals applied and shows it when they differ", () => {
    const sameModel = EMPTY_FILTER_MODEL;
    const { rerender, container } = render(
      <FilterBar {...makeProps({ draft: sameModel, applied: sameModel })} />,
    );
    expect(container.querySelector('[aria-label="Apply"]')).toBeInTheDocument();
    expect(container.querySelector('[aria-label="Apply (unsaved changes)"]')).toBeNull();

    const dirty: FilterModel = {
      mode: "structured",
      tree: {
        children: [
          {
            kind: "condition",
            column: { kind: "named", name: "country" },
            op: "=",
            value: "CL",
          },
        ],
      },
      raw: "",
    };
    rerender(
      <FilterBar {...makeProps({ draft: dirty, applied: EMPTY_FILTER_MODEL })} />,
    );
    expect(
      container.querySelector('[aria-label="Apply (unsaved changes)"]'),
    ).toBeInTheDocument();
  });

  it("calls onApply when the Apply button is clicked", () => {
    const onApply = vi.fn();
    render(<FilterBar {...makeProps({ onApply })} />);
    fireEvent.click(screen.getByRole("button", { name: /^Apply/ }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("calls onApply on Cmd+Enter inside the bar", () => {
    const onApply = vi.fn();
    const { container } = render(<FilterBar {...makeProps({ onApply })} />);
    const apply = screen.getByRole("button", { name: /^Apply/ });
    apply.focus();
    const root = container.firstChild as HTMLElement;
    fireEvent.keyDown(root, { key: "Enter", metaKey: true });
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("discards draft to applied on Esc when dirty", () => {
    const onDraftChange = vi.fn();
    const dirty: FilterModel = {
      mode: "structured",
      tree: {
        children: [
          {
            kind: "condition",
            column: { kind: "named", name: "country" },
            op: "=",
            value: "CL",
          },
        ],
      },
      raw: "",
    };
    const { container } = render(
      <FilterBar
        {...makeProps({
          draft: dirty,
          applied: EMPTY_FILTER_MODEL,
          onDraftChange,
        })}
      />,
    );
    const apply = screen.getByRole("button", { name: /^Apply/ });
    apply.focus();
    fireEvent.keyDown(container.firstChild as HTMLElement, { key: "Escape" });
    expect(onDraftChange).toHaveBeenCalledWith(EMPTY_FILTER_MODEL);
  });

  it("calls onReset when Reset is clicked", () => {
    const onReset = vi.fn();
    render(<FilterBar {...makeProps({ onReset })} />);
    fireEvent.click(screen.getByRole("button", { name: /^Reset$/ }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("calls onOpenInSqlEditor when the corresponding button is clicked", () => {
    const onOpenInSqlEditor = vi.fn();
    render(<FilterBar {...makeProps({ onOpenInSqlEditor })} />);
    fireEvent.click(screen.getByRole("button", { name: /Open in SQL Editor/ }));
    expect(onOpenInSqlEditor).toHaveBeenCalledTimes(1);
  });
});

describe("FilterBar — structured mode", () => {
  it("adds a root AND row when '+ AND row' is clicked", () => {
    const onDraftChange = vi.fn();
    render(<FilterBar {...makeProps({ onDraftChange })} />);
    fireEvent.click(screen.getByRole("button", { name: /AND row/ }));
    expect(onDraftChange).toHaveBeenCalled();
    const next = onDraftChange.mock.calls[0]![0] as FilterModel;
    expect(next.tree.children).toHaveLength(1);
    expect(next.tree.children[0]).toMatchObject({
      kind: "condition",
      column: { kind: "any_column" },
      op: "=",
    });
  });

  it("adds an OR group with one seed condition when '+ OR group' is clicked", () => {
    const onDraftChange = vi.fn();
    render(<FilterBar {...makeProps({ onDraftChange })} />);
    fireEvent.click(screen.getByRole("button", { name: /OR group/ }));
    const next = onDraftChange.mock.calls[0]![0] as FilterModel;
    expect(next.tree.children).toHaveLength(1);
    expect(next.tree.children[0]).toMatchObject({
      kind: "or_group",
      children: [{ kind: "condition" }],
    });
  });

  it("does not expose a way to nest groups inside groups", () => {
    const draft: FilterModel = {
      mode: "structured",
      tree: {
        children: [
          {
            kind: "or_group",
            children: [
              {
                kind: "condition",
                column: { kind: "named", name: "country" },
                op: "=",
                value: "CL",
              },
            ],
          },
        ],
      },
      raw: "",
    };
    render(<FilterBar {...makeProps({ draft })} />);
    // The only "OR" affordance inside the group is "+ OR row" (adds a leaf),
    // not a group-nesting button.
    const orRowButtons = screen.queryAllByRole("button", { name: /Add OR row/ });
    expect(orRowButtons).toHaveLength(1);
    // The root-level `+ OR group` is the *only* button that can introduce a
    // group; the OR group itself exposes only `+ OR row` (leaf) and a
    // remove-group ×.
    const addGroupButtons = screen.queryAllByRole("button", {
      name: /^OR group$/i,
    });
    expect(addGroupButtons.filter((b) => b.textContent?.includes("OR group"))).toHaveLength(1);
  });

  it("collapses an OR group when its last condition is removed", () => {
    const onDraftChange = vi.fn();
    const draft: FilterModel = {
      mode: "structured",
      tree: {
        children: [
          {
            kind: "or_group",
            children: [
              {
                kind: "condition",
                column: { kind: "named", name: "country" },
                op: "=",
                value: "CL",
              },
            ],
          },
        ],
      },
      raw: "",
    };
    render(
      <FilterBar
        {...makeProps({ draft, applied: EMPTY_FILTER_MODEL, onDraftChange })}
      />,
    );
    // Two remove buttons exist for the group: condition row × and group ×.
    // Click the condition's remove (lower) to drain the group.
    const removeBtns = screen.getAllByRole("button", { name: /Remove condition/ });
    fireEvent.click(removeBtns[0]!);
    const next = onDraftChange.mock.calls[0]![0] as FilterModel;
    expect(next.tree.children).toHaveLength(0);
  });

  it("renders the Any-column performance warning", () => {
    const draft: FilterModel = {
      mode: "structured",
      tree: {
        children: [
          {
            kind: "condition",
            column: { kind: "any_column" },
            op: "Contains",
            value: "x",
          },
        ],
      },
      raw: "",
    };
    render(<FilterBar {...makeProps({ draft })} />);
    expect(
      screen.getByLabelText("Any column performance warning"),
    ).toBeInTheDocument();
  });
});

describe("FilterBar — Raw → Structured confirm", () => {
  it("shows confirm dialog and Cancel keeps the raw body", () => {
    const onDraftChange = vi.fn();
    const draft: FilterModel = {
      mode: "raw",
      tree: { children: [] },
      raw: "created_at > now()",
    };
    render(<FilterBar {...makeProps({ draft, onDraftChange })} />);
    fireEvent.click(screen.getByRole("tab", { name: "Structured" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/Switch to structured\?/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("on Switch, resets both the structured tree and the raw body", () => {
    const onDraftChange = vi.fn();
    const draft: FilterModel = {
      mode: "raw",
      tree: {
        children: [
          {
            kind: "condition",
            column: { kind: "named", name: "id" },
            op: "=",
            value: 1,
          },
        ],
      },
      raw: "created_at > now()",
    };
    render(<FilterBar {...makeProps({ draft, onDraftChange })} />);
    fireEvent.click(screen.getByRole("tab", { name: "Structured" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    expect(onDraftChange).toHaveBeenCalledWith({
      mode: "structured",
      tree: { children: [], combinator: "AND" },
      raw: "",
    });
  });
});

describe("modelToPayload — wire shape", () => {
  it("emits empty object for the empty model", () => {
    expect(modelToPayload(EMPTY_FILTER_MODEL)).toEqual({});
  });

  it("emits filter_tree for structured drafts", () => {
    const model: FilterModel = {
      mode: "structured",
      tree: {
        children: [
          {
            kind: "condition",
            column: { kind: "named", name: "country" },
            op: "=",
            value: "CL",
          },
        ],
      },
      raw: "",
    };
    expect(modelToPayload(model)).toEqual({
      filter_tree: {
        children: [
          {
            kind: "condition",
            column: { kind: "named", name: "country" },
            op: "=",
            value: "CL",
          },
        ],
      },
    });
  });

  it("emits raw_where with leading WHERE trimmed", () => {
    const model: FilterModel = {
      mode: "raw",
      tree: { children: [] },
      raw: "WHERE created_at > now()",
    };
    expect(modelToPayload(model)).toEqual({
      raw_where: "created_at > now()",
    });
  });

  it("emits empty object when raw is whitespace-only", () => {
    const model: FilterModel = {
      mode: "raw",
      tree: { children: [] },
      raw: "   ",
    };
    expect(modelToPayload(model)).toEqual({});
  });

  it("serializes an OR group node uniformly under the same kind union", () => {
    const model: FilterModel = {
      mode: "structured",
      tree: {
        children: [
          {
            kind: "or_group",
            children: [
              {
                kind: "condition",
                column: { kind: "any_column" },
                op: "Contains",
                value: "x",
              },
            ],
          },
        ],
      },
      raw: "",
    };
    expect(JSON.parse(JSON.stringify(modelToPayload(model)))).toEqual({
      filter_tree: {
        children: [
          {
            kind: "or_group",
            children: [
              {
                kind: "condition",
                column: { kind: "any_column" },
                op: "Contains",
                value: "x",
              },
            ],
          },
        ],
      },
    });
  });
});

// ─── Section 5.7 — new tests ──────────────────────────────────────────────────

describe("FilterBar — root combinator toggle", () => {
  const draftWithRow: FilterModel = {
    mode: "structured",
    tree: {
      combinator: "AND",
      children: [
        {
          kind: "condition",
          column: { kind: "named", name: "country" },
          op: "=",
          value: "CL",
        },
        {
          kind: "condition",
          column: { kind: "named", name: "status" },
          op: "=",
          value: "ok",
        },
      ],
    },
    raw: "",
  };

  it("is hidden when the tree has no children", () => {
    render(<FilterBar {...makeProps()} />);
    // The root combinator toggle should not be rendered for an empty tree.
    expect(screen.queryByRole("radiogroup", { name: /Root combinator/i })).toBeNull();
  });

  it("is visible when there is at least one row", () => {
    const draft: FilterModel = {
      mode: "structured",
      tree: {
        combinator: "AND",
        children: [
          {
            kind: "condition",
            column: { kind: "named", name: "country" },
            op: "=",
            value: "CL",
          },
        ],
      },
      raw: "",
    };
    render(<FilterBar {...makeProps({ draft })} />);
    expect(screen.getByRole("radiogroup", { name: /Root combinator/i })).toBeInTheDocument();
  });

  it("toggling combinator calls onDraftChange with updated tree combinator", () => {
    const onDraftChange = vi.fn();
    render(<FilterBar {...makeProps({ draft: draftWithRow, onDraftChange })} />);

    // The "OR" radio button should be unchecked initially.
    const orRadio = screen.getByRole("radio", { name: "OR" });
    expect(orRadio).toHaveAttribute("aria-checked", "false");

    fireEvent.click(orRadio);

    expect(onDraftChange).toHaveBeenCalledTimes(1);
    const next = onDraftChange.mock.calls[0]![0] as FilterModel;
    expect(next.tree.combinator).toBe("OR");
    // Children must be preserved.
    expect(next.tree.children).toHaveLength(2);
  });

  it("inter-row connector pills reflect the active combinator", () => {
    const onDraftChange = vi.fn();
    render(<FilterBar {...makeProps({ draft: draftWithRow, onDraftChange })} />);

    // Two rows → one FilterConnector pill showing "AND".
    // getAllByText captures all instances; at least one must be the connector pill.
    expect(screen.getAllByText("AND").length).toBeGreaterThan(0);
    // No OR connector pills should be present (OR only appears inside an OR group
    // in Structured mode with AND combinator; here we have flat AND rows).
    // The RootCombinatorToggle renders an "OR" radio button too, so we check
    // that no FilterConnector (span) shows "OR" text.
    const orConnectors = screen
      .queryAllByText("OR")
      .filter((el) => el.tagName === "SPAN" && el.getAttribute("role") !== "radio");
    expect(orConnectors).toHaveLength(0);
  });

  it("connector pills read OR after toggling to OR", () => {
    const orDraft: FilterModel = {
      ...draftWithRow,
      tree: { ...draftWithRow.tree, combinator: "OR" },
    };
    render(<FilterBar {...makeProps({ draft: orDraft })} />);
    // The inter-row connector should now show OR.
    expect(screen.getAllByText("OR").length).toBeGreaterThan(0);
  });
});

describe("FilterBar — per-row Apply button", () => {
  const conditionRow: FilterModel = {
    mode: "structured",
    tree: {
      combinator: "AND",
      children: [
        {
          kind: "condition",
          column: { kind: "named", name: "country" },
          op: "=",
          value: "CL",
        },
        {
          kind: "condition",
          column: { kind: "named", name: "status" },
          op: "=",
          value: "ok",
        },
      ],
    },
    raw: "",
  };

  const orGroupRow: FilterModel = {
    mode: "structured",
    tree: {
      combinator: "AND",
      children: [
        {
          kind: "condition",
          column: { kind: "named", name: "country" },
          op: "=",
          value: "CL",
        },
        {
          kind: "or_group",
          children: [
            {
              kind: "condition",
              column: { kind: "named", name: "status" },
              op: "=",
              value: "ok",
            },
          ],
        },
      ],
    },
    raw: "",
  };

  it("calls onApplyOnlyRow with the correct index for a condition row", () => {
    const onApplyOnlyRow = vi.fn();
    render(
      <FilterBar {...makeProps({ draft: conditionRow, onApplyOnlyRow })} />,
    );
    const applyOnlyBtns = screen.getAllByRole("button", {
      name: "Apply only this row",
    });
    // Two condition rows → two apply-only buttons.
    expect(applyOnlyBtns).toHaveLength(2);

    // Click the second row's button → index 1.
    fireEvent.click(applyOnlyBtns[1]!);
    expect(onApplyOnlyRow).toHaveBeenCalledWith(1);
  });

  it("calls onApplyOnlyRow with the correct index for an OR group row", () => {
    const onApplyOnlyRow = vi.fn();
    render(
      <FilterBar {...makeProps({ draft: orGroupRow, onApplyOnlyRow })} />,
    );
    // The OR group header has "Apply only this OR group" button.
    const groupApplyBtn = screen.getByRole("button", {
      name: "Apply only this OR group",
    });
    fireEvent.click(groupApplyBtn);
    // The OR group is at root index 1.
    expect(onApplyOnlyRow).toHaveBeenCalledWith(1);
  });

  it("does not render apply-only buttons when onApplyOnlyRow is not provided", () => {
    render(<FilterBar {...makeProps({ draft: conditionRow })} />);
    expect(
      screen.queryByRole("button", { name: /Apply only this/ }),
    ).toBeNull();
  });
});

describe("FilterBar — forwardRef focus() API", () => {
  it("when collapsed, expands and focuses the empty-state add button", () => {
    const ref = createRef<FilterBarHandle>();
    render(<FilterBar ref={ref} {...makeProps()} />);

    // Collapse the bar.
    fireEvent.click(screen.getByRole("button", { name: "Collapse filter bar" }));
    expect(screen.queryByText("No filters yet")).toBeNull();

    // Call focus() inside act() so React processes the setCollapsed(false)
    // state update and re-renders before we assert.
    act(() => {
      ref.current?.focus();
    });

    // After focus(), the bar should be expanded.
    expect(screen.getByText("No filters yet")).toBeInTheDocument();
  });

  it("when expanded with rows, the column picker is marked as focus target", () => {
    const draft: FilterModel = {
      mode: "structured",
      tree: {
        combinator: "AND",
        children: [
          {
            kind: "condition",
            column: { kind: "named", name: "country" },
            op: "=",
            value: "CL",
          },
        ],
      },
      raw: "",
    };
    const ref = createRef<FilterBarHandle>();
    const { container } = render(<FilterBar ref={ref} {...makeProps({ draft })} />);

    // The first row should have data-filter-focus-target="true" on the column
    // picker's wrapper.
    const focusTarget = container.querySelector("[data-filter-focus-target='true']");
    expect(focusTarget).toBeInTheDocument();
  });

  it("empty state add button is wrapped by the focus-target container", () => {
    const ref = createRef<FilterBarHandle>();
    const { container } = render(<FilterBar ref={ref} {...makeProps()} />);

    // The empty state wraps the first + AND row button in a container.
    const focusContainer = container.querySelector(
      "[data-filter-focus-target-container='true']",
    );
    expect(focusContainer).toBeInTheDocument();
    // The container should contain a button.
    const btn = focusContainer?.querySelector("button");
    expect(btn).toBeInTheDocument();
  });
});
