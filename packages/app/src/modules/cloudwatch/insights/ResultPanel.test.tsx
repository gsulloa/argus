/**
 * CloudWatch Insights ResultPanel tests
 * (`openspec/changes/configurable-result-row-cap`, tasks 6.1/6.3/6.4/6.6).
 *
 * Asserts the shared `<TruncationBanner />` renders the response's own
 * `row_cap` (not a hardcoded 10,000), is absent when the result is not
 * truncated, and — per the "Engine-clamped banner explains the AWS limit and
 * offers no raise action" scenario in the `cloudwatch-insights-editor`
 * spec — that `row_cap_source: "engine"` renders the exact AWS-ceiling
 * reason and never offers a Raise-limit control.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { InsightsResultPanel } from "./ResultPanel";
import type { InsightsRunState } from "./useQueryRun";
import type { InsightsColumnInfo } from "../types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/platform/settings/api", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/modules/athena/sql/export/ExportMenu", () => ({
  ExportMenu: () => <div data-testid="export-menu" />,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COLUMNS: InsightsColumnInfo[] = [
  { name: "@timestamp", type: "string" },
  { name: "@message", type: "string" },
];

const ROWS: unknown[][] = [
  ["2024-01-01T00:00:00.000Z", "hello"],
  ["2024-01-01T00:00:01.000Z", "world"],
];

function makeRunState(overrides: {
  truncated: boolean;
  row_cap: number;
  row_cap_source: "setting" | "hard_ceiling" | "engine";
}): InsightsRunState {
  return {
    status: "idle",
    error: null,
    result: {
      kind: "rows",
      columns: COLUMNS,
      rows: ROWS,
      query_ms: 10,
      truncated: overrides.truncated,
      records_matched: ROWS.length,
      records_scanned: ROWS.length,
      bytes_scanned: 0,
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

describe("CloudWatch Insights ResultPanel truncation banner", () => {
  it("names the response's row_cap, not a hardcoded 10,000", () => {
    render(
      <InsightsResultPanel
        state={makeRunState({ truncated: true, row_cap: 500, row_cap_source: "setting" })}
        connectionName="conn"
      />,
    );

    expect(screen.getByText(/500 rows/)).toBeInTheDocument();
    expect(screen.queryByText(/10,000/)).not.toBeInTheDocument();
  });

  it("is absent when the result is not truncated", () => {
    render(
      <InsightsResultPanel
        state={makeRunState({ truncated: false, row_cap: 10000, row_cap_source: "setting" })}
        connectionName="conn"
      />,
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(/hit Argus's row limit/)).not.toBeInTheDocument();
  });

  it("engine-clamped source renders the exact AWS-ceiling reason and offers no Raise-limit control", () => {
    render(
      <InsightsResultPanel
        state={makeRunState({ truncated: true, row_cap: 10000, row_cap_source: "engine" })}
        connectionName="conn"
      />,
    );

    expect(
      screen.getByText(
        "Showing the first 10,000 rows — CloudWatch Logs Insights returns at most 10,000 records per query.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /raise limit/i })).not.toBeInTheDocument();
  });

  it("setting source below the AWS ceiling still offers Raise limit", () => {
    render(
      <InsightsResultPanel
        state={makeRunState({ truncated: true, row_cap: 500, row_cap_source: "setting" })}
        connectionName="conn"
      />,
    );

    expect(screen.getByRole("button", { name: "Raise limit" })).toBeInTheDocument();
  });
});
