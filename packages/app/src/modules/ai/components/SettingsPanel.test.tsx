import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockUseAiSettings, mockSetSettings, mockSetApiKey, mockDeleteApiKey } = vi.hoisted(
  () => ({
    mockUseAiSettings: vi.fn(),
    mockSetSettings: vi.fn(),
    mockSetApiKey: vi.fn(),
    mockDeleteApiKey: vi.fn(),
  }),
);

vi.mock("@/modules/ai/store", () => ({
  useAiSettings: () => mockUseAiSettings(),
}));

vi.mock("@/modules/ai/api", () => ({
  aiApi: {
    setSettings: (...args: unknown[]) => mockSetSettings(...args),
    setApiKey: (...args: unknown[]) => mockSetApiKey(...args),
    deleteApiKey: (...args: unknown[]) => mockDeleteApiKey(...args),
  },
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { SettingsPanel } from "./SettingsPanel";
import type { AiSettingsView, ProviderListEntry } from "@/modules/ai/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLAUDE_CLI_ENTRY: ProviderListEntry = {
  id: "claude-cli",
  capabilities: {
    can_read_files: true,
    supports_streaming: false,
    requires_api_key: false,
    default_model: "claude-opus-4-8",
    available_models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
  },
  validation: { kind: "Ready" },
};

const CODEX_CLI_ENTRY: ProviderListEntry = {
  id: "codex-cli",
  capabilities: {
    can_read_files: false,
    supports_streaming: false,
    requires_api_key: false,
    default_model: "o4-mini",
    available_models: ["o4-mini", "o3"],
  },
  validation: { kind: "Missing", hint: "codex not found in PATH" },
};

const ANTHROPIC_API_ENTRY: ProviderListEntry = {
  id: "anthropic-api",
  capabilities: {
    can_read_files: false,
    supports_streaming: false,
    requires_api_key: true,
    default_model: "claude-opus-4-8",
    available_models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
  },
  validation: { kind: "Missing", hint: "Enter an API key below" },
};

const OPENAI_API_ENTRY: ProviderListEntry = {
  id: "openai-api",
  capabilities: {
    can_read_files: false,
    supports_streaming: false,
    requires_api_key: true,
    default_model: "gpt-5.1",
    available_models: ["gpt-5.1", "gpt-5.1-mini", "gpt-4o"],
  },
  validation: { kind: "Ready" },
};

const ALL_PROVIDERS: ProviderListEntry[] = [
  CLAUDE_CLI_ENTRY,
  CODEX_CLI_ENTRY,
  ANTHROPIC_API_ENTRY,
  OPENAI_API_ENTRY,
];

const BASE_SETTINGS: AiSettingsView = {
  default_provider: "claude-cli",
  claude_cli_model: null,
  codex_cli_model: null,
  anthropic_api_model: null,
  openai_api_model: "gpt-5.1-mini",
  overrides: [],
  key_present: { anthropic: false, openai: false },
};

function makeRefresh() {
  return vi.fn().mockResolvedValue(undefined);
}

function setupStore(overrides: Partial<{
  settings: AiSettingsView | null;
  providers: ProviderListEntry[];
  loading: boolean;
  error: string | null;
  refresh: ReturnType<typeof vi.fn>;
}> = {}) {
  const refresh = overrides.refresh ?? makeRefresh();
  mockUseAiSettings.mockReturnValue({
    settings: BASE_SETTINGS,
    providers: ALL_PROVIDERS,
    loading: false,
    error: null,
    refresh,
    ...overrides,
  });
  return { refresh };
}

function renderPanel({
  open = true,
  onOpenChange = vi.fn(),
} = {}) {
  return render(<SettingsPanel open={open} onOpenChange={onOpenChange} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SettingsPanel — loaded settings preselected", () => {
  beforeEach(() => {
    mockSetSettings.mockResolvedValue(undefined);
    mockSetApiKey.mockResolvedValue(undefined);
    mockDeleteApiKey.mockResolvedValue(undefined);
  });

  it("radio is checked for the loaded default_provider", () => {
    setupStore({ settings: { ...BASE_SETTINGS, default_provider: "claude-cli" } });
    renderPanel();

    const claudeRadio = screen.getByRole("radio", { name: /claude cli/i });
    expect((claudeRadio as HTMLInputElement).checked).toBe(true);
  });

  it("OpenAI model dropdown shows the configured model (gpt-5.1-mini)", () => {
    setupStore({
      settings: { ...BASE_SETTINGS, openai_api_model: "gpt-5.1-mini" },
    });
    renderPanel();

    // There are multiple model dropdowns — find the one for openai-api by its id
    const openaiModelSelect = document.getElementById("model-openai-api") as HTMLSelectElement;
    expect(openaiModelSelect).toBeTruthy();
    expect(openaiModelSelect.value).toBe("gpt-5.1-mini");
  });
});

describe("SettingsPanel — retired model fallback", () => {
  beforeEach(() => {
    mockSetSettings.mockResolvedValue(undefined);
  });

  it("falls back to default_model when persisted model is not in available_models", () => {
    // gpt-4o-mini is a retired id not present in OPENAI_API_ENTRY.available_models
    setupStore({
      settings: { ...BASE_SETTINGS, openai_api_model: "gpt-4o-mini" },
    });
    renderPanel();

    const openaiModelSelect = document.getElementById("model-openai-api") as HTMLSelectElement;
    expect(openaiModelSelect).toBeTruthy();
    // Should show default_model ("gpt-5.1"), not the retired id
    expect(openaiModelSelect.value).toBe("gpt-5.1");
    // No option for the retired id
    const options = Array.from(openaiModelSelect.options).map((o) => o.value);
    expect(options).not.toContain("gpt-4o-mini");
  });
});

describe("SettingsPanel — API key flow", () => {
  beforeEach(() => {
    mockSetApiKey.mockResolvedValue(undefined);
    mockDeleteApiKey.mockResolvedValue(undefined);
  });

  it("saving a key calls setApiKey and clears the input", async () => {
    const refresh = makeRefresh();
    setupStore({ refresh });
    renderPanel();

    const keyInput = screen.getByLabelText(/anthropic api key/i) as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: "sk-ant-test-123" } });
    expect(keyInput.value).toBe("sk-ant-test-123");

    // Find the Save button that is a sibling of the key input (inside the keyRow)
    // by getting the button next to the input
    const keyRow = keyInput.closest("div")!;
    const anthropicSave = keyRow.querySelector("button") as HTMLButtonElement;
    expect(anthropicSave).toBeTruthy();

    await act(async () => {
      fireEvent.click(anthropicSave);
    });

    expect(mockSetApiKey).toHaveBeenCalledWith("anthropic-api", "sk-ant-test-123");
    expect(keyInput.value).toBe("");
    expect(refresh).toHaveBeenCalled();
  });
});

