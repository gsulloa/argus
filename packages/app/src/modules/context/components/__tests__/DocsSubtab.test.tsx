import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
// Imports after mock declarations
// ---------------------------------------------------------------------------

import { contextApi } from "@/modules/context/api";
import { DocsSubtab } from "../DocsSubtab";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_DOC: ObjectDoc = {
  system: {
    kind: "table",
    schema: "public",
    name: "users",
    primary_key: ["id"],
    columns: [
      { name: "id", type: "uuid" },
      { name: "email", type: "text" },
    ],
    last_synced: "2026-06-01T00:00:00Z",
    deleted_in_db: false,
  },
  human: {
    tags: ["pii", "core"],
    owners: ["@team-identity"],
    column_notes: {
      email: "lowercased before insert",
    },
  },
  body: "# users\n\nThe user identity table.",
};

const DELETED_DOC: ObjectDoc = {
  ...BASE_DOC,
  system: { ...BASE_DOC.system, deleted_in_db: true },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DocsSubtab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders_loading_state", () => {
    // getObject never resolves during this render
    vi.mocked(contextApi.getObject).mockReturnValue(new Promise(() => undefined));

    render(
      <DocsSubtab
        connectionId="conn-1"
        contextPath="/some/path"
        identity="public.users"
      />,
    );

    expect(screen.getByText(/loading docs/i)).toBeInTheDocument();
  });

  it("renders_loaded_with_body_and_chips", async () => {
    vi.mocked(contextApi.getObject).mockResolvedValue(BASE_DOC);

    render(
      <DocsSubtab
        connectionId="conn-1"
        contextPath="/some/path"
        identity="public.users"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/The user identity table/i)).toBeInTheDocument();
    });

    // Tags and owners rendered as chips
    expect(screen.getByText("pii")).toBeInTheDocument();
    expect(screen.getByText("core")).toBeInTheDocument();
    expect(screen.getByText("@team-identity")).toBeInTheDocument();

    // No deleted-in-db warning
    expect(screen.queryByText(/no db match/i)).toBeNull();
  });

  it("renders_deleted_in_db_warning", async () => {
    vi.mocked(contextApi.getObject).mockResolvedValue(DELETED_DOC);

    render(
      <DocsSubtab
        connectionId="conn-1"
        contextPath="/some/path"
        identity="public.users"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/no db match/i)).toBeInTheDocument();
    });
  });

  it("renders_error_state_when_api_rejects", async () => {
    vi.mocked(contextApi.getObject).mockRejectedValue(new Error("Backend failure"));

    render(
      <DocsSubtab
        connectionId="conn-1"
        contextPath="/some/path"
        identity="public.users"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Backend failure/i)).toBeInTheDocument();
    });
  });
});
