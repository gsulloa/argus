import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  deriveReadinessLevel,
  isProviderConfigured,
  useAiReadiness,
  type ContextState,
} from "./useAiReadiness";
import type { AiSettingsView } from "./types";

// --- Mocks for the hook's dependencies --------------------------------------

const mockListObjects = vi.fn();
let mockItems: Array<{ id: string; context_path: string | null }> = [];

vi.mock("@/modules/context/api", () => ({
  contextApi: { listObjects: (...args: unknown[]) => mockListObjects(...args) },
}));
vi.mock("@/modules/context/eventBus", () => ({
  useContextChangeListener: () => {},
}));
vi.mock("@/modules/context/components/availability", () => ({
  isMissingFolderError: (msg: string) => msg.includes("missing"),
}));
vi.mock("./store", () => ({
  useAiSettings: () => ({ settings: { default_provider: "claude-cli" } }),
}));
vi.mock("@/platform/connection-registry/useConnections", () => ({
  useConnections: () => ({ items: mockItems }),
}));

const BASE_SETTINGS: AiSettingsView = {
  default_provider: null,
  claude_cli_model: null,
  codex_cli_model: null,
  anthropic_api_model: null,
  openai_api_model: null,
  overrides: [],
  key_present: { anthropic: false, openai: false },
};

describe("isProviderConfigured", () => {
  it("false when settings null", () => {
    expect(isProviderConfigured(null, "c1")).toBe(false);
  });
  it("false when no default and no override", () => {
    expect(isProviderConfigured(BASE_SETTINGS, "c1")).toBe(false);
  });
  it("true when a global default provider exists", () => {
    expect(
      isProviderConfigured(
        { ...BASE_SETTINGS, default_provider: "claude-cli" },
        "c1",
      ),
    ).toBe(true);
  });
  it("true when a per-connection override exists", () => {
    expect(
      isProviderConfigured(
        {
          ...BASE_SETTINGS,
          overrides: [
            { connection_id: "c1", provider_id: "openai-api", model: null },
          ],
        },
        "c1",
      ),
    ).toBe(true);
  });
  it("false when override is for a different connection", () => {
    expect(
      isProviderConfigured(
        {
          ...BASE_SETTINGS,
          overrides: [
            { connection_id: "other", provider_id: "openai-api", model: null },
          ],
        },
        "c1",
      ),
    ).toBe(false);
  });
  it("false when connectionId is null and only an override exists", () => {
    expect(
      isProviderConfigured(
        {
          ...BASE_SETTINGS,
          overrides: [
            { connection_id: "c1", provider_id: "openai-api", model: null },
          ],
        },
        null,
      ),
    ).toBe(false);
  });
});

describe("deriveReadinessLevel", () => {
  const contexts: ContextState[] = ["none", "available", "missing", "unknown"];

  it("not-configured whenever provider is missing, regardless of context", () => {
    for (const ctx of contexts) {
      expect(deriveReadinessLevel(false, ctx)).toBe("not-configured");
    }
  });

  it("ready only when provider configured and context available", () => {
    expect(deriveReadinessLevel(true, "available")).toBe("ready");
  });

  it("needs-context when provider configured but context none/missing/unknown", () => {
    expect(deriveReadinessLevel(true, "none")).toBe("needs-context");
    expect(deriveReadinessLevel(true, "missing")).toBe("needs-context");
    expect(deriveReadinessLevel(true, "unknown")).toBe("needs-context");
  });
});

describe("useAiReadiness — stale-result guard", () => {
  beforeEach(() => {
    mockListObjects.mockReset();
    mockItems = [];
  });

  it("ignores a late folder-check result from a previous connection", async () => {
    // Connection A has a folder; its listObjects never resolves until we say so.
    let resolveA: (() => void) | undefined;
    const pendingA = new Promise<void>((res) => {
      resolveA = () => res();
    });
    mockListObjects.mockReturnValueOnce(pendingA);
    mockItems = [
      { id: "A", context_path: "/a" },
      { id: "B", context_path: null },
    ];

    const { result, rerender } = renderHook((id: string) => useAiReadiness(id), {
      initialProps: "A",
    });

    // Switch to connection B (no folder) before A's check resolves.
    rerender("B");
    await waitFor(() => expect(result.current.contextState).toBe("none"));

    // A's check resolves late — the guard must drop it, keeping B's "none".
    await act(async () => {
      resolveA?.();
      await pendingA;
    });
    expect(result.current.contextState).toBe("none");
    expect(result.current.level).toBe("needs-context");
  });

  it("applies the result for the current connection", async () => {
    mockListObjects.mockResolvedValue(undefined);
    mockItems = [{ id: "A", context_path: "/a" }];

    const { result } = renderHook(() => useAiReadiness("A"));

    await waitFor(() => expect(result.current.contextState).toBe("available"));
    expect(result.current.level).toBe("ready");
  });
});
