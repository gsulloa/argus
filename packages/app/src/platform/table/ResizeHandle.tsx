import { useEffect, useRef, useState } from "react";
import { clampWidth } from "./columnWidths";
import styles from "./ResizeHandle.module.css";

export interface ResizeHandleProps {
  currentWidth: number;
  onChange: (px: number) => void;
  onReset: () => void;
  /** When true, renders nothing. E.g. DynamoDB "More…" column. */
  disabled?: boolean;
}

interface DragState {
  pointerId: number;
  startX: number;
  startWidth: number;
}

/**
 * Draggable resize handle for table header cells.
 *
 * Renders a 6px-wide hit area absolutely positioned over the right edge of the
 * parent header cell. The parent MUST have `position: relative` (each consuming
 * grid is responsible for setting this on its header cells via its own CSS
 * module).
 *
 * - Hover / active drag → 1px accent line at 50% opacity, `cursor: col-resize`
 * - Drag → live width updates via `onChange(clampWidth(px))`
 * - Double-click → `onReset()`
 * - `disabled` → returns null (no DOM node)
 */
export function ResizeHandle({
  currentWidth,
  onChange,
  onReset,
  disabled,
}: ResizeHandleProps) {
  if (disabled) return null;

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [isDragging, setIsDragging] = useState(false);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const dragRef = useRef<DragState | null>(null);
  // Keep a ref to the saved body styles so we can restore them even if the
  // component unmounts mid-drag.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const savedBodyStyles = useRef<{ userSelect: string; cursor: string } | null>(
    null,
  );

  // Cleanup on unmount in case of mid-drag unmount
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    return () => {
      if (savedBodyStyles.current !== null) {
        document.body.style.userSelect = savedBodyStyles.current.userSelect;
        document.body.style.cursor = savedBodyStyles.current.cursor;
        savedBodyStyles.current = null;
      }
    };
  }, []);

  const applyBodyDragStyles = () => {
    savedBodyStyles.current = {
      userSelect: document.body.style.userSelect,
      cursor: document.body.style.cursor,
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };

  const restoreBodyStyles = () => {
    if (savedBodyStyles.current !== null) {
      document.body.style.userSelect = savedBodyStyles.current.userSelect;
      document.body.style.cursor = savedBodyStyles.current.cursor;
      savedBodyStyles.current = null;
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startWidth: currentWidth,
    };
    setIsDragging(true);
    applyBodyDragStyles();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current === null) return;
    const { startX, startWidth } = dragRef.current;
    const next = startWidth + (e.clientX - startX);
    onChange(clampWidth(next));
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current === null) return;
    e.currentTarget.releasePointerCapture(dragRef.current.pointerId);
    dragRef.current = null;
    setIsDragging(false);
    restoreBodyStyles();
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current === null) return;
    e.currentTarget.releasePointerCapture(dragRef.current.pointerId);
    dragRef.current = null;
    setIsDragging(false);
    restoreBodyStyles();
  };

  const handleDoubleClick = () => {
    onReset();
  };

  return (
    <div
      className={styles.handle}
      data-dragging={isDragging ? "true" : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onDoubleClick={handleDoubleClick}
    />
  );
}
