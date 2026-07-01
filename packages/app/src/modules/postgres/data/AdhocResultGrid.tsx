import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { categorize, isMonoCategory } from "./typeHelpers";
import {
  isCellEnvelope,
  type CellEnvelope,
  type CellValue,
  type DataColumn,
} from "./types";
import { useColumnWidths } from "@/platform/table/columnWidths";
import { ResizeHandle } from "@/platform/table/ResizeHandle";
import { copyCell, copyRows, copyRowRangeFromKeydown, writeClipboardText } from "@/platform/grid/gridCopy";
import { useToast } from "@/platform/toast";
import { RowContextMenu } from "./RowContextMenu";
import { pixelYToRowIndex } from "./dragRowIndex";
import type { SortOrder } from "@/platform/table/sortResultRows";
import styles from "./DataGrid.module.css";

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 28;
const GUTTER_WIDTH = 32;

export interface AdhocResultGridProps {
  columns: DataColumn[];
  rows: CellValue[][];
  /** Called when the row-range selection changes. */
  onSelectionChange?(sel: { anchor: number | null; active: number | null }): void;
  /**
   * Current client-side sort state (issue #91). When provided together with
   * `onSortChange`, column headers become click-to-sort and show ↑/↓ indicators.
   * The caller is responsible for sorting `rows` to match.
   */
  orderBy?: SortOrder[];
  /** Fired with the next sort state when a header is clicked. */
  onSortChange?(next: SortOrder[]): void;
  /** Optional element rendered when `rows.length === 0`. */
  emptyState?: ReactNode;
  /** Forwarded to the root container. */
  style?: CSSProperties;
}

/**
 * Read-only virtualized result grid. Used by the SQL editor for ad-hoc query
 * results and shares the same DOM and styling as the editable table viewer's
 * grid (no separate virtualization implementation). It has no edit/filter
 * affordances; client-side sort (header click → asc/desc/unsorted) is opt-in
 * via the `orderBy`/`onSortChange` props.
 *
 * Column widths are in-memory only (storageKey: null) and reset automatically
 * when the columns shape changes (via the `key` on the inner component).
 */
export function AdhocResultGrid({
  columns,
  rows,
  onSelectionChange,
  orderBy,
  onSortChange,
  emptyState,
  style,
}: AdhocResultGridProps) {
  // Compute a signature of column names so that when the shape changes (a
  // different query shape), the inner component remounts and all in-memory
  // widths reset to their type-derived defaults.
  const columnsSignature = useMemo(
    () => columns.map((c) => c.name).join("|"),
    [columns],
  );

  return (
    <AdhocResultGridInner
      key={columnsSignature}
      columns={columns}
      rows={rows}
      onSelectionChange={onSelectionChange}
      orderBy={orderBy}
      onSortChange={onSortChange}
      emptyState={emptyState}
      style={style}
    />
  );
}

/**
 * Inner component — owns the in-memory column-widths state via
 * `useColumnWidths`. Keyed on `columnsSignature` by the outer component so
 * that a different column shape causes a full remount (and therefore a clean
 * widths record).
 */
