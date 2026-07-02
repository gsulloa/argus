import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { QueryListItem } from "@/modules/context/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/modules/context/hooks", () => ({
  useContextQueries: vi.fn(),
}));

vi.mock("@/modules/context/api", () => ({
  contextApi: {
    createQueryFolder: vi.fn(() => Promise.resolve({ path: "reports" })),
    deleteQueryFolder: vi.fn(() => Promise.resolve({ path: "reports" })),
    saveQuery: vi.fn(() =>
      Promise.resolve({ path: "new-query", created: true, name: "new-query", rel_path: "new-query", folder: "" }),
    ),
    renameQuery: vi.fn(() =>
      Promise.resolve({ path: "renamed", created: false, name: "renamed", rel_path: "renamed", folder: "" }),
    ),
    deleteQuery: vi.fn(() => Promise.resolve({ deleted: true })),
  },
}));

vi.mock("@/modules/context/eventBus", () => ({
  useContextChangeListener: vi.fn(),
  useContextEventBus: vi.fn(() => ({
    subscribe: vi.fn(() => () => undefined),
    subscribeAll: vi.fn(() => () => undefined),
  })),
}));

vi.mock("@/modules/context/useContextFolderLink", () => ({
  useContextFolderLink: vi.fn(() => ({
    knownFolders: [],
    knownFoldersLoading: false,
    busy: false,
    error: null,
    reuse: vi.fn(),
    beginCreate: vi.fn(),
    confirmCreate: vi.fn(),
    chooseExisting: vi.fn(),
  })),
}));

// Mock useToast
vi.mock("@/platform/toast", () => ({
  useToast: vi.fn(() => ({ show: vi.fn() })),
}));

// Mock Tauri dialog (used in ContextQueriesBranch via NamePromptDialog indirectly)
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mock declarations
// ---------------------------------------------------------------------------

import { useContextQueries } from "@/modules/context/hooks";
import { contextApi } from "@/modules/context/api";
import { useContextFolderLink } from "@/modules/context/useContextFolderLink";
import { ContextQueriesBranch, moveTargetOrNoop } from "../ContextQueriesBranch";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const QUERIES: QueryListItem[] = [
  { name: "top-customers", description: "Top customers by revenue", params: [], tags: [], path: "top-customers", folder: "" },
  { name: "stuck-orders", description: null, params: [], tags: [], path: "stuck-orders", folder: "" },
  { name: "active-users", description: null, params: [], tags: [], path: "active-users", folder: "" },
];

const NESTED_QUERIES: QueryListItem[] = [
  { name: "top", description: null, params: [], tags: [], path: "top", folder: "" },
  { name: "inner", description: null, params: [], tags: [], path: "reports/inner", folder: "reports" },
];

function makeState(
  queries: QueryListItem[] = [],
  folders: string[] = [],
  loading = false,
  error: Error | null = null,
) {
  const refresh = vi.fn() as unknown as () => void;
  return { data: { queries, folders }, loading, error, refresh };
}

const emptyState = makeState();
const loadedState = makeState(QUERIES);

