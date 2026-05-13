/**
 * Toolbar.readonly.test.tsx — task 12.4
 *
 * Verifies badge visibility and affordance hiding for read-only vs writable
 * connections.
 *
 * Coverage:
 *   - isReadOnly=true:  "Read-only" badge IS rendered
 *   - isReadOnly=true:  "+ Insert" button is NOT rendered
 *   - isReadOnly=true:  locking toggle/button is NOT rendered
 *   - isReadOnly=false: "Read-only" badge is NOT rendered
 *   - isReadOnly=false: "+ Insert" button IS rendered (when onInsert provided)
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Toolbar } from "./Toolbar";
import type { BuilderState } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const defaultBuilder: BuilderState = {
  mode: "scan",
  indexName: null,
  pageSize: 100,
  consistentRead: false,
  scanIndexForward: true,
  filters: [],
};

function makeProps(overrides: Partial<Parameters<typeof Toolbar>[0]> = {}) {
  return {
    viewMode: "tabla" as const,
    onViewModeChange: vi.fn(),
    builder: defaultBuilder,
    onBuilderChange: vi.fn(),
    status: "idle" as const,
    lastEvaluatedKey: null,
    onRun: vi.fn(),
    onReset: vi.fn(),
    onLoadMore: vi.fn(),
    countLoading: false,
    countResult: undefined,
    onCount: vi.fn(),
    needsCredentials: false,
    pageSize: 100,
    onPageSizeChange: vi.fn(),
    isReadOnly: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Read-only badge visibility
// ---------------------------------------------------------------------------

describe("Toolbar — read-only badge", () => {
  it("renders 'Read-only' badge when isReadOnly=true", () => {
    render(<Toolbar {...makeProps({ isReadOnly: true })} />);
    expect(screen.getByTestId("toolbar-readonly-badge")).toBeTruthy();
    expect(screen.getByText(/read.only/i)).toBeTruthy();
  });

  it("does NOT render 'Read-only' badge when isReadOnly=false", () => {
    render(<Toolbar {...makeProps({ isReadOnly: false })} />);
    expect(screen.queryByTestId("toolbar-readonly-badge")).toBeNull();
  });

  it("does NOT render 'Read-only' badge when isReadOnly is omitted (default false)", () => {
    render(<Toolbar {...makeProps()} />);
    expect(screen.queryByTestId("toolbar-readonly-badge")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Insert button visibility
// ---------------------------------------------------------------------------

describe("Toolbar — Insert button", () => {
  it("does NOT render '+ Insert' button when isReadOnly=true", () => {
    render(
      <Toolbar
        {...makeProps({ isReadOnly: true, onInsert: vi.fn() })}
      />,
    );
    expect(screen.queryByTestId("toolbar-insert-btn")).toBeNull();
  });

  it("renders '+ Insert' button when isReadOnly=false and onInsert is provided", () => {
    render(
      <Toolbar
        {...makeProps({ isReadOnly: false, onInsert: vi.fn() })}
      />,
    );
    expect(screen.getByTestId("toolbar-insert-btn")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Locking controls visibility
// ---------------------------------------------------------------------------

describe("Toolbar — locking controls", () => {
  it("does NOT render locking toggle when isReadOnly=true", () => {
    render(
      <Toolbar
        {...makeProps({
          isReadOnly: true,
          useConditionExpression: false,
          onUseConditionExpressionChange: vi.fn(),
          onOpenLockingDialog: vi.fn(),
        })}
      />,
    );
    expect(screen.queryByTestId("use-condition-expression-toggle")).toBeNull();
    expect(screen.queryByTestId("toolbar-locking-btn")).toBeNull();
  });

  it("does NOT render locking toggle when onUseConditionExpressionChange is undefined (read-only path)", () => {
    render(
      <Toolbar
        {...makeProps({
          isReadOnly: false,
          // no onUseConditionExpressionChange passed — same as DataViewContent does for read-only
          useConditionExpression: false,
        })}
      />,
    );
    expect(screen.queryByTestId("use-condition-expression-toggle")).toBeNull();
  });

  it("renders locking toggle when isReadOnly=false and handler provided", () => {
    render(
      <Toolbar
        {...makeProps({
          isReadOnly: false,
          useConditionExpression: false,
          onUseConditionExpressionChange: vi.fn(),
          onOpenLockingDialog: vi.fn(),
        })}
      />,
    );
    expect(screen.getByTestId("use-condition-expression-toggle")).toBeTruthy();
    expect(screen.getByTestId("toolbar-locking-btn")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Run button is always rendered regardless of read-only
// ---------------------------------------------------------------------------

describe("Toolbar — Run button always present", () => {
  it("renders Run button on read-only connection", () => {
    render(<Toolbar {...makeProps({ isReadOnly: true })} />);
    expect(screen.getByTestId("toolbar-run")).toBeTruthy();
  });

  it("renders Run button on writable connection", () => {
    render(<Toolbar {...makeProps({ isReadOnly: false })} />);
    expect(screen.getByTestId("toolbar-run")).toBeTruthy();
  });
});
