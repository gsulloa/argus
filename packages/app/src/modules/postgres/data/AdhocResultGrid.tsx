import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { categorize } from "./typeHelpers";
import {
  isCellEnvelope,
  type CellValue,
  type DataColumn,
  type EditValue,
} from "./types";
import { useColumnWidths } from "@/platform/table/columnWidths";
import { ResizeHandle } from "@/platform/table/ResizeHandle";
import { copyCell, copyRows, copyRowRangeFromKeydown, writeClipboardText } from "@/platform/grid/gridCopy";
import { useToast } from "@/platform/toast";
import { EditableCell, looksLikeBytea } from "./EditableCell";
import { RowContextMenu } from "./RowContextMenu";
import { buildRowKey, type UseEditBufferResult } from "./useEditBuffer";
import { pixelYToRowIndex } from "./dragRowIndex";
import type { SortOrder } from "@/platform/table/sortResultRows";
import styles from "./DataGrid.module.css";

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 28;
const GUTTER_WIDTH = 32;

/** Hover copy for the two blockers the grid can determine per-cell. */
const PK_CELL_REASON = "Primary key — not editable";
const COMPUTED_CELL_REASON = "Computed column — not editable";

/**
 * Everything the grid needs to allow inline cell editing on an ad-hoc result.
 * Supplied by the SQL editor's result panel from the run's `editability`
 * payload; omitted entirely by any consumer that wants the read-only grid.
 */
export interface AdhocGridEdit {
  /** Shared edit buffer — the same one the table viewer uses. */
  buffer: UseEditBufferResult;
  /**
   * Aligned to `columns`: the BASE column each result column projects, or null
   * when it's a computed expression. Writes target these names, so an aliased
   * `SELECT id AS pk` edits `id`.
   */
  columnSources: (string | null)[];
  /** PK column names, declared order. */
  pkColumns: string[];
  /** Result-column index carrying each PK column, aligned to `pkColumns`. */
  pkColumnIndexes: number[];
  /** Enum labels keyed by BASE column name. */
  enumValuesByColumn: Record<string, string[]>;
  /**
   * When non-empty, editing is off for the whole grid and this string is the
   * hover title on every cell. Lets a non-editable result still explain itself
   * rather than swallowing the double-click silently.
   */
  blockedReason: string;
}

