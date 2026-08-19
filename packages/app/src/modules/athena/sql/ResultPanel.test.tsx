/**
 * Athena ResultPanel tests (`openspec/changes/configurable-result-row-cap`,
 * tasks 6.1/6.3/6.4/6.5/6.6).
 *
 * Asserts the shared `<TruncationBanner />` renders the response's own
 * `row_cap` (not a hardcoded 10,000), names the Athena `LIMIT` clause, is
 * absent when the result is not truncated, and — the task 6.5 regression —
 * that `<ExportMenu />` receives the result's `truncated` flag instead of
 * silently defaulting to `false`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResultPanel } from "./ResultPanel";
import type { RunState } from "./useQueryRun";
import type { AthenaResultColumnInfo } from "../types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/platform/settings/api", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

// Capture the props ExportMenu is rendered with, so the truncated-flag
// regression (task 6.5) can be asserted without driving an actual export.
const exportMenuProps = vi.fn();
vi.mock("./export/ExportMenu", () => ({
  ExportMenu: (props: { truncated?: boolean }) => {
    exportMenuProps(props);
    return <div data-testid="export-menu" data-truncated={String(props.truncated)} />;
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COLUMNS: AthenaResultColumnInfo[] = [
  { name: "id", ty: "bigint" },
  { name: "label", ty: "varchar" },
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
      truncated: overrides.truncated,
      query_ms: 10,
      data_scanned_bytes: 0,
      row_cap: overrides.row_cap,
      row_cap_source: overrides.row_cap_source,
    },
  };
}

beforeEach(() => {
  exportMenuProps.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Athena ResultPanel truncation banner", () => {
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

  it("names the LIMIT clause", () => {
    render(
      <ResultPanel
        state={makeRunState({ truncated: true, row_cap: 10000, row_cap_source: "setting" })}
        onShowInEditor={() => {}}
        connectionName="conn"
      />,
    );

    expect(screen.getByText(/add a LIMIT clause/)).toBeInTheDocument();
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

describe("Athena ResultPanel export truncation flag (task 6.5)", () => {
  it("passes truncated: true to ExportMenu when the result is truncated", () => {
    render(
      <ResultPanel
        state={makeRunState({ truncated: true, row_cap: 10000, row_cap_source: "setting" })}
        onShowInEditor={() => {}}
        connectionName="conn"
      />,
    );

    expect(exportMenuProps).toHaveBeenCalled();
    const lastCall = exportMenuProps.mock.calls[exportMenuProps.mock.calls.length - 1]![0];
    expect(lastCall.truncated).toBe(true);
    expect(screen.getByTestId("export-menu")).toHaveAttribute("data-truncated", "true");
  });

  it("passes truncated: false to ExportMenu when the result is not truncated", () => {
    render(
      <ResultPanel
        state={makeRunState({ truncated: false, row_cap: 10000, row_cap_source: "setting" })}
        onShowInEditor={() => {}}
        connectionName="conn"
      />,
    );

    const lastCall = exportMenuProps.mock.calls[exportMenuProps.mock.calls.length - 1]![0];
    expect(lastCall.truncated).toBe(false);
  });
});
