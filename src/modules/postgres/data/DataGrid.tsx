import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AppError } from "@/platform/errors/AppError";
import { ColumnFilter } from "./ColumnFilter";
import { EditableCell, looksLikeBytea } from "./EditableCell";
import { cycleSort, sortIndexFor } from "./sortHelpers";
import { isCellEnvelope, type CellValue, type DataColumn, type EditValue, type Filter, type OrderBy } from "./types";
import type { UseEditBufferResult } from "./useEditBuffer";
import styles from "./DataGrid.module.css";

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 28;
const STATUS_ROW_HEIGHT = 28;
const COLUMN_WIDTH = 180;
const SCROLL_LOOKAHEAD_ROWS = (pageSize: number) => pageSize * 2;

export interface UnifiedRow {
  rowKey: string;
  cells: CellValue[];
  source: "insert" | "server";
}

export interface DataGridProps {
  columns: DataColumn[];
  rows: UnifiedRow[];
  pageSize: number;
  orderBy: OrderBy[];
  filters: Filter[];
  status: string;
  nextError: AppError | null;
  reachedEnd: boolean;
  selectedRowIndex: number | null;
  isReadOnly: boolean;
  pkColumns: string[] | null;
  enumValuesByColumn: Record<string, string[]>;
  buffer: UseEditBufferResult;
  onSelectRow(index: number | null): void;
  onSortChange(next: OrderBy[]): void;
  onFiltersChange(next: Filter[]): void;
  onLoadNextPage(): void;
  onRetryNextPage(): void;
}

export function DataGrid(props: DataGridProps) {
  const {
    columns,
    rows,
    pageSize,
    orderBy,
    filters,
    status,
    nextError,
    reachedEnd,
    selectedRowIndex,
    isReadOnly,
    pkColumns,
    enumValuesByColumn,
    buffer,
    onSelectRow,
    onSortChange,
    onFiltersChange,
    onLoadNextPage,
    onRetryNextPage,
  } = props;

  const viewportRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

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

  const filterByColumn = useMemo(() => {
    const map = new Map<string, Filter>();
    for (const f of filters) map.set(f.column, f);
    return map;
  }, [filters]);

  function setFilterFor(column: string, next: Filter | null) {
    const without = filters.filter((f) => f.column !== column);
    onFiltersChange(next === null ? without : [...without, next]);
  }

  // Track the active editor: at most one cell at a time.
  const [editing, setEditing] = useState<{ rowIndex: number; col: string } | null>(null);

  // Keyboard handler at the grid level: Backspace toggles delete, Escape clears selection.
  function onGridKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (editing) return; // editor handles its own keys
    if ((e.key === "Backspace" || e.key === "Delete") && selectedRowIndex !== null) {
      const r = rows[selectedRowIndex];
      if (!r) return;
      if (isReadOnly) return;
      if (r.source === "insert") {
        e.preventDefault();
        buffer.removeInsertRow(r.rowKey);
        return;
      }
      if (!pkColumns) return; // no-PK relation: can't delete existing rows
      e.preventDefault();
      if (buffer.isRowDeleted(r.rowKey)) {
        buffer.markRowUndelete(r.rowKey);
      } else {
        const pk: Record<string, EditValue> = {};
        for (const col of pkColumns) {
          const idx = columns.findIndex((c) => c.name === col);
          if (idx >= 0) pk[col] = (r.cells[idx] ?? null) as EditValue;
        }
        buffer.markRowDelete(r.rowKey, pk);
      }
    }
  }

  const totalWidth = Math.max(columns.length * COLUMN_WIDTH, 1);

  return (
    <div className={styles.root} tabIndex={0} onKeyDown={onGridKeyDown}>
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
                  style={{ width: COLUMN_WIDTH }}
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
                  <span className={styles.colType}>{col.data_type}</span>
                  <ColumnFilter
                    column={col}
                    current={filterByColumn.get(col.name) ?? null}
                    onChange={(next) => setFilterFor(col.name, next)}
                  />
                </div>
              );
            })}
          </div>
        </div>
        <div
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
            const selected = selectedRowIndex === vi.index;
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
                onClick={() => onSelectRow(selected ? null : vi.index)}
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

                  return (
                    <EditableCell
                      key={col.name}
                      column={col}
                      displayValue={displayValue}
                      dirty={dirty}
                      readOnly={cellReadOnly}
                      enumValues={enumValuesByColumn[col.name]}
                      editing={cellEditing}
                      onStartEdit={onStartEdit}
                      onCommitEdit={onCommitEdit}
                      onCancelEdit={onCancelEdit}
                      style={{ width: COLUMN_WIDTH }}
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
}