export interface AdhocResultGridProps {
  columns: DataColumn[];
  rows: CellValue[][];
  /**
   * Optional inline-edit configuration. Absent → the grid behaves exactly as
   * the read-only grid always has.
   */
  edit?: AdhocGridEdit;
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
 * Virtualized result grid. Used by the SQL editor for ad-hoc query results and
 * shares the same DOM, styling and inline-cell component as the editable table
 * viewer's grid (no separate virtualization implementation).
 *
 * Read-only by default. Pass `edit` to enable double-click inline editing on a
 * result whose rows are provably traceable to one base table — see the
 * `sql-result-editability` capability. Even then the grid never offers row
 * insert or delete: cell UPDATE is the only write it supports.
 *
 * Client-side sort (header click → asc/desc/unsorted) is opt-in via the
 * `orderBy`/`onSortChange` props. Because pending edits are keyed by primary
 * key rather than row index, sorting can never mis-target a write.
 *
 * Column widths are in-memory only (storageKey: null) and reset automatically
 * when the columns shape changes (via the `key` on the inner component).
 */
export function AdhocResultGrid({
  columns,
  rows,
  edit,
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
      edit={edit}
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
  edit,
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

  // -----------------------------------------------------------------------
  // Edit mode
  // -----------------------------------------------------------------------
  // Editing is live only when a config was supplied AND nothing blocks the
  // whole grid. A supplied-but-blocked config still flows through so every
  // cell can carry the explanation on hover.
  const editingEnabled = !!edit && edit.blockedReason === "";
  const [editing, setEditing] = useState<{ rowIndex: number; col: string } | null>(null);

  // Reset the open editor whenever the dataset changes underneath it.
  useEffect(() => {
    setEditing(null);
  }, [columns, rows]);

  /**
   * Stable, PK-derived identity for a row. Keying the buffer this way (rather
   * than by row index) is what makes client-side sorting safe: reordering the
   * displayed rows cannot re-point a pending edit at a different row.
   * Returns null when the row can't be identified, which makes it read-only.
   */
  const rowKeyFor = useCallback(
    (row: CellValue[] | undefined): string | null => {
      if (!edit || !row) return null;
      const pk: Record<string, EditValue> = {};
      for (let i = 0; i < edit.pkColumns.length; i++) {
        const name = edit.pkColumns[i];
        const colIdx = edit.pkColumnIndexes[i];
        if (name === undefined || colIdx === undefined) return null;
        pk[name] = (row[colIdx] ?? null) as EditValue;
      }
      return buildRowKey(pk);
    },
    [edit],
  );

  /**
   * Buffer-aware value lookup: the pending edit when there is one, else the
   * server value. Used for display AND for every copy path, so what the user
   * copies is what they see.
   */
  const displayValueAt = useCallback(
    (rowIndex: number, colIndex: number): CellValue | EditValue => {
      const row = rows[rowIndex];
      const serverValue = row ? (row[colIndex] ?? null) : null;
      if (!edit || !row) return serverValue;
      const base = edit.columnSources[colIndex];
      if (!base) return serverValue;
      const rowKey = rowKeyFor(row);
      if (!rowKey) return serverValue;
      const entry = edit.buffer.getRowEdits(rowKey);
      return entry && base in entry.changes
        ? (entry.changes[base] as EditValue)
        : serverValue;
    },
    [edit, rows, rowKeyFor],
  );

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

  /**
   * Everything `EditableCell` needs for one cell. Centralised so the display
   * path and the context menu agree on what "editable" means.
   *
   * A cell is read-only when: no edit config; the grid is blocked wholesale;
   * the column is computed (no base column to write to); the base column is
   * part of the primary key (that's the row's identity); the column is binary;
   * the value arrived as an oversized/binary envelope; or the row has no
   * resolvable PK.
   */
  function cellEditState(
    rowIndex: number,
    colIndex: number,
    col: DataColumn,
    serverValue: CellValue,
  ) {
    const displayValue = displayValueAt(rowIndex, colIndex);
    if (!edit) {
      return {
        displayValue,
        dirty: false,
        readOnly: true,
        readOnlyReason: undefined as string | undefined,
        enumValues: undefined as string[] | undefined,
        editing: false,
      };
    }

    const base = edit.columnSources[colIndex] ?? null;
    const rowKey = rowKeyFor(rows[rowIndex]);
    const dirty = !!base && !!rowKey && edit.buffer.isCellDirty(rowKey, base);

    let readOnlyReason: string | undefined;
    if (edit.blockedReason !== "") readOnlyReason = edit.blockedReason;
    else if (!base) readOnlyReason = COMPUTED_CELL_REASON;
    else if (edit.pkColumns.includes(base)) readOnlyReason = PK_CELL_REASON;
    else if (looksLikeBytea(col.data_type)) readOnlyReason = "binary, not editable inline";
    else if (isCellEnvelope(serverValue)) readOnlyReason = "value too large to edit inline";
    else if (!rowKey) readOnlyReason = "Row has no resolvable primary key";

    return {
      displayValue,
      dirty,
      readOnly: !editingEnabled || readOnlyReason !== undefined,
      readOnlyReason,
      enumValues: base ? edit.enumValuesByColumn[base] : undefined,
      editing:
        editing !== null && editing.rowIndex === rowIndex && editing.col === col.name,
    };
  }

  function startEdit(rowIndex: number, colIndex: number) {
    const col = columns[colIndex];
    if (!col) return;
    setEditing({ rowIndex, col: col.name });
  }

  function commitEdit(rowIndex: number, colIndex: number, value: EditValue) {
    setEditing(null);
    if (!edit) return;
    const base = edit.columnSources[colIndex];
    if (!base) return;
    const row = rows[rowIndex];
    const rowKey = rowKeyFor(row);
    if (!row || !rowKey) return;

    const pk: Record<string, EditValue> = {};
    for (let i = 0; i < edit.pkColumns.length; i++) {
      const name = edit.pkColumns[i];
      const idx = edit.pkColumnIndexes[i];
      if (name === undefined || idx === undefined) return;
      pk[name] = (row[idx] ?? null) as EditValue;
    }

    // `originalColumns` must be in BASE-column terms so the buffer's
    // "reverted to the server value" check compares like with like. Computed
    // columns get an empty name, which simply never matches a base column.
    edit.buffer.setCellEdit({
      rowKey,
      column: base,
      value,
      pk,
      originalRow: row,
      originalColumns: edit.columnSources.map((s) => s ?? ""),
    });
  }

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
          // Copy what the user sees — a pending edit, not the stale server value.
          const value = displayValueAt(activeCell.row, activeCell.col);
          e.preventDefault();
          void copyCell(value as CellValue, onCopyError);
        }
        return;
      }

