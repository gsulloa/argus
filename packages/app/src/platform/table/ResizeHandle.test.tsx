import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ResizeHandle } from "./ResizeHandle";
import { MIN_WIDTH, MAX_WIDTH } from "./columnWidths";

// jsdom does not implement pointer capture — polyfill for tests.
beforeEach(() => {
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => true);
});

// Helper: fire pointer events on an element
function pointerDown(el: Element, clientX: number) {
  fireEvent.pointerDown(el, { clientX, pointerId: 1, bubbles: true });
}
function pointerMove(el: Element, clientX: number) {
  fireEvent.pointerMove(el, { clientX, pointerId: 1, bubbles: true });
}
function pointerUp(el: Element, clientX: number) {
  fireEvent.pointerUp(el, { clientX, pointerId: 1, bubbles: true });
}

describe("ResizeHandle", () => {
  it("renders a div when not disabled", () => {
    const onChange = vi.fn();
    const onReset = vi.fn();
    const { container } = render(
      <ResizeHandle
        currentWidth={180}
        onChange={onChange}
        onReset={onReset}
      />,
    );
    expect(container.firstChild).not.toBeNull();
  });

  it("renders nothing when disabled", () => {
    const { container } = render(
      <ResizeHandle
        currentWidth={180}
        onChange={vi.fn()}
        onReset={vi.fn()}
        disabled
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("calls onChange with updated width during drag (live feedback)", () => {
    const onChange = vi.fn();
    const { container } = render(
      <ResizeHandle currentWidth={180} onChange={onChange} onReset={vi.fn()} />,
    );
    const handle = container.firstChild as Element;

    pointerDown(handle, 100);
    pointerMove(handle, 150); // +50px → 230
    pointerMove(handle, 140); // +40px → 220

    expect(onChange).toHaveBeenCalledWith(230);
    expect(onChange).toHaveBeenCalledWith(220);
  });

  it("clamps at MIN_WIDTH on large left drag", () => {
    const onChange = vi.fn();
    const { container } = render(
      <ResizeHandle currentWidth={180} onChange={onChange} onReset={vi.fn()} />,
    );
    const handle = container.firstChild as Element;

    pointerDown(handle, 500);
    pointerMove(handle, 0); // 180 + (0 - 500) = -320 → clamped to MIN_WIDTH

    expect(onChange).toHaveBeenCalledWith(MIN_WIDTH);
  });

  it("clamps at MAX_WIDTH on large right drag", () => {
    const onChange = vi.fn();
    const { container } = render(
      <ResizeHandle currentWidth={180} onChange={onChange} onReset={vi.fn()} />,
    );
    const handle = container.firstChild as Element;

    pointerDown(handle, 100);
    pointerMove(handle, 900); // 180 + 800 = 980 → clamped to MAX_WIDTH

    expect(onChange).toHaveBeenCalledWith(MAX_WIDTH);
  });

  it("calls onReset on double-click", () => {
    const onReset = vi.fn();
    const { container } = render(
      <ResizeHandle currentWidth={180} onChange={vi.fn()} onReset={onReset} />,
    );
    const handle = container.firstChild as Element;
    fireEvent.dblClick(handle);
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("resets body styles after pointer up", () => {
    const { container } = render(
      <ResizeHandle currentWidth={180} onChange={vi.fn()} onReset={vi.fn()} />,
    );
    const handle = container.firstChild as Element;

    pointerDown(handle, 100);
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    pointerUp(handle, 150);
    // Body styles should be restored (empty string = original value)
    expect(document.body.style.cursor).not.toBe("col-resize");
    expect(document.body.style.userSelect).not.toBe("none");
  });

  it("sets data-dragging=true during drag, undefined after pointer up", () => {
    const { container } = render(
      <ResizeHandle currentWidth={180} onChange={vi.fn()} onReset={vi.fn()} />,
    );
    const handle = container.firstChild as Element;

    pointerDown(handle, 100);
    expect(handle.getAttribute("data-dragging")).toBe("true");

    pointerUp(handle, 150);
    expect(handle.getAttribute("data-dragging")).toBeNull();
  });

  it("does not call onChange before pointer down", () => {
    const onChange = vi.fn();
    const { container } = render(
      <ResizeHandle currentWidth={180} onChange={onChange} onReset={vi.fn()} />,
    );
    const handle = container.firstChild as Element;

    pointerMove(handle, 250); // move without down first
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stops tracking after pointerCancel", () => {
    const onChange = vi.fn();
    const { container } = render(
      <ResizeHandle currentWidth={180} onChange={onChange} onReset={vi.fn()} />,
    );
    const handle = container.firstChild as Element;

    pointerDown(handle, 100);
    onChange.mockClear();
    fireEvent.pointerCancel(handle, { pointerId: 1, bubbles: true });
    pointerMove(handle, 200); // should be ignored
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Event isolation from the enclosing header cell (issue #277)
//
// Header cells in every SQL grid carry the sort handler on their own onClick,
// and the browser synthesises a `click` after `pointerup`. The handle must keep
// that click to itself or a resize gesture also sorts the column.
// ---------------------------------------------------------------------------

describe("ResizeHandle — click isolation", () => {
  /** Render the handle inside a clickable "header cell" like the grids do. */
  function renderInHeader(props: {
    onChange?: (px: number) => void;
    onReset?: () => void;
  } = {}) {
    const headerClick = vi.fn();
    const onChange = props.onChange ?? vi.fn();
    const onReset = props.onReset ?? vi.fn();
    const { container } = render(
      <div onClick={headerClick}>
        <ResizeHandle
          currentWidth={180}
          onChange={onChange}
          onReset={onReset}
        />
      </div>,
    );
    const header = container.firstChild as Element;
    const handle = header.firstChild as Element;
    return { headerClick, onChange, onReset, header, handle };
  }

  it("a click on the handle does not reach the header", () => {
    const { headerClick, handle } = renderInHeader();

    fireEvent.click(handle);

    expect(headerClick).not.toHaveBeenCalled();
  });

  it("a double-click still resets the width but does not reach the header", () => {
    const onReset = vi.fn();
    const { headerClick, handle } = renderInHeader({ onReset });

    // A real dblclick is preceded by its two constituent clicks.
    fireEvent.click(handle);
    fireEvent.click(handle);
    fireEvent.dblClick(handle);

    expect(onReset).toHaveBeenCalledOnce();
    expect(headerClick).not.toHaveBeenCalled();
  });

  it("a full drag resizes without sorting the header", () => {
    const onChange = vi.fn();
    const { headerClick, handle } = renderInHeader({ onChange });

    pointerDown(handle, 100);
    pointerMove(handle, 140); // +40px → 220
    pointerUp(handle, 140);
    // The browser fires this after pointerup — the whole point of #277.
    fireEvent.click(handle);

    expect(onChange).toHaveBeenCalledWith(220);
    expect(headerClick).not.toHaveBeenCalled();
  });

  it("a click elsewhere in the header still reaches the header", () => {
    const headerClick = vi.fn();
    const { container } = render(
      <div onClick={headerClick}>
        <span>column_name</span>
        <ResizeHandle
          currentWidth={180}
          onChange={vi.fn()}
          onReset={vi.fn()}
        />
      </div>,
    );
    const colName = container.querySelector("span") as Element;

    fireEvent.click(colName);

    expect(headerClick).toHaveBeenCalledOnce();
  });
});
