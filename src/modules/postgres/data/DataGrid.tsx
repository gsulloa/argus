import { useEffect, useMemo, useRef } from "react";
import { Loader2 } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AppError } from "@/platform/errors/AppError";
import { ColumnFilter } from "./ColumnFilter";
import { cycleSort, sortIndexFor } from "./sortHelpers";
import { categorize, isMonoCategory } from "./typeHelpers";
import type {
  CellEnvelope,
  CellValue,
  DataColumn,
  Filter,
  OrderBy,
} from "./types";
import { isCellEnvelope } from "./types";
import styles from "./DataGrid.module.css";

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 28;
const STATUS_ROW_HEIGHT = 28;
const COLUMN_WIDTH = 180;
const SCROLL_LOOKAHEAD_ROWS = (pageSize: number) => pageSize * 2;

export interface DataGridProps {
  columns: DataColumn[];
  rows: CellValue[][];
  pageSize: number;
  orderBy: OrderBy[];
  filters: Filter[];
  status: string;
  nextError: AppError | null;
  reachedEnd: boolean;
  selectedRowIndex: number | null;
  onSelectRow(index: number | null): void;
  onSortChange(next: OrderBy[]): void;
  onFiltersChange(next: Filter[]): void;
  onLoadNextPage(): void;
  onRetryNextPage(): void;
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

function CellContent({
  value,
  column,
}: {
  value: CellValue;
  column: DataColumn;
}) {
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
  // Object/array (e.g. jsonb that's small enough to come back inline).
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

  const totalWidth = Math.max(columns.length * COLUMN_WIDTH, 1);

  return (
    <div className={styles.root}>
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
            const selected = selectedRowIndex === vi.index;
            return (
              <div
                key={vi.key}
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
                onClick={() => onSelectRow(selected ? null : vi.index)}
              >
                {columns.map((col, ci) => (
                  <div
                    key={col.name}
                    className={styles.cell}
                    style={{ width: COLUMN_WIDTH }}
                  >
                    <span className={styles.cellValue}>
                      <CellContent value={row[ci] ?? null} column={col} />
                    </span>
                  </div>
                ))}
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