      // Row-range copy path (mirroring DataGrid).
      void copyRowRangeFromKeydown(e, {
        editing: editing !== null,
        activeCell,
        selection,
        columnNames: columns.map((c) => c.name),
        resolveRow: (i) =>
          rows[i] ? columns.map((_, ci) => displayValueAt(i, ci) as CellValue) : null,
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
              if (!rows[tgt.rowIndex]) return;
              void copyCell(
                displayValueAt(tgt.rowIndex, tgt.colIndex) as CellValue,
                onCopyError,
              );
            }

            function handleCtxCopyRows() {
              const targetRows: unknown[][] = [];
              for (let i = ctxRangeStart; i <= ctxRangeEnd; i++) {
                if (!rows[i]) continue;
                targetRows.push(columns.map((_, ci) => displayValueAt(i, ci)));
              }
              void copyRows(targetRows, columns.map((c) => c.name), onCopyError);
            }

            // Edit cell — enabled only for a cell the grid would actually let
            // the user edit, using the same computation as the display path.
            const ctxCol = columns[ctxColIndex];
            const ctxCellState = ctxCol
              ? cellEditState(vi.index, ctxColIndex, ctxCol, row[ctxColIndex] ?? null)
              : null;
            const canEditCell = !!ctxCellState && !ctxCellState.readOnly;
            const editCellDisabledReason =
              ctxCellState?.readOnlyReason ?? "This cell can’t be edited";

            function handleCtxEditCell() {
              const tgt = ctxTargetRef.current;
              if (!tgt) return;
              if (!canEditCell) return;
              startEdit(tgt.rowIndex, tgt.colIndex);
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
                  const serverValue = row[ci] ?? null;
                  const isActiveCellHere =
                    activeCell !== null &&
                    activeCell.row === vi.index &&
                    activeCell.col === ci;

                  const cell = cellEditState(vi.index, ci, col, serverValue);

                  return (
                    <EditableCell
                      key={col.name}
                      column={col}
                      displayValue={cell.displayValue}
                      dirty={cell.dirty}
                      readOnly={cell.readOnly}
                      readOnlyReason={cell.readOnlyReason}
                      enumValues={cell.enumValues}
                      editing={cell.editing}
                      colIndex={ci}
                      isActiveCell={isActiveCellHere}
                      onStartEdit={() => startEdit(vi.index, ci)}
                      onCommitEdit={(value) => commitEdit(vi.index, ci, value)}
                      onCancelEdit={() => setEditing(null)}
                      style={{ width: widthFor(col.name) }}
                    />
                  );
                })}
              </div>
            );

            return (
              <RowContextMenu
                key={vi.key}
                // Copy-only unless editing is live. `hideDelete` keeps the
                // Edit-cell entry while omitting Delete entirely — this grid
                // supports cell UPDATE and nothing else.
                copyOnly={!editingEnabled}
                hideDelete
                target={{ rowIndex: vi.index, colIndex: ctxColIndex }}
                isMulti={isMulti}
                canEditCell={canEditCell}
                editCellDisabledReason={editCellDisabledReason}
                canDeleteRows={false}
                deleteDisabledReason=""
                deleteIsRestore={false}
                onCopyCell={handleCtxCopyCell}
                onCopyRows={handleCtxCopyRows}
                onEditCell={handleCtxEditCell}
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
