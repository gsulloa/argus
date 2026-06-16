import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

vi.mock("@/platform/settings/api", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

import { getSetting, setSetting } from "@/platform/settings/api";
import { shouldCloseTab } from "@/platform/shell/tabs/useCloseConfirm";
import { useQueryBuffer } from "./useQueryBuffer";

const getSettingMock = vi.mocked(getSetting);
const setSettingMock = vi.mocked(setSetting);

const StrictWrapper = ({ children }: { children: React.ReactNode }) => (
  <React.StrictMode>{children}</React.StrictMode>
);

describe("useQueryBuffer", () => {
  beforeEach(() => {
    getSettingMock.mockReset();
    setSettingMock.mockReset();
    getSettingMock.mockResolvedValue(null);
    setSettingMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("preserves the prefilled fallback under StrictMode dev double-mount (Tauri)", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    // Settings has no record for this tabId — getSetting returns null. Even
    // so, the strict-mode replay must NOT clobber the fallback.
    getSettingMock.mockResolvedValue(null);

    const tabId = "pgquery:test:strict-1";
    const fallback = "SELECT * FROM \"public\".\"users\" WHERE \"country\" = 'CL' LIMIT 200";

    const { result } = renderHook(() => useQueryBuffer(tabId, fallback), {
      wrapper: StrictWrapper,
    });

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    expect(result.current.initialSql).toBe(fallback);
    // Critically: setSetting must NOT have been called with `""` during the
    // mount/replay cycle (the prior bug). The buffer wipe only fires on a
    // real tab close (covered by the next test).
    const wipeCalls = setSettingMock.mock.calls.filter(
      ([key, value]) => key === `pgQueryBuffer:${tabId}` && (value === "" || value === '""'),
    );
    expect(wipeCalls).toHaveLength(0);
  });

  it("shouldCloseTab triggers the buffer wipe via the close-handler registry", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};

    const tabId = "pgquery:test:close-1";
    const { unmount } = renderHook(() =>
      useQueryBuffer(tabId, "SELECT 1"),
    );

    // Trigger the close-handler — what TabStrip does on the close button.
    const allowed = await shouldCloseTab(tabId);
    expect(allowed).toBe(true);
    expect(setSettingMock).toHaveBeenCalledWith(`pgQueryBuffer:${tabId}`, "");

    unmount();
  });
});
