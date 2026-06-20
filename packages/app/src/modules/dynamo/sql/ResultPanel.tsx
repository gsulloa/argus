/**
 * DynamoDB PartiQL ResultPanel.
 *
 * Hybrid result renderer:
 *   - kind:"rows"     → inferred-columns grid (reusing data-view's useInferredColumns
 *                        + TabView-style AttributeValue cell rendering) + Inspector
 *                        for the selected item.
 *   - kind:"succeeded"→ status summary banner (statement_type + query_ms +
 *                        consumed_capacity readout, task 3.2).
 *   - error            → error banner.
 *   - skipped          → grayed-out skipped banner.
 *
 * Data-view components reused:
 *   - useInferredColumns (column inference from AttributeMap items)
 *   - Inspector (attribute-tree + JSON inspector for selected item)
 */

import { useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { useInferredColumns, MORE_COLUMN_ID } from "../data-view/useInferredColumns";
import { Inspector } from "../data-view/Inspector";
import type { AttributeMap, AttributeValue } from "../data-view/types";
import { ExportMenu } from "./export/ExportMenu";
import type { RunState, PartiQLStatementOutcome } from "./useQueryRun";
import type { RunPartiQLResult } from "./api";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 28;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  state: RunState;
  onShowInEditor(offset: number): void;
  connectionName?: string;
}

// ---------------------------------------------------------------------------
// Consumed capacity formatting (task 3.2)
// ---------------------------------------------------------------------------

