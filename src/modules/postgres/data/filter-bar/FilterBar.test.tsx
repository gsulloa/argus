import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { FilterBar } from "./FilterBar";
import {
  EMPTY_FILTER_MODEL,
  modelToPayload,
  type DataColumn,
  type FilterModel,
} from "../types";

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
      tree: { children: [] },
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
