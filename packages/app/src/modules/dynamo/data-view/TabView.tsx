/**
 * TabView — task 10.1
 *
 * Virtualized Tabla grid for DynamoDB items.
 *
 * Architecture:
 *   - useInferredColumns() computes a stable ordered column list.
 *   - useReactTable (TanStack Table) builds the column + cell model.
 *   - useVirtualizer (TanStack Virtual) virtualizes rows over a scroll div.
 *   - IntersectionObserver watches a sentinel div after the last row to
 *     trigger scroll-to-load (task 10.5).
 *
 * Scroll-to-load design:
 *   An invisible sentinel <div> sits immediately after the virtualizer's
 *   virtual rows list. An IntersectionObserver fires once the sentinel enters
 *   the viewport. We track a "fired" ref to prevent double-calls in the same
 *   state transition — it resets whenever items.length or hasMore change.
 *
 * Props are controlled / stateless (parent DataViewTab owns selection state).
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2, MoreHorizontal } from "lucide-react";
import type { AttributeMap, AttributeValue } from "./types";
import type { TableDescription } from "@/modules/dynamo/tables/types";
import { MORE_COLUMN_ID, useInferredColumns } from "./useInferredColumns";
import type { DynamoItemsStatus } from "./useDynamoItems";
import { InlineCellEditor } from "./edit/InlineCellEditor";
import {
  useColumnWidths,
  type ColumnCategory,
  type ColumnSpec,
} from "@/platform/table/columnWidths";
import { ResizeHandle } from "@/platform/table/ResizeHandle";
import { makeSortingFn } from "./dynamoSortHelpers";
import styles from "./TabView.module.css";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 28;
const MORE_COLUMN_WIDTH = 40;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** Identifies the cell currently open for inline editing. */
export interface EditingCell {
  rowIndex: number;
  attrName: string;
}

/** Gesture modifiers passed from row click events. */
export interface SelectGesture {
  shiftKey?: boolean;
  metaKey?: boolean;
}

export interface TabViewProps {
  items: AttributeMap[];
  describe: TableDescription | null;
  indexName: string | null; // null = primary index
  /** Connection identifier — used to scope column-width persistence. */
  connectionId: string;
  /** Table name — used to scope column-width persistence. */
  tableName: string;
  /** Multi-row selection set. */
  selectedRowIndices: Set<number>;
  /** Primary selected row (most recently clicked). Used for inspector. */
  primarySelectedRowIndex: number | null;
  onSelect: (rowIndex: number, attribute?: string, gesture?: SelectGesture) => void;
  onLoadMore: () => void; // triggerAutoLoadMore from the hook
  hasMore: boolean; // lastEvaluatedKey != null
  status: DynamoItemsStatus;
  autoScrollDisabled: boolean;
  // ── Edit-in-place (task 6.1) ─────────────────────────────────────────────
  /** The cell currently in edit mode, or null. */
  editingCell: EditingCell | null;
  /** Called when a double-click on a primitive non-key cell requests edit mode. */
  onStartEdit: (rowIndex: number, attrName: string) => void;
  /** Called when the editor commits a new value. */
  onCommitEdit: (rowIndex: number, attrName: string, next: AttributeValue) => void;
  /** Called when the editor is dismissed without saving (Escape). */
  onCancelEdit: () => void;
  /** The cell whose commit is currently in flight, or null. */
  savingCell: EditingCell | null;
  /** Disables all double-click edit affordances when true. */
  isReadOnly: boolean;
  /** Current sort state — persisted by the parent via useDynamoSort. */
  sorting: SortingState;
  /** Called by TanStack when the user clicks a sortable header. */
  onSortingChange: OnChangeFn<SortingState>;
}

// ---------------------------------------------------------------------------
// Cell rendering helpers (task 10.3)
// ---------------------------------------------------------------------------

function binaryByteLength(base64: string): number {
  // Quick approximation per spec: Math.floor(base64.length * 0.75)
  return Math.floor(base64.length * 0.75);
}

function formatCount(n: number): string {
  return new Intl.NumberFormat().format(n);
}

