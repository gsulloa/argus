/**
 * MSSQL TableViewerTab — tab component for `mssql-table-data`.
 * Payload: { connectionId, connectionName, schema, relation, relationKind }
 *
 * §18.1, 18.6, 18.7, 18.8, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8
 *
 * Note: Structure / Raw subtabs (§21) are out of scope for this slice.
 * Trigger-degradation banner (§19.8) is shown once per session per
 * (connectionId, schema.relation) when the backend returns a "trigger-degraded" result.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { TabRegistry } from "@/platform/shell/tabs/TabRegistry";
import { useDirtySummary } from "@/platform/shell/tabs/useDirtySummary";
import type { Tab } from "@/platform/shell/tabs/types";
import { useActiveMssqlConnections } from "../useActiveConnections";
import { AppError } from "@/platform/errors/AppError";
import { dataApi } from "./api";
import { DataGrid, type DataGridHandle, type UnifiedRow } from "./DataGrid";
import { FilterBar } from "./FilterBar";
import { Inspector, type InspectorSelectedRow } from "./Inspector";
import { useEditBuffer, buildRowKey } from "./useEditBuffer";
import { useTableData } from "./useTableData";
import { type CellValue, type RelationKind } from "./types";
import type { EditOp, EditValue, PrimaryKeyResult } from "../types";

// ---------------------------------------------------------------------------
// Tab kind constant
// ---------------------------------------------------------------------------

export const MSSQL_TABLE_DATA_KIND = "mssql-table-data";

export interface MssqlTableDataPayload {
  connectionId: string;
  connectionName: string;
  schema: string;
  relation: string;
  relationKind: RelationKind;
}

function isPayload(v: unknown): v is MssqlTableDataPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.connectionId === "string" &&
    typeof o.connectionName === "string" &&
    typeof o.schema === "string" &&
    typeof o.relation === "string" &&
    (o.relationKind === "table" || o.relationKind === "view")
  );
}

// ---------------------------------------------------------------------------
// §19.7 — Typed constraint error code mapping
// ---------------------------------------------------------------------------

const MSSQL_CONSTRAINT_MESSAGES: Record<number, string> = {
  547: "Constraint violation — a foreign key constraint failed",
  2627: "Unique constraint violation — a duplicate key already exists",
  2601: "Duplicate key violation — a unique index rejected the insert/update",
  515: "NOT NULL violation — a required column has no value",
  8152: "String truncation — the value is too long for the column",
  2628: "String truncation — the value is too long for the column",
  8115: "Numeric overflow — the value exceeds the column's precision/scale",
  241: "Invalid date/time value — conversion failed",
  242: "Invalid date/time value — out of range",
};

function friendlyApplyError(raw: string): string {
  // Extract SQL Server error code if present in the message: e.g. "[547]"
  const codeMatch = raw.match(/\[(\d+)\]/);
  if (codeMatch && codeMatch[1] !== undefined) {
    const code = parseInt(codeMatch[1], 10);
    const friendly = MSSQL_CONSTRAINT_MESSAGES[code];
    if (friendly) {
      return `${friendly}\n${raw}`;
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// §19.8 — Trigger-degradation banner session cache
// ---------------------------------------------------------------------------

const triggerDegradedSeen = new Set<string>();

// ---------------------------------------------------------------------------
// TableViewerTab shell
// ---------------------------------------------------------------------------

function MssqlTableViewerTabImpl({ tab, active }: { tab: Tab; active: boolean }) {
  if (!isPayload(tab.payload)) {
    return <div style={{ padding: 16, fontSize: 13 }}>Invalid MSSQL table viewer payload.</div>;
  }
  return (
    <MssqlTableViewer
      tabId={tab.id}
      active={active}
      {...tab.payload}
    />
  );
}

TabRegistry.register(MSSQL_TABLE_DATA_KIND, MssqlTableViewerTabImpl);

export { MssqlTableViewerTabImpl as MssqlTableViewerTab };

// ---------------------------------------------------------------------------
// Main viewer component
// ---------------------------------------------------------------------------

interface ViewerProps extends MssqlTableDataPayload {
  tabId: string;
  active: boolean;
}

function MssqlTableViewer({
  tabId,
  connectionId,
  schema,
  relation,
  relationKind,
}: ViewerProps) {
  // Primary key
  const [pkResult, setPkResult] = useState<PrimaryKeyResult | null>(null);
  const [pkLoading, setPkLoading] = useState(false);
  const pkColumns: string[] | null = pkResult?.columns ?? null;

  // §19.5 — Read-only detection from active connection metadata.
  const { getActive } = useActiveMssqlConnections();
  const isReadOnly = getActive(connectionId)?.read_only ?? false;
  const isView = relationKind === "view";

  // Table data
  const tableData = useTableData({
    connectionId,
    schema,
    relation,
    relationKind,
  });

  // Edit buffer
  const buffer = useEditBuffer();

  // Apply state
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // §19.8 — Trigger-degradation banner
  const triggerDegradedKey = `${connectionId}:${schema}.${relation}`;
  const [triggerDegraded, setTriggerDegraded] = useState(
    () => triggerDegradedSeen.has(triggerDegradedKey),
  );

  // Grid selection (§18.7)
  const [selection, setSelection] = useState<{ anchor: number | null; active: number | null }>({
    anchor: null,
    active: null,
  });

  // Filter bar visibility
  const [filterVisible, setFilterVisible] = useState(false);

  // Inspector
  const [inspectorVisible, setInspectorVisible] = useState(true);

  // Discard dialog (§19.4)
  const [discardOpen, setDiscardOpen] = useState(false);

  const gridRef = useRef<DataGridHandle | null>(null);

  // Load PK on mount
  useEffect(() => {
    if (!connectionId || !schema || !relation) return;
    let cancelled = false;
    setPkLoading(true);
    dataApi
      .tablePrimaryKey(connectionId, schema, relation, "auto")
      .then((pk) => {
        if (cancelled) return;
        setPkResult(pk);
      })
      .catch(() => {
        if (cancelled) return;
        setPkResult(null);
      })
      .finally(() => {
        if (!cancelled) setPkLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, schema, relation]);

  // §19.6 — dirty-buffer close guard
  useDirtySummary(
    tabId,
    buffer.hasDirty
      ? { connectionId, label: `${schema}.${relation}` }
      : null,
  );

  // Build unified rows (inserts at top, then server rows)
  const unifiedRows = useMemo<UnifiedRow[]>(() => {
    const insertRows: UnifiedRow[] = [];
    for (const [rowKey, edits] of buffer.rows) {
      if (edits.kind === "insert") {
        const cells = tableData.columns.map((c) => {
          const v = edits.changes[c.name];
          return (v === undefined ? null : v) as CellValue;
        });
        insertRows.push({ rowKey, cells, source: "insert" });
      }
    }
    const serverRows: UnifiedRow[] = tableData.rows.map((row) => {
      const pkMap = buildRowKeyFromRow(row, tableData.columns.map((c) => c.name), pkColumns);
      return { rowKey: buildRowKey(pkMap), cells: row, source: "server" };
    });
    return [...insertRows, ...serverRows];
  }, [buffer.rows, tableData.rows, tableData.columns, pkColumns]);

  // Reset row selection when sort / filter / pageSize / relation changes,
  // so stale indices don't leave the Inspector pointing at the wrong (or
  // non-existent) row after a refresh.
  useEffect(() => {
    setSelection({ anchor: null, active: null });
  }, [
    tableData.pageSize,
    tableData.orderBy,
    tableData.filterModel,
    connectionId,
    schema,
    relation,
  ]);

  // Inspector selected rows
  const selectedRows = useMemo<InspectorSelectedRow[]>(() => {
    const { anchor, active } = selection;
    if (anchor === null || active === null) return [];
    const from = Math.min(anchor, active);
    const to = Math.max(anchor, active);
    return unifiedRows.slice(from, to + 1).map((r) => ({
      rowKey: r.rowKey,
      row: r.cells,
      pk: buildRowKeyFromRow(r.cells, tableData.columns.map((c) => c.name), pkColumns),
      source: r.source,
      isDeleted: buffer.isRowDeleted(r.rowKey),
    }));
  }, [selection, unifiedRows, tableData.columns, pkColumns, buffer]);

  // §19.2 — Apply action with typed error surface
  const handleApply = useCallback(async () => {
    if (!buffer.hasDirty || applying) return;
    const ops: EditOp[] = buffer.toEditOps();
    if (ops.length === 0) return;
    setApplying(true);
    setApplyError(null);
    try {
      const result = await dataApi.applyTableEdits(
        connectionId,
        schema,
        relation,
        ops,
        "user",
      );
      // §19.8 — Check trigger-degradation flag and show banner once per session.
      if (result.degraded_to_refetch && !triggerDegradedSeen.has(triggerDegradedKey)) {
        triggerDegradedSeen.add(triggerDegradedKey);
        setTriggerDegraded(true);
      }
      buffer.commitSuccess();
      tableData.refresh();
      gridRef.current?.scrollToTop();
    } catch (e) {
      const err = e instanceof AppError ? e : new AppError("Internal", String(e));
      setApplyError(friendlyApplyError(err.message));
    } finally {
      setApplying(false);
    }
  }, [buffer, applying, connectionId, schema, relation, tableData, triggerDegradedKey]);

  // Discard action (§19.4)
  const handleDiscard = useCallback(() => {
    if (!buffer.hasDirty) return;
    setDiscardOpen(true);
  }, [buffer.hasDirty]);

  const handleDiscardConfirm = useCallback(() => {
    buffer.clear();
    setDiscardOpen(false);
    tableData.refresh();
  }, [buffer, tableData]);

  // Add row (§19.3)
  const handleAddRow = useCallback(() => {
    if (isReadOnly || isView) return;
    buffer.addInsertRow({});
    gridRef.current?.scrollToTop();
    setSelection({ anchor: 0, active: 0 });
  }, [buffer, isReadOnly, isView]);

  // Keyboard: Backspace = delete selected rows, Cmd+Z = undo, Cmd+S = save
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (
        e.key === "Backspace" &&
        !isReadOnly &&
        selection.anchor !== null &&
        selection.active !== null
      ) {
        const from = Math.min(selection.anchor, selection.active);
        const to = Math.max(selection.anchor, selection.active);
        const entries = unifiedRows.slice(from, to + 1).map((r) => ({
          rowKey: r.rowKey,
          source: r.source,
          pk:
            r.source === "server"
              ? buildRowKeyFromRow(r.cells, tableData.columns.map((c) => c.name), pkColumns)
              : undefined,
          currentlyDeleted: buffer.isRowDeleted(r.rowKey),
        }));
        buffer.bulkDeleteToggle(entries);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        buffer.undo();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void handleApply();
      }
    },
    [selection, isReadOnly, unifiedRows, tableData.columns, pkColumns, buffer, handleApply],
  );

  // §18.8 — Empty state discrimination
  const tableIsEmpty = tableData.isReady && tableData.rows.length === 0 && !buffer.hasDirty;
  const hasActiveFilter = tableData.filterModel.rows.filter((r) => r.enabled).length > 0;
  const emptyBecauseFilter = tableIsEmpty && hasActiveFilter;

  const pendingCount =
    buffer.dirtyCounts.updates + buffer.dirtyCounts.inserts + buffer.dirtyCounts.deletes;

  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100%", flex: 1, minWidth: 0, outline: "none" }}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      role="region"
      aria-label={`${relation} data`}
    >
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 8px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-sidebar)",
          flexShrink: 0,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", flex: 1 }}>
          {schema}.{relation}
          {/* §19.5 — RO badge */}
          {isReadOnly && (
            <span
              style={{
                marginLeft: 6,
                fontSize: 9,
                fontWeight: 700,
                padding: "1px 5px",
                borderRadius: 3,
                background: "var(--bg-active)",
                color: "var(--text-muted)",
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                verticalAlign: "middle",
              }}
            >
              RO
            </span>
          )}
        </span>

        {/* Pending count */}
        {pendingCount > 0 && (
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {pendingCount} pending edit{pendingCount !== 1 ? "s" : ""}
          </span>
        )}

        {/* Filter toggle */}
        <button
          type="button"
          onClick={() => setFilterVisible((v) => !v)}
          style={toolbarBtnStyle}
          title="Toggle filter"
        >
          Filter
        </button>

        {/* Apply / Discard — hidden on read-only */}
        {!isReadOnly && (
          <>
            <button
              type="button"
              onClick={() => void handleApply()}
              disabled={!buffer.hasDirty || applying}
              style={{
                ...toolbarBtnStyle,
                background: buffer.hasDirty ? "var(--accent)" : "transparent",
                color: buffer.hasDirty ? "var(--on-accent, #fff)" : "var(--text-muted)",
                borderColor: buffer.hasDirty ? "var(--accent)" : "var(--border)",
              }}
            >
              {applying ? (
                <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
              ) : null}
              Apply
            </button>
            {buffer.hasDirty && (
              <button
                type="button"
                onClick={handleDiscard}
                style={{ ...toolbarBtnStyle, color: "var(--danger)", borderColor: "var(--danger)" }}
              >
                Discard
              </button>
            )}
          </>
        )}

        {/* Inspector toggle */}
        <button
          type="button"
          onClick={() => setInspectorVisible((v) => !v)}
          style={toolbarBtnStyle}
          title="Toggle inspector"
        >
          Inspector
        </button>
      </div>

      {/* §19.8 — Trigger-degradation banner (shown once per session) */}
      {triggerDegraded && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            background: "rgba(var(--warning-rgb, 234,179,8), 0.08)",
            color: "var(--text-muted)",
            fontSize: 11,
            flexShrink: 0,
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span style={{ flex: 1 }}>
            This table has triggers — OUTPUT clause was disabled; rows re-fetched via SELECT
            (slightly slower).
          </span>
          <button
            type="button"
            onClick={() => setTriggerDegraded(false)}
            style={{ background: "transparent", border: 0, cursor: "pointer", color: "inherit" }}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Apply error banner (§19.7) */}
      {applyError && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 6,
            padding: "4px 10px",
            background: "rgba(var(--danger-rgb, 239,68,68), 0.1)",
            color: "var(--danger)",
            fontSize: 12,
            flexShrink: 0,
            borderBottom: "1px solid var(--border)",
          }}
        >
          <pre
            style={{
              flex: 1,
              margin: 0,
              fontFamily: "inherit",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {applyError}
          </pre>
          <button
            type="button"
            onClick={() => setApplyError(null)}
            style={{ background: "transparent", border: 0, cursor: "pointer", color: "inherit", flexShrink: 0 }}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* §19.5 — No-PK banner */}
      {!pkLoading && pkColumns === null && !isView && (
        <div
          style={{
            padding: "3px 10px",
            fontSize: 11,
            color: "var(--text-muted)",
            background: "var(--bg-sidebar)",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          No primary key — existing rows cannot be edited or deleted via Argus
        </div>
      )}

      {/* Read-only banner */}
      {isReadOnly && (
        <div
          style={{
            padding: "3px 10px",
            fontSize: 11,
            color: "var(--text-muted)",
            background: "var(--bg-sidebar)",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          Read-only connection — edits disabled
        </div>
      )}

      {/* Filter bar */}
      {filterVisible && (
        <div style={{ flexShrink: 0, borderBottom: "1px solid var(--border)" }}>
          <FilterBar
            columns={tableData.columns}
            model={tableData.filterModel}
            onChange={tableData.setFilterModel}
            onApply={tableData.refresh}
          />
        </div>
      )}

      {/* Main content area */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
        {/* Loading */}
        {tableData.isLoading && (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              color: "var(--text-muted)",
              fontSize: 13,
            }}
          >
            <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />
            Loading…
          </div>
        )}

        {/* Error */}
        {tableData.error && (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              color: "var(--danger)",
              fontSize: 13,
            }}
          >
            <div>{tableData.error.message}</div>
            <button
              type="button"
              onClick={tableData.refresh}
              style={{
                fontSize: 12,
                padding: "3px 10px",
                borderRadius: 4,
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

        {/* §18.8 — Empty state */}
        {!tableData.isLoading && !tableData.error && tableIsEmpty && (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-subtle)",
              fontSize: 13,
              fontStyle: "italic",
            }}
          >
            {emptyBecauseFilter ? "No rows match the current filter." : "This table is empty."}
          </div>
        )}

        {/* Data grid */}
        {!tableData.isLoading &&
          !tableData.error &&
          (tableData.isReady || unifiedRows.length > 0) && (
            <DataGrid
              ref={gridRef}
              columns={tableData.columns}
              rows={unifiedRows}
              pageSize={tableData.pageSize}
              orderBy={tableData.orderBy}
              status={tableData.isLoadingNext ? "loading-next" : "ready"}
              nextError={tableData.nextError}
              reachedEnd={tableData.reachedEnd}
              selection={selection}
              isReadOnly={isReadOnly}
              pkColumns={pkColumns}
              buffer={buffer}
              connectionId={connectionId}
              schema={schema}
              relation={relation}
              onSelectionChange={setSelection}
              onSortChange={(o) => {
                tableData.setOrderBy(o);
              }}
              onLoadNextPage={tableData.loadNextPage}
              onRetryNextPage={tableData.clearNextError}
              onCellSelect={(_rowIdx, _colIdx) => {
                // Inspector uses selectedRows array; colIdx ignored for now.
              }}
            />
          )}

        {/* Inspector (§18.6) */}
        {inspectorVisible && (
          <Inspector
            columns={tableData.columns}
            selectedRows={selectedRows}
            isReadOnly={isReadOnly}
            pkColumns={pkColumns}
          />
        )}
      </div>

      {/* Bottom bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "3px 10px",
          borderTop: "1px solid var(--border)",
          background: "var(--bg-sidebar)",
          flexShrink: 0,
          fontSize: 11,
          color: "var(--text-muted)",
        }}
      >
        <span>{unifiedRows.length} rows</span>
        {tableData.queryMs !== null && <span>{tableData.queryMs}ms</span>}

        {/* §19.3 — Add row button (hidden on read-only and views) */}
        {!isReadOnly && !isView && (
          <button
            type="button"
            onClick={handleAddRow}
            style={{
              marginLeft: "auto",
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 3,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            + Add row
          </button>
        )}
      </div>

      {/* Discard dialog (§19.4) */}
      {discardOpen && (
        <DiscardDialog
          count={pendingCount}
          onConfirm={handleDiscardConfirm}
          onCancel={() => setDiscardOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DiscardDialog
// ---------------------------------------------------------------------------

function DiscardDialog({
  count,
  onConfirm,
  onCancel,
}: {
  count: number;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.3)",
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "20px 24px",
          minWidth: 280,
          boxShadow: "var(--shadow-md)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
          Discard {count} pending edit{count !== 1 ? "s" : ""}?
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          All unsaved changes will be lost.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              fontSize: 12,
              padding: "4px 12px",
              borderRadius: 4,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{
              fontSize: 12,
              padding: "4px 12px",
              borderRadius: 4,
              border: "none",
              background: "var(--danger)",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRowKeyFromRow(
  row: CellValue[],
  columnNames: string[],
  pkColumns: string[] | null,
): Record<string, EditValue> {
  if (!pkColumns) return {};
  const out: Record<string, EditValue> = {};
  for (const pk of pkColumns) {
    const idx = columnNames.indexOf(pk);
    if (idx >= 0) out[pk] = (row[idx] ?? null) as EditValue;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const toolbarBtnStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "2px 8px",
  borderRadius: 3,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
};
