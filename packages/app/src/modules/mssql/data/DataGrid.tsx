/**
 * MSSQL DataGrid — forked from MySQL DataGrid.
 * Uses MSSQL-typed columns (ColumnInfo instead of DataColumn).
 * Column-width preferences keyed by (connectionId, schema, relation, column)
 * using `msColumnWidths:` prefix (§18.2).
 *
 * Fork justified: MySQL DataGrid imports MySQL-specific EditableCell,
 * and the storage key prefix must differ (`msColumnWidths:` vs `myColumnWidths:`).
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Loader2 } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AppError } from "@/platform/errors/AppError";
import { useColumnWidths } from "@/platform/table/columnWidths";
import { ResizeHandle } from "@/platform/table/ResizeHandle";
import { headerFloorWidthFor } from "@/modules/postgres/data/headerMeasure";
import { copyCellValue, formatCellValue } from "@/platform/grid/cellClipboard";
import { EditableCell } from "./EditableCell";
import type { ColumnInfo, OrderBy } from "../types";
import type { CellValue, EditValue } from "./types";
import type { UseEditBufferResult } from "./useEditBuffer";

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 28;

export interface UnifiedRow {
  rowKey: string;
  cells: CellValue[];
  source: "insert" | "server";
}

export interface DataGridHandle {
  scrollToTop(): void;
}

export interface DataGridProps {
  columns: ColumnInfo[];
  rows: UnifiedRow[];
  pageSize: number;
  orderBy: OrderBy[];
  status: string;
  nextError: AppError | null;
  reachedEnd: boolean;
  selection: { anchor: number | null; active: number | null };
  isReadOnly: boolean;
  pkColumns: string[] | null;
  buffer: UseEditBufferResult;
  connectionId: string;
  schema: string;
  relation: string;
  onSelectionChange(next: { anchor: number | null; active: number | null }): void;
  onSortChange(next: OrderBy[]): void;
  onLoadNextPage(): void;
  onRetryNextPage(): void;
  /** Fired when cell selection changes (for inspector). */
  onCellSelect?(rowIdx: number | null, colIdx: number | null): void;
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
    isReadOnly,
    pkColumns,
    buffer,
    connectionId,
    schema,
    relation,
    onSelectionChange,
    onSortChange,
    onLoadNextPage,
    onRetryNextPage,
    onCellSelect,
  } = props;

  const mappedColumns = useMemo(
    () =>
      columns.map((c) => {
        const isKey = pkColumns?.includes(c.name) ?? false;
        return {
          name: c.name,
          category: "text" as const,
          isKey,
          floorWidth: headerFloorWidthFor({ name: c.name, isKey }),
        };
      }),
    [columns, pkColumns],
  );

  // §18.2 — MSSQL uses `msColumnWidths:` prefix (not `myColumnWidths:`)
  const { widthFor, setWidth, resetWidth } = useColumnWidths({
    storageKey: `msColumnWidths:${connectionId}:${schema}:${relation}`,
    columns: mappedColumns,
  });

  const viewportRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  useImperativeHandle(
    ref,
    () => ({
      scrollToTop() {
        viewportRef.current?.scrollTo({ top: 0 });
      },
    }),
    [],
  );

  // Infinite scroll: load next page as user approaches end
  const { scrollOffset, getTotalSize } = virtualizer;
  useEffect(() => {
    if (status !== "ready" || reachedEnd) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const scrollRemaining = getTotalSize() - viewport.offsetHeight - viewport.scrollTop;
    if (scrollRemaining < ROW_HEIGHT * pageSize * 2) {
      onLoadNextPage();
    }
  }, [scrollOffset, status, reachedEnd, pageSize, onLoadNextPage, getTotalSize]);

  // Multi-cell selection state for clipboard (tab-separated)
  const [editingCell, setEditingCell] = useState<{ rowIdx: number; colIdx: number } | null>(null);

  // Single-cell active selection — mutually exclusive with row range.
  const [activeCell, setActiveCell] = useState<{ rowIdx: number; colIdx: number } | null>(null);

  // Reset active cell when rows/columns change (sort, filter, page, data refresh).
  useEffect(() => {
    setActiveCell(null);
  }, [rows, columns]);

  // Row-range copy-to-clipboard on Ctrl/Cmd+C (§18.7).
  // Early-returns when a single cell is active so the keydown handler owns that path.
  useEffect(() => {
    function handleCopy(e: ClipboardEvent) {
      // Single-cell takes precedence — handled by the keydown handler.
      if (activeCell !== null) return;
      const { anchor, active } = selection;
      if (anchor === null || active === null) return;
      const from = Math.min(anchor, active);
      const to = Math.max(anchor, active);
      const lines: string[] = [];
      for (let i = from; i <= to; i++) {
        const row = rows[i];
        if (!row) continue;
        lines.push(row.cells.map(formatCellValue).join("\t"));
      }
      if (lines.length > 0) {
        e.clipboardData?.setData("text/plain", lines.join("\n"));
        e.preventDefault();
      }
    }
    window.addEventListener("copy", handleCopy);
    return () => window.removeEventListener("copy", handleCopy);
  }, [selection, rows, activeCell]);

  function onCellClick(e: React.MouseEvent, rowIdx: number, colIdx: number) {
    if (e.shiftKey && selection.anchor !== null) {
      // Shift-click extends row range — keep row-range mode, clear active cell.
      onSelectionChange({ anchor: selection.anchor, active: rowIdx });
      setActiveCell(null);
    } else {
      // Plain click — set active cell, clear row range.
      setActiveCell({ rowIdx, colIdx });
      onSelectionChange({ anchor: null, active: null });
    }
    onCellSelect?.(rowIdx, colIdx);
  }

  function onGridKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (editingCell !== null) return; // editor handles its own keys

    // ⌘C / Ctrl+C — single-cell copy.
    if ((e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C")) {
      if (activeCell !== null) {
        const target = e.target as HTMLElement;
        const tag = target.tagName.toUpperCase();
        if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT" && !target.isContentEditable) {
          const row = rows[activeCell.rowIdx];
          if (row) {
            const displayVal = buffer.getDisplayValue(
              row.rowKey,
              row.cells,
              columns.map((c) => c.name),
              columns[activeCell.colIdx]?.name ?? "",
            );
            e.preventDefault();
            void copyCellValue(displayVal);
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
      setActiveCell(null);
      onSelectionChange({ anchor: 0, active: rows.length - 1 });
      return;
    }

    if (e.key === "Escape") {
      if (activeCell !== null) {
        setActiveCell(null);
        return;
      }
      if (selection.anchor !== null) {
        onSelectionChange({ anchor: null, active: null });
      }
    }
  }

  const selFrom =
    selection.anchor !== null && selection.active !== null
      ? Math.min(selection.anchor, selection.active)
      : null;
  const selTo =
    selection.anchor !== null && selection.active !== null
      ? Math.max(selection.anchor, selection.active)
      : null;

  const items = virtualizer.getVirtualItems();

  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", flex: 1, minWidth: 0 }}
      tabIndex={0}
      onKeyDown={onGridKeyDown}
    >
      {/* Header */}
      <div
        style={{
          height: HEADER_HEIGHT,
          display: "flex",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-sidebar)",
          flexShrink: 0,
          overflow: "hidden",
          position: "relative",
        }}
      >
        {/* Gutter */}
        <div style={{ width: 32, flexShrink: 0, borderRight: "1px solid var(--border)" }} />
        {columns.map((col) => {
          const w = widthFor(col.name);
          const isPk = pkColumns?.includes(col.name) ?? false;
          const dir = orderBy.find((o) => o.column === col.name)?.direction ?? null;
          return (
            <div
              key={col.name}
              style={{
                width: w,
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                padding: "0 8px",
                gap: 4,
                borderRight: "1px solid var(--border)",
                fontSize: 12,
                fontWeight: 600,
                color: "var(--text)",
                cursor: "pointer",
                position: "relative",
                overflow: "hidden",
                userSelect: "none",
              }}
              onClick={() => {
                const cur = orderBy.find((o) => o.column === col.name);
                if (!cur) {
                  onSortChange([{ column: col.name, direction: "asc" }]);
                } else if (cur.direction === "asc") {
                  onSortChange([{ column: col.name, direction: "desc" }]);
                } else {
                  onSortChange([]);
                }
              }}
              title={col.name}
            >
              {isPk && (
                <span style={{ fontSize: 9, color: "var(--accent)", fontWeight: 700 }}>PK</span>
              )}
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {col.name}
              </span>
              {dir && (
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                  {dir === "asc" ? "↑" : "↓"}
                </span>
              )}
              <ResizeHandle
                currentWidth={w}
                onChange={(px) => setWidth(col.name, px)}
                onReset={() => resetWidth(col.name)}
              />
            </div>
          );
        })}
      </div>

      {/* Body */}
      <div
        ref={viewportRef}
        style={{ flex: 1, overflow: "auto", position: "relative" }}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((vItem) => {
            const rowIdx = vItem.index;
            const unifiedRow = rows[rowIdx];
            if (!unifiedRow) return null;
            const isSelected = selFrom !== null && selTo !== null && rowIdx >= selFrom && rowIdx <= selTo;
            const rowEdits = buffer.getRowEdits(unifiedRow.rowKey);
            const isDeleted = rowEdits?.kind === "delete";
            const isInsert = unifiedRow.source === "insert";

            return (
              <div
                key={vItem.key}
                data-index={rowIdx}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: vItem.start,
                  left: 0,
                  right: 0,
                  height: ROW_HEIGHT,
                  display: "flex",
                  alignItems: "stretch",
                  background: isSelected
                    ? "var(--bg-active)"
                    : isInsert
                    ? "rgba(var(--accent-rgb, 59, 130, 246), 0.05)"
                    : "transparent",
                  opacity: isDeleted ? 0.5 : 1,
                  textDecoration: isDeleted ? "line-through" : "none",
                  cursor: "default",
                }}
              >
                {/* Gutter with row number / indicator */}
                <div
                  style={{
                    width: 32,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-end",
                    paddingRight: 4,
                    borderRight: "1px solid var(--border)",
                    fontSize: 10,
                    color: isInsert
                      ? "var(--accent)"
                      : isDeleted
                      ? "var(--danger)"
                      : "var(--text-subtle)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {isInsert ? "+" : isDeleted ? "−" : rowIdx + 1}
                </div>

                {/* Cells */}
                {columns.map((col, colIdx) => {
                  const w = widthFor(col.name);
                  const isPk = pkColumns?.includes(col.name) ?? false;
                  const displayVal = buffer.getDisplayValue(
                    unifiedRow.rowKey,
                    unifiedRow.cells,
                    columns.map((c) => c.name),
                    col.name,
                  );
                  const cellIsDirty = buffer.isCellDirty(unifiedRow.rowKey, col.name);
                  const isEditing =
                    editingCell?.rowIdx === rowIdx && editingCell?.colIdx === colIdx;

                  const isActiveCellHere =
                    activeCell !== null &&
                    activeCell.rowIdx === rowIdx &&
                    activeCell.colIdx === colIdx;

                  return (
                    <div
                      key={col.name}
                      style={{
                        width: w,
                        flexShrink: 0,
                        display: "flex",
                        alignItems: "center",
                        padding: "0 6px",
                        borderRight: "1px solid var(--border)",
                        fontSize: 12,
                        overflow: "hidden",
                        background: isActiveCellHere
                          ? "var(--accent-soft, rgba(168, 85, 247, 0.12))"
                          : cellIsDirty
                          ? "rgba(250, 204, 21, 0.12)"
                          : "transparent",
                        boxShadow: isActiveCellHere
                          ? "inset 0 0 0 2px var(--accent, #a855f7)"
                          : undefined,
                        position: "relative",
                      }}
                      onClick={(e) => onCellClick(e, rowIdx, colIdx)}
                      onDoubleClick={() => {
                        if (isReadOnly || (isPk && !isInsert)) return;
                        setEditingCell({ rowIdx, colIdx });
                        onCellSelect?.(rowIdx, colIdx);
                      }}
                    >
                      {isEditing ? (
                        <EditableCell
                          column={col}
                          value={displayVal}
                          isPkColumn={isPk}
                          isReadOnly={isReadOnly}
                          isInsertRow={isInsert}
                          editing
                          onStartEdit={() => setEditingCell({ rowIdx, colIdx })}
                          onCommit={(val: EditValue) => {
                            const pk = buildPkMap(unifiedRow, columns, pkColumns);
                            buffer.setCellEdit({
                              rowKey: unifiedRow.rowKey,
                              column: col.name,
                              value: val,
                              pk,
                              originalRow: unifiedRow.source === "server" ? unifiedRow.cells : null,
                              originalColumns:
                                unifiedRow.source === "server"
                                  ? columns.map((c) => c.name)
                                  : null,
                            });
                            setEditingCell(null);
                          }}
                          onCancel={() => setEditingCell(null)}
                        />
                      ) : (
                        <CellDisplay value={displayVal} isDirty={cellIsDirty} />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Status row */}
        {status === "loading-next" && (
          <div style={statusRowStyle}>
            <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
            Loading more…
          </div>
        )}
        {nextError && (
          <div style={{ ...statusRowStyle, color: "var(--danger)" }}>
            {nextError.message}{" "}
            <button
              type="button"
              onClick={onRetryNextPage}
              style={{
                marginLeft: 6,
                fontSize: 11,
                padding: "1px 6px",
                borderRadius: 3,
                border: "1px solid var(--danger)",
                background: "transparent",
                color: "var(--danger)",
                cursor: "pointer",
              }}
            >
              Retry
            </button>
          </div>
        )}
        {reachedEnd && rows.length === 0 && (
          <div style={statusRowStyle}>No rows.</div>
        )}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPkMap(
  row: UnifiedRow,
  columns: ColumnInfo[],
  pkColumns: string[] | null,
): Record<string, EditValue> {
  if (!pkColumns) return {};
  const out: Record<string, EditValue> = {};
  for (const pk of pkColumns) {
    const idx = columns.findIndex((c) => c.name === pk);
    if (idx >= 0) out[pk] = (row.cells[idx] ?? null) as EditValue;
  }
  return out;
}

function CellDisplay({ value }: { value: CellValue | EditValue; isDirty: boolean }) {
  const str = formatCellValue(value);
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        flex: 1,
        color:
          value === null
            ? "var(--text-subtle)"
            : typeof value === "boolean"
            ? "var(--accent)"
            : "var(--text)",
        fontStyle: value === null ? "italic" : "normal",
        fontFamily:
          typeof value === "object" && value !== null
            ? "var(--font-mono, monospace)"
            : "inherit",
      }}
    >
      {str}
    </span>
  );
}

const statusRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 12px",
  fontSize: 12,
  color: "var(--text-muted)",
  borderTop: "1px solid var(--border)",
};
