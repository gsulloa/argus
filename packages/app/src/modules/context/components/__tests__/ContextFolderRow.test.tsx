import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { ContextFolderRow } from "../ContextFolderRow";

// ---------------------------------------------------------------------------
// Mocks — must come before any module imports that transitively load them
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@/modules/context/api", () => ({
  contextApi: {
    listObjects: vi.fn(),
    createFolder: vi.fn(),
    linkFolder: vi.fn(),
    unlink: vi.fn(),
    syncSchema: vi.fn(),
    revealPath: vi.fn(),
  },
}));

vi.mock("@/platform/connection-registry/useConnections", () => ({
  useConnections: vi.fn(() => ({
    items: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    move: vi.fn(),
    remove: vi.fn(),
  })),
}));

// Stub SyncReportModal — keeps tests focused on ContextFolderRow itself
vi.mock("../SyncReportModal", () => ({
  SyncReportModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="sync-modal">SyncReportModal</div> : null,
}));

// ---------------------------------------------------------------------------
// Import mocked modules after vi.mock calls (hoisting ensures mock is applied)
// ---------------------------------------------------------------------------

import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { contextApi } from "@/modules/context/api";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONNECTION_ID = "conn-abc-123";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function renderRow(props: {
  connectionId?: string;
  contextPath?: string | null;
  onChanged?: () => void;
}) {
  const { connectionId = CONNECTION_ID, contextPath = null, onChanged = vi.fn() } = props;
  return render(
    <ContextFolderRow
      connectionId={connectionId}
      contextPath={contextPath}
      onChanged={onChanged}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ContextFolderRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(contextApi.listObjects).mockResolvedValue([]);
  });

  // -------------------------------------------------------------------------
  // 9.6.1 — "none" state: Create + Link buttons
  // -------------------------------------------------------------------------

  it("renders_none_state_with_create_and_link_buttons", () => {
    renderRow({ contextPath: null });

    // Label is present (may appear multiple times in DOM, just check at least one)
    expect(screen.getAllByText(/context folder/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /create folder/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /link existing/i })).toBeInTheDocument();
    expect(screen.getByText(/holds documentation and prefab queries/i)).toBeInTheDocument();

    // listObjects should NOT be called when contextPath is null
    expect(contextApi.listObjects).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 9.6.2 — "linked" state: path + Reveal / Unlink / Sync schema
  // -------------------------------------------------------------------------

  it("renders_linked_state_with_path_and_action_buttons", async () => {
    vi.mocked(contextApi.listObjects).mockResolvedValue([]);

    renderRow({ contextPath: "/some/path" });

    await waitFor(() => {
      expect(screen.getByText("/some/path")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /reveal/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Unlink$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sync schema/i })).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // 9.6.3 — "missing" state when listObjects throws "not found"
  // -------------------------------------------------------------------------

  it("renders_missing_state_when_listObjects_throws_not_found", async () => {
    vi.mocked(contextApi.listObjects).mockRejectedValue(new Error("not found"));

    renderRow({ contextPath: "/missing/path" });

    await waitFor(() => {
      expect(screen.getByText(/folder not found on disk/i)).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /locate/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Unlink$/i })).toBeInTheDocument();

    // Reveal and Sync schema should NOT be present in missing state
    expect(screen.queryByRole("button", { name: /reveal/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /sync schema/i })).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 9.6.4 — transitions from none to linked after "Link existing…"
  // -------------------------------------------------------------------------

  it("transitions_from_none_to_linked_after_link_click", async () => {
    const onChanged = vi.fn();

    vi.mocked(dialogOpen).mockResolvedValue("/picked/folder");
    vi.mocked(contextApi.linkFolder).mockResolvedValue({
      schema_version: 1,
      name: "test-folder",
    });

    renderRow({ contextPath: null, onChanged });

    const linkBtn = screen.getByRole("button", { name: /link existing/i });

    await act(async () => {
      fireEvent.click(linkBtn);
    });

    await waitFor(() => {
      expect(dialogOpen).toHaveBeenCalled();
      expect(contextApi.linkFolder).toHaveBeenCalledWith(CONNECTION_ID, "/picked/folder");
      expect(onChanged).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // 9.6.5 — unlink calls API and onChanged
  // -------------------------------------------------------------------------

  it("unlink_calls_api_and_onChanged", async () => {
    const onChanged = vi.fn();

    vi.mocked(contextApi.listObjects).mockResolvedValue([]);
    vi.mocked(contextApi.unlink).mockResolvedValue(undefined);

    renderRow({ contextPath: "/linked/path", onChanged });

    // Wait for linked state
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Unlink$/i })).toBeInTheDocument();
    });

    // Click main Unlink button to open confirmation dialog
    fireEvent.click(screen.getByRole("button", { name: /^Unlink$/i }));

    // Confirmation dialog should appear — find the confirm Unlink button in the dialog
    await waitFor(() => {
      const unlinkBtns = screen.getAllByRole("button", { name: /unlink/i });
      // Two Unlink buttons: the row one (now disabled / behind overlay) + dialog confirm
      return expect(unlinkBtns.length).toBeGreaterThanOrEqual(1);
    });

    // Click the last Unlink button (the one in the dialog footer)
    const allUnlinkBtns = screen.getAllByRole("button", { name: /unlink/i });
    await act(async () => {
      fireEvent.click(allUnlinkBtns[allUnlinkBtns.length - 1]!);
    });

    await waitFor(() => {
      expect(contextApi.unlink).toHaveBeenCalledWith(CONNECTION_ID);
      expect(onChanged).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // No-op when dialog is cancelled
  // -------------------------------------------------------------------------

  it("does_nothing_when_dialog_is_cancelled", async () => {
    const onChanged = vi.fn();

    vi.mocked(dialogOpen).mockResolvedValue(null);

    renderRow({ contextPath: null, onChanged });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /link existing/i }));
    });

    await waitFor(() => {
      expect(contextApi.linkFolder).not.toHaveBeenCalled();
      expect(onChanged).not.toHaveBeenCalled();
    });
  });
});
