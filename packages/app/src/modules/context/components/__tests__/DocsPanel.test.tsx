/**
 * DocsPanel tests — §9.7 / §12.6
 *
 * Assertions:
 *  1. Renders nothing when useContextObject returns null (no doc).
 *  2. Renders the header + body when a doc exists.
 *  3. Toggles open/closed when the header is clicked.
 *  4. Renders nothing when contextPath is null.
 *  5. Renders nothing when identity is null.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ObjectDoc } from "@/modules/context/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/modules/context/api", () => ({
  contextApi: {
    getObject: vi.fn(),
  },
}));

vi.mock("@/modules/context/eventBus", () => ({
  useContextChangeListener: vi.fn(),
  useContextEventBus: vi.fn(() => ({
    subscribe: vi.fn(() => () => undefined),
    subscribeAll: vi.fn(() => () => undefined),
  })),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { contextApi } from "@/modules/context/api";
import { DocsPanel } from "../DocsPanel";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_DOC: ObjectDoc = {
  system: {
    kind: "dynamo_table",
    schema: null,
    name: "Orders",
    primary_key: ["orderId"],
    columns: [{ name: "orderId", type: "S" }],
    last_synced: "2026-06-01T00:00:00Z",
    deleted_in_db: false,
  },
  human: {
    tags: ["billing"],
    owners: ["@team-orders"],
    column_notes: { orderId: "UUID v4 string" },
  },
  body: "The Orders table stores all order records.",
};

const DELETED_DOC: ObjectDoc = {
  ...BASE_DOC,
  system: { ...BASE_DOC.system, deleted_in_db: true },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DocsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when getObject returns null (no doc)", async () => {
    vi.mocked(contextApi.getObject).mockResolvedValue(null);

    const { container } = render(
      <DocsPanel
        connectionId="conn-1"
        contextPath="/some/path"
        identity="Orders"
      />,
    );

    // Wait for the async fetch to settle.
    await waitFor(() => {
      expect(vi.mocked(contextApi.getObject)).toHaveBeenCalled();
    });

    // Nothing should be rendered.
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when contextPath is null", () => {
    const { container } = render(
      <DocsPanel
        connectionId="conn-1"
        contextPath={null}
        identity="Orders"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when identity is null", () => {
    const { container } = render(
      <DocsPanel
        connectionId="conn-1"
        contextPath="/some/path"
        identity={null}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the header and body when a doc exists", async () => {
    vi.mocked(contextApi.getObject).mockResolvedValue(BASE_DOC);

    render(
      <DocsPanel
        connectionId="conn-1"
        contextPath="/some/path"
        identity="Orders"
      />,
    );

    // Header should appear.
    await waitFor(() => {
      expect(screen.getByTestId("docs-panel-header")).toBeInTheDocument();
    });

    // Body should be visible (default open).
    expect(screen.getByTestId("docs-panel-body")).toBeInTheDocument();
    expect(screen.getByText(/The Orders table/i)).toBeInTheDocument();

    // Chips.
    expect(screen.getByText("billing")).toBeInTheDocument();
    expect(screen.getByText("@team-orders")).toBeInTheDocument();
  });

  it("toggles closed when the header is clicked and reopens on second click", async () => {
    vi.mocked(contextApi.getObject).mockResolvedValue(BASE_DOC);

    render(
      <DocsPanel
        connectionId="conn-1"
        contextPath="/some/path"
        identity="Orders"
      />,
    );

    // Wait for the doc to load.
    await waitFor(() => {
      expect(screen.getByTestId("docs-panel-body")).toBeInTheDocument();
    });

    // Click header → close.
    const header = screen.getByTestId("docs-panel-header");
    fireEvent.click(header);
    expect(screen.queryByTestId("docs-panel-body")).toBeNull();

    // Click header again → open.
    fireEvent.click(header);
    expect(screen.getByTestId("docs-panel-body")).toBeInTheDocument();
  });

  it("shows deleted-in-db notice when system.deleted_in_db is true", async () => {
    vi.mocked(contextApi.getObject).mockResolvedValue(DELETED_DOC);

    render(
      <DocsPanel
        connectionId="conn-1"
        contextPath="/some/path"
        identity="Orders"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("docs-panel-body")).toBeInTheDocument();
    });

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/no db match/i)).toBeInTheDocument();
  });
});
