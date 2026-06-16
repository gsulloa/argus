/**
 * BottomBar unit tests.
 *
 * Covers:
 *   - Comma grouping via Intl.NumberFormat
 *   - Singular vs plural "item(s) loaded"
 *   - Count result rendering
 *   - Loading spinner display
 *   - Error display
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BottomBar } from "./BottomBar";

describe("BottomBar", () => {
  it("renders 0 items", () => {
    render(<BottomBar itemsLoaded={0} status="idle" />);
    expect(screen.getByText(/0 items loaded/i)).toBeTruthy();
  });

  it("renders singular 'item' for count 1", () => {
    render(<BottomBar itemsLoaded={1} status="idle" />);
    expect(screen.getByText("1 item loaded")).toBeTruthy();
  });

  it("renders plural for count 2", () => {
    render(<BottomBar itemsLoaded={2} status="idle" />);
    expect(screen.getByText("2 items loaded")).toBeTruthy();
  });

  it("formats large numbers with comma grouping", () => {
    render(<BottomBar itemsLoaded={1250} status="ready" />);
    expect(screen.getByText("1,250 items loaded")).toBeTruthy();
  });

  it("does not show count result when not provided", () => {
    render(<BottomBar itemsLoaded={10} status="ready" />);
    expect(screen.queryByText(/Count:/)).toBeNull();
  });

  it("renders count result with comma grouping", () => {
    render(
      <BottomBar
        itemsLoaded={100}
        status="ready"
        countResult={{ totalCount: 12345, totalScannedCount: 50000 }}
      />,
    );
    expect(screen.getByText(/Count: 12,345 \(scanned 50,000\)/)).toBeTruthy();
  });

  it("shows loading indicator when status is loading", () => {
    render(<BottomBar itemsLoaded={0} status="loading" />);
    expect(screen.getByText(/Loading…/)).toBeTruthy();
  });

  it("shows error message when status is error", () => {
    render(
      <BottomBar
        itemsLoaded={0}
        status="error"
        error={{ message: "Throttled by AWS", code: "ProvisionedThroughputExceededException" }}
      />,
    );
    expect(screen.getByText(/Throttled by AWS/)).toBeTruthy();
  });

  it("does not show error text when status is ready", () => {
    render(<BottomBar itemsLoaded={5} status="ready" error={{ message: "old error" }} />);
    expect(screen.queryByText(/old error/)).toBeNull();
  });
});
