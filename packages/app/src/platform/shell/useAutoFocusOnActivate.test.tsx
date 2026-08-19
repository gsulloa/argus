import { describe, expect, it, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRef } from "react";
import { useAutoFocusOnActivate } from "./useAutoFocusOnActivate";

const nextFrame = () =>
  act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  });

afterEach(() => {
  document.body.innerHTML = "";
});

function renderAutoFocus(
  active: boolean,
  root: HTMLElement,
  target: { focus(): void } | null,
) {
  return renderHook(
    ({ active }: { active: boolean }) => {
      const rootRef = useRef<HTMLElement | null>(root);
      const targetRef = useRef<{ focus(): void } | null>(target);
      useAutoFocusOnActivate({ active, rootRef, targetRef });
    },
    { initialProps: { active } },
  );
}

/**
 * Builds a target that behaves like a real, visible, mounted data grid: a
 * focusable child element genuinely appended *inside* `root`, whose
 * `focus()` actually moves `document.activeElement`. A bare
 * `{ focus: vi.fn() }` stub never moves `document.activeElement`, so it
 * can't distinguish "the grid took focus" from "the grid's focus() call was
 * a no-op and the root took over" — which is exactly the distinction the
 * hook's verify-then-fallback logic exists to handle (see
 * useAutoFocusOnActivate.ts).
 */
function createMountedGridTarget(root: HTMLElement) {
  const gridEl = document.createElement("div");
  gridEl.tabIndex = 0;
  root.appendChild(gridEl);
  const target = { focus: vi.fn(() => gridEl.focus()) };
  return { target, gridEl };
}

describe("useAutoFocusOnActivate", () => {
  it("focuses targetRef.current when mounted with active: true", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const rootFocusSpy = vi.spyOn(root, "focus");
    const { target, gridEl } = createMountedGridTarget(root);

    renderAutoFocus(true, root, target);
    await nextFrame();

    expect(target.focus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(gridEl);
    expect(rootFocusSpy).not.toHaveBeenCalled();
  });

  it("focuses on a false -> true rerender", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const rootFocusSpy = vi.spyOn(root, "focus");
    const { target, gridEl } = createMountedGridTarget(root);

    const { rerender } = renderAutoFocus(false, root, target);
    await nextFrame();
    expect(target.focus).not.toHaveBeenCalled();

    rerender({ active: true });
    await nextFrame();

    expect(target.focus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(gridEl);
    expect(rootFocusSpy).not.toHaveBeenCalled();
  });

  it("falls back to rootRef.current.focus() when targetRef.current is null", async () => {
    const root = document.createElement("div");
    root.tabIndex = -1;
    document.body.appendChild(root);
    const focusSpy = vi.spyOn(root, "focus");

    renderAutoFocus(true, root, null);
    await nextFrame();

    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(root);
  });

  it("falls back to rootRef.current.focus() when the target's focus() is a no-op", async () => {
    // Simulates the Postgres/MSSQL "grid mounted but display: none" case:
    // targetRef.current is non-null, but calling focus() on it doesn't move
    // document.activeElement. We reproduce that with a stub whose focus()
    // does nothing at all, rather than with a real display:none DOM node,
    // because jsdom performs no layout/paint and will happily focus a real
    // display:none element — so a real hidden node would NOT exercise this
    // branch under jsdom the way it does in a real browser. The no-op stub
    // gives the same observable behavior (focus() is called, but
    // document.activeElement doesn't move) without relying on layout.
    const root = document.createElement("div");
    root.tabIndex = -1;
    document.body.appendChild(root);
    const rootFocusSpy = vi.spyOn(root, "focus");
    const target = { focus: vi.fn() };

    renderAutoFocus(true, root, target);
    await nextFrame();

    expect(target.focus).toHaveBeenCalledTimes(1);
    expect(rootFocusSpy).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(root);
  });

  it("no-ops when focus is already inside rootRef", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const rootFocusSpy = vi.spyOn(root, "focus");
    const child = document.createElement("button");
    root.appendChild(child);
    child.focus();
    const target = { focus: vi.fn() };

    renderAutoFocus(true, root, target);
    await nextFrame();

    expect(target.focus).not.toHaveBeenCalled();
    expect(rootFocusSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(child);
  });

  it("no-ops when an <input> outside the tab is focused", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const rootFocusSpy = vi.spyOn(root, "focus");
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();
    const target = { focus: vi.fn() };

    renderAutoFocus(true, root, target);
    await nextFrame();

    expect(target.focus).not.toHaveBeenCalled();
    expect(rootFocusSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
  });

  it("no-ops when a <textarea> outside the tab is focused", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const rootFocusSpy = vi.spyOn(root, "focus");
    const outside = document.createElement("textarea");
    document.body.appendChild(outside);
    outside.focus();
    const target = { focus: vi.fn() };

    renderAutoFocus(true, root, target);
    await nextFrame();

    expect(target.focus).not.toHaveBeenCalled();
    expect(rootFocusSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
  });

  it("no-ops when focus is inside a .cm-editor container", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const rootFocusSpy = vi.spyOn(root, "focus");
    const cm = document.createElement("div");
    cm.className = "cm-editor";
    const inner = document.createElement("div");
    inner.tabIndex = 0;
    cm.appendChild(inner);
    document.body.appendChild(cm);
    inner.focus();
    const target = { focus: vi.fn() };

    renderAutoFocus(true, root, target);
    await nextFrame();

    expect(target.focus).not.toHaveBeenCalled();
    expect(rootFocusSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(inner);
  });

  it("does not focus again on true -> false", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const rootFocusSpy = vi.spyOn(root, "focus");
    const { target, gridEl } = createMountedGridTarget(root);

    const { rerender } = renderAutoFocus(true, root, target);
    await nextFrame();
    expect(target.focus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(gridEl);
    expect(rootFocusSpy).not.toHaveBeenCalled();

    (document.activeElement as HTMLElement | null)?.blur?.();
    rerender({ active: false });
    await nextFrame();

    expect(target.focus).toHaveBeenCalledTimes(1);
    expect(rootFocusSpy).not.toHaveBeenCalled();
  });

  it("does not re-fire on a rerender with active still true", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const rootFocusSpy = vi.spyOn(root, "focus");
    const { target } = createMountedGridTarget(root);

    const { rerender } = renderAutoFocus(true, root, target);
    await nextFrame();
    expect(target.focus).toHaveBeenCalledTimes(1);

    rerender({ active: true });
    await nextFrame();

    expect(target.focus).toHaveBeenCalledTimes(1);
    expect(rootFocusSpy).not.toHaveBeenCalled();
  });

  it("cancels the pending frame on unmount", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const rootFocusSpy = vi.spyOn(root, "focus");
    const { target } = createMountedGridTarget(root);

    const { unmount } = renderAutoFocus(true, root, target);
    unmount();
    await nextFrame();

    expect(target.focus).not.toHaveBeenCalled();
    expect(rootFocusSpy).not.toHaveBeenCalled();
  });
});
