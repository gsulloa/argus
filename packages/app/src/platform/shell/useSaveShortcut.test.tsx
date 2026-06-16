import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { useSaveShortcut } from "./useSaveShortcut";

function pressSave() {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "s",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useSaveShortcut", () => {
  it("fires when nothing is focused", () => {
    const onSave = vi.fn();
    const root = document.createElement("div");
    document.body.appendChild(root);
    renderHook(() => {
      const rootRef = useRef<HTMLDivElement | null>(root);
      useSaveShortcut({ active: true, rootRef, onSave });
    });
    pressSave();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("fires when focus is within the root", () => {
    const onSave = vi.fn();
    const root = document.createElement("div");
    const input = document.createElement("input");
    root.appendChild(input);
    document.body.appendChild(root);
    input.focus();
    renderHook(() => {
      const rootRef = useRef<HTMLDivElement | null>(root);
      useSaveShortcut({ active: true, rootRef, onSave });
    });
    pressSave();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("does not fire when focus is in a CodeMirror editor", () => {
    const onSave = vi.fn();
    const root = document.createElement("div");
    const cm = document.createElement("div");
    cm.className = "cm-editor";
    const inner = document.createElement("input");
    cm.appendChild(inner);
    root.appendChild(cm);
    document.body.appendChild(root);
    inner.focus();
    renderHook(() => {
      const rootRef = useRef<HTMLDivElement | null>(root);
      useSaveShortcut({ active: true, rootRef, onSave });
    });
    pressSave();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not fire when focus is outside the root", () => {
    const onSave = vi.fn();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();
    renderHook(() => {
      const rootRef = useRef<HTMLDivElement | null>(root);
      useSaveShortcut({ active: true, rootRef, onSave });
    });
    pressSave();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not fire when inactive", () => {
    const onSave = vi.fn();
    const root = document.createElement("div");
    document.body.appendChild(root);
    renderHook(() => {
      const rootRef = useRef<HTMLDivElement | null>(root);
      useSaveShortcut({ active: false, rootRef, onSave });
    });
    pressSave();
    expect(onSave).not.toHaveBeenCalled();
  });
});
