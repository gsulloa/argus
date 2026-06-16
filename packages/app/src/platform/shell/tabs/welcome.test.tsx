import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Connection } from "@/platform/connection-registry/types";
import type { AiSettingsView } from "@/modules/ai/types";

// --- Mock the reactive stores and flow entry points -------------------------

const mockUseConnections = vi.fn();
const mockUseAiSettings = vi.fn();
const mockKindPickerOpen = vi.fn();
const mockCommandRun = vi.fn();
const mockCommandGet = vi.fn();
const mockPgOpenEdit = vi.fn();
const mockMyOpenEdit = vi.fn();
const mockMsOpenEdit = vi.fn();
const mockDyOpenEdit = vi.fn();

vi.mock("@/platform/connection-registry/useConnections", () => ({
  useConnections: () => mockUseConnections(),
}));

vi.mock("@/modules/ai/store", () => ({
  useAiSettings: () => mockUseAiSettings(),
}));

vi.mock("@/platform/shell/useKindPicker", () => ({
  useKindPicker: () => ({ open: mockKindPickerOpen, close: vi.fn() }),
}));

vi.mock("@/platform/command-palette/CommandRegistry", () => ({
  CommandRegistry: { get: (id: string) => mockCommandGet(id) },
}));

vi.mock("@/modules/postgres", () => ({
  usePostgresForm: () => ({ openEdit: mockPgOpenEdit }),
  POSTGRES_KIND: "postgres",
}));
vi.mock("@/modules/mysql", () => ({
  useMysqlForm: () => ({ openEdit: mockMyOpenEdit }),
  MYSQL_KIND: "mysql",
}));
vi.mock("@/modules/mssql", () => ({
  useMssqlForm: () => ({ openEdit: mockMsOpenEdit }),
  MSSQL_KIND: "mssql",
}));
vi.mock("@/modules/dynamo", () => ({
  useDynamoForm: () => ({ openEdit: mockDyOpenEdit }),
  DYNAMO_KIND: "dynamodb",
}));

// TabRegistry.register runs at import time; importing after the mocks are set up.
import { WelcomeTab } from "./welcome";

// --- Fixtures ----------------------------------------------------------------

function makeConnection(over: Partial<Connection> = {}): Connection {
  return {
    id: "c1",
    name: "Conn",
    kind: "postgres",
    params: {} as Connection["params"],
    group_id: null,
    sort_order: 0,
    context_path: null,
    project_source_path: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

const EMPTY_SETTINGS: AiSettingsView = {
  default_provider: null,
  claude_cli_model: null,
  codex_cli_model: null,
  anthropic_api_model: null,
  openai_api_model: null,
  overrides: [],
  key_present: { anthropic: false, openai: false },
};

function setup(opts: {
  connections?: Connection[];
  settings?: AiSettingsView | null;
} = {}) {
  mockUseConnections.mockReturnValue({ items: opts.connections ?? [] });
  mockUseAiSettings.mockReturnValue({ settings: opts.settings ?? EMPTY_SETTINGS });
  mockCommandGet.mockReturnValue({ run: mockCommandRun });
}

function renderTab() {
  return render(<WelcomeTab tab={null} active={true} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe("WelcomeTab onboarding checklist", () => {
  it("renders the Getting started checklist with all three items", () => {
    setup();
    renderTab();
    expect(screen.getByText("Getting started")).toBeTruthy();
    // "Add a connection" is also the CTA label, so it appears twice.
    expect(screen.getAllByText("Add a connection").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Configure AI")).toBeTruthy();
    expect(screen.getByText("Link a context folder")).toBeTruthy();
  });

  it("marks all items unsatisfied in the fresh state", () => {
    setup();
    renderTab();
    // No item satisfied → three ○ todo marks, no ✓.
    expect(screen.queryAllByText("✓")).toHaveLength(0);
    expect(screen.queryAllByText("○")).toHaveLength(3);
  });

  it("add-connection CTA opens the kind picker", () => {
    setup();
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Add a connection" }));
    expect(mockKindPickerOpen).toHaveBeenCalledTimes(1);
  });

  it("configure-AI CTA runs the ai.configureProviders command", () => {
    setup();
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Configure providers" }));
    expect(mockCommandGet).toHaveBeenCalledWith("ai.configureProviders");
    expect(mockCommandRun).toHaveBeenCalledTimes(1);
  });

  it("locks the context-folder item with no CTA while no connection exists", () => {
    setup();
    renderTab();
    expect(screen.getByText("Add a connection first.")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Link context folder" }),
    ).toBeNull();
  });

  it("marks add-connection satisfied and unlocks the context item once a connection exists", () => {
    setup({ connections: [makeConnection()] });
    renderTab();
    // connection satisfied (✓), context now unlocked with a CTA.
    expect(screen.getAllByText("✓").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: "Link context folder" })).toBeTruthy();
    expect(screen.queryByText("Add a connection first.")).toBeNull();
  });

  it("locks the context item (no CTA) when the only connection can't link a folder", () => {
    // CloudWatch (and any engine without a form handler) has no edit form to
    // open, so the CTA must not dead-end.
    setup({ connections: [makeConnection({ kind: "cloudwatch" })] });
    renderTab();
    expect(
      screen.queryByRole("button", { name: "Link context folder" }),
    ).toBeNull();
    expect(
      screen.getByText("Connect a SQL or DynamoDB source to link a folder."),
    ).toBeTruthy();
  });

  it("targets the first folder-capable connection, skipping unsupported ones", () => {
    setup({
      connections: [
        makeConnection({ id: "cw", kind: "cloudwatch" }),
        makeConnection({ id: "pg", kind: "postgres" }),
      ],
    });
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Link context folder" }));
    expect(mockPgOpenEdit).toHaveBeenCalledTimes(1);
    expect(mockPgOpenEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pg" }),
    );
  });

  it("link-context-folder CTA opens the edit form for the connection's kind", () => {
    setup({ connections: [makeConnection({ kind: "mysql" })] });
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Link context folder" }));
    expect(mockMyOpenEdit).toHaveBeenCalledTimes(1);
    expect(mockPgOpenEdit).not.toHaveBeenCalled();
  });

  it("marks configure-AI satisfied when a default provider exists", () => {
    setup({ settings: { ...EMPTY_SETTINGS, default_provider: "claude-cli" } });
    renderTab();
    expect(
      screen.queryByRole("button", { name: "Configure providers" }),
    ).toBeNull();
  });

  it("marks configure-AI satisfied when a per-connection override exists", () => {
    setup({
      settings: {
        ...EMPTY_SETTINGS,
        overrides: [{ connection_id: "c1", provider_id: "openai-api", model: null }],
      },
    });
    renderTab();
    expect(
      screen.queryByRole("button", { name: "Configure providers" }),
    ).toBeNull();
  });

  it("collapses to the 'all set' state when all three prerequisites are met", () => {
    setup({
      connections: [makeConnection({ context_path: "/ctx" })],
      settings: { ...EMPTY_SETTINGS, default_provider: "claude-cli" },
    });
    renderTab();
    expect(screen.getByText("You’re all set")).toBeTruthy();
    // The active checklist CTAs are gone.
    expect(screen.queryByRole("button", { name: "Add a connection" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Configure providers" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Link context folder" })).toBeNull();
  });
});