interface CellContentProps {
  value: AttributeValue | undefined;
  attrName: string;
  rowIndex: number;
  onSelect: (rowIndex: number, attribute?: string, gesture?: SelectGesture) => void;
  // Edit-in-place props (task 6.1)
  isEditing: boolean;
  onStartEdit: (rowIndex: number, attrName: string) => void;
  onCommitEdit: (rowIndex: number, attrName: string, next: AttributeValue) => void;
  onCancelEdit: () => void;
  saving: boolean;
  isKeyColumn: boolean;
  isReadOnly: boolean;
}

function CellContent({
  value,
  attrName,
  rowIndex,
  onSelect,
  isEditing,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  saving,
  isKeyColumn,
  isReadOnly,
}: CellContentProps) {
  const handleComplexClick = useCallback(
    (e: React.MouseEvent) => {
      // Complex-cell click: select the row AND focus inspector on this attribute.
      // stopPropagation so the row-level onClick sees it as a complex-cell intent.
      e.stopPropagation();
      onSelect(rowIndex, attrName);
    },
    [rowIndex, attrName, onSelect],
  );

  // Double-click on a primitive cell opens the inline editor.
  // Key columns and read-only connections never allow editing.
  const handlePrimitiveDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (isKeyColumn || isReadOnly) return;
      onStartEdit(rowIndex, attrName);
    },
    [rowIndex, attrName, onStartEdit, isKeyColumn, isReadOnly],
  );

  if (value === undefined) {
    return (
      <span className={styles.cellEmpty} data-testid="tabla-cell-empty">
        —
      </span>
    );
  }

  // ── Inline editor branch — only for editing primitives ──────────────────
  if (isEditing && value !== undefined && ("S" in value || "N" in value || "BOOL" in value || "NULL" in value)) {
    return (
      <InlineCellEditor
        value={value}
        onCommit={(next) => onCommitEdit(rowIndex, attrName, next)}
        onCancel={onCancelEdit}
        saving={saving}
      />
    );
  }

  // Primitives — render inline, with double-click handler when editable
  const canEdit = !isKeyColumn && !isReadOnly;

  if ("S" in value) {
    return (
      <span
        className={styles.cellPrimitive}
        data-testid="tabla-cell"
        onDoubleClick={canEdit ? handlePrimitiveDoubleClick : undefined}
        title={canEdit ? "Double-click to edit" : undefined}
      >
        {value.S}
      </span>
    );
  }
  if ("N" in value) {
    return (
      <span
        className={styles.cellPrimitive}
        data-testid="tabla-cell"
        onDoubleClick={canEdit ? handlePrimitiveDoubleClick : undefined}
        title={canEdit ? "Double-click to edit" : undefined}
      >
        {value.N}
      </span>
    );
  }
  if ("BOOL" in value) {
    return (
      <span
        className={value.BOOL ? styles.boolTrue : styles.boolFalse}
        data-testid="tabla-cell"
        onDoubleClick={canEdit ? handlePrimitiveDoubleClick : undefined}
        title={canEdit ? "Double-click to edit" : undefined}
      >
        {value.BOOL ? "true" : "false"}
      </span>
    );
  }
  if ("NULL" in value) {
    return (
      <span
        className={styles.cellNull}
        data-testid="tabla-cell"
        onDoubleClick={canEdit ? handlePrimitiveDoubleClick : undefined}
        title={canEdit ? "Double-click to edit" : undefined}
      >
        null
      </span>
    );
  }

  // Complex types — render summary chip, clickable
  if ("B" in value) {
    const bytes = binaryByteLength(value.B);
    return (
      <button
        type="button"
        className={styles.complexChip}
        data-testid="tabla-cell"
        onClick={handleComplexClick}
        title={`Binary — ${bytes} bytes (click to inspect)`}
      >
        {`<binary ${bytes}B>`}
      </button>
    );
  }
  if ("L" in value) {
    return (
      <button
        type="button"
        className={styles.complexChip}
        data-testid="tabla-cell"
        onClick={handleComplexClick}
        title={`List — ${formatCount(value.L.length)} items (click to inspect)`}
      >
        {`[${formatCount(value.L.length)} items]`}
      </button>
    );
  }
  if ("M" in value) {
    const keyCount = Object.keys(value.M).length;
    return (
      <button
        type="button"
        className={styles.complexChip}
        data-testid="tabla-cell"
        onClick={handleComplexClick}
        title={`Map — ${formatCount(keyCount)} keys (click to inspect)`}
      >
        {`{${formatCount(keyCount)} keys}`}
      </button>
    );
  }
  if ("SS" in value) {
    return (
      <button
        type="button"
        className={styles.complexChip}
        data-testid="tabla-cell"
        onClick={handleComplexClick}
        title={`String Set — ${formatCount(value.SS.length)} items (click to inspect)`}
      >
        {`[${formatCount(value.SS.length)} items]`}
      </button>
    );
  }
  if ("NS" in value) {
    return (
      <button
        type="button"
        className={styles.complexChip}
        data-testid="tabla-cell"
        onClick={handleComplexClick}
        title={`Number Set — ${formatCount(value.NS.length)} items (click to inspect)`}
      >
        {`[${formatCount(value.NS.length)} items]`}
      </button>
    );
  }
  if ("BS" in value) {
    return (
      <button
        type="button"
        className={styles.complexChip}
        data-testid="tabla-cell"
        onClick={handleComplexClick}
        title={`Binary Set — ${formatCount(value.BS.length)} items (click to inspect)`}
      >
        {`[${formatCount(value.BS.length)} items]`}
      </button>
    );
  }

  // Fallback (should not happen with a well-typed AttributeValue)
  return (
    <span className={styles.cellEmpty} data-testid="tabla-cell">
      —
    </span>
  );
}