describe("SettingsPanel — Save settings", () => {
  beforeEach(() => {
    mockSetSettings.mockReset();
    mockSetSettings.mockResolvedValue(undefined);
  });

  it("clicking Save calls setSettings and closes the modal", async () => {
    const onOpenChange = vi.fn();
    setupStore();
    renderPanel({ onOpenChange });

    // Change the default provider to trigger dirty state
    const openaiRadio = screen.getByRole("radio", { name: /openai api/i });
    fireEvent.click(openaiRadio);

    const saveBtn = screen.getByRole("button", { name: /save settings/i });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    expect(mockSetSettings).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Cancel does not call setSettings and calls onOpenChange(false)", () => {
    const onOpenChange = vi.fn();
    setupStore();
    renderPanel({ onOpenChange });

    // Change something to make it dirty
    const openaiRadio = screen.getByRole("radio", { name: /openai api/i });
    fireEvent.click(openaiRadio);

    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    fireEvent.click(cancelBtn);

    expect(mockSetSettings).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("SettingsPanel — Unready selection warns inline", () => {
  it("shows inline warning when a Missing provider is selected as default", () => {
    setupStore({
      settings: { ...BASE_SETTINGS, default_provider: "codex-cli" },
    });
    renderPanel();

    // codex-cli is Missing — warning should be visible
    expect(
      screen.getByText(/this provider isn't ready/i),
    ).toBeTruthy();
  });

  it("no warning when a Ready provider is selected", () => {
    setupStore({
      settings: { ...BASE_SETTINGS, default_provider: "claude-cli" },
    });
    renderPanel();

    expect(screen.queryByText(/this provider isn't ready/i)).toBeNull();
  });
});

describe("SettingsPanel — CLI sub-card omits API key input", () => {
  it("Anthropic API key input exists", () => {
    setupStore();
    renderPanel();
    expect(screen.getByLabelText(/anthropic api key/i)).toBeTruthy();
  });

  it("Claude CLI has no API key input, shows install hint instead", () => {
    setupStore();
    renderPanel();
    expect(screen.queryByLabelText(/claude cli api key/i)).toBeNull();
    expect(screen.getByText(/install claude code/i)).toBeTruthy();
  });

  it("Codex CLI has no API key input, shows install hint instead", () => {
    setupStore();
    renderPanel();
    expect(screen.queryByLabelText(/codex cli api key/i)).toBeNull();
    expect(screen.getByText(/install openai codex cli/i)).toBeTruthy();
  });
});

describe("SettingsPanel — Save button disabled state", () => {
  it("Save is disabled when form is unchanged", () => {
    setupStore();
    renderPanel();

    const saveBtn = screen.getByRole("button", { name: /save settings/i });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("Save is enabled after changing the radio", () => {
    setupStore({
      settings: { ...BASE_SETTINGS, default_provider: "claude-cli" },
    });
    renderPanel();

    const saveBtn = screen.getByRole("button", { name: /save settings/i });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);

    const openaiRadio = screen.getByRole("radio", { name: /openai api/i });
    fireEvent.click(openaiRadio);

    expect((saveBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it("Save remains disabled when no settings are loaded yet", async () => {
    setupStore({ settings: null, loading: true });
    renderPanel();

    // Loading state is shown
    expect(screen.getByText(/loading/i)).toBeTruthy();
    // Save button still exists in footer
    const saveBtn = screen.getByRole("button", { name: /save settings/i });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("SettingsPanel — refresh on open", () => {
  it("calls refresh when opened", async () => {
    const refresh = makeRefresh();
    setupStore({ refresh });

    const onOpenChange = vi.fn();
    const { rerender } = render(<SettingsPanel open={false} onOpenChange={onOpenChange} />);

    expect(refresh).not.toHaveBeenCalled();

    await act(async () => {
      rerender(<SettingsPanel open={true} onOpenChange={onOpenChange} />);
    });

    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
  });
});
