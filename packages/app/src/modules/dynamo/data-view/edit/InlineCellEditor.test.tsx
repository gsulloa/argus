/**
 * InlineCellEditor.test.tsx — task 6.5
 *
 * Tests each tag editor: S, N, BOOL, NULL.
 * Also tests saving=true disables input and shows spinner.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { InlineCellEditor } from "./InlineCellEditor";

// ---------------------------------------------------------------------------
// S editor
// ---------------------------------------------------------------------------

describe("InlineCellEditor — S (string)", () => {
  it("renders text input pre-filled with current value", () => {
    render(
      <InlineCellEditor
        value={{ S: "hello" }}
        onCommit={vi.fn()}
        onCancel={vi.fn()}
        saving={false}
      />,
    );
    const input = screen.getByTestId("inline-cell-input") as HTMLInputElement;
    expect(input.value).toBe("hello");
  });

  it("Tab commits with new value", () => {
    const onCommit = vi.fn();
    render(
      <InlineCellEditor
        value={{ S: "hello" }}
        onCommit={onCommit}
        onCancel={vi.fn()}
        saving={false}
      />,
    );
    const input = screen.getByTestId("inline-cell-input");
    fireEvent.change(input, { target: { value: "world" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(onCommit).toHaveBeenCalledWith({ S: "world" });
  });

  it("Enter commits with new value", () => {
    const onCommit = vi.fn();
    render(
      <InlineCellEditor
        value={{ S: "hello" }}
        onCommit={onCommit}
        onCancel={vi.fn()}
        saving={false}
      />,
    );
    const input = screen.getByTestId("inline-cell-input");
    fireEvent.change(input, { target: { value: "enter-val" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith({ S: "enter-val" });
  });

  it("Escape cancels without commit", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(
      <InlineCellEditor
        value={{ S: "hello" }}
        onCommit={onCommit}
        onCancel={onCancel}
        saving={false}
      />,
    );
    const input = screen.getByTestId("inline-cell-input");
    fireEvent.change(input, { target: { value: "changed" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("Blur commits with current value", () => {
    const onCommit = vi.fn();
    render(
      <InlineCellEditor
        value={{ S: "hello" }}
        onCommit={onCommit}
        onCancel={vi.fn()}
        saving={false}
      />,
    );
    const input = screen.getByTestId("inline-cell-input");
    fireEvent.change(input, { target: { value: "blurred" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith({ S: "blurred" });
  });

  it("empty string is a valid commit", () => {
    const onCommit = vi.fn();
    render(
      <InlineCellEditor
        value={{ S: "hello" }}
        onCommit={onCommit}
        onCancel={vi.fn()}
        saving={false}
      />,
    );
    const input = screen.getByTestId("inline-cell-input");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith({ S: "" });
  });
});

// ---------------------------------------------------------------------------
// N editor
// ---------------------------------------------------------------------------

describe("InlineCellEditor — N (number)", () => {
  it("renders text input pre-filled with numeric string", () => {
    render(
      <InlineCellEditor
        value={{ N: "42" }}
        onCommit={vi.fn()}
        onCancel={vi.fn()}
        saving={false}
      />,
    );
    const input = screen.getByTestId("inline-cell-input") as HTMLInputElement;
    expect(input.value).toBe("42");
  });

  it("accepts valid number on Enter and commits trimmed", () => {
    const onCommit = vi.fn();
    render(
      <InlineCellEditor
        value={{ N: "1" }}
        onCommit={onCommit}
        onCancel={vi.fn()}
        saving={false}
      />,
    );
    const input = screen.getByTestId("inline-cell-input");
    fireEvent.change(input, { target: { value: "5.5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith({ N: "5.5" });
  });

  it("rejects non-numeric string — does not call onCommit on Enter", () => {
    const onCommit = vi.fn();
    render(
      <InlineCellEditor
        value={{ N: "1" }}
        onCommit={onCommit}
        onCancel={vi.fn()}
        saving={false}
      />,
    );
    const input = screen.getByTestId("inline-cell-input");
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("rejects empty string — does not call onCommit on Tab", () => {
    const onCommit = vi.fn();
    render(
      <InlineCellEditor
        value={{ N: "1" }}
        onCommit={onCommit}
        onCancel={vi.fn()}
        saving={false}
      />,
    );
    const input = screen.getByTestId("inline-cell-input");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("Escape still cancels on invalid input", () => {
    const onCancel = vi.fn();
    const onCommit = vi.fn();
    render(
      <InlineCellEditor
        value={{ N: "1" }}
        onCommit={onCommit}
        onCancel={onCancel}
        saving={false}
      />,
    );
    const input = screen.getByTestId("inline-cell-input");
    fireEvent.change(input, { target: { value: "not-a-number" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("rejects non-numeric on Blur — does not call onCommit", () => {
    const onCommit = vi.fn();
    render(
      <InlineCellEditor
        value={{ N: "1" }}
        onCommit={onCommit}
        onCancel={vi.fn()}
        saving={false}
      />,
    );
    const input = screen.getByTestId("inline-cell-input");
    fireEvent.change(input, { target: { value: "bad" } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// BOOL editor
// ---------------------------------------------------------------------------

describe("InlineCellEditor — BOOL (boolean toggle)", () => {
  it("renders toggle showing current value (true)", () => {
    render(
      <InlineCellEditor
        value={{ BOOL: true }}
        onCommit={vi.fn()}
        onCancel={vi.fn()}
        saving={false}
      />,
    );
    const btn = screen.getByTestId("inline-bool-toggle");
    expect(btn.textContent).toBe("true");
  });

  it("renders toggle showing current value (false)", () => {
    render(
      <InlineCellEditor
        value={{ BOOL: false }}
        onCommit={vi.fn()}
        onCancel={vi.fn()}
        saving={false}
      />,
    );
    const btn = screen.getByTestId("inline-bool-toggle");
    expect(btn.textContent).toBe("false");
  });

  it("clicking toggle fires onCommit with toggled value (true → false)", () => {
    const onCommit = vi.fn();
    render(
      <InlineCellEditor
        value={{ BOOL: true }}
        onCommit={onCommit}
        onCancel={vi.fn()}
        saving={false}
      />,
    );
    fireEvent.click(screen.getByTestId("inline-bool-toggle"));
    expect(onCommit).toHaveBeenCalledWith({ BOOL: false });
  });

  it("clicking toggle fires onCommit with toggled value (false → true)", () => {
    const onCommit = vi.fn();
    render(
      <InlineCellEditor
        value={{ BOOL: false }}
        onCommit={onCommit}
        onCancel={vi.fn()}
        saving={false}
      />,
    );
    fireEvent.click(screen.getByTestId("inline-bool-toggle"));
    expect(onCommit).toHaveBeenCalledWith({ BOOL: true });
  });
});

// ---------------------------------------------------------------------------
// NULL editor
// ---------------------------------------------------------------------------

describe("InlineCellEditor — NULL (segmented switch)", () => {
  it("renders 'null' and 'set value' buttons", () => {
    render(
      <InlineCellEditor
        value={{ NULL: true }}
        onCommit={vi.fn()}
        onCancel={vi.fn()}
        saving={false}
      />,
    );
    expect(screen.getByTestId("inline-null-set-null")).toBeTruthy();
    expect(screen.getByTestId("inline-null-set-value")).toBeTruthy();
  });

  it("'Set to NULL' commits { NULL: true }", () => {
    const onCommit = vi.fn();
    render(
      <InlineCellEditor
        value={{ NULL: true }}
        onCommit={onCommit}
        onCancel={vi.fn()}
        saving={false}
      />,
    );
    fireEvent.click(screen.getByTestId("inline-null-set-null"));
    expect(onCommit).toHaveBeenCalledWith({ NULL: true });
  });

  it("'Set to value' calls onCancel", () => {
    const onCancel = vi.fn();
    const onCommit = vi.fn();
    render(
      <InlineCellEditor
        value={{ NULL: true }}
        onCommit={onCommit}
        onCancel={onCancel}
        saving={false}
      />,
    );
    fireEvent.click(screen.getByTestId("inline-null-set-value"));
    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// saving=true
// ---------------------------------------------------------------------------

describe("InlineCellEditor — saving=true", () => {
  it("S: input is disabled and spinner is shown", () => {
    render(
      <InlineCellEditor
        value={{ S: "hello" }}
        onCommit={vi.fn()}
        onCancel={vi.fn()}
        saving={true}
      />,
    );
    const input = screen.getByTestId("inline-cell-input") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByTestId("inline-spinner")).toBeTruthy();
  });

  it("N: input is disabled and spinner is shown", () => {
    render(
      <InlineCellEditor
        value={{ N: "5" }}
        onCommit={vi.fn()}
        onCancel={vi.fn()}
        saving={true}
      />,
    );
    const input = screen.getByTestId("inline-cell-input") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByTestId("inline-spinner")).toBeTruthy();
  });

  it("BOOL: toggle button is disabled and spinner is shown", () => {
    render(
      <InlineCellEditor
        value={{ BOOL: true }}
        onCommit={vi.fn()}
        onCancel={vi.fn()}
        saving={true}
      />,
    );
    const btn = screen.getByTestId("inline-bool-toggle") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByTestId("inline-spinner")).toBeTruthy();
  });

  it("NULL: buttons disabled and spinner shown", () => {
    render(
      <InlineCellEditor
        value={{ NULL: true }}
        onCommit={vi.fn()}
        onCancel={vi.fn()}
        saving={true}
      />,
    );
    const setNull = screen.getByTestId("inline-null-set-null") as HTMLButtonElement;
    const setValue = screen.getByTestId("inline-null-set-value") as HTMLButtonElement;
    expect(setNull.disabled).toBe(true);
    expect(setValue.disabled).toBe(true);
    expect(screen.getByTestId("inline-spinner")).toBeTruthy();
  });
});
