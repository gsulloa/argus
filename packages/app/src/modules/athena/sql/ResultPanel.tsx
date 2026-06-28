/**
 * Athena ResultPanel.
 *
 * Renders one StatementOutcome from the Athena query runner:
 *  - "ok" + "rows"      → virtualized data grid with data_scanned_bytes cost indicator
 *  - "ok" + "succeeded" → banner with statement_type + query_ms + data_scanned_bytes
 *  - "err"              → error banner
 *  - "skipped"          → grayed-out skipped banner
 *
 * Unlike MySQL, Athena has NO "affected" variant — only "rows" and "succeeded".
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { RunState } from "./useQueryRun";
import type { AthenaStatementOutcome, AthenaRunSqlResult, AthenaResultColumnInfo } from "../types";
import { ExportMenu } from "./export/ExportMenu";
import { copyCellValue } from "@/platform/grid/cellClipboard";
import { sortResultRows, type SortOrder } from "@/platform/table/sortResultRows";

interface Props {
  state: RunState;
  onShowInEditor(offset: number): void;
  connectionName?: string;
}

export function ResultPanel({ state, onShowInEditor, connectionName = "" }: Props) {
  if (state.status === "idle") {
    return (
      <div style={emptyStyle}>Press ⌘↩ to run · Tab to autocomplete</div>
    );
  }
  if (state.status === "running") {
    return <div style={emptyStyle}>Running… (Athena is polling — this may take a moment)</div>;
  }
  if (state.status === "cancelled") {
    return <div style={emptyStyle}>Query cancelled</div>;
  }
  if (state.mode === "single") {
    if (state.error) {
      return (
        <ErrorBlock
          message={state.error.message}
          code={state.error.code}
          statementStartOffset={state.startOffset}
          onShowInEditor={onShowInEditor}
        />
      );
    }
    if (!state.result) return null;
    return (
      <ResultBody
        result={state.result}
        connectionName={connectionName}
        showExport
      />
    );
  }
  // multi
  return (
    <MultiStatementTabs
      outcomes={state.outcomes}
      renderTab={(o) => renderMultiOutcome(o, state.statements, onShowInEditor)}
    />
  );
}

function renderMultiOutcome(
  outcome: AthenaStatementOutcome,
  statements: { startOffset: number }[],
  onShowInEditor: (offset: number) => void,
) {
  if (outcome.outcome === "skipped") {
    return (
      <div style={{ ...emptyStyle, color: "var(--text-subtle)", fontStyle: "italic" }}>
        Skipped — a previous statement failed.
      </div>
    );
  }
  if (outcome.outcome === "err" && outcome.error) {
    const stmt = statements[outcome.statement_index];
    return (
      <ErrorBlock
        message={outcome.error.message}
        code={outcome.error.code}
        statementStartOffset={stmt?.startOffset ?? 0}
        onShowInEditor={onShowInEditor}
      />
    );
  }
  if (outcome.outcome === "ok" && outcome.result) {
    return <ResultBody result={outcome.result} connectionName="" showExport={false} />;
  }
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function ResultBody({
  result,
  connectionName,
  showExport,
}: {
  result: AthenaRunSqlResult;
  connectionName: string;
  showExport: boolean;
}) {
  if (result.kind === "succeeded") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
          fontSize: 12,
          color: "var(--text)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontWeight: 600,
            background: "var(--bg-active)",
            padding: "2px 6px",
            borderRadius: 3,
            fontSize: 11,
          }}
        >
          {result.statement_type}
        </span>
        <span>
          {result.query_ms} ms
          {result.data_scanned_bytes > 0 && (
            <span style={{ marginLeft: 8, color: "var(--text-muted)", fontSize: 11 }}>
              · {formatBytes(result.data_scanned_bytes)} scanned
            </span>
          )}
        </span>
      </div>
    );
  }
  // rows
  return (
    <RowsResultView
      result={result}
      connectionName={connectionName}
      showExport={showExport}
    />
  );
}

function RowsResultView({
  result,
  connectionName,
  showExport,
}: {
  result: Extract<AthenaRunSqlResult, { kind: "rows" }>;
  connectionName: string;
  showExport: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {result.truncated ? (
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
          Result truncated — add a LIMIT clause to refine.
        </div>
      ) : null}
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
          {result.rows.length} row{result.rows.length !== 1 ? "s" : ""} · {result.query_ms} ms
          {result.data_scanned_bytes > 0 && (
            <span
              style={{ marginLeft: 8 }}
              title="Data scanned by this query — Athena bills per scanned byte"
            >
              · {formatBytes(result.data_scanned_bytes)} scanned
            </span>
          )}
        </span>
        {showExport && result.rows.length > 0 ? (
          <ExportMenu
            connectionName={connectionName}
            columns={result.columns}
            rows={result.rows}
          />
        ) : null}
      </div>
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {result.rows.length === 0 ? (
          <div style={emptyStyle}>(0 rows)</div>
        ) : (
          <SimpleTable columns={result.columns} rows={result.rows} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Simple table renderer (Athena does not use the MySQL DataGrid since it has
// no inline-edit capabilities — use a lightweight read-only table)
// ---------------------------------------------------------------------------

function SimpleTable({
  columns,
  rows,
}: {
  columns: AthenaResultColumnInfo[];
  rows: unknown[][];
}) {
  const tableRootRef = useRef<HTMLDivElement | null>(null);
  // Single-cell active selection — mutually exclusive with sorting.
  const [activeCell, setActiveCell] = useState<{ row: number; col: number } | null>(null);
  // Client-side sort state (issue #91). Athena results are read-only and have
  // no table context to re-query, so sorting reorders the loaded rows in-memory.
  const [orderBy, setOrderBy] = useState<SortOrder[]>([]);

  // Reset the sort whenever the result's column shape changes (new query).
  const columnsSig = columns.map((c) => c.name).join("|");
  useEffect(() => {
    setOrderBy([]);
  }, [columnsSig]);

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

  // Clear the active cell whenever the displayed data changes (new query or
  // re-sort) — the cell index refers to a position in `sortedRows`.
  useEffect(() => {
    setActiveCell(null);
  }, [columnsSig, rows, orderBy]);

  function onGridKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if ((e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C")) {
      if (activeCell !== null) {
        const target = e.target as HTMLElement;
        const tag = target.tagName.toUpperCase();
        if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT" && !target.isContentEditable) {
          const row = sortedRows[activeCell.row];
          const value = row ? (row[activeCell.col] ?? null) : null;
          e.preventDefault();
          void copyCellValue(value);
          return;
        }
      }
    }
    if (e.key === "Escape") {
      setActiveCell(null);
    }
  }

  const handleHeaderClick = (name: string) => {
    const cur = orderBy.find((o) => o.column === name);
    if (!cur) setOrderBy([{ column: name, direction: "asc" }]);
    else if (cur.direction === "asc") setOrderBy([{ column: name, direction: "desc" }]);
    else setOrderBy([]);
  };

  return (
    <div
      ref={tableRootRef}
      style={{ overflow: "auto", height: "100%", outline: "none" }}
      tabIndex={0}
      onKeyDown={onGridKeyDown}
    >
      <table
        style={{
          borderCollapse: "collapse",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          width: "100%",
        }}
      >
        <thead>
          <tr>
            {columns.map((col) => {
              const dir = orderBy.find((o) => o.column === col.name)?.direction ?? null;
              return (
                <th
                  key={col.name}
                  onClick={() => handleHeaderClick(col.name)}
                  style={{
                    padding: "3px 8px",
                    textAlign: "left",
                    borderBottom: "1px solid var(--border)",
                    background: "var(--surface)",
                    color: "var(--text-muted)",
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                    position: "sticky",
                    top: 0,
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  {col.name}
                  <span
                    style={{
                      marginLeft: 6,
                      opacity: 0.6,
                      fontSize: 10,
                      fontWeight: 400,
                    }}
                  >
                    {col.ty}
                  </span>
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
          {sortedRows.map((row, i) => (
            <tr
              key={i}
              style={{
                cursor: "pointer",
              }}
            >
              {(row as unknown[]).map((cell, j) => {
                const isActive = activeCell !== null && activeCell.row === i && activeCell.col === j;
                return (
                  <td
                    key={j}
                    style={{
                      padding: "2px 8px",
                      borderBottom: "1px solid var(--border)",
                      color: cell === null ? "var(--text-subtle)" : "var(--text)",
                      whiteSpace: "nowrap",
                      maxWidth: 320,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      background: isActive ? "var(--accent-soft, rgba(168, 85, 247, 0.12))" : undefined,
                      boxShadow: isActive ? "inset 0 0 0 2px var(--accent, #a855f7)" : undefined,
                    }}
                    title={cell === null ? "NULL" : String(cell)}
                    onClick={() => {
                      setActiveCell({ row: i, col: j });
                      tableRootRef.current?.focus();
                    }}
                  >
                    {cell === null ? (
                      <span style={{ color: "var(--text-subtle)", fontStyle: "italic" }}>NULL</span>
                    ) : (
                      String(cell)
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Multi-statement tabs (local implementation for Athena outcomes)
// ---------------------------------------------------------------------------

function MultiStatementTabs({
  outcomes,
  renderTab,
}: {
  outcomes: AthenaStatementOutcome[];
  renderTab(outcome: AthenaStatementOutcome): React.ReactNode;
}) {
  const firstFailure = outcomes.findIndex((o) => o.outcome === "err");
  const initial = firstFailure >= 0 ? firstFailure : 0;
  const [active, setActive] = useState(initial);

  if (outcomes.length === 0) return null;
  const current = outcomes[active] ?? outcomes[0]!;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          gap: 2,
          padding: "0 8px",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
          flexShrink: 0,
          overflowX: "auto",
        }}
        role="tablist"
      >
        {outcomes.map((o, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === active}
            onClick={() => setActive(i)}
            style={{
              fontSize: 11,
              padding: "4px 10px",
              border: "none",
              borderBottom: i === active ? "2px solid var(--accent)" : "2px solid transparent",
              background: "transparent",
              color:
                o.outcome === "err"
                  ? "var(--danger)"
                  : o.outcome === "skipped"
                    ? "var(--text-subtle)"
                    : i === active
                      ? "var(--text)"
                      : "var(--text-muted)",
              cursor: "pointer",
              whiteSpace: "nowrap",
              fontFamily: "var(--font-mono)",
            }}
          >
            {labelFor(o)}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>{renderTab(current)}</div>
    </div>
  );
}

function labelFor(o: AthenaStatementOutcome): string {
  const idx = o.statement_index + 1;
  if (o.outcome === "ok" && o.result) {
    if (o.result.kind === "rows") {
      const trunc = o.result.truncated ? "+" : "";
      return `${idx} · ${o.result.rows.length}${trunc} rows`;
    }
    return `${idx} · ${o.result.statement_type}`;
  }
  if (o.outcome === "err") {
    return `${idx} · ✗ ${o.error?.code ?? "error"}`;
  }
  return `${idx} · … skipped`;
}

// ---------------------------------------------------------------------------
// Error block
// ---------------------------------------------------------------------------

function ErrorBlock({
  message,
  code,
  statementStartOffset,
  onShowInEditor,
}: {
  message: string;
  code: string | null;
  statementStartOffset: number;
  onShowInEditor(offset: number): void;
}) {
  void statementStartOffset; // Athena errors have no character position
  void onShowInEditor;
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
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
      role="alert"
    >
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        {code ? (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              fontWeight: 700,
              background: "rgba(239,68,68,0.15)",
              padding: "1px 5px",
              borderRadius: 3,
              flexShrink: 0,
            }}
          >
            {code}
          </span>
        ) : null}
        <span style={{ flex: 1, wordBreak: "break-word" }}>{message}</span>
      </div>
    </div>
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
