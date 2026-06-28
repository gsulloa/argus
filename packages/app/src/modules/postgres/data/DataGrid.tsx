import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AppError } from "@/platform/errors/AppError";
import { useColumnWidths } from "@/platform/table/columnWidths";
import { ResizeHandle } from "@/platform/table/ResizeHandle";
import { copyCellValue, copyRowsTsv, formatRowsTSV } from "@/platform/grid/cellClipboard";
import { EditableCell, looksLikeBytea } from "./EditableCell";
import { RowContextMenu } from "./RowContextMenu";
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

// ---------------------------------------------------------------------------
// Module-level pure helpers (shared by keyboard shortcuts AND the context menu)
// ---------------------------------------------------------------------------

/** Entry type used by `buffer.bulkDeleteToggle`. */
export type DeleteEntry = {
  rowKey: string;
  source: "insert" | "server";
  pk?: Record<string, EditValue>;
  currentlyDeleted: boolean;
};

/**
 * Resolve the display value for a cell, preferring any pending edit in the
 * buffer over the server value. This is the same lookup used in the ⌘C copy
 * path so the menu and keyboard shortcut produce identical output.
 */
export function resolveCellDisplayValue(
  rows: UnifiedRow[],
  columns: DataColumn[],
  buffer: Pick<UseEditBufferResult, "getRowEdits">,
  rowIndex: number,
  colIndex: number,
): EditValue | CellValue | null {
  const row = rows[rowIndex];
  if (!row) return null;
  const serverValue = row.cells[colIndex] ?? null;
  const col = columns[colIndex];
  if (!col || !row.rowKey) return serverValue;
  const editsEntry = buffer.getRowEdits(row.rowKey);
  return editsEntry && col.name in editsEntry.changes
    ? (editsEntry.changes[col.name] as EditValue)
    : serverValue;
}

/**
 * Build the array of delete-toggle entries for a contiguous row range
 * [rangeStart, rangeEnd] (inclusive). Mirrors the logic in the Backspace/Delete
 * keyboard branch so both paths produce identical entries.
 */
