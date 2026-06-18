/**
 * MySQL TableViewerTab — tab component for `mysql-table-data`.
 * Payload: { connectionId, connectionName, schema, relation, relationKind }
 *
 * §18.1, 18.7, 18.8, 19.2, 19.3, 19.4, 19.5, 19.6, 23.5
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { TabRegistry } from "@/platform/shell/tabs/TabRegistry";
import { useDirtySummary } from "@/platform/shell/tabs/useDirtySummary";
import { APP_DISPLAY_NAME } from "@/platform/app-identity";
import type { Tab } from "@/platform/shell/tabs/types";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { useSaveShortcut } from "@/platform/shell/useSaveShortcut";
import { useContextObjects, useContextObject } from "@/modules/context/hooks";
import { DocsSubtab } from "@/modules/context/components/DocsSubtab";
import { useActiveMysqlConnections } from "../useActiveConnections";
import { AppError } from "@/platform/errors/AppError";
import { dataApi } from "./api";
import { DataGrid, type DataGridHandle, type UnifiedRow } from "./DataGrid";
import { FilterBar } from "./FilterBar";
import { Inspector, type InspectorSelectedRow } from "./Inspector";
import { useEditBuffer, buildRowKey } from "./useEditBuffer";
import { useTableData } from "./useTableData";
import { deriveDefaultOrderBy } from "@/modules/shared/orderBy";
import {
  type CellValue,
  type RelationKind,
} from "./types";
import type { EditOp, EditValue, PrimaryKeyResult } from "../types";
import { useTableStructureCache } from "../structure/useTableStructureCache";
import { StructureSubtab } from "../structure/StructureSubtab";
import { RawSubtab } from "../structure/RawSubtab";
import { SubtabHeader, type Subtab } from "../structure/SubtabHeader";

// ---------------------------------------------------------------------------
// Tab kind constant
// ---------------------------------------------------------------------------

export const MYSQL_TABLE_DATA_KIND = "mysql-table-data";

export interface MysqlTableDataPayload {
  connectionId: string;
  connectionName: string;
  schema: string;
  relation: string;
  relationKind: RelationKind;
}

function isPayload(v: unknown): v is MysqlTableDataPayload {
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
// TableViewerTab shell
// ---------------------------------------------------------------------------

function MysqlTableViewerTabImpl({ tab, active }: { tab: Tab; active: boolean }) {
  if (!isPayload(tab.payload)) {
    return <div style={{ padding: 16, fontSize: 13 }}>Invalid MySQL table viewer payload.</div>;
  }
  return (
    <MysqlTableViewer
      tabId={tab.id}
      active={active}
      {...tab.payload}
    />
  );
}

TabRegistry.register(MYSQL_TABLE_DATA_KIND, MysqlTableViewerTabImpl);

export { MysqlTableViewerTabImpl as MysqlTableViewerTab };

// ---------------------------------------------------------------------------
// Main viewer component
// ---------------------------------------------------------------------------

interface ViewerProps extends MysqlTableDataPayload {
  tabId: string;
  active: boolean;
}

function MysqlTableViewer({
  tabId,
  active,
  connectionId,
  schema,
  relation,
  relationKind,
}: ViewerProps) {
  // Primary key
  const [pkResult, setPkResult] = useState<PrimaryKeyResult | null>(null);
  const [pkLoading, setPkLoading] = useState(false);
  // Whether the PK lookup has settled (resolved or failed). Gates the first
  // data fetch so it carries the PK-derived default order.
  const [pkSettled, setPkSettled] = useState(false);
  const pkColumns: string[] | null = pkResult?.columns ?? null;

  // §23.5 — Read-only detection from active connection metadata.
  const { getActive } = useActiveMysqlConnections();
  const isReadOnly = getActive(connectionId)?.read_only ?? false;
  const isView = relationKind === "view";

  // Context folder integration
  const { items: connections } = useConnections();
  const contextPath = connections.find((c) => c.id === connectionId)?.context_path ?? null;
  const identity = `${schema}.${relation}`;

  // Fetch the list of documented objects to know if this relation has a doc
  const { data: contextObjectsList } = useContextObjects(connectionId, contextPath);
  const documentedObjectItem = useMemo(
    () => contextObjectsList.find((item) => item.identity === identity) ?? null,
    [contextObjectsList, identity],
  );
  const docsAvailable = documentedObjectItem !== null && contextPath !== null;

  // Full object doc — consumed by DocsSubtab and column-notes decoration.
  const { data: contextDoc } = useContextObject(
    connectionId,
    docsAvailable ? identity : null,
    contextPath,
  );

  // Column notes derived from context doc
  const columnNotes: Record<string, string> | undefined = useMemo(() => {
    if (!contextDoc?.human?.column_notes) return undefined;
    return contextDoc.human.column_notes;
  }, [contextDoc]);

  // Table data — default the order to the PK descending until the user picks
  // one; gate the first fetch on the PK lookup so it issues a single query.
  const tableData = useTableData({
    connectionId,
    schema,
    relation,
    relationKind,
    initialOrderBy: deriveDefaultOrderBy(pkColumns, relationKind),
    enabled: pkSettled,
  });

  // Edit buffer
  const buffer = useEditBuffer();

  // Apply state
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Grid selection (§18.7)
  const [selection, setSelection] = useState<{ anchor: number | null; active: number | null }>({
    anchor: null,
    active: null,
  });

  // Filter bar visibility
  const [filterVisible, setFilterVisible] = useState(false);

  // Inspector
  const [inspectorVisible, setInspectorVisible] = useState(true);

  // §21 — Subtab
  const [subtab, setSubtab] = useState<Subtab>("data");
  const structureCache = useTableStructureCache(connectionId, schema, relation);

  // §7.5 — Snap back to "data" when navigating to a relation that has no doc
  useEffect(() => {
    if (subtab === "docs" && !docsAvailable) {
      setSubtab("data");
    }
  }, [subtab, docsAvailable]);

  const visibleTabs: Subtab[] = docsAvailable
    ? ["data", "structure", "raw", "docs"]
    : ["data", "structure", "raw"];

  // Discard dialog (§19.4)
  const [discardOpen, setDiscardOpen] = useState(false);

  const gridRef = useRef<DataGridHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

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
        // Set to null to indicate no PK detected or error fetching PK.
        setPkResult(null);
      })
      .finally(() => {
        if (!cancelled) {
          setPkLoading(false);
          setPkSettled(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, schema, relation]);

  // §19.6 — dirty-buffer close guard: register with DirtySummary registry
  // so the disconnect-confirmation dialog can list unsaved work.
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

  // §19.2 — Apply action
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
      if (result.outcome === "ok") {
        buffer.commitSuccess();
        // Re-fetch first page to sync state.
        tableData.refresh();
        gridRef.current?.scrollToTop();
      } else {
        const opIdx = result.failed_op_index;
        setApplyError(
          `Op #${opIdx + 1} failed: ${result.code ? `[${result.code}] ` : ""}${result.message}`,
        );
      }
    } catch (e) {
      const err = e instanceof AppError ? e : new AppError("Internal", String(e));
      setApplyError(err.message);
    } finally {
      setApplying(false);
    }
  }, [buffer, applying, connectionId, schema, relation, tableData]);

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
    // Focus added row in selection.
    setSelection({ anchor: 0, active: 0 });
  }, [buffer, isReadOnly, isView]);

  // Keyboard: Backspace = delete selected rows (§19.3)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Backspace" && !isReadOnly && selection.anchor !== null && selection.active !== null) {
        const from = Math.min(selection.anchor, selection.active);
        const to = Math.max(selection.anchor, selection.active);
        const entries = unifiedRows.slice(from, to + 1).map((r) => ({
          rowKey: r.rowKey,
          source: r.source,
          pk: r.source === "server"
            ? buildRowKeyFromRow(r.cells, tableData.columns.map((c) => c.name), pkColumns)
            : undefined,
          currentlyDeleted: buffer.isRowDeleted(r.rowKey),
        }));
        buffer.bulkDeleteToggle(entries);
      }
      // Undo (§19.4 buffer semantics)
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        buffer.undo();
      }
      // ⌘R / Ctrl+R → Reload the current table query (Data subtab only).
      // Skip when focus is inside a CodeMirror surface.
      if (active && (e.metaKey || e.ctrlKey) && e.key === "r" && !e.shiftKey && !e.altKey) {
        if ((e.target as HTMLElement | null)?.closest(".cm-editor")) return;
        e.preventDefault();
        tableData.refresh();
      }
    },
    [active, selection, isReadOnly, unifiedRows, tableData, pkColumns, buffer],
  );

  // ⌘S → apply the dirty buffer regardless of focus position (issue #88).
  useSaveShortcut({ active, rootRef, onSave: handleApply });

  // §18.8 — Empty state discrimination
  const tableIsEmpty = tableData.isReady && tableData.rows.length === 0 && !buffer.hasDirty;
  const hasActiveFilter = tableData.filterModel.rows.filter((r) => r.enabled).length > 0;
  const emptyBecauseFilter = tableIsEmpty && hasActiveFilter;

  const pendingCount =
    buffer.dirtyCounts.updates + buffer.dirtyCounts.inserts + buffer.dirtyCounts.deletes;

  return (
    <div
      ref={rootRef}
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

        {/* Subtab toggle — rendered below; spacer for layout */}

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
              {applying ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : null}
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

      {/* Subtab header */}
      <SubtabHeader
        active={subtab}
        onChange={setSubtab}
        filterBarVisible={filterVisible}
        onFilterToggle={subtab === "data" ? () => setFilterVisible((v) => !v) : undefined}
        visibleTabs={visibleTabs}
        onReload={tableData.refresh}
        reloadDisabled={tableData.isLoading}
        reloading={tableData.isLoading}
      />

      {/* Apply error banner */}
      {applyError && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            background: "rgba(var(--danger-rgb, 239,68,68), 0.1)",
            color: "var(--danger)",
            fontSize: 12,
            flexShrink: 0,
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span style={{ flex: 1 }}>{applyError}</span>
          <button
            type="button"
            onClick={() => setApplyError(null)}
            style={{ background: "transparent", border: 0, cursor: "pointer", color: "inherit" }}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* §19.5 — No-PK banner (shown below toolbar) */}
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
          No primary key — existing rows cannot be edited or deleted via {APP_DISPLAY_NAME}
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

      {/* Structure subtab — full-height replacement */}
      {subtab === "structure" && (
        <StructureSubtab
          connectionId={connectionId}
          schema={schema}
          relation={relation}
          relationKind={relationKind}
          cache={structureCache}
          columnNotes={columnNotes}
        />
      )}

      {/* Raw DDL subtab — full-height replacement */}
      {subtab === "raw" && (
        <RawSubtab
          schema={schema}
          relation={relation}
          cache={structureCache}
        />
      )}

      {/* Docs subtab — full-height replacement */}
      {subtab === "docs" && docsAvailable && (
        <DocsSubtab
          connectionId={connectionId}
          contextPath={contextPath}
          identity={identity}
        />
      )}

      {/* Filter bar — data subtab only */}
      {subtab === "data" && filterVisible && (
        <div style={{ flexShrink: 0, borderBottom: "1px solid var(--border)" }}>
          <FilterBar
            columns={tableData.columns}
            model={tableData.filterModel}
            onChange={tableData.setFilterModel}
            onApply={tableData.refresh}
          />
        </div>
      )}

      {/* Main content area — data subtab only */}
      {subtab !== "data" ? null : (
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
        {!tableData.isLoading && !tableData.error && (tableData.isReady || unifiedRows.length > 0) && (
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
      )}

      {/* Bottom bar — only show for data subtab */}
      {subtab !== "data" ? null : (
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
        {tableData.queryMs !== null && (
          <span>{tableData.queryMs}ms</span>
        )}

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
      )}

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
