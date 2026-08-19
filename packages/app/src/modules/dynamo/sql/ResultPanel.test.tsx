/**
 * DynamoDB PartiQL ResultPanel tests
 * (`openspec/changes/configurable-result-row-cap`, tasks 6.1/6.3/6.4/6.6).
 *
 * Asserts the shared `<TruncationBanner />` renders the response's own
 * `row_cap` (not a hardcoded 10,000), is absent when the result is not
 * truncated, and — per the "Truncation banner omits a clause suggestion"
 * scenario in the `dynamo-partiql-editor` spec — never suggests adding a
 * `LIMIT` clause, since PartiQL has no such syntax.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResultPanel } from "./ResultPanel";
import type { RunState } from "./useQueryRun";
import type { AttributeMap } from "../data-view/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/platform/settings/api", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

// Mock @tanstack/react-virtual so all rows render in JSDOM.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => {
    const size = estimateSize();
    return {
      scrollToIndex: vi.fn(),
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
// Helpers
// ---------------------------------------------------------------------------

const ITEMS: AttributeMap[] = [
  { id: { N: "1" }, label: { S: "alpha" } },
  { id: { N: "2" }, label: { S: "beta" } },
];

function makeRunState(overrides: {
  truncated: boolean;
  row_cap: number;
  row_cap_source: "setting" | "hard_ceiling" | "engine";
}): RunState {
  return {
    status: "done",
    mode: "single",
    sql: "SELECT * FROM t",
    startOffset: 0,
    error: null,
    result: {
      kind: "rows",
      items: ITEMS,
      count: ITEMS.length,
      query_ms: 10,
      truncated: overrides.truncated,
      consumed_capacity: null,
      row_cap: overrides.row_cap,
      row_cap_source: overrides.row_cap_source,
    },
  };
}

beforeEach(() => {
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => true);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Dynamo PartiQL ResultPanel truncation banner", () => {
  it("names the response's row_cap, not a hardcoded 10,000", () => {
    render(
      <ResultPanel
        state={makeRunState({ truncated: true, row_cap: 50000, row_cap_source: "setting" })}
        onShowInEditor={() => {}}
        connectionName="conn"
      />,
    );

    expect(screen.getByText(/50,000 rows/)).toBeInTheDocument();
    expect(screen.queryByText(/10,000/)).not.toBeInTheDocument();
  });

  it("is absent when the result is not truncated", () => {
    render(
      <ResultPanel
        state={makeRunState({ truncated: false, row_cap: 10000, row_cap_source: "setting" })}
        onShowInEditor={() => {}}
        connectionName="conn"
      />,
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(/hit Argus's row limit/)).not.toBeInTheDocument();
  });

  it("omits any 'add a … clause' sentence — PartiQL has no LIMIT syntax", () => {
    render(
      <ResultPanel
        state={makeRunState({ truncated: true, row_cap: 50000, row_cap_source: "setting" })}
        onShowInEditor={() => {}}
        connectionName="conn"
      />,
    );

    // Still names the cap and offers Raise limit...
    expect(screen.getByText("Showing the first 50,000 rows — the result hit Argus's row limit.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Raise limit" })).toBeInTheDocument();
    // ...but never suggests adding a clause.
    expect(screen.queryByText(/add a/)).not.toBeInTheDocument();
    expect(screen.queryByText(/LIMIT clause/)).not.toBeInTheDocument();
  });

  it("hard_ceiling source renders the maximum-result-size copy with no Raise-limit control", () => {
    render(
      <ResultPanel
        state={makeRunState({ truncated: true, row_cap: 1000000, row_cap_source: "hard_ceiling" })}
        onShowInEditor={() => {}}
        connectionName="conn"
      />,
    );

    expect(screen.getByText(/Argus's maximum result size/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /raise limit/i })).not.toBeInTheDocument();
  });
});
