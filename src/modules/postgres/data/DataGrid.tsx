import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AppError } from "@/platform/errors/AppError";
import { useColumnWidths } from "@/platform/table/columnWidths";
import { ResizeHandle } from "@/platform/table/ResizeHandle";
import { copyCellValue } from "@/platform/grid/cellClipboard";
import { EditableCell, looksLikeBytea } from "./EditableCell";
import { pixelYToRowIndex } from "./dragRowIndex";
import { headerFloorWidthFor } from "./headerMeasure";
import { cycleSort, sortIndexFor } from "./sortHelpers";
import { categorize } from "./typeHelpers";
import { isCellEnvelope, type CellValue, type DataColumn, type EditValue, type OrderBy } from "./types";
import type { UseEditBufferResult } from "./useEditBuffer";
import styles from "./DataGrid.module.css";

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 28;
const STATUS_ROW_HEIGHT = 28;
const SCROLL_LOOKAHEAD_ROWS = (pageSize: number) => pageSize * 2;

export interface UnifiedRow {
  rowKey: string;
  cells: CellValue[];
  source: "insert" | "server";
}

export interface DataGridHandle {
  /** Scroll the grid's vertical viewport back to the top (row index 0). */
  scrollToTop(): void;
}

export interface DataGridProps {
  columns: DataColumn[];
  rows: UnifiedRow[];
  pageSize: number;
  orderBy: OrderBy[];
  status: string;
  nextError: AppError | null;
  reachedEnd: boolean;
  /** Multi-row selection: anchor + active indices (both null = nothing selected). */
  selection: { anchor: number | null; active: number | null };
  /** Single-cell active selection — mutually exclusive with row range. */
  activeCell: { row: number; col: number } | null;
  /** When true (effective selection >= 2 and pkColumns != null), inline cell
   *  editing is suppressed so the inspector bulk-edit UI handles all edits. */
  bulkEditActive: boolean;
  isReadOnly: boolean;
  pkColumns: string[] | null;
  enumValuesByColumn: Record<string, string[]>;
  buffer: UseEditBufferResult;
  /** Connection identifier — used for per-relation column-width persistence. */
  connectionId: string;
  /** Schema name — used for per-relation column-width persistence. */
  schema: string;
  /** Relation name — used for per-relation column-width persistence. */
  relation: string;
  onSelectionChange(next: { anchor: number | null; active: number | null }): void;
  onActiveCellChange(next: { row: number; col: number } | null): void;
  onSortChange(next: OrderBy[]): void;
  onLoadNextPage(): void;
  onRetryNextPage(): void;
}

