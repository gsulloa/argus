/**
 * TruncationBanner tests (tasks 5.3/5.4). Copy is verbatim from the
 * `sql-result-row-cap` spec's "Shared truncation banner" requirement.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TruncationBanner } from "./TruncationBanner";

vi.mock("@/platform/settings/api", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

describe("TruncationBanner", () => {
  it("setting source: names the cap, offers Raise limit, and appends the clause sentence", () => {
    render(<TruncationBanner rowCap={50000} rowCapSource="setting" clause="LIMIT" />);

    expect(
      screen.getByText(
        "Showing the first 50,000 rows — the result hit Argus's row limit. Raise the limit or add a LIMIT clause.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Raise limit" })).toBeInTheDocument();
  });

  it("setting source with no clause (DynamoDB PartiQL): omits the trailing sentence but keeps Raise limit", () => {
    render(<TruncationBanner rowCap={50000} rowCapSource="setting" clause={null} />);

    expect(
      screen.getByText("Showing the first 50,000 rows — the result hit Argus's row limit."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Raise the limit or add a/),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Raise limit" })).toBeInTheDocument();
  });

  it("hard_ceiling source: hard-ceiling copy, no Raise limit action", () => {
    render(<TruncationBanner rowCap={1000000} rowCapSource="hard_ceiling" clause="LIMIT" />);

    expect(
      screen.getByText(
        "Showing the first 1,000,000 rows — Argus's maximum result size. Narrow the query to see the rest.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Raise limit" })).not.toBeInTheDocument();
  });

  it("engine source: uses the engine-specific reason, no Raise limit action", () => {
    render(
      <TruncationBanner
        rowCap={10000}
        rowCapSource="engine"
        engineReason="CloudWatch Logs Insights returns at most 10,000 records per query"
      />,
    );

    expect(
      screen.getByText(
        "Showing the first 10,000 rows — CloudWatch Logs Insights returns at most 10,000 records per query.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Raise limit" })).not.toBeInTheDocument();
  });

  it("thousands-separates the cap via toLocaleString (100000 -> 100,000)", () => {
    render(<TruncationBanner rowCap={100000} rowCapSource="hard_ceiling" />);

    expect(screen.getByText(/100,000 rows/)).toBeInTheDocument();
  });
});
