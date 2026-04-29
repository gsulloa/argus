import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { categorize, isMonoCategory } from "./typeHelpers";
import {
  isCellEnvelope,
  type CellEnvelope,
  type CellValue,
  type DataColumn,
} from "./types";
import styles from "./DataGrid.module.css";

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 28;
const COLUMN_WIDTH = 180;

export interface AdhocResultGridProps {
  columns: DataColumn[];
  rows: CellValue[][];
  /** -1 means no row selected. */
  selectedRowIndex?: number | null;
  /** Called with the row index on click (or `null` on toggle-off). */
  onSelectRow?(index: number | null): void;
  /** Optional element rendered when `rows.length === 0`. */
  emptyState?: ReactNode;
  /** Forwarded to the root container. */
  style?: CSSProperties;
}

/**
 * Read-only virtualized result grid. Used by the SQL editor for ad-hoc query
 * results and shares the same DOM and styling as the editable table viewer's
 * grid (no separate virtualization implementation). Intentionally has zero
 * sort/filter/edit affordances — it is purely presentational.
 */
export function AdhocResultGrid({
  columns,
  rows,
  selectedRowIndex,
  onSelectRow,
  emptyState,
  style,
}: AdhocResultGridProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);

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

  const totalWidth = Math.max(columns.length * COLUMN_WIDTH, 1);

  if (rows.length === 0 && emptyState) {
    // Empty state: the header keeps its column-derived width (so it can
    // scroll horizontally if there are many columns), but the empty body
    // fills the full available width — otherwise the "(0 rows)" hint sits
    // squashed into a narrow strip at the left.
    return (
      <div className={styles.root} style={style}>
        <div className={styles.viewport}>
          <div className={styles.thead} style={{ width: totalWidth }}>
            <div className={styles.headerRow} style={{ height: HEADER_HEIGHT }}>
              {columns.map((col) => (
                <div
                  key={col.name}
                  className={styles.headerCell}
                  style={{ width: COLUMN_WIDTH, cursor: "default" }}
                  role="columnheader"
                  title={`${col.name} : ${col.data_type}`}
                >
                  <span className={styles.colName}>{col.name}</span>
                  <span className={styles.colType}>{col.data_type}</span>
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
    <div className={styles.root} style={style}>
      <div className={styles.viewport} ref={viewportRef}>
        <div className={styles.thead} style={{ width: totalWidth }}>
          <div className={styles.headerRow} style={{ height: HEADER_HEIGHT }}>
            {columns.map((col) => (
              <div
                key={col.name}
                className={styles.headerCell}
                style={{ width: COLUMN_WIDTH, cursor: "default" }}
                role="columnheader"
                title={`${col.name} : ${col.data_type}`}
              >
                <span className={styles.colName}>{col.name}</span>
                <span className={styles.colType}>{col.data_type}</span>
              </div>
            ))}
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
                onClick={() => onSelectRow?.(selected ? null : vi.index)}
              >
                {columns.map((col, ci) => {
                  const value = row[ci] ?? null;
                  return (
                    <div
                      key={col.name}
                      className={styles.cell}
                      style={{ width: COLUMN_WIDTH }}
                    >
                      <span className={styles.cellValue}>
                        <CellContent value={value} column={col} />
                      </span>
                    </div>
                  );
                })}
              </div>
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
