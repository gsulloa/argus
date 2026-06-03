import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { QueryListItem } from "@/modules/context/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/modules/context/hooks", () => ({
  useContextQueries: vi.fn(),
}));

vi.mock("@/modules/context/eventBus", () => ({
  useContextChangeListener: vi.fn(),
  useContextEventBus: vi.fn(() => ({
    subscribe: vi.fn(() => () => undefined),
    subscribeAll: vi.fn(() => () => undefined),
  })),
}));

// ---------------------------------------------------------------------------
// Imports after mock declarations
// ---------------------------------------------------------------------------

import { useContextQueries } from "@/modules/context/hooks";
import { ContextQueriesBranch } from "../ContextQueriesBranch";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const QUERIES: QueryListItem[] = [
  { name: "top-customers", description: "Top customers by revenue", params: [], tags: [] },
  { name: "stuck-orders", description: null, params: [], tags: [] },
  { name: "active-users", description: null, params: [], tags: [] },
];

const emptyState = { data: [] as QueryListItem[], loading: false, error: null, refresh: vi.fn() };
const loadedState = { data: QUERIES, loading: false, error: null, refresh: vi.fn() };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ContextQueriesBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hidden_when_no_context_path", () => {
    vi.mocked(useContextQueries).mockReturnValue(emptyState);
    const { container } = render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath={null}
        engine="postgres"
        onActivate={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("hidden_when_empty_query_list", () => {
    vi.mocked(useContextQueries).mockReturnValue(emptyState);
    const { container } = render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders_sorted_by_name", async () => {
    vi.mocked(useContextQueries).mockReturnValue(loadedState);
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={vi.fn()}
      />,
    );

    // Header should be visible
    expect(screen.getByText("Context Queries")).toBeInTheDocument();

    // By default, ≤ 8 queries → expanded. Rows should be visible.
    const rows = screen.getAllByRole("button", { name: /active-users|stuck-orders|top-customers/i });
    // sorted: active-users, stuck-orders, top-customers
    expect(rows[0]).toHaveTextContent("active-users");
    expect(rows[1]).toHaveTextContent("stuck-orders");
    expect(rows[2]).toHaveTextContent("top-customers");
  });

  it("clicking_row_calls_onActivate", () => {
    const onActivate = vi.fn();
    vi.mocked(useContextQueries).mockReturnValue(loadedState);
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={onActivate}
      />,
    );

    // Click the "top-customers" row (QUERIES[0] is top-customers at index 0 in the fixture)
    // sorted order: active-users (index 0), stuck-orders (index 1), top-customers (index 2)
    const topCustomersBtn = screen.getByText("top-customers").closest("button")!;
    fireEvent.click(topCustomersBtn);
    expect(onActivate).toHaveBeenCalledWith(QUERIES[0]);
  });
});