function formatCapacity(cap: unknown): string | null {
  if (!cap || typeof cap !== "object") return null;
  const obj = cap as Record<string, unknown>;
  // DynamoDB returns { CapacityUnits: number, ... }
  const cu = typeof obj.CapacityUnits === "number" ? obj.CapacityUnits : null;
  if (cu === null) return null;
  return `${cu} CU consumed`;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Multi-statement helpers
// ---------------------------------------------------------------------------

function renderMultiOutcome(
  outcome: PartiQLStatementOutcome,
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
    const stmt = statements[outcome.index];
    return (
      <ErrorBlock
        message={outcome.error.message}
        code={null}
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

// ---------------------------------------------------------------------------
// ResultBody — routes between rows and succeeded
// ---------------------------------------------------------------------------

function ResultBody({
  result,
  connectionName,
  showExport,
}: {
  result: RunPartiQLResult;
  connectionName: string;
  showExport: boolean;
}) {
  if (result.kind === "succeeded") {
    const capStr = formatCapacity(result.consumed_capacity);
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
          {capStr && (
            <span style={{ marginLeft: 8, color: "var(--text-muted)", fontSize: 11 }}>
              · {capStr}
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

// ---------------------------------------------------------------------------
// RowsResultView — inferred-columns grid + inspector
// ---------------------------------------------------------------------------

function RowsResultView({
  result,
  connectionName,
  showExport,
}: {
  result: Extract<RunPartiQLResult, { kind: "rows" }>;
  connectionName: string;
  showExport: boolean;
}) {
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);

  // Infer columns from the items (no TableDescription / no index here — PartiQL
  // is schema-free across tables). Pass null for both.
  const inferredCols = useInferredColumns(result.items, null, null);

  // Derive just the data column names (exclude MORE_COLUMN_ID) for export
  const columnNames = useMemo(
    () => inferredCols.filter((c) => c.id !== MORE_COLUMN_ID).map((c) => c.id),
    [inferredCols],
  );

  const capStr = formatCapacity(result.consumed_capacity);

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
          {result.count} row{result.count !== 1 ? "s" : ""} · {result.query_ms} ms
          {capStr && (
            <span
              style={{ marginLeft: 8 }}
              title="Consumed capacity units for this query"
            >
              · {capStr}
            </span>
          )}
        </span>
        {showExport && result.items.length > 0 ? (
          <ExportMenu
            connectionName={connectionName}
            columns={columnNames}
            rows={result.items}
            truncated={result.truncated}
          />
        ) : null}
      </div>
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
        <div style={{ flex: 1, overflow: "hidden", minHeight: 0, minWidth: 0 }}>
          {result.items.length === 0 ? (
            <div style={emptyStyle}>(0 rows)</div>
          ) : (
            <PartiQLGrid
              items={result.items}
              columnNames={columnNames}
              selectedRowIndex={selectedRowIndex}
              onSelect={setSelectedRowIndex}
            />
          )}
        </div>
        {selectedRowIndex !== null && result.items[selectedRowIndex] && (
          <div
            style={{
              width: 320,
              flexShrink: 0,
              borderLeft: "1px solid var(--border)",
              overflow: "auto",
            }}
          >
            <Inspector
              item={result.items[selectedRowIndex]!}
              describe={null}
              indexName={null}
              onClearSelection={() => setSelectedRowIndex(null)}
              isReadOnly
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PartiQLGrid — virtualized read-only grid for AttributeMap rows
// ---------------------------------------------------------------------------

function PartiQLGrid({
  items,
  columnNames,
  selectedRowIndex,
  onSelect,
}: {
  items: AttributeMap[];
  columnNames: string[];
  selectedRowIndex: number | null;
  onSelect: (rowIndex: number) => void;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Build TanStack Table columns for the data columns only
  const columns = useMemo<ColumnDef<AttributeMap, unknown>[]>(
    () =>
      columnNames.map((name): ColumnDef<AttributeMap, unknown> => ({
        id: name,
        header: name,
        accessorFn: (row: AttributeMap) => row[name],
        cell: (info) => {
          const val = info.getValue() as AttributeValue | undefined;
          return <AttributeCell value={val} />;
        },
      })),
    [columnNames],
  );

  const table = useReactTable({
    data: items,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (_row, index) => String(index),
  });

  const tableRows = table.getRowModel().rows;

  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  return (
    <div
      ref={viewportRef}
      style={{ overflow: "auto", height: "100%", position: "relative" }}
    >
      {/* Sticky header */}
      <div
        style={{
          display: "flex",
          position: "sticky",
          top: 0,
          zIndex: 1,
          background: "var(--surface)",
          borderBottom: "1px solid var(--border)",
          height: HEADER_HEIGHT,
        }}
      >
        {columnNames.map((name) => (
          <div
            key={name}
            style={{
              minWidth: 120,
              width: 160,
              padding: "0 8px",
              display: "flex",
              alignItems: "center",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text-muted)",
              fontWeight: 500,
              borderRight: "1px solid var(--border)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              flexShrink: 0,
            }}
          >
            {name}
          </div>
        ))}
      </div>

      {/* Virtual body */}
      <div style={{ height: totalSize, position: "relative" }}>
        {virtualItems.map((vi) => {
          const row = tableRows[vi.index];
          if (!row) return null;
          const selected = selectedRowIndex === vi.index;
          return (
            <div
              key={vi.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: ROW_HEIGHT,
                transform: `translateY(${vi.start}px)`,
                display: "flex",
                background: selected ? "var(--accent-soft, rgba(168,85,247,0.12))" : undefined,
                borderBottom: "1px solid var(--border)",
                cursor: "pointer",
              }}
              onClick={() => onSelect(vi.index)}
            >
              {row.getVisibleCells().map((cell) => (
                <div
                  key={cell.id}
                  style={{
                    minWidth: 120,
                    width: 160,
                    padding: "0 8px",
                    display: "flex",
                    alignItems: "center",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    borderRight: "1px solid var(--border)",
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AttributeCell — renders a single AttributeValue inline
// ---------------------------------------------------------------------------

function AttributeCell({ value }: { value: AttributeValue | undefined }) {
  if (value === undefined) {
    return <span style={{ color: "var(--text-subtle)" }}>—</span>;
  }
  if ("NULL" in value) {
    return <span style={{ color: "var(--text-subtle)", fontStyle: "italic" }}>null</span>;
  }
  if ("S" in value) return <span style={{ color: "var(--text)" }}>{value.S}</span>;
  if ("N" in value) return <span style={{ color: "var(--text)" }}>{value.N}</span>;
  if ("BOOL" in value) {
    return (
      <span style={{ color: value.BOOL ? "var(--success)" : "var(--danger)" }}>
        {String(value.BOOL)}
      </span>
    );
  }
  if ("B" in value) {
    const bytes = Math.floor(value.B.length * 0.75);
    return <span style={{ color: "var(--text-subtle)" }}>{`<binary ${bytes}B>`}</span>;
  }
  if ("L" in value) {
    return (
      <span style={{ color: "var(--text-muted)" }}>
        {`[${value.L.length} items]`}
      </span>
    );
  }
  if ("M" in value) {
    const keyCount = Object.keys(value.M).length;
    return (
      <span style={{ color: "var(--text-muted)" }}>
        {`{${keyCount} keys}`}
      </span>
    );
  }
  if ("SS" in value) return <span style={{ color: "var(--text-muted)" }}>{`[${value.SS.length} strings]`}</span>;
  if ("NS" in value) return <span style={{ color: "var(--text-muted)" }}>{`[${value.NS.length} numbers]`}</span>;
  if ("BS" in value) return <span style={{ color: "var(--text-muted)" }}>{`[${value.BS.length} binaries]`}</span>;
  return <span style={{ color: "var(--text-subtle)" }}>—</span>;
}

// ---------------------------------------------------------------------------
// Multi-statement tabs
// ---------------------------------------------------------------------------

function MultiStatementTabs({
  outcomes,
  renderTab,
}: {
  outcomes: PartiQLStatementOutcome[];
  renderTab(outcome: PartiQLStatementOutcome): React.ReactNode;
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

function labelFor(o: PartiQLStatementOutcome): string {
  const idx = o.index + 1;
  if (o.outcome === "ok" && o.result) {
    if (o.result.kind === "rows") {
      const trunc = o.result.truncated ? "+" : "";
      return `${idx} · ${o.result.count}${trunc} rows`;
    }
    return `${idx} · ${o.result.statement_type}`;
  }
  if (o.outcome === "err") {
    return `${idx} · ✗ error`;
  }
  return `${idx} · … skipped`;
}

// ---------------------------------------------------------------------------
// Error block
// ---------------------------------------------------------------------------

function ErrorBlock({
  message,
  code,
  statementStartOffset: _statementStartOffset,
  onShowInEditor: _onShowInEditor,
}: {
  message: string;
  code: string | null;
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