// ---------------------------------------------------------------------------
// TabView
// ---------------------------------------------------------------------------

export function TabView({
  items,
  describe,
  indexName,
  connectionId,
  tableName,
  selectedRowIndices,
  primarySelectedRowIndex: _primarySelectedRowIndex,
  onSelect,
  onLoadMore,
  hasMore,
  status,
  autoScrollDisabled,
  editingCell,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  savingCell,
  isReadOnly,
  sorting,
  onSortingChange,
}: TabViewProps) {
  // ── Inferred columns ─────────────────────────────────────────────────────
  const inferredCols = useInferredColumns(items, describe, indexName);

  // ── Column width management ───────────────────────────────────────────────
  const columnSpecs = useMemo<ColumnSpec[]>(
    () => [
      ...inferredCols
        .filter((c) => c.id !== MORE_COLUMN_ID)
        .map((c) => ({
          name: c.id,
          category: c.category as ColumnCategory,
          isKey: c.isKey,
        })),
      {
        name: MORE_COLUMN_ID,
        category: "other" as ColumnCategory,
        nonResizable: true,
        fixedWidth: MORE_COLUMN_WIDTH,
      },
    ],
    [inferredCols],
  );

  const { widthFor, totalWidth, setWidth, resetWidth } = useColumnWidths({
    storageKey: `dynamoColumnWidths:${connectionId}:${tableName}`,
    columns: columnSpecs,
  });

  // ── Key columns (PK + SK names for the active index) ─────────────────────
  // Used to prevent double-click editing on key columns (task 6.1).
  const keyColumns = useMemo<Set<string>>(() => {
    const names = new Set<string>();
    if (!describe) return names;
    let schema = describe.key_schema;
    if (indexName !== null) {
      const gsi = describe.global_secondary_indexes.find((g) => g.index_name === indexName);
      const lsi = describe.local_secondary_indexes.find((l) => l.index_name === indexName);
      if (gsi) schema = gsi.key_schema;
      else if (lsi) schema = lsi.key_schema;
    }
    for (const k of schema) names.add(k.attribute_name);
    return names;
  }, [describe, indexName]);

  // ── TanStack Table columns ────────────────────────────────────────────────
  // We use `ColumnDef<AttributeMap, unknown>[]` to let both display columns and
  // accessor columns coexist without fighting TanStack's variance constraints.
  const columns = useMemo<ColumnDef<AttributeMap, unknown>[]>(
    () =>
      inferredCols.map((col): ColumnDef<AttributeMap, unknown> => {
        if (col.id === MORE_COLUMN_ID) {
          return {
            id: MORE_COLUMN_ID,
            header: "…",
            size: widthFor(MORE_COLUMN_ID),
            enableSorting: false,
            cell: (info) => {
              const rowIndex = info.row.index;
              return (
                <button
                  type="button"
                  className={styles.moreBtn}
                  title="Open full item in inspector"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(rowIndex);
                  }}
                  data-testid="tabla-cell-more"
                >
                  <MoreHorizontal size={14} />
                </button>
              );
            },
          };
        }
        return {
          id: col.id,
          header: col.id,
          size: widthFor(col.id),
          accessorFn: (row: AttributeMap) => row[col.id],
          enableSorting: true,
          // sortUndefined: "last" keeps missing-attribute rows at the bottom in
          // both asc and desc — TanStack respects this before calling sortingFn.
          sortUndefined: "last",
          sortingFn: makeSortingFn(col.category as ColumnCategory),
          cell: (info) => {
            const val = info.getValue() as AttributeValue | undefined;
            const rowIdx = info.row.index;
            const isEditing =
              editingCell?.rowIndex === rowIdx &&
              editingCell?.attrName === col.id;
            const saving =
              savingCell?.rowIndex === rowIdx &&
              savingCell?.attrName === col.id;
            return (
              <CellContent
                value={val}
                attrName={col.id}
                rowIndex={rowIdx}
                onSelect={onSelect}
                isEditing={isEditing}
                onStartEdit={onStartEdit}
                onCommitEdit={onCommitEdit}
                onCancelEdit={onCancelEdit}
                saving={saving}
                isKeyColumn={keyColumns.has(col.id)}
                isReadOnly={isReadOnly}
              />
            );
          },
        };
      }),
    [inferredCols, widthFor, onSelect, editingCell, savingCell, keyColumns, isReadOnly, onStartEdit, onCommitEdit, onCancelEdit],
  );

  // ── TanStack Table instance ───────────────────────────────────────────────
  const table = useReactTable({
    data: items,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    state: { sorting },
    onSortingChange,
    enableMultiSort: true,
    enableSortingRemoval: true,
    enableMultiRemove: true,
    getRowId: (_row, index) => String(index),
  });

  const tableRows = table.getRowModel().rows;

  // ── Viewport ref ─────────────────────────────────────────────────────────
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // ── TanStack Virtual ──────────────────────────────────────────────────────
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // ── Scroll-to-load (task 10.5) ────────────────────────────────────────────
  // Strategy: IntersectionObserver on a sentinel div placed after the body.
  // A "fired" ref prevents double-calls in the same state transition.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const firedRef = useRef(false);

  // Reset the fired flag whenever the conditions change state
  useEffect(() => {
    firedRef.current = false;
  }, [items.length, hasMore, autoScrollDisabled, status]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting) return;
        if (!hasMore) return;
        if (autoScrollDisabled) return;
        if (status === "loading") return;
        if (firedRef.current) return;
        firedRef.current = true;
        onLoadMore();
      },
      {
        // Root is the viewport div; trigger when sentinel has 0% visible
        root: viewportRef.current,
        threshold: 0,
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, autoScrollDisabled, status, onLoadMore]);

  // ── Empty / idle state ────────────────────────────────────────────────────
  if (items.length === 0 && status !== "loading") {
    const msg =
      status === "idle"
        ? "Run a query to see results."
        : status === "error"
          ? "Query returned an error."
          : "No items found.";
    return (
      <div className={styles.root}>
        <div className={styles.empty}>{msg}</div>
      </div>
    );
  }

  const headerGroups = table.getHeaderGroups();

  return (
    <div className={styles.root}>
      <div className={styles.viewport} ref={viewportRef}>
        {/* Sticky header */}
        <div className={styles.thead} style={{ width: totalWidth, minWidth: "100%" }}>
          {headerGroups.map((hg) => (
            <div key={hg.id} style={{ display: "flex" }}>
              {hg.headers.map((header) => {
                const col = inferredCols.find((c) => c.id === header.id);
                const isKey = col?.isKey ?? false;
                const isMore = header.id === MORE_COLUMN_ID;
                const w = widthFor(header.id);
                const isSorted = !isMore ? header.column.getIsSorted() : false;
                const sortIndex = !isMore ? header.column.getSortIndex() : -1;
                const multiSort = table.getState().sorting.length >= 2;
                const sortArrow = isSorted === "asc" ? "▲" : isSorted === "desc" ? "▼" : null;
                return (
                  <div
                    key={header.id}
                    className={`${styles.headerCell} ${isKey ? styles.headerCellKey : ""} ${!isMore ? styles.headerCellSortable : ""}`}
                    style={{ width: w, height: HEADER_HEIGHT }}
                    role="columnheader"
                    onClick={!isMore ? header.column.getToggleSortingHandler() : undefined}
                  >
                    {isMore ? (
                      <span style={{ color: "var(--text-subtle)", fontSize: 11 }}>…</span>
                    ) : (
                      <>
                        <span>{header.id}</span>
                        {isKey && (
                          <span className={styles.keyBadge}>
                            {/* PK vs SK label */}
                            {col?.id === (describe?.key_schema.find((k) => k.key_type === "HASH")?.attribute_name ?? "")
                              ? "PK"
                              : "SK"}
                          </span>
                        )}
                        {sortArrow !== null && (
                          <span className={`${styles.sortIndicator} ${multiSort ? styles.sortIndicatorMulti : ""}`}>
                            {sortArrow}{multiSort ? ` ${sortIndex + 1}` : ""}
                          </span>
                        )}
                        {/* Wrap ResizeHandle to stop click propagation so
                            resize gestures don't toggle the column sort. */}
                        <span
                          onClick={(e) => e.stopPropagation()}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <ResizeHandle
                            currentWidth={w}
                            onChange={(px) => setWidth(header.id, px)}
                            onReset={() => resetWidth(header.id)}
                          />
                        </span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Virtual body */}
        <div
          className={styles.body}
          style={{
            height: totalSize,
            width: totalWidth,
            minWidth: "100%",
            position: "relative",
          }}
        >
          {virtualItems.map((vi) => {
            const row = tableRows[vi.index];
            if (!row) return null;
            const selected = selectedRowIndices.has(vi.index);
            return (
              <div
                key={vi.key}
                className={styles.row}
                data-selected={selected ? "true" : "false"}
                data-testid="tabla-row"
                style={{
                  height: ROW_HEIGHT,
                  transform: `translateY(${vi.start}px)`,
                  width: totalWidth,
                  minWidth: "100%",
                }}
                onClick={(e) => {
                  // Row-level click: select row, no specific attribute
                  // Pass gesture modifiers for multi-row selection (task 9.1)
                  onSelect(vi.index, undefined, {
                    shiftKey: e.shiftKey,
                    metaKey: e.metaKey || e.ctrlKey,
                  });
                }}
              >
                {row.getVisibleCells().map((cell) => {
                  const isMore = cell.column.id === MORE_COLUMN_ID;
                  const w = widthFor(cell.column.id);
                  return (
                    <div
                      key={cell.id}
                      className={styles.cell}
                      style={{ width: w }}
                      data-testid={isMore ? undefined : "tabla-cell-wrapper"}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Loading indicator row */}
        {status === "loading" && (
          <div className={styles.loadingRow} style={{ width: totalWidth }}>
            <span className={styles.spinner}>
              <Loader2 size={12} />
            </span>
            Loading…
          </div>
        )}

        {/* Scroll-to-load sentinel — invisible, sits after the virtualizer body */}
        <div
          ref={sentinelRef}
          style={{ height: 1, width: 1, flexShrink: 0 }}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