export function buildDeleteEntries(
  rows: UnifiedRow[],
  columns: DataColumn[],
  pkColumns: string[] | null,
  buffer: Pick<UseEditBufferResult, "isRowDeleted">,
  rangeStart: number,
  rangeEnd: number,
): DeleteEntry[] {
  const entries: DeleteEntry[] = [];
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
  return entries;
}

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
  // Context menu state — resolved on right-click, cleared on close.
  // -----------------------------------------------------------------------
  /**
   * The effective target for the context menu: the row/col that was
   * right-clicked, after applying the retargeting rule. Reset to null
   * when the menu closes.
   */
  const [ctxTarget, setCtxTarget] = useState<{ rowIndex: number; colIndex: number } | null>(null);
  // Keep a ref in sync so context menu callbacks always read fresh data even
  // if the Radix portal captures a stale prop reference.
  const ctxTargetRef = useRef<{ rowIndex: number; colIndex: number } | null>(null);
  ctxTargetRef.current = ctxTarget;

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
  // Row-range copy-to-clipboard on Ctrl/Cmd+C.
  // Early-returns when a single cell is active so the keydown handler owns
  // that path. Resolves cell values via the edit buffer so pending edits are
  // reflected in the copied TSV.
  // -----------------------------------------------------------------------
  useEffect(() => {
    function handleCopy(e: ClipboardEvent) {
      // Single-cell takes precedence — handled by the keydown handler.
      if (activeCell !== null) return;
      const { anchor, active } = selection;
      if (anchor === null || active === null) return;
      const from = Math.min(anchor, active);
      const to = Math.max(anchor, active);
      const resolved: unknown[][] = [];
      for (let i = from; i <= to; i++) {
        const row = rows[i];
        if (!row) continue;
        resolved.push(
          columns.map((_, colIdx) => resolveCellDisplayValue(rows, columns, buffer, i, colIdx)),
        );
      }
      if (resolved.length > 0) {
        e.clipboardData?.setData("text/plain", formatRowsTSV(resolved));
        e.preventDefault();
      }
    }
    window.addEventListener("copy", handleCopy);
    return () => window.removeEventListener("copy", handleCopy);
  }, [selection, rows, activeCell, columns, buffer]);

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
            const displayValue = resolveCellDisplayValue(rows, columns, buffer, activeCell.row, activeCell.col);
            e.preventDefault();
            void copyCellValue(displayValue);
          }
          return;
        }
      }
    }

    // ⌘A / Ctrl+A — select all loaded rows. Only fires when a selection is
    // already active (row range or active cell) and focus is not in a native
    // editing context; otherwise the browser's select-all-text applies.
    if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
      const target = e.target as HTMLElement;
      const tag = target.tagName.toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
        return;
      }
      if ((selection.anchor === null && activeCell === null) || rows.length === 0) return;
      e.preventDefault();
      onActiveCellChange(null);
      onSelectionChange({ anchor: 0, active: rows.length - 1 });
      return;
    }

    if (e.key === "Backspace" || e.key === "Delete") {
      if (selection.anchor === null) return;
      if (isReadOnly) return;
      e.preventDefault();
      const entries = buildDeleteEntries(rows, columns, pkColumns, buffer, rangeStart, rangeEnd);
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

            // ------------------------------------------------------------------
            // Context menu: resolve state for this row when it is the target.
            // ------------------------------------------------------------------
            // The effective context target: either ctxTarget (if it was set for
            // this row) or the fallback for when nothing has been set yet.
            // We compute menu props here so they're always in scope for the JSX.
            const isCtxRow = ctxTarget !== null && ctxTarget.rowIndex === vi.index;
            const ctxColIndex = isCtxRow ? ctxTarget.colIndex : 0;

            // Determine the effective target range for multi-row operations.
            // If this row is selected (inside the range), the whole range is the target.
            const ctxRangeStart = selected && isCtxRow ? rangeStart : vi.index;
            const ctxRangeEnd   = selected && isCtxRow ? rangeEnd   : vi.index;
            const isMulti = ctxRangeEnd > ctxRangeStart;

            // canEditCell: same cellReadOnly computation for the context-targeted cell.
            const ctxCol = columns[ctxColIndex];
            const ctxServerValue = ctxCol ? (r.cells[ctxColIndex] ?? null) : null;
            const ctxIsPkOfExisting = ctxCol ? (!isInsert && (pkColumns?.includes(ctxCol.name) ?? false)) : false;
            const ctxCellReadOnly =
              isReadOnly ||
              isDeleted ||
              ctxIsPkOfExisting ||
              (ctxCol ? looksLikeBytea(ctxCol.data_type) : false) ||
              isCellEnvelope(ctxServerValue) ||
              (!isInsert && pkColumns === null) ||
              !r.rowKey;
            const canEditCell = !ctxCellReadOnly && !bulkEditActive;

            // canDeleteRows: at least one targetted row is deletable.
            const canDeleteRows =
              !isReadOnly &&
              (() => {
                for (let i = ctxRangeStart; i <= ctxRangeEnd; i++) {
                  const tr = rows[i];
                  if (!tr || !tr.rowKey) continue;
                  if (tr.source === "insert") return true;
                  if (pkColumns !== null) return true;
                }
                return false;
              })();

            // deleteIsRestore: every targeted row is already deleted.
            const deleteIsRestore =
              (() => {
                for (let i = ctxRangeStart; i <= ctxRangeEnd; i++) {
                  const tr = rows[i];
                  if (!tr || !tr.rowKey) continue;
                  if (!buffer.isRowDeleted(tr.rowKey)) return false;
                }
                return true;
              })();

            // Disabled reason strings.
            const editCellDisabledReason = isReadOnly
              ? "Grid is read-only"
              : bulkEditActive
              ? "Bulk-edit mode is active"
              : "This cell can’t be edited";
            const deleteDisabledReason = isReadOnly
              ? "Grid is read-only"
              : "Requires a primary key";

            // Context menu callbacks.
            function handleCtxCopyCell() {
              // Use the ref so the callback always reads the latest ctxTarget,
              // even if Radix captured an older closure from the portal mount.
              const target = ctxTargetRef.current;
              if (!target) return;
              const val = resolveCellDisplayValue(rows, columns, buffer, target.rowIndex, target.colIndex);
              void copyCellValue(val);
            }

            function handleCtxCopyRows() {
              const targetRows: unknown[][] = [];
              for (let i = ctxRangeStart; i <= ctxRangeEnd; i++) {
                const tr = rows[i];
                if (!tr) continue;
                targetRows.push(
                  columns.map((_, colIdx) => resolveCellDisplayValue(rows, columns, buffer, i, colIdx)),
                );
              }
              void copyRowsTsv(targetRows, columns.map((c) => c.name));
            }

            function handleCtxEditCell() {
              const target = ctxTargetRef.current;
              if (!target) return;
              if (bulkEditActive) return;
              const col = columns[target.colIndex];
              if (col) setEditing({ rowIndex: target.rowIndex, col: col.name });
            }

            function handleCtxToggleDelete() {
              const entries = buildDeleteEntries(rows, columns, pkColumns, buffer, ctxRangeStart, ctxRangeEnd);
              if (entries.length > 0) {
                buffer.bulkDeleteToggle(entries);
              }
            }

            const rowEl = (
              <div
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
                onContextMenu={(e) => {
                  // Resolve the clicked column from [data-col].
                  const cellEl = (e.target as HTMLElement).closest("[data-col]") as HTMLElement | null;
                  const colIdx = cellEl ? parseInt(cellEl.dataset.col ?? "0", 10) : 0;

                  // Retargeting rule:
                  //   • Right-click INSIDE current selection → keep selection, multi-target.
                  //   • Right-click OUTSIDE → set activeCell to the clicked cell, clear range.
                  const insideSelection = vi.index >= rangeStart && vi.index <= rangeEnd && rangeStart >= 0;
                  if (!insideSelection) {
                    onActiveCellChange({ row: vi.index, col: colIdx });
                    onSelectionChange({ anchor: null, active: null });
                  }
                  // Always record the clicked cell as context target.
                  setCtxTarget({ rowIndex: vi.index, colIndex: colIdx });
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

            return (
              <RowContextMenu
                key={vi.key}
                target={{ rowIndex: vi.index, colIndex: ctxColIndex }}
                isMulti={isMulti}
                canEditCell={canEditCell}
                editCellDisabledReason={editCellDisabledReason}
                canDeleteRows={canDeleteRows}
                deleteDisabledReason={deleteDisabledReason}
                deleteIsRestore={deleteIsRestore}
                onCopyCell={handleCtxCopyCell}
                onCopyRows={handleCtxCopyRows}
                onEditCell={handleCtxEditCell}
                onToggleDelete={handleCtxToggleDelete}
              >
                {rowEl}
              </RowContextMenu>
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
