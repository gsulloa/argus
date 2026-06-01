/**
 * §20.4 — MS SQL Server ResultPanel.
 *
 * Renders one StatementOutcome from the query runner:
 *  - "ok" + "rows"     → virtualized data grid
 *  - "ok" + "affected" → banner with command_tag + affected_rows + query_ms
 *  - "err"             → error banner (with line / code / procedure / read-only hint)
 *  - "skipped"         → grayed-out skipped banner
 *
 * §20.9 — Read-only codes 3906 / 3908 get a friendly banner.
 * §20.5 — Error line reported per-batch (relative to the failing batch).
 */

import { useState } from "react";
import type { RunState } from "./useQueryRun";
import type { StatementOutcome, RunSqlResult } from "../types";
import { MultiStatementTabs } from "./MultiStatementTabs";
import { DataGrid } from "../data/DataGrid";
import { useEditBuffer } from "../data/useEditBuffer";
import type { CellValue } from "../data/types";
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
          line={state.error.line}
          procedure={state.error.procedure}
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
        line={outcome.error.line}
        procedure={outcome.error.procedure}
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
  const dummyBuffer = useEditBuffer();

  const unifiedRows = result.rows.map((row, i) => ({
    rowKey: String(i),
    cells: row as CellValue[],
    source: "server" as const,
  }));

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
          Result truncated — add a TOP clause to refine.
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
            rows={unifiedRows}
            pageSize={result.rows.length}
            orderBy={[]}
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
            onSortChange={() => {}}
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
// Error block (§20.5 + §20.9)
// ---------------------------------------------------------------------------

/** Read-only database codes that get a friendly banner. */
const READ_ONLY_CODES = new Set([3906, 3908]);

function ErrorBlock({
  message,
  code,
  line,
  procedure,
  statementStartOffset,
  onShowInEditor,
}: {
  message: string;
  code: number | null;
  line: number | null;
  procedure: string | null;
  statementStartOffset: number;
  onShowInEditor(offset: number): void;
}) {
  const isCancelled =
    code === null && (message === "query cancelled" || message.includes("cancelled"));

  // §20.9 — Friendly read-only hint
  const isReadOnly = code !== null && READ_ONLY_CODES.has(code);

  return (
    <div
      style={{
        margin: 8,
        padding: "8px 12px",
        background: isCancelled ? "rgba(107,114,128,0.08)" : "rgba(239,68,68,0.08)",
        border: `1px solid ${isCancelled ? "rgba(107,114,128,0.3)" : "rgba(239,68,68,0.3)"}`,
        borderRadius: 4,
        fontSize: 12,
        color: isCancelled ? "var(--text-muted)" : "var(--danger)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
      role="alert"
    >
      {isCancelled ? (
        <span style={{ fontStyle: "italic" }}>Cancelled.</span>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            {code != null ? (
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

          {procedure ? (
            <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              In procedure: {procedure}
            </div>
          ) : null}

          {line != null ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                Line {line} (within this batch)
              </span>
              <button
                type="button"
                style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  borderRadius: 3,
                  border: "1px solid rgba(239,68,68,0.5)",
                  background: "transparent",
                  color: "var(--danger)",
                  cursor: "pointer",
                }}
                onClick={() => {
                  // Line is 1-based; convert to 0-based line start using
                  // the statement's start offset.
                  // This is approximate: we jump to the start-of-batch offset
                  // and let the editor handle the visual highlight.
                  onShowInEditor(statementStartOffset);
                }}
              >
                Show in editor
              </button>
            </div>
          ) : null}

          {isReadOnly ? (
            <div
              style={{
                marginTop: 4,
                padding: "6px 10px",
                background: "rgba(168,85,247,0.08)",
                border: "1px solid rgba(168,85,247,0.25)",
                borderRadius: 3,
                fontSize: 11,
                color: "var(--text)",
              }}
            >
              Database is in a read-only state — switch to a writable replica or disable
              ApplicationIntent=ReadOnly.
            </div>
          ) : null}
        </>
      )}
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
