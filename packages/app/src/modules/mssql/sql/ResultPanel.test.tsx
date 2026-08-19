/**
 * ResultPanel tests (`openspec/changes/configurable-result-row-cap`, tasks
 * 6.1/6.3/6.6 for MS SQL Server).
 *
 * Asserts the shared `<TruncationBanner />` renders the response's own
 * `row_cap` (not a hardcoded 10,000), names the MSSQL `TOP / OFFSET … FETCH
 * NEXT` clause, is absent when the result is not truncated, and drops the
 * "Raise limit" control when `row_cap_source` is `"hard_ceiling"`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResultPanel } from "./ResultPanel";
import type { RunState } from "./useQueryRun";
import type { ColumnInfo } from "../types";

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

// Clipboard (ExportMenu / grid copy actions may reach for it).
const writeText = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText } },
  writable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COLUMNS: ColumnInfo[] = [
  {
    name: "id",
    data_type: "int",
    base_type: "int",
    ordinal_position: 1,
    is_nullable: false,
    column_default: null,
    is_identity: false,
    is_computed: false,
    character_max_length: null,
  },
  {
    name: "label",
    data_type: "nvarchar",
    base_type: "nvarchar",
    ordinal_position: 2,
    is_nullable: true,
    column_default: null,
    is_identity: false,
    is_computed: false,
    character_max_length: 255,
  },
];

const ROWS: unknown[][] = [
  [1, "alpha"],
  [2, "beta"],
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
    error: null,
    startOffset: 0,
    result: {
      kind: "rows",
      columns: COLUMNS,
      rows: ROWS,
      truncated_columns: [],
      truncated: overrides.truncated,
      query_ms: 10,
      row_cap: overrides.row_cap,
      row_cap_source: overrides.row_cap_source,
    },
  };
}

beforeEach(() => {
  writeText.mockClear();
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

describe("MSSQL ResultPanel truncation banner", () => {
  it("names the response's row_cap, not a hardcoded 10,000", () => {
    render(
      <ResultPanel
        state={makeRunState({ truncated: true, row_cap: 50000, row_cap_source: "setting" })}
        onShowInEditor={() => {}}
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
      />,
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(/hit Argus's row limit/)).not.toBeInTheDocument();
  });

  it("names the MSSQL TOP / OFFSET … FETCH NEXT clause", () => {
    render(
      <ResultPanel
        state={makeRunState({ truncated: true, row_cap: 10000, row_cap_source: "setting" })}
        onShowInEditor={() => {}}
      />,
    );

    expect(screen.getByText(/add a TOP \/ OFFSET … FETCH NEXT clause/)).toBeInTheDocument();
  });

  it("hard_ceiling source renders the maximum-result-size copy with no Raise-limit control", () => {
    render(
      <ResultPanel
        state={makeRunState({ truncated: true, row_cap: 1000000, row_cap_source: "hard_ceiling" })}
        onShowInEditor={() => {}}
      />,
    );

    expect(screen.getByText(/Argus's maximum result size/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /raise limit/i })).not.toBeInTheDocument();
  });
});
