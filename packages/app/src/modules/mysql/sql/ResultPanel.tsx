/**
 * §20.4 — MySQL ResultPanel.
 *
 * Renders one StatementOutcome from the query runner:
 *  - "ok" + "rows"     → virtualized data grid
 *  - "ok" + "affected" → banner with command_tag + affected_rows + query_ms
 *  - "err"             → error banner with optional "Show in editor" link
 *  - "skipped"         → grayed-out skipped banner
 *
 * Also renders the idle / running states for single-run mode.
 */

import { useEffect, useMemo, useState } from "react";
import type { RunState } from "./useQueryRun";
import type { StatementOutcome, RunSqlResult, OrderBy } from "../types";
import { MultiStatementTabs } from "./MultiStatementTabs";
// We re-use the MySQL data DataGrid for rows output (it already handles
// ColumnInfo and generic row arrays).
import { DataGrid } from "../data/DataGrid";
import { useEditBuffer } from "../data/useEditBuffer";
import type { CellValue } from "../data/types";
import { sortResultRows } from "@/platform/table/sortResultRows";

// Export menu (§20.7)
import { ExportMenu } from "./export/ExportMenu";

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
    return <div style={emptyStyle}>Running…</div>;
  }
  if (state.mode === "single") {
    if (state.error) {
      return (
        <ErrorBlock
          message={state.error.message}
          code={state.error.code}
          position={state.error.position}
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
  outcome: StatementOutcome,
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
        position={outcome.error.position}
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

function ResultBody({
  result,
  connectionName,
  showExport,
}: {
  result: RunSqlResult;
  connectionName: string;
  showExport: boolean;
}) {
  if (result.kind === "affected") {
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
          {result.command_tag}
        </span>
        <span>
          {result.affected_rows} row{result.affected_rows !== 1 ? "s" : ""} affected · {result.query_ms} ms
        </span>
      </div>
    );
  }
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
  result: Extract<RunSqlResult, { kind: "rows" }>;
  connectionName: string;
  showExport: boolean;
}) {
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  // Client-side sort state for this result (issue #91). SQL results have no
  // table context to re-query, so sorting reorders the loaded rows in-memory.
  const [orderBy, setOrderBy] = useState<OrderBy[]>([]);
  // Use a dummy buffer — the result grid is always read-only.
  const dummyBuffer = useEditBuffer();

  // Reset the sort whenever the result's column shape changes (new query).
  const columnsSig = result.columns.map((c) => c.name).join("|");
  useEffect(() => {
    setOrderBy([]);
  }, [columnsSig]);

  // Map ColumnInfo to the DataGrid shape expected by the MySQL DataGrid.
  // The MySQL DataGrid expects ColumnInfo directly.
  const unifiedRows = useMemo(
    () =>
      result.rows.map((row, i) => ({
        rowKey: String(i),
        cells: row as CellValue[],
        source: "server" as const,
      })),
    [result.rows],
  );

  // Sort the loaded rows client-side; the original result is never mutated.
  const sortedRows = useMemo(
    () =>
      sortResultRows(
        unifiedRows,
        result.columns.map((c) => c.name),
        orderBy,
        (r, i) => r.cells[i],
      ),
    [unifiedRows, result.columns, orderBy],
  );

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
        </span>
        {showExport && result.rows.length > 0 ? (
          <ExportMenu
            connectionName={connectionName}
            columns={result.columns}
            rows={result.rows as CellValue[][]}
            truncated={result.truncated}
          />
        ) : null}
      </div>
      <div style={{ flex: 1, overflow: "hidden", minHeight: 0 }}>
        {result.rows.length === 0 ? (
          <div style={emptyStyle}>(0 rows)</div>
        ) : (
          <DataGrid
            columns={result.columns}
            rows={sortedRows}
            pageSize={result.rows.length}
            orderBy={orderBy}
            status="ready"
            nextError={null}
            reachedEnd
            selection={{ anchor: selectedRow, active: selectedRow }}
            isReadOnly
            pkColumns={null}
            buffer={dummyBuffer}
            connectionId=""
            schema=""
            relation=""
            onSelectionChange={(sel) => {
              setSelectedRow(sel.anchor);
            }}
            onSortChange={setOrderBy}
            onLoadNextPage={() => {}}
            onRetryNextPage={() => {}}
            onCellSelect={() => {}}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error block
// ---------------------------------------------------------------------------

function ErrorBlock({
  message,
  code,
  position,
  statementStartOffset,
  onShowInEditor,
}: {
  message: string;
  code: string | null;
  position: number | null;
  statementStartOffset: number;
  onShowInEditor(offset: number): void;
}) {
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
      {position != null ? (
        <button
          type="button"
          style={{
            alignSelf: "flex-start",
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 3,
            border: "1px solid rgba(239,68,68,0.5)",
            background: "transparent",
            color: "var(--danger)",
            cursor: "pointer",
          }}
          onClick={() => {
            // position is 1-based; convert to 0-based editor offset.
            const editorOffset = statementStartOffset + Math.max(0, position - 1);
            onShowInEditor(editorOffset);
          }}
        >
          Show in editor (position {position})
        </button>
      ) : null}
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
