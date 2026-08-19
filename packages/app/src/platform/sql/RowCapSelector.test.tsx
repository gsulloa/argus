/**
 * RowCapSelector tests (tasks 5.2/5.4).
 *
 * `sql.rowCap` lives in `useSetting`'s module-level memory cache, so state
 * can carry across `it` blocks in this file the same way it would across
 * two mounts of the real control in the app — assertions capture the
 * trigger's label immediately before an action and compare against it
 * afterward, rather than assuming a fixed starting value.
 *
 * `useSetting` only calls the Tauri `setSetting` IPC command when running
 * under an actual Tauri webview (`isTauriRuntime()`); in this jsdom
 * environment it intentionally short-circuits to local state + the memory
 * cache only, so a "write" is verified here by (a) the trigger's own label
 * updating and (b) a freshly mounted second instance of the control picking
 * up the same value from the shared memory cache — the same mechanism the
 * real app relies on when a query tab remounts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RowCapSelector } from "./RowCapSelector";

vi.mock("@/platform/settings/api", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

function trigger(): HTMLElement {
  // Queried by test id (not role): while the dropdown is open, Radix marks
  // the rest of the document `aria-hidden="true"` for a11y focus-trapping,
  // which would make an accessible-role query for the trigger fail even
  // though the element is still very much in the DOM.
  return screen.getByTestId("row-cap-trigger");
}

function openMenu(): void {
  fireEvent.pointerDown(trigger(), { button: 0, ctrlKey: false });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("RowCapSelector", () => {
  it("the trigger reflects the current sql.rowCap value", () => {
    render(<RowCapSelector />);
    expect(trigger().textContent).toMatch(/^Limit: /);
  });

  it("picking 50k writes 50000: the trigger updates and a fresh mount agrees", async () => {
    const { unmount } = render(<RowCapSelector />);
    openMenu();

    const item = await screen.findByText("50k");
    fireEvent.click(item);

    expect(trigger().textContent).toContain("Limit: 50k");
    unmount();

    // A brand-new instance reads the same shared memory cache.
    render(<RowCapSelector />);
    expect(trigger().textContent).toContain("Limit: 50k");
  });

  it("Custom… with 0 is rejected and leaves the setting/display unchanged", async () => {
    const { unmount } = render(<RowCapSelector />);
    const before = trigger().textContent;

    openMenu();
    fireEvent.click(await screen.findByText("Custom…"));

    const input = await screen.findByPlaceholderText("Rows (1–1,000,000)");
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(trigger().textContent).toBe(before);
    unmount();

    render(<RowCapSelector />);
    expect(trigger().textContent).toBe(before);
  });

  it("Custom… with 2000000 is rejected and leaves the setting/display unchanged", async () => {
    const { unmount } = render(<RowCapSelector />);
    const before = trigger().textContent;

    openMenu();
    fireEvent.click(await screen.findByText("Custom…"));

    const input = await screen.findByPlaceholderText("Rows (1–1,000,000)");
    fireEvent.change(input, { target: { value: "2000000" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(trigger().textContent).toBe(before);
    unmount();

    render(<RowCapSelector />);
    expect(trigger().textContent).toBe(before);
  });

  it("Custom… with a valid value (e.g. 250000) writes the setting and updates the trigger", async () => {
    const { unmount } = render(<RowCapSelector />);

    openMenu();
    fireEvent.click(await screen.findByText("Custom…"));

    const input = await screen.findByPlaceholderText("Rows (1–1,000,000)");
    fireEvent.change(input, { target: { value: "250000" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(trigger().textContent).toContain("Limit: 250k");
    });
    unmount();

    render(<RowCapSelector />);
    expect(trigger().textContent).toContain("Limit: 250k");
  });
});