export const DataGrid = forwardRef<DataGridHandle, DataGridProps>(function DataGrid(
  props,
  ref,
) {
  const {
    columns,
    rows,
    pageSize,
    orderBy,
    status,
    nextError,
    reachedEnd,
    selection,
    activeCell,
    bulkEditActive,
    isReadOnly,
    pkColumns,
    enumValuesByColumn,
    buffer,
    connectionId,
    schema,
    relation,
    onSelectionChange,
    onActiveCellChange,
    onSortChange,
    onLoadNextPage,
    onRetryNextPage,
  } = props;

  // Map DataColumn[] to the shape useColumnWidths expects.
  // isKey: true when the column is part of the primary key (PK columns are
  // provided by the parent via `pkColumns`). The +16px KEY_BADGE_PAD widens
  // PK columns to accommodate a future key badge without truncation.
  // floorWidth: measured header text width + fixed pads, so long column names
  // don't ellipsis-truncate at type-derived defaults.
  const mappedColumns = useMemo(
    () =>
      columns.map((c) => {
        const isKey = pkColumns?.includes(c.name) ?? false;
        return {
          name: c.name,
          category: categorize(c.data_type),
          isKey,
          floorWidth: headerFloorWidthFor({ name: c.name, isKey }),
        };
      }),
    [columns, pkColumns],
  );

  const { widthFor, totalWidth, setWidth, resetWidth } = useColumnWidths({
    storageKey: `pgColumnWidths:${connectionId}:${schema}:${relation}`,
    columns: mappedColumns,
  });

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  useImperativeHandle(
    ref,
    () => ({
      scrollToTop() {
        // Prefer the virtualizer so its internal scroll state stays
        // consistent; always also reset the viewport directly so the scroll
        // takes effect under jsdom and in cases where the virtualizer hasn't
        // mounted yet.
        try {
          virtualizer.scrollToIndex(0, { align: "start" });
        } catch {
          // ignore — fall through to direct scroll
        }
        const vp = viewportRef.current;
        if (vp) vp.scrollTop = 0;
      },
    }),
    [virtualizer],
  );

  // Trigger pagination when we render within `2 * pageSize` rows of the buffer's tail.
  const items = virtualizer.getVirtualItems();
  const lastVirtual = items[items.length - 1];
  useEffect(() => {
    if (!lastVirtual) return;
    if (status !== "ready") return;
    if (reachedEnd) return;
    const lookahead = SCROLL_LOOKAHEAD_ROWS(pageSize);
    if (rows.length - 1 - lastVirtual.index <= lookahead) {
      onLoadNextPage();
    }
  }, [lastVirtual, status, reachedEnd, pageSize, rows.length, onLoadNextPage]);

  // Track the active editor: at most one cell at a time.
  const [editing, setEditing] = useState<{ rowIndex: number; col: string } | null>(null);

  // -----------------------------------------------------------------------
  // Drag-to-select state
  // -----------------------------------------------------------------------
  interface DragState {
    status: "pending" | "active";
    anchorIndex: number;
    anchorColIndex: number;
    anchorClientX: number;
    anchorClientY: number;
  }
  const dragRef = useRef<DragState | null>(null);
  const [dragActive, setDragActive] = useState(false);
  // Last known clientY during an active drag — read by the RAF auto-scroll loop.
  const dragClientYRef = useRef<number>(0);
  // Derived range bounds (re-derived each render from selection).
  const rangeStart =
    selection.anchor === null
      ? -1
      : Math.min(selection.anchor, selection.active ?? selection.anchor);
  const rangeEnd =
    selection.anchor === null
      ? -1
      : Math.max(selection.anchor, selection.active ?? selection.anchor);

  // -----------------------------------------------------------------------
  // Keyboard handler: Backspace / Delete toggles bulk delete; Escape clears;
  // ⌘C / Ctrl+C copies the active cell value when a single cell is selected.
  // -----------------------------------------------------------------------
  function onGridKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (editing) return; // editor handles its own keys

    // ⌘C / Ctrl+C — single-cell copy. Only fires when:
    //   • activeCell is set
    //   • the event target is not an input/textarea/select (native copy)
    if ((e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C")) {
      if (activeCell !== null) {
        const target = e.target as HTMLElement;
        const tag = target.tagName.toUpperCase();
        if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT" && !target.isContentEditable) {
          const row = rows[activeCell.row];
          if (row) {
            const serverValue = row.cells[activeCell.col] ?? null;
            const col = columns[activeCell.col];
            const displayValue =
              col && row.rowKey
                ? (() => {
                    const editsEntry = buffer.getRowEdits(row.rowKey);
                    return editsEntry && col.name in editsEntry.changes
                      ? (editsEntry.changes[col.name] as EditValue)
                      : serverValue;
                  })()
                : serverValue;
            e.preventDefault();
            void copyCellValue(displayValue);
          }
          return;
        }
      }
    }

    if (e.key === "Backspace" || e.key === "Delete") {
      if (selection.anchor === null) return;
      if (isReadOnly) return;
      e.preventDefault();
      const entries: Array<{
        rowKey: string;
        source: "insert" | "server";
        pk?: Record<string, EditValue>;
        currentlyDeleted: boolean;
      }> = [];
      for (let i = rangeStart; i <= rangeEnd; i++) {
        const r = rows[i];
        if (!r || !r.rowKey) continue;
        if (r.source === "insert") {
          entries.push({ rowKey: r.rowKey, source: "insert", currentlyDeleted: false });
        } else {
          if (!pkColumns) continue; // no-PK relation: can't delete server rows
          const pk: Record<string, EditValue> = {};
          for (const col of pkColumns) {
            const idx = columns.findIndex((c) => c.name === col);
            if (idx >= 0) pk[col] = (r.cells[idx] ?? null) as EditValue;
          }
          const currentlyDeleted = buffer.isRowDeleted(r.rowKey);
          entries.push({ rowKey: r.rowKey, source: "server", pk, currentlyDeleted });
        }
      }
      if (entries.length > 0) {
        buffer.bulkDeleteToggle(entries);
      }
      return;
    }

    if (e.key === "Escape") {
      if (activeCell !== null) {
        onActiveCellChange(null);
        return;
      }
      if (selection.anchor !== null) {
        onSelectionChange({ anchor: null, active: null });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Drag event effect
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!dragActive) return;

    let rafId: number | null = null;

    function getBodyRect(): DOMRect | null {
      return bodyRef.current?.getBoundingClientRect() ?? null;
    }

    function getScrollTop(): number {
      return viewportRef.current?.scrollTop ?? 0;
    }

    function computeActiveIndex(clientY: number): number {
      const bodyRect = getBodyRect();
      if (!bodyRect) return dragRef.current?.anchorIndex ?? 0;
      const scrollTop = getScrollTop();
      return pixelYToRowIndex(scrollTop, clientY, bodyRect.top, ROW_HEIGHT, rows.length);
    }

    function handleMouseMove(e: MouseEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      dragClientYRef.current = e.clientY;

      if (drag.status === "pending") {
        const dx = e.clientX - drag.anchorClientX;
        const dy = e.clientY - drag.anchorClientY;
        if (Math.sqrt(dx * dx + dy * dy) >= 4) {
          drag.status = "active";
          onSelectionChange({ anchor: drag.anchorIndex, active: drag.anchorIndex });
        }
      }

      if (drag.status === "active") {
        const rowIndex = computeActiveIndex(e.clientY);
        onSelectionChange({ anchor: drag.anchorIndex, active: rowIndex });
      }
    }

    function handleMouseUp(e: MouseEvent) {
      const drag = dragRef.current;
      if (!drag) {
        setDragActive(false);
        return;
      }

      if (drag.status === "active") {
        // Drag completed — finalize row-range selection; clear active cell.
        const rowIndex = computeActiveIndex(e.clientY);
        onSelectionChange({ anchor: drag.anchorIndex, active: rowIndex });
        onActiveCellChange(null);
      } else {
        // Click (pending, never crossed threshold) — set the active cell;
        // clear any row-range selection (mutually exclusive).
        onActiveCellChange({ row: drag.anchorIndex, col: drag.anchorColIndex });
        onSelectionChange({ anchor: null, active: null });
      }

      // Focus the grid root so Escape / ⌘C work immediately after click.
      const rootEl = viewportRef.current?.parentElement as HTMLElement | null;
      rootEl?.focus();

      dragRef.current = null;
      setDragActive(false);
    }

    // Auto-scroll RAF loop.
    function startAutoScroll() {
      function tick() {
        const drag = dragRef.current;
        if (!drag || drag.status !== "active") return;
        const bodyRect = getBodyRect();
        if (!bodyRect || !viewportRef.current) return;
        const clientY = dragClientYRef.current;
        let scrolled = false;
        if (clientY < bodyRect.top + 20) {
          const speed = (bodyRect.top + 20 - clientY) * 0.5;
          viewportRef.current.scrollTop = Math.max(0, viewportRef.current.scrollTop - speed);
          scrolled = true;
        } else if (clientY > bodyRect.bottom - 20) {
          const speed = (clientY - (bodyRect.bottom - 20)) * 0.5;
          viewportRef.current.scrollTop += speed;
          scrolled = true;
        }
        if (scrolled) {
          // After scrolling, update active row to follow cursor.
          const rowIndex = computeActiveIndex(clientY);
          onSelectionChange({ anchor: drag.anchorIndex, active: rowIndex });
        }
        rafId = requestAnimationFrame(tick);
      }
      rafId = requestAnimationFrame(tick);
    }

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    startAutoScroll();

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragActive, rows.length]);

  return (
    <div
      className={`${styles.root} ${bulkEditActive ? styles.bulkActive : ""}`}
      tabIndex={0}
      onKeyDown={onGridKeyDown}
    >
      <div className={styles.viewport} ref={viewportRef}>
        <div className={styles.thead} style={{ width: totalWidth }}>
          <div className={styles.headerRow} style={{ height: HEADER_HEIGHT }}>
            {columns.map((col) => {
              const sortIdx = sortIndexFor(col.name, orderBy);
              const sortDir =
                sortIdx >= 0 ? (orderBy[sortIdx]?.direction ?? null) : null;
              return (
                <div
                  key={col.name}
                  className={styles.headerCell}
                  style={{ width: widthFor(col.name) }}
                  role="columnheader"
                  onClick={(e) => {
                    onSortChange(cycleSort(col.name, orderBy, e.shiftKey));
                  }}
                  title={`${col.name} : ${col.data_type}`}
                >
                  <span className={styles.colName}>{col.name}</span>
                  {sortDir && (
                    <span className={styles.sortBadge}>
                      {sortDir === "asc" ? "▲" : "▼"}
                      {orderBy.length > 1 && (
                        <span className={styles.sortIndex}>{sortIdx + 1}</span>
                      )}
                    </span>
                  )}
                  <ResizeHandle
                    currentWidth={widthFor(col.name)}
                    onChange={(px) => setWidth(col.name, px)}
                    onReset={() => resetWidth(col.name)}
                  />
                </div>
              );
            })}
          </div>
        </div>
        <div
          ref={bodyRef}
          className={styles.body}
          style={{
            height: virtualizer.getTotalSize(),
            width: totalWidth,
            position: "relative",
          }}
        >
          {items.map((vi) => {
            const row = rows[vi.index];
            if (!row) return null;
            // Bind the row narrowly for the inner closure that follows so
            // TypeScript doesn't widen `row` back to `T | undefined` after
            // the `if (!row) return null` guard.
            const r = row;
            const selected = vi.index >= rangeStart && vi.index <= rangeEnd;
            const isInsert = r.source === "insert";
            const isDeleted = r.rowKey ? buffer.isRowDeleted(r.rowKey) : false;
            const rowClasses = [
              styles.row,
              isInsert ? styles.rowInsert : "",
              isDeleted ? styles.rowDeleted : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={vi.key}
                className={rowClasses}
                data-selected={selected ? "true" : "false"}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: ROW_HEIGHT,
                  transform: `translateY(${vi.start}px)`,
                }}
                onMouseDown={(e) => {
                  // Only respond to primary mouse button.
                  if (e.button !== 0) return;
                  // Prevent the browser from starting a native text-selection drag inside the cell.
                  e.preventDefault();
                  // Detect which column was clicked from the nearest data-col attribute.
                  const cellEl = (e.target as HTMLElement).closest("[data-col]") as HTMLElement | null;
                  const colIdx = cellEl ? parseInt(cellEl.dataset.col ?? "0", 10) : 0;
                  dragRef.current = {
                    status: "pending",
                    anchorIndex: vi.index,
                    anchorColIndex: colIdx,
                    anchorClientX: e.clientX,
                    anchorClientY: e.clientY,
                  };
                  dragClientYRef.current = e.clientY;
                  setDragActive(true);
                }}
              >
                {columns.map((col) => {
                  const colIdx = columns.findIndex((c) => c.name === col.name);
                  const serverValue = r.cells[colIdx] ?? null;
                  const dirty = r.rowKey
                    ? buffer.isCellDirty(r.rowKey, col.name)
                    : false;
                  const editsEntry = r.rowKey ? buffer.getRowEdits(r.rowKey) : undefined;
                  const displayValue =
                    editsEntry && col.name in editsEntry.changes
                      ? (editsEntry.changes[col.name] as EditValue)
                      : serverValue;
                  const isPkOfExisting =
                    !isInsert && pkColumns?.includes(col.name);
                  const cellReadOnly =
                    isReadOnly ||
                    isDeleted ||
                    (isPkOfExisting ?? false) ||
                    looksLikeBytea(col.data_type) ||
                    isCellEnvelope(serverValue) ||
                    (!isInsert && pkColumns === null) ||
                    !r.rowKey;
                  const cellEditing =
                    !!editing &&
                    editing.rowIndex === vi.index &&
                    editing.col === col.name;

                  function onStartEdit() {
                    // Suppress inline editing when bulk-edit mode is active.
                    if (bulkEditActive) return;
                    setEditing({ rowIndex: vi.index, col: col.name });
                  }
                  function onCancelEdit() {
                    setEditing(null);
                  }
                  function onCommitEdit(value: EditValue) {
                    setEditing(null);
                    if (!r.rowKey) return;
                    const pk: Record<string, EditValue> = {};
                    if (pkColumns) {
                      for (const c of pkColumns) {
                        const i = columns.findIndex((cc) => cc.name === c);
                        if (i >= 0) pk[c] = (r.cells[i] ?? null) as EditValue;
                      }
                    }
                    if (isInsert) {
                      buffer.setCellEdit({
                        rowKey: r.rowKey,
                        column: col.name,
                        value,
                        pk: {},
                        originalRow: null,
                        originalColumns: null,
                      });
                    } else {
                      buffer.setCellEdit({
                        rowKey: r.rowKey,
                        column: col.name,
                        value,
                        pk,
                        originalRow: r.cells,
                        originalColumns: columns.map((c) => c.name),
                      });
                    }
                  }

                  const isActiveCellHere =
                    activeCell !== null &&
                    activeCell.row === vi.index &&
                    activeCell.col === colIdx;

                  return (
                    <EditableCell
                      key={col.name}
                      column={col}
                      displayValue={displayValue}
                      dirty={dirty}
                      readOnly={cellReadOnly}
                      enumValues={enumValuesByColumn[col.name]}
                      editing={cellEditing}
                      colIndex={colIdx}
                      isActiveCell={isActiveCellHere}
                      onStartEdit={onStartEdit}
                      onCommitEdit={onCommitEdit}
                      onCancelEdit={onCancelEdit}
                      style={{ width: widthFor(col.name) }}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
        {(status === "loading-next" || status === "next-error") && (
          <div
            className={`${styles.statusRow} ${
              status === "next-error" ? styles.errorRow : ""
            }`}
            style={{ height: STATUS_ROW_HEIGHT, width: totalWidth }}
          >
            {status === "loading-next" && (
              <>
                <span className={styles.spinner}>
                  <Loader2 size={12} />
                </span>
                Loading more rows…
              </>
            )}
            {status === "next-error" && (
              <>
                <span>{nextError?.message ?? "Failed to load next page."}</span>
                <button
                  type="button"
                  className={styles.retryButton}
                  onClick={onRetryNextPage}
                >
                  Retry
                </button>
              </>
            )}
          </div>
        )}
        {rows.length === 0 && status === "ready" && (
          <div className={styles.empty}>No rows.</div>
        )}
      </div>
    </div>
  );
});
