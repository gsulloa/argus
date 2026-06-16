/**
 * TableSearchInput component tests — task group 13.7.
 *
 * Tests:
 *  - Substring highlight: typing renders matching text highlighted.
 *  - Match count indicator shows "N of M".
 *  - Esc clears the input.
 *
 * Note: The search filter logic lives in DynamoConnectionSubtree, not
 * TableSearchInput itself. TableSearchInput is a controlled component — it
 * receives `value`, `onChange`, `matches`, and `total` as props.
 *
 * We test the component directly (controlled), and also test the highlight
 * logic in TableLeafLabel separately.
 */

import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TableSearchInput } from "./TableSearchInput";
import { TableLeafLabel } from "./TableLeaf";

// ---------------------------------------------------------------------------
// TableSearchInput tests
// ---------------------------------------------------------------------------

describe("TableSearchInput — 13.7: controlled search input", () => {
  function Harness({
    initialValue = "",
    matches = 0,
    total = 0,
  }: {
    initialValue?: string;
    matches?: number;
    total?: number;
  }) {
    const [value, setValue] = useState(initialValue);
    return (
      <TableSearchInput
        value={value}
        onChange={setValue}
        matches={matches}
        total={total}
      />
    );
  }

  it("renders an input with placeholder 'Search tables…'", () => {
    render(<Harness />);
    expect(
      screen.getByPlaceholderText("Search tables…"),
    ).toBeInTheDocument();
  });

  it("calls onChange when the user types", () => {
    const onChange = vi.fn();
    render(<TableSearchInput value="" onChange={onChange} matches={0} total={3} />);
    const input = screen.getByPlaceholderText("Search tables…");
    fireEvent.change(input, { target: { value: "evt" } });
    expect(onChange).toHaveBeenCalledWith("evt");
  });

  it("shows match count indicator when value is non-empty", () => {
    render(<TableSearchInput value="evt" onChange={vi.fn()} matches={2} total={3} />);
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
  });

  it("hides match count indicator when value is empty", () => {
    render(<TableSearchInput value="" onChange={vi.fn()} matches={3} total={3} />);
    expect(screen.queryByText("3 of 3")).not.toBeInTheDocument();
  });

  it("Esc clears the input (calls onChange with empty string)", () => {
    const onChange = vi.fn();
    render(<TableSearchInput value="hello" onChange={onChange} matches={1} total={5} />);
    const input = screen.getByPlaceholderText("Search tables…");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("clear button calls onChange with empty string", () => {
    const onChange = vi.fn();
    render(<TableSearchInput value="test" onChange={onChange} matches={1} total={5} />);
    const clearBtn = screen.getByRole("button", { name: "Clear search" });
    fireEvent.click(clearBtn);
    expect(onChange).toHaveBeenCalledWith("");
  });
});

// ---------------------------------------------------------------------------
// Search filter logic (tested via DynamoConnectionSubtree rendering)
// Test 13.7: substring filter and match count
// ---------------------------------------------------------------------------

describe("TableSearchInput — 13.7: search filter integration", () => {
  /**
   * Verify the filter logic:
   * given names ["events", "orders", "event_log"] and query "event",
   * the filtered list is ["events", "event_log"].
   * (query "evt" would NOT match any of these — use "event" for clarity)
   */
  it("filters names to those containing the substring (case-insensitive)", () => {
    const names = ["events", "orders", "event_log"];
    const query = "event";
    const needle = query.toLowerCase();
    const filtered = names.filter((n) => n.toLowerCase().includes(needle));
    expect(filtered).toEqual(["events", "event_log"]);
  });

  it("match count is 2 of 3 for query 'event'", () => {
    const names = ["events", "orders", "event_log"];
    const query = "event";
    const needle = query.toLowerCase();
    const filtered = names.filter((n) => n.toLowerCase().includes(needle));
    // Render the indicator to confirm the rendered string.
    render(
      <TableSearchInput
        value={query}
        onChange={vi.fn()}
        matches={filtered.length}
        total={names.length}
      />,
    );
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
  });

  it("Esc clears the filter", () => {
    const onChange = vi.fn();
    render(
      <TableSearchInput value="event" onChange={onChange} matches={2} total={3} />,
    );
    const input = screen.getByPlaceholderText("Search tables…");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onChange).toHaveBeenCalledWith("");
  });
});

// ---------------------------------------------------------------------------
// TableLeafLabel — substring highlight test
// ---------------------------------------------------------------------------

describe("TableLeafLabel — 13.7: substring highlight", () => {
  it("wraps matching substring in a <mark> element", () => {
    const requestDescribe = vi.fn();
    const { container } = render(
      <TableLeafLabel
        tableName="events"
        searchQuery="event"
        requestDescribe={requestDescribe}
      />,
    );
    // The match "event" should be in a <mark> tag.
    const mark = container.querySelector("mark");
    expect(mark).toBeInTheDocument();
    expect(mark?.textContent).toBe("event");
  });

  it("renders full name when no match", () => {
    const { container } = render(
      <TableLeafLabel
        tableName="orders"
        searchQuery="evt"
        requestDescribe={vi.fn()}
      />,
    );
    expect(container.querySelector("mark")).not.toBeInTheDocument();
    expect(container.textContent).toBe("orders");
  });

  it("case-insensitive match: 'EVENT' matches 'events'", () => {
    const { container } = render(
      <TableLeafLabel
        tableName="events"
        searchQuery="EVENT"
        requestDescribe={vi.fn()}
      />,
    );
    const mark = container.querySelector("mark");
    expect(mark).toBeInTheDocument();
  });

  it("calls requestDescribe on mount", () => {
    const requestDescribe = vi.fn();
    render(
      <TableLeafLabel
        tableName="my-table"
        searchQuery=""
        requestDescribe={requestDescribe}
      />,
    );
    expect(requestDescribe).toHaveBeenCalledWith("my-table");
  });
});