const defaultLinkHook = {
  knownFolders: [] as { path: string; name: string; connection_ids: string[] }[],
  knownFoldersLoading: false,
  busy: false,
  error: null,
  reuse: vi.fn(),
  beginCreate: vi.fn(),
  confirmCreate: vi.fn(),
  chooseExisting: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ContextQueriesBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useContextFolderLink).mockReturnValue(defaultLinkHook);
  });

  // -------------------------------------------------------------------------
  // Guard 1: no context path → shows setup CTA (NOT null)
  // -------------------------------------------------------------------------

  it("shows_setup_cta_when_no_context_path", () => {
    vi.mocked(useContextQueries).mockReturnValue(makeState());
    const { container } = render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath={null}
        engine="postgres"
        onActivate={vi.fn()}
      />,
    );
    // Should NOT be null — renders the CTA
    expect(container.firstChild).not.toBeNull();
    // Should show the label
    expect(screen.getByText("Context Queries")).toBeInTheDocument();
    // Should show create/link buttons
    expect(screen.getByRole("button", { name: /create folder/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /link existing/i })).toBeInTheDocument();
  });

  it("shows_known_folder_buttons_in_setup_cta", () => {
    vi.mocked(useContextQueries).mockReturnValue(makeState());
    vi.mocked(useContextFolderLink).mockReturnValue({
      ...defaultLinkHook,
      knownFolders: [
        { path: "/my/ctx", name: "my-ctx", connection_ids: [] },
      ],
    });
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath={null}
        engine="postgres"
        onActivate={vi.fn()}
      />,
    );
    expect(screen.getByText("my-ctx")).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Guard 2: linked-but-empty → renders (NOT null), shows empty hint
  // -------------------------------------------------------------------------

  it("renders_when_linked_but_empty", () => {
    vi.mocked(useContextQueries).mockReturnValue(emptyState);
    const { container } = render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={vi.fn()}
      />,
    );
    // Should NOT be null
    expect(container.firstChild).not.toBeNull();
    // Header should be visible
    expect(screen.getByText("Context Queries")).toBeInTheDocument();
    // Empty hint should appear
    expect(screen.getByText(/no queries yet/i)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Queries list — flat queries render at root, sorted by name
  // -------------------------------------------------------------------------

  it("renders_sorted_by_name", async () => {
    vi.mocked(useContextQueries).mockReturnValue(loadedState);
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={vi.fn()}
      />,
    );

    // Header should be visible
    expect(screen.getByText("Context Queries")).toBeInTheDocument();

    // By default, ≤ 8 queries → expanded. Rows should be visible.
    const rows = screen.getAllByRole("button", { name: /active-users|stuck-orders|top-customers/i });
    // sorted: active-users, stuck-orders, top-customers
    expect(rows[0]).toHaveTextContent("active-users");
    expect(rows[1]).toHaveTextContent("stuck-orders");
    expect(rows[2]).toHaveTextContent("top-customers");
  });

  it("clicking_row_calls_onActivate", () => {
    const onActivate = vi.fn();
    vi.mocked(useContextQueries).mockReturnValue(loadedState);
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={onActivate}
      />,
    );

    // Click the "top-customers" row
    const topCustomersBtn = screen.getByText("top-customers").closest("button")!;
    fireEvent.click(topCustomersBtn);
    expect(onActivate).toHaveBeenCalledWith(QUERIES[0]);
  });

  // -------------------------------------------------------------------------
  // Nested tree rendering
  // -------------------------------------------------------------------------

  it("renders_nested_queries_under_folder_node", () => {
    vi.mocked(useContextQueries).mockReturnValue(makeState(NESTED_QUERIES, ["reports"]));
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={vi.fn()}
      />,
    );
    // Root query should be visible
    expect(screen.getByText("top")).toBeInTheDocument();
    // Folder node should appear
    expect(screen.getByText("reports")).toBeInTheDocument();
    // Inner query not visible until folder expanded
    expect(screen.queryByText("inner")).toBeNull();
  });

  it("expanding_folder_reveals_inner_queries", () => {
    vi.mocked(useContextQueries).mockReturnValue(makeState(NESTED_QUERIES, ["reports"]));
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={vi.fn()}
      />,
    );
    // Click the reports folder to expand
    const folderBtn = screen.getByText("reports").closest("button")!;
    fireEvent.click(folderBtn);
    // Now inner should be visible
    expect(screen.getByText("inner")).toBeInTheDocument();
  });

  it("empty_folder_renders_as_node", () => {
    vi.mocked(useContextQueries).mockReturnValue(makeState([], ["archive"]));
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={vi.fn()}
      />,
    );
    // Empty folder should appear as a folder node
    expect(screen.getByText("archive")).toBeInTheDocument();
    // Empty hint is NOT shown when there is a folder
    expect(screen.queryByText(/no queries yet/i)).toBeNull();
  });

  it("nested_empty_subfolder_is_visible_after_expanding_parent", () => {
    // Regression: nested/empty folders must be wired under their parent so they render.
    vi.mocked(useContextQueries).mockReturnValue(
      makeState([], ["reports", "reports/monthly"]),
    );
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={vi.fn()}
      />,
    );
    // Parent folder renders; nested one is hidden until expanded.
    expect(screen.getByText("reports")).toBeInTheDocument();
    expect(screen.queryByText("monthly")).toBeNull();
    // Expand "reports" → the nested empty subfolder becomes visible.
    fireEvent.click(screen.getByText("reports").closest("button")!);
    expect(screen.getByText("monthly")).toBeInTheDocument();
  });

  it("folders_sort_before_queries", () => {
    const queries: QueryListItem[] = [
      { name: "aaa-query", description: null, params: [], tags: [], path: "aaa-query", folder: "" },
    ];
    vi.mocked(useContextQueries).mockReturnValue(makeState(queries, ["zzz-folder"]));
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={vi.fn()}
      />,
    );
    // Both should be visible
    const folderEl = screen.getByText("zzz-folder");
    const queryEl = screen.getByText("aaa-query");
    // zzz-folder should come BEFORE aaa-query in DOM order
    // (DOCUMENT_POSITION_FOLLOWING means the argument is after the reference)
    expect(
      folderEl.compareDocumentPosition(queryEl) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy(); // aaa-query follows zzz-folder
  });

  // -------------------------------------------------------------------------
  // New query affordance
  // -------------------------------------------------------------------------

  it("shows_new_query_button_when_onNewQuery_provided", () => {
    vi.mocked(useContextQueries).mockReturnValue(emptyState);
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={vi.fn()}
        onNewQuery={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /new context query/i })).toBeInTheDocument();
  });

  it("does_not_show_new_query_button_without_prop", () => {
    vi.mocked(useContextQueries).mockReturnValue(emptyState);
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /new context query/i })).toBeNull();
  });

  it("clicking_new_query_button_opens_name_dialog", () => {
    vi.mocked(useContextQueries).mockReturnValue(emptyState);
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={vi.fn()}
        onNewQuery={vi.fn()}
      />,
    );
    const newBtn = screen.getByRole("button", { name: /new context query/i });
    fireEvent.click(newBtn);
    // The dialog title should appear
    expect(screen.getByText("New context query")).toBeInTheDocument();
  });

  it("new_query_at_root_calls_onNewQuery_without_folder", () => {
    const onNewQuery = vi.fn();
    vi.mocked(useContextQueries).mockReturnValue(emptyState);
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={vi.fn()}
        onNewQuery={onNewQuery}
      />,
    );
    const newBtn = screen.getByRole("button", { name: /new context query/i });
    fireEvent.click(newBtn);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "my-query" } });
    const createBtn = screen.getByRole("button", { name: /^Create$/i });
    fireEvent.click(createBtn);
    expect(onNewQuery).toHaveBeenCalledWith("my-query", undefined);
  });

  // -------------------------------------------------------------------------
  // New folder affordance
  // -------------------------------------------------------------------------

  it("shows_new_folder_button_always_when_context_path_set", () => {
    vi.mocked(useContextQueries).mockReturnValue(emptyState);
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /new folder/i })).toBeInTheDocument();
  });

  it("new_folder_calls_createQueryFolder", async () => {
    vi.mocked(useContextQueries).mockReturnValue(emptyState);
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={vi.fn()}
      />,
    );
    const newFolderBtn = screen.getByRole("button", { name: /new folder/i });
    fireEvent.click(newFolderBtn);
    // Dialog appears
    expect(screen.getByText("New folder")).toBeInTheDocument();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "reports" } });
    const createBtn = screen.getByRole("button", { name: /^Create$/i });
    fireEvent.click(createBtn);
    await waitFor(() => {
      expect(contextApi.createQueryFolder).toHaveBeenCalledWith("conn-1", "reports");
    });
  });

  // -------------------------------------------------------------------------
  // Path-based open: onActivate receives QueryListItem with path
  // -------------------------------------------------------------------------

  it("activating_nested_query_passes_item_with_path", () => {
    const onActivate = vi.fn();
    vi.mocked(useContextQueries).mockReturnValue(makeState(NESTED_QUERIES, ["reports"]));
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={onActivate}
      />,
    );
    // Expand folder first
    const folderBtn = screen.getByText("reports").closest("button")!;
    fireEvent.click(folderBtn);
    // Click inner query
    const innerBtn = screen.getByText("inner").closest("button")!;
    fireEvent.click(innerBtn);
    expect(onActivate).toHaveBeenCalledWith(
      expect.objectContaining({ path: "reports/inner", folder: "reports" }),
    );
  });

  // -------------------------------------------------------------------------
  // Context menu: Move to folder — calls renameQuery with correct paths
  // -------------------------------------------------------------------------

  it("move_calls_renameQuery_with_expected_paths", async () => {
    // Query at root (folder: ""), move to "reports"
    const query: QueryListItem = {
      name: "top-customers",
      description: null,
      params: [],
      tags: [],
      path: "top-customers",
      folder: "",
    };
    vi.mocked(useContextQueries).mockReturnValue(makeState([query], ["reports"]));
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={vi.fn()}
      />,
    );

    // Right-click to open context menu
    const rowBtn = screen.getByText("top-customers").closest("button")!;
    fireEvent.contextMenu(rowBtn);

    // Select "Move to folder…"
    const moveItem = await screen.findByText("Move to folder…");
    fireEvent.click(moveItem);

    // Picker dialog should open
    expect(await screen.findByText("Move to folder")).toBeInTheDocument();

    // Pick "reports" from the list
    const reportsOpt = screen.getByRole("button", { name: "reports" });
    fireEvent.click(reportsOpt);

    // Confirm move
    const moveBtn = screen.getByRole("button", { name: /^Move$/i });
    fireEvent.click(moveBtn);

    await waitFor(() => {
      expect(contextApi.renameQuery).toHaveBeenCalledWith(
        "conn-1",
        "top-customers",
        "reports/top-customers",
      );
    });
  });

  it("move_picker_excludes_current_folder", async () => {
    // Query inside "reports" — "reports" must not appear as a destination
    const query: QueryListItem = {
      name: "inner",
      description: null,
      params: [],
      tags: [],
      path: "reports/inner",
      folder: "reports",
    };
    vi.mocked(useContextQueries).mockReturnValue(
      makeState([query], ["reports", "archive"]),
    );
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={vi.fn()}
      />,
    );

    // Expand "reports" folder to see the query
    const folderBtn = screen.getByText("reports").closest("button")!;
    fireEvent.click(folderBtn);

    // Right-click on "inner"
    const rowBtn = screen.getByText("inner").closest("button")!;
    fireEvent.contextMenu(rowBtn);

    const moveItem = await screen.findByText("Move to folder…");
    fireEvent.click(moveItem);

    // Dialog open — "reports" should NOT appear as an option (it's the current folder)
    await screen.findByText("Move to folder");
    // "(root)" and "archive" should be present
    expect(screen.getByRole("button", { name: "(root)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "archive" })).toBeInTheDocument();
    // "reports" folder option (not the folder row in the tree) should NOT be in the picker
    // The picker button for "reports" should not exist
    const pickerButtons = screen.getAllByRole("button");
    const pickerReports = pickerButtons.filter(
      (b) => b.textContent === "reports" && b.closest("[class*='folderPicker']"),
    );
    expect(pickerReports).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Context menu: Rename — computes to_path correctly
  // -------------------------------------------------------------------------

  it("rename_calls_renameQuery_with_expected_to_path", async () => {
    const query: QueryListItem = {
      name: "top-customers",
      description: null,
      params: [],
      tags: [],
      path: "reports/top-customers",
      folder: "reports",
    };
    vi.mocked(useContextQueries).mockReturnValue(makeState([query], ["reports"]));
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={vi.fn()}
      />,
    );

    // Expand reports to see query
    const folderBtn = screen.getByText("reports").closest("button")!;
    fireEvent.click(folderBtn);

    // Right-click on query
    const rowBtn = screen.getByText("top-customers").closest("button")!;
    fireEvent.contextMenu(rowBtn);

    const renameItem = await screen.findByText("Rename");
    fireEvent.click(renameItem);

    // Dialog opens — prefilled with current name
    const input = await screen.findByRole("textbox");
    // Clear and enter new name
    fireEvent.change(input, { target: { value: "Best customers" } });
    // Submit via Rename button
    const renameBtn = screen.getByRole("button", { name: /^Rename$/i });
    fireEvent.click(renameBtn);

    await waitFor(() => {
      expect(contextApi.renameQuery).toHaveBeenCalledWith(
        "conn-1",
        "reports/top-customers",
        "reports/Best-customers",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Context menu: Delete — shows confirm dialog, calls deleteQuery
  // -------------------------------------------------------------------------

  it("delete_calls_deleteQuery_after_confirm", async () => {
    const query: QueryListItem = {
      name: "top-customers",
      description: null,
      params: [],
      tags: [],
      path: "top-customers",
      folder: "",
    };
    vi.mocked(useContextQueries).mockReturnValue(makeState([query], []));
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={vi.fn()}
      />,
    );

    // Right-click to open context menu
    const rowBtn = screen.getByText("top-customers").closest("button")!;
    fireEvent.contextMenu(rowBtn);

    const deleteItem = await screen.findByText("Delete");
    fireEvent.click(deleteItem);

    // Confirm dialog appears
    expect(await screen.findByText("Delete query")).toBeInTheDocument();

    // Click the danger confirm button (the one with text "Delete" inside the dialog)
    // There will be the dialog title "Delete query" + the button "Delete"
    const confirmBtn = screen.getAllByRole("button", { name: /^Delete$/i })[0]!;
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(contextApi.deleteQuery).toHaveBeenCalledWith("conn-1", "top-customers");
    });
  });

  // -------------------------------------------------------------------------
  // Context menu: Delete folder — calls deleteQueryFolder
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Drag-and-drop move — move-path resolution (pointer DnD is wired via
  // @dnd-kit; its pointer-sensor drag can't be reliably simulated in jsdom,
  // so the drop decision logic is unit-tested here and the end-to-end gesture
  // is covered by manual QA).
  // -------------------------------------------------------------------------

  const mkQuery = (path: string, folder: string): QueryListItem => ({
    name: path.split("/").pop()!,
    description: null,
    params: [],
    tags: [],
    path,
    folder,
  });

  it("drag_root_query_onto_folder_resolves_to_folder_path", () => {
    // Dropping "top-customers" (root) onto "reports" → moves under reports.
    expect(moveTargetOrNoop(mkQuery("top-customers", ""), "reports")).toBe(
      "reports/top-customers",
    );
  });

  it("drop_onto_current_folder_is_a_noop", () => {
    // Dropping "reports/inner" onto "reports" → same path → no move.
    expect(moveTargetOrNoop(mkQuery("reports/inner", "reports"), "reports")).toBeNull();
  });

  it("drop_onto_root_moves_to_top_level", () => {
    // Dropping "reports/inner" onto the root drop zone (dest "") → top level.
    expect(moveTargetOrNoop(mkQuery("reports/inner", "reports"), "")).toBe("inner");
  });

  it("menu_move_to_root_for_root_query_is_a_noop", async () => {
    const query: QueryListItem = {
      name: "top-customers",
      description: null,
      params: [],
      tags: [],
      path: "top-customers",
      folder: "",
    };
    vi.mocked(useContextQueries).mockReturnValue(makeState([query], ["reports"]));
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={vi.fn()}
      />,
    );

    const rowBtn = screen.getByText("top-customers").closest("button")!;
    fireEvent.contextMenu(rowBtn);

    fireEvent.click(await screen.findByText("Move to folder…"));
    await screen.findByText("Move to folder");

    // Pick "(root)" — the query already lives at root → no-op.
    fireEvent.click(screen.getByRole("button", { name: "(root)" }));
    fireEvent.click(screen.getByRole("button", { name: /^Move$/i }));

    await Promise.resolve();
    expect(contextApi.renameQuery).not.toHaveBeenCalled();
  });

  it("delete_folder_calls_deleteQueryFolder", async () => {
    vi.mocked(useContextQueries).mockReturnValue(makeState([], ["archive"]));
    render(
      <ContextQueriesBranch
        connectionId="conn-1"
        connectionName="Local PG"
        contextPath="/some/folder"
        engine="postgres"
        onActivate={vi.fn()}
      />,
    );

    // Right-click on the folder row container (context menu trigger wraps the row div)
    const folderNameEl = screen.getByText("archive");
    // Find the ContextMenu.Trigger wrapper (the div containing folderRow)
    const folderRowDiv = folderNameEl.closest("[class*='folderRow']")!;
    fireEvent.contextMenu(folderRowDiv);

    const deleteItem = await screen.findByText("Delete folder");
    fireEvent.click(deleteItem);

    // Confirm dialog appears
    expect(await screen.findByText("Delete folder")).toBeInTheDocument();

    // Click the danger confirm button
    const confirmBtn = screen.getAllByRole("button", { name: /^Delete$/i })[0]!;
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(contextApi.deleteQueryFolder).toHaveBeenCalledWith("conn-1", "archive");
    });
  });
});
