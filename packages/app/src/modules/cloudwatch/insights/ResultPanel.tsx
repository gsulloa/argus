/**
 * CloudWatch Insights ResultPanel.
 *
 * Renders the query result over dynamic columns returned by the backend:
 *  - running → "Running…" placeholder
 *  - error   → error banner
 *  - idle + no result → idle placeholder
 *  - done + result   → virtualized (scrollable) table + cost + export
 *
 * Reuses the Athena export menu (CSV/JSONL/XLSX) by adapting the column shape.
 */

import { Fragment, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import type { InsightsRunState } from "./useQueryRun";
import type { InsightsColumnInfo } from "../types";
import { copyCellValue } from "@/platform/grid/cellClipboard";
import { sortResultRows, type SortOrder } from "@/platform/table/sortResultRows";
import { formatLogTs, prettyMaybeJson } from "../logFormat";
import { COPY_FAILED_MESSAGE } from "@/platform/clipboard";
import { useToast } from "@/platform/toast";
import styles from "./ResultPanel.module.css";

// Re-use the Athena export infra. The ExportMenu accepts { name, ty }[] columns;
// we adapt our { name, type } columns to that shape.
import { ExportMenu } from "@/modules/athena/sql/export/ExportMenu";
import type { AthenaResultColumnInfo } from "@/modules/athena/types";

// Columns rendered as a readable timestamp rather than a raw value.
const TIMESTAMP_COLUMNS = new Set(["@timestamp", "@ingestionTime"]);

interface Props {
  state: InsightsRunState;
  connectionName?: string;
}

export function InsightsResultPanel({ state, connectionName = "" }: Props) {
  if (state.status === "running") {
    return (
      <div style={emptyStyle}>
        Running Insights query… (polling for results)
      </div>
    );
  }
  if (state.error) {
    return (
      <div
        style={{
          margin: 8,
          padding: "8px 12px",
          background: "rgba(239,68,68,0.08)",
          border: "1px solid rgba(239,68,68,0.3)",
          borderRadius: 4,
          fontSize: 12,
          color: "var(--danger)",
        }}
        role="alert"
      >
        {state.error}
      </div>
    );
  }
  if (!state.result) {
    return (
      <div style={emptyStyle}>
        Select log groups and a time range, then press Run (⌘↩)
      </div>
    );
  }

  const { result } = state;
  // Adapt columns: InsightsColumnInfo has `type`, Athena exporter expects `ty`
  const exportColumns: AthenaResultColumnInfo[] = result.columns.map((c) => ({
    name: c.name,
    ty: c.type,
  }));

  return (
    <RowsResultView
      columns={result.columns}
      exportColumns={exportColumns}
      rows={result.rows}
      queryMs={result.query_ms}
      truncated={result.truncated}
      recordsMatched={result.records_matched}
      bytesScanned={result.bytes_scanned}
      connectionName={connectionName}
    />
  );
}

// ---------------------------------------------------------------------------
// Rows result view
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes.toFixed(0)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

interface RowsResultViewProps {
  columns: InsightsColumnInfo[];
  exportColumns: AthenaResultColumnInfo[];
  rows: unknown[][];
  queryMs: number;
  truncated: boolean;
  recordsMatched: number;
  bytesScanned: number;
  connectionName: string;
}

function RowsResultView({
  columns,
  exportColumns,
  rows,
  queryMs,
  truncated,
  recordsMatched,
  bytesScanned,
  connectionName,
}: RowsResultViewProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {truncated && (
        <div
          style={{
            padding: "3px 10px",
            fontSize: 11,
            color: "var(--text-muted)",
            background: "rgba(245,158,11,0.1)",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          Result truncated to {rows.length.toLocaleString()} rows.
        </div>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "2px 8px",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
          flexShrink: 0,
          fontSize: 11,
          color: "var(--text-muted)",
        }}
      >
        <span>
          {rows.length} row{rows.length !== 1 ? "s" : ""} · {queryMs} ms
          {recordsMatched > 0 && (
            <span style={{ marginLeft: 8 }}>
              · {recordsMatched.toLocaleString()} matched
            </span>
          )}
          {bytesScanned > 0 && (
            <span
              style={{ marginLeft: 8 }}
              title="Data scanned by this Insights query — CloudWatch bills per scanned byte"
            >
              · {formatBytes(bytesScanned)} scanned
            </span>
          )}
        </span>
        {rows.length > 0 && (
          <ExportMenu
            connectionName={connectionName}
            columns={exportColumns}
            rows={rows}
            truncated={truncated}
          />
        )}
      </div>
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {rows.length === 0 ? (
          <div style={emptyStyle}>(0 rows)</div>
        ) : (
          <InsightsTable columns={columns} rows={rows} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read-only table (mirrors Athena's SimpleTable pattern)
// ---------------------------------------------------------------------------

function InsightsTable({
  columns,
  rows,
}: {
  columns: InsightsColumnInfo[];
  rows: unknown[][];
}) {
  const tableRootRef = useRef<HTMLDivElement | null>(null);
  const [activeCell, setActiveCell] = useState<{ row: number; col: number } | null>(null);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [orderBy, setOrderBy] = useState<SortOrder[]>([]);
  const toast = useToast();

  const columnsSig = columns.map((c) => c.name).join("|");
  const sortedRows = useMemo(
    () =>
      sortResultRows(
        rows,
        columns.map((c) => c.name),
        orderBy,
        (row, i) => row[i],
      ),
    [rows, columns, orderBy],
  );

  function onGridKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if ((e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C")) {
      if (activeCell !== null) {
        const target = e.target as HTMLElement;
        const tag = target.tagName.toUpperCase();
        if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT" && !target.isContentEditable) {
          const row = sortedRows[activeCell.row];
          const value = row ? (row[activeCell.col] ?? null) : null;
          e.preventDefault();
          void copyCellValue(value).then((ok) => {
            if (!ok) toast.show(COPY_FAILED_MESSAGE, "error");
          });
          return;
        }
      }
    }
    if (e.key === "Escape") {
      setActiveCell(null);
    }
  }

  void columnsSig; // used for dep tracking

  const handleHeaderClick = (name: string) => {
    const cur = orderBy.find((o) => o.column === name);
    if (!cur) setOrderBy([{ column: name, direction: "asc" }]);
    else if (cur.direction === "asc") setOrderBy([{ column: name, direction: "desc" }]);
    else setOrderBy([]);
  };

  const colCount = columns.length + 1; // +1 for the leading caret column

  return (
    <div
      ref={tableRootRef}
      style={{ overflow: "auto", height: "100%", outline: "none" }}
      tabIndex={0}
      onKeyDown={onGridKeyDown}
    >
      <table className={styles.table}>
        <thead>
          <tr>
            <th className={`${styles.headerCell} ${styles.caretCol}`} aria-hidden="true" />
            {columns.map((col) => {
              const dir = orderBy.find((o) => o.column === col.name)?.direction ?? null;
              return (
                <th
                  key={col.name}
                  className={styles.headerCell}
                  onClick={() => handleHeaderClick(col.name)}
                >
                  {col.name}
                  {dir && (
                    <span style={{ marginLeft: 4, fontSize: 10, color: "var(--accent)" }}>
                      {dir === "asc" ? "↑" : "↓"}
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, i) => {
            const expanded = expandedRow === i;
            const cells = row as unknown[];
            return (
              <Fragment key={i}>
                <tr className={styles.row}>
                  <td className={`${styles.cell} ${styles.caretCol}`}>
                    <button
                      type="button"
                      className={styles.caretBtn}
                      aria-label={expanded ? "Collapse row" : "Expand row"}
                      aria-expanded={expanded}
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedRow(expanded ? null : i);
                      }}
                    >
                      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    </button>
                  </td>
                  {cells.map((cell, j) => {
                    const isActive =
                      activeCell !== null && activeCell.row === i && activeCell.col === j;
                    const isTs = TIMESTAMP_COLUMNS.has(columns[j]?.name ?? "");
                    const display =
                      cell === null ? null : isTs ? formatLogTs(String(cell)) : String(cell);
                    return (
                      <td
                        key={j}
                        className={[
                          styles.cell,
                          isTs ? styles.tsCell : "",
                          isActive ? styles.cellActive : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        title={cell === null ? "NULL" : String(cell)}
                        onClick={() => {
                          setActiveCell({ row: i, col: j });
                          tableRootRef.current?.focus();
                        }}
                      >
                        {cell === null ? (
                          <span className={styles.cellNull}>NULL</span>
                        ) : (
                          display
                        )}
                      </td>
                    );
                  })}
                </tr>
                {expanded && (
                  <tr>
                    <td className={styles.detailCell} colSpan={colCount}>
                      <div className={styles.detailGrid}>
                        {columns.map((col, j) => {
                          const cell = cells[j];
                          if (cell === null || cell === undefined) {
                            return (
                              <FieldDetail key={col.name} name={col.name} value={null} />
                            );
                          }
                          return (
                            <FieldDetail key={col.name} name={col.name} value={String(cell)} />
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// One field in the expanded-row detail view: the value is wrapped + selectable,
// and pretty-printed when it is JSON.
function FieldDetail({ name, value }: { name: string; value: string | null }) {
  const pretty = value === null ? null : prettyMaybeJson(value);
  return (
    <>
      <span className={styles.detailKey}>{name}</span>
      {value === null ? (
        <span className={`${styles.detailVal} ${styles.detailValNull}`}>NULL</span>
      ) : (
        <pre className={styles.detailVal}>{pretty!.text}</pre>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

const emptyStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  fontSize: 12,
  color: "var(--text-subtle)",
  fontStyle: "italic",
};