function AdhocResultGridInner({
  columns,
  rows,
  onSelectionChange,
  orderBy,
  onSortChange,
  emptyState,
  style,
}: AdhocResultGridProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const toast = useToast();
  const onCopyError = (msg: string) => toast.show(msg, "error");

  // Single-cell active selection — mutually exclusive with row range selection.
  const [activeCell, setActiveCell] = useState<{ row: number; col: number } | null>(null);
  // Multi-row range selection — mutually exclusive with activeCell.
  const [selection, setSelection] = useState<{ anchor: number | null; active: number | null }>({
    anchor: null,
    active: null,
  });

  // Internal helpers to keep mutual exclusivity enforced.
  function applySelection(next: { anchor: number | null; active: number | null }) {
    setSelection(next);
    setActiveCell(null);
    onSelectionChange?.(next);
  }
  function applyActiveCell(next: { row: number; col: number } | null) {
    setActiveCell(next);
    setSelection({ anchor: null, active: null });
    // Always report the cleared selection to the parent so it can update the inspector.
    onSelectionChange?.({ anchor: null, active: null });
  }

  // Reset active cell and selection when the dataset changes.
  useEffect(() => {
    setActiveCell(null);
    setSelection({ anchor: null, active: null });
  }, [columns, rows]);

  const sortable = !!onSortChange;
  const sortDirFor = (name: string): "asc" | "desc" | null =>
    orderBy?.find((o) => o.column === name)?.direction ?? null;
  const handleHeaderClick = (name: string) => {
    if (!onSortChange) return;
    const cur = orderBy?.find((o) => o.column === name);
    if (!cur) onSortChange([{ column: name, direction: "asc" }]);
    else if (cur.direction === "asc") onSortChange([{ column: name, direction: "desc" }]);
    else onSortChange([]);
  };

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();

  // Reset scroll position when the dataset changes shape (different query).
  // We key off column-shape and row-count rather than the full data identity
  // to avoid scroll jumps on stable re-renders.
  const shapeKey = useMemo(
    () => `${columns.map((c) => c.name).join("|")}::${rows.length}`,
    [columns, rows.length],
  );
  useEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [shapeKey]);

  // Map columns to ColumnSpec for the hook
  const mapped = useMemo(
    () =>
      columns.map((c) => ({
        name: c.name,
        category: categorize(c.data_type),
        isKey: false as const, // ad-hoc results don't have PK semantics
      })),
    [columns],
  );

  const { widthFor, totalWidth, setWidth, resetWidth } = useColumnWidths({
    storageKey: null, // in-memory only — never persist ad-hoc widths
    columns: mapped,
  });

  const effectiveTotalWidth = Math.max(totalWidth, 1);

  // Derived range bounds from selection.
  const rangeStart =
    selection.anchor === null
      ? -1
      : Math.min(selection.anchor, selection.active ?? selection.anchor);
  const rangeEnd =
    selection.anchor === null
      ? -1
      : Math.max(selection.anchor, selection.active ?? selection.anchor);

  // -----------------------------------------------------------------------
  // Drag-to-select state (mirrors DataGrid)
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

  // -----------------------------------------------------------------------
  // Drag event effect (mirrors DataGrid)
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
          applySelection({ anchor: drag.anchorIndex, active: drag.anchorIndex });
        }
      }

      if (drag.status === "active") {
        const rowIndex = computeActiveIndex(e.clientY);
        applySelection({ anchor: drag.anchorIndex, active: rowIndex });
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
        applySelection({ anchor: drag.anchorIndex, active: rowIndex });
      } else {
        // Click (pending, never crossed threshold) — set the active cell;
        // clear any row-range selection (mutually exclusive).
        applyActiveCell({ row: drag.anchorIndex, col: drag.anchorColIndex });
      }

      // Focus the grid root so Escape / ⌘C work immediately after click.
      rootRef.current?.focus();

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
          applySelection({ anchor: drag.anchorIndex, active: rowIndex });
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

  // -----------------------------------------------------------------------
  // Keyboard handler
  // -----------------------------------------------------------------------
  function onGridKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Skip when focus is in a native editing context.
    const target = e.target as HTMLElement;
    const tag = target.tagName.toUpperCase();
    const isEditing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;

    if ((e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C")) {
      // Single-cell copy takes precedence.
      if (activeCell !== null && !isEditing) {
        const row = rows[activeCell.row];
        if (row) {
          const value = row[activeCell.col] ?? null;
          e.preventDefault();
          void copyCell(value, onCopyError);
        }
        return;
      }

      // Row-range copy path (mirroring DataGrid).
      void copyRowRangeFromKeydown(e, {
        editing: false,
        activeCell,
        selection,
        columnNames: columns.map((c) => c.name),
        resolveRow: (i) => (rows[i] ? [...rows[i]] : null),
        write: writeClipboardText,
        onError: onCopyError,
      });
      return;
    }

    // ⌘A / Ctrl+A — select all loaded rows. Only fires when a selection is
    // already active (row range or active cell) and focus is not in a native
    // editing context; otherwise the browser's select-all-text applies.
    if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
      if (isEditing) return;
      if ((selection.anchor === null && activeCell === null) || rows.length === 0) return;
      e.preventDefault();
      applySelection({ anchor: 0, active: rows.length - 1 });
      return;
    }

    if (e.key === "Escape") {
      if (activeCell !== null) {
        applyActiveCell(null);
        return;
      }
      if (selection.anchor !== null) {
        applySelection({ anchor: null, active: null });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Context menu state
  // -----------------------------------------------------------------------
  const [ctxTarget, setCtxTarget] = useState<{ rowIndex: number; colIndex: number } | null>(null);
  const ctxTargetRef = useRef<{ rowIndex: number; colIndex: number } | null>(null);
  ctxTargetRef.current = ctxTarget;

  if (rows.length === 0 && emptyState) {
    // Empty state: the header keeps its column-derived width (so it can
    // scroll horizontally if there are many columns), but the empty body
    // fills the full available width — otherwise the "(0 rows)" hint sits
    // squashed into a narrow strip at the left.
    return (
      <div className={styles.root} style={style}>
        <div className={styles.viewport}>
          <div className={styles.thead} style={{ width: effectiveTotalWidth + GUTTER_WIDTH }}>
            <div className={styles.headerRow} style={{ height: HEADER_HEIGHT }}>
              <div className={styles.gutterHeader} style={{ width: GUTTER_WIDTH }} />
              {columns.map((col) => (
                <div
                  key={col.name}
                  className={styles.headerCell}
                  style={{ width: widthFor(col.name), cursor: "default", position: "relative" }}
                  role="columnheader"
                  title={`${col.name} : ${col.data_type}`}
                >
                  <span className={styles.colName}>{col.name}</span>
                  <span className={styles.colType}>{col.data_type}</span>
                  <ResizeHandle
                    currentWidth={widthFor(col.name)}
                    onChange={(px) => setWidth(col.name, px)}
                    onReset={() => resetWidth(col.name)}
                  />
                </div>
              ))}
            </div>
          </div>
          <div style={{ width: "100%", flex: 1, display: "flex" }}>
            {emptyState}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={styles.root}
      style={style}
      tabIndex={0}
      onKeyDown={onGridKeyDown}
    >
      <div className={styles.viewport} ref={viewportRef}>
        <div className={styles.thead} style={{ width: effectiveTotalWidth + GUTTER_WIDTH }}>
          <div className={styles.headerRow} style={{ height: HEADER_HEIGHT }}>
            <div className={styles.gutterHeader} style={{ width: GUTTER_WIDTH }} />
            {columns.map((col) => {
              const dir = sortDirFor(col.name);
              return (
                <div
                  key={col.name}
                  className={styles.headerCell}
                  style={{
                    width: widthFor(col.name),
                    cursor: sortable ? "pointer" : "default",
                    position: "relative",
                  }}
                  role="columnheader"
                  title={`${col.name} : ${col.data_type}`}
                  onClick={sortable ? () => handleHeaderClick(col.name) : undefined}
                >
                  <span className={styles.colName}>{col.name}</span>
                  {dir && (
                    <span className={styles.sortBadge}>{dir === "asc" ? "↑" : "↓"}</span>
                  )}
                  <span className={styles.colType}>{col.data_type}</span>
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
            width: effectiveTotalWidth + GUTTER_WIDTH,
            position: "relative",
          }}
        >
          {items.map((vi) => {
            const row = rows[vi.index];
            if (!row) return null;
            const selected = vi.index >= rangeStart && vi.index <= rangeEnd;

            // Context menu target resolution for this row.
            const isCtxRow = ctxTarget !== null && ctxTarget.rowIndex === vi.index;
            const ctxColIndex = isCtxRow ? ctxTarget.colIndex : 0;

            // Effective range for multi-row context menu operations.
            const ctxRangeStart = selected && isCtxRow ? rangeStart : vi.index;
            const ctxRangeEnd   = selected && isCtxRow ? rangeEnd   : vi.index;
            const isMulti = ctxRangeEnd > ctxRangeStart;

            function handleCtxCopyCell() {
              const tgt = ctxTargetRef.current;
              if (!tgt) return;
              const r = rows[tgt.rowIndex];
              const value = r ? (r[tgt.colIndex] ?? null) : null;
              void copyCell(value, onCopyError);
            }

            function handleCtxCopyRows() {
              const targetRows: unknown[][] = [];
              for (let i = ctxRangeStart; i <= ctxRangeEnd; i++) {
                const r = rows[i];
                if (!r) continue;
                targetRows.push([...r]);
              }
              void copyRows(targetRows, columns.map((c) => c.name), onCopyError);
            }

            const rowEl = (
              <div
                className={styles.row}
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
                  // Prevent the browser from starting a native text-selection drag.
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
                  //   • Right-click INSIDE current selection → keep selection.
                  //   • Right-click OUTSIDE → set activeCell to the clicked cell, clear range.
                  const insideSelection = vi.index >= rangeStart && vi.index <= rangeEnd && rangeStart >= 0;
                  if (!insideSelection) {
                    applyActiveCell({ row: vi.index, col: colIdx });
                  }
                  // Always record the clicked cell as context target.
                  setCtxTarget({ rowIndex: vi.index, colIndex: colIdx });
                }}
              >
                {/* Row-number gutter cell */}
                <div
                  className={styles.gutterCell}
                  style={{ width: GUTTER_WIDTH }}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.shiftKey && selection.anchor !== null) {
                      applySelection({ anchor: selection.anchor, active: vi.index });
                      return;
                    }
                    applySelection({ anchor: vi.index, active: vi.index });
                    dragRef.current = {
                      status: "active",
                      anchorIndex: vi.index,
                      anchorColIndex: 0,
                      anchorClientX: e.clientX,
                      anchorClientY: e.clientY,
                    };
                    dragClientYRef.current = e.clientY;
                    setDragActive(true);
                  }}
                  title="Select row"
                >
                  {vi.index + 1}
                </div>

                {/* Data cells */}
                {columns.map((col, ci) => {
                  const value = row[ci] ?? null;
                  const isActiveCellHere =
                    activeCell !== null &&
                    activeCell.row === vi.index &&
                    activeCell.col === ci;
                  return (
                    <div
                      key={col.name}
                      data-col={ci}
                      className={[styles.cell, isActiveCellHere ? styles.cellActive : ""].filter(Boolean).join(" ")}
                      style={{ width: widthFor(col.name), cursor: "pointer" }}
                    >
                      <span className={styles.cellValue}>
                        <CellContent value={value} column={col} />
                      </span>
                    </div>
                  );
                })}
              </div>
            );

            return (
              <RowContextMenu
                key={vi.key}
                copyOnly
                target={{ rowIndex: vi.index, colIndex: ctxColIndex }}
                isMulti={isMulti}
                canEditCell={false}
                editCellDisabledReason=""
                canDeleteRows={false}
                deleteDisabledReason=""
                deleteIsRestore={false}
                onCopyCell={handleCtxCopyCell}
                onCopyRows={handleCtxCopyRows}
                onEditCell={() => {}}
                onToggleDelete={() => {}}
              >
                {rowEl}
              </RowContextMenu>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function formatEnvelope(env: CellEnvelope): string {
  const bytes = env.byte_length;
  const human =
    bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${(bytes / 1024).toFixed(1)} KB`
        : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return env.kind === "binary" ? `binary ~${human}` : `truncated ~${human}`;
}

function CellContent({ value, column }: { value: CellValue; column: DataColumn }) {
  if (value === null || value === undefined) {
    return <span className={styles.cellNull}>NULL</span>;
  }
  if (isCellEnvelope(value)) {
    return <span className={styles.envelopeChip}>{formatEnvelope(value)}</span>;
  }
  if (typeof value === "boolean") {
    return <span className={styles.cellMono}>{value ? "true" : "false"}</span>;
  }
  if (typeof value === "number") {
    return <span className={styles.cellMono}>{String(value)}</span>;
  }
  if (typeof value === "string") {
    const cat = categorize(column.data_type);
    return (
      <span
        className={isMonoCategory(cat) ? styles.cellMono : undefined}
        title={value.length > 80 ? value : undefined}
      >
        {value}
      </span>
    );
  }
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return (
    <span className={styles.cellMono} title={text.length > 80 ? text : undefined}>
      {text}
    </span>
  );
}
