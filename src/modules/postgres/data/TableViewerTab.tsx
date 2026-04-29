import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { TabRegistry } from "@/platform/shell/tabs/TabRegistry";
import { useTabs } from "@/platform/shell/tabs/TabsContext";
import { useCloseConfirm } from "@/platform/shell/tabs/useCloseConfirm";
import type { Tab } from "@/platform/shell/tabs/types";
import { AppError } from "@/platform/errors/AppError";
import { useActiveConnections } from "../useActiveConnections";
import { dataApi } from "./api";
import { BottomBar } from "./BottomBar";
import { DataGrid } from "./DataGrid";
import { DiscardChangesDialog } from "./DiscardChangesDialog";
import { Inspector } from "./Inspector";
import { useEditBuffer, buildRowKey } from "./useEditBuffer";
import { useInspectorWidth } from "./useInspectorWidth";
import { usePageSize } from "./usePageSize";
import { useTableData } from "./useTableData";
import { useTablePrimaryKey } from "./useTablePrimaryKey";
import type {
  CellValue,
  EditValue,
  Filter,
  OrderBy,
  RelationKind,
} from "./types";
import styles from "./TableViewerTab.module.css";

export const POSTGRES_TABLE_DATA_KIND = "postgres-table-data";

export interface PostgresTableDataPayload {
  connectionId: string;
  connectionName: string;
  schema: string;
  relation: string;
  relationKind: RelationKind;
}

function isPayload(v: unknown): v is PostgresTableDataPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.connectionId === "string" &&
    typeof o.connectionName === "string" &&
    typeof o.schema === "string" &&
    typeof o.relation === "string" &&
    (o.relationKind === "table" ||
      o.relationKind === "view" ||
      o.relationKind === "materialized-view")
  );
}

function TableViewerTab({ tab }: { tab: Tab }) {
  if (!isPayload(tab.payload)) {
    return <div className={styles.firstLoad}>Invalid table viewer payload.</div>;
  }
  const { connectionId, schema, relation, relationKind } = tab.payload;
  return (
    <TableViewer
      tabId={tab.id}
      connectionId={connectionId}
      schema={schema}
      relation={relation}
      relationKind={relationKind}
    />
  );
}

interface TableViewerProps {
  tabId: string;
  connectionId: string;
  schema: string;
  relation: string;
  relationKind: RelationKind;
}

function TableViewer({ tabId, connectionId, schema, relation, relationKind }: TableViewerProps) {
  const [orderBy, setOrderBy] = useState<OrderBy[]>([]);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);

  const { pageSize, setPageSize, options: pageSizeOptions } = usePageSize(
    connectionId,
    schema,
    relation,
  );
  const { width: inspectorWidth, setWidth, min, max } = useInspectorWidth();

  const { getActive } = useActiveConnections();
  const isReadOnly = getActive(connectionId)?.read_only ?? false;

  // PK + enum metadata (one fetch per (conn, schema, relation)).
  const pkLookup = useTablePrimaryKey(connectionId, schema, relation);
  const pkColumns = pkLookup.metadata?.pk_columns ?? null;
  const enumValuesByColumn = pkLookup.metadata?.enums ?? {};

  const data = useTableData({
    connectionId,
    schema,
    relation,
    pageSize,
    orderBy,
    filters,
  });

  // Edit buffer (per-tab; survives in-memory re-renders).
  const buffer = useEditBuffer();

  // Insert rows that the user has typed but not committed. We keep these in
  // a parallel list so the grid can render them at the top while the
  // server-side `data.rows` stays untouched.
  const insertRowKeys = useMemo(() => {
    const out: string[] = [];
    for (const [k, e] of buffer.rows) {
      if (e.kind === "insert") out.push(k);
    }
    return out;
  }, [buffer.rows]);

  // Rebuild the unified row list when buffer or server data changes.
  const unifiedRows = useMemo<Array<{ rowKey: string; cells: CellValue[]; source: "insert" | "server" }>>(() => {
    const out: Array<{ rowKey: string; cells: CellValue[]; source: "insert" | "server" }> = [];
    // Inserts at top.
    if (data.columns.length > 0) {
      for (const k of insertRowKeys) {
        const e = buffer.rows.get(k);
        if (!e) continue;
        const cells: CellValue[] = data.columns.map((c) => {
          const v = e.changes[c.name];
          return v === undefined ? null : (v as CellValue);
        });
        out.push({ rowKey: k, cells, source: "insert" });
      }
    }
    // Then server rows. We pre-compute their RowKeys based on PK if available.
    if (pkColumns && data.rows.length > 0) {
      for (const row of data.rows) {
        const pk: Record<string, EditValue> = {};
        for (const col of pkColumns) {
          const idx = data.columns.findIndex((c) => c.name === col);
          if (idx >= 0) pk[col] = (row[idx] ?? null) as EditValue;
        }
        out.push({ rowKey: buildRowKey(pk), cells: row, source: "server" });
      }
    } else {
      // No PK or no data → server rows still render but don't get edit-buffer hooks.
      for (const row of data.rows) {
        out.push({ rowKey: "", cells: row, source: "server" });
      }
    }
    return out;
  }, [data.rows, data.columns, buffer.rows, insertRowKeys, pkColumns]);

  // Reset row selection whenever the buffer rebuilds.
  useEffect(() => {
    setSelectedRow(null);
  }, [pageSize, orderBy, filters, connectionId, schema, relation]);

  // Count rows: lazy, on demand. Invalidates whenever filters change.
  const [totalRows, setTotalRows] = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);
  const [countError, setCountError] = useState<string | null>(null);
  useEffect(() => {
    setTotalRows(null);
    setCountError(null);
  }, [filters, connectionId, schema, relation]);

  const onCountRows = useCallback(() => {
    setCountLoading(true);
    setCountError(null);
    dataApi
      .countTable(connectionId, schema, relation, filters.length ? filters : undefined, "user")
      .then((res) => {
        setTotalRows(res.count);
      })
      .catch((e) => {
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        setCountError(err.message);
      })
      .finally(() => setCountLoading(false));
  }, [connectionId, schema, relation, filters]);

  // Resizable inspector: drag from its left edge.
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  const onHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragState.current = { startX: e.clientX, startWidth: inspectorWidth };
      const move = (ev: MouseEvent) => {
        if (!dragState.current) return;
        const delta = dragState.current.startX - ev.clientX;
        const next = dragState.current.startWidth + delta;
        setWidth(Math.max(min, Math.min(max, next)));
      };
      const up = () => {
        dragState.current = null;
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [inspectorWidth, max, min, setWidth],
  );

  const selectedRowData = useMemo(() => {
    if (selectedRow === null) return null;
    const r = unifiedRows[selectedRow];
    return r ? r.cells : null;
  }, [selectedRow, unifiedRows]);

  const selectedRowKey = useMemo(() => {
    if (selectedRow === null) return null;
    return unifiedRows[selectedRow]?.rowKey ?? null;
  }, [selectedRow, unifiedRows]);

  const isFirstLoad =
    data.status === "loading-first" || data.status === "loading-first-retrying";
  const showFirstError = data.status === "error";

  // Save flow: apply directly (no preview modal). Errors land on a
  // dismissable banner above the grid.
  const [saveError, setSaveError] = useState<{ message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const tabs = useTabs();

  const onSave = useCallback(() => {
    if (!buffer.hasDirty) return;
    if (saving) return;
    const edits = buffer.toEditOps();
    setSaving(true);
    setSaveError(null);
    dataApi
      .applyTableEdits(connectionId, schema, relation, edits, "user")
      .then((outcome) => {
        if (outcome.outcome === "ok") {
          buffer.commitSuccess();
          // Re-fetch the first page so the user sees committed values. A
          // surgical row-replace honoring `refreshed_rows` is a follow-up.
          data.retryFirstPage();
        } else {
          // Op-level failure: show a banner with `Op #N failed: [code] message`
          // (1-based for users); buffer stays intact so the user can correct.
          const code = outcome.code ? `[${outcome.code}] ` : "";
          setSaveError({
            message: `Op #${outcome.failed_op_index + 1} failed: ${code}${outcome.message}`,
          });
        }
      })
      .catch((e) => {
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        setSaveError({ message: err.message });
      })
      .finally(() => setSaving(false));
  }, [buffer, connectionId, schema, relation, data, saving]);

  // Discard close: confirm when buffer has dirty entries.
  useCloseConfirm(
    tabId,
    useCallback(async () => {
      if (!buffer.hasDirty) return true;
      setShowDiscardConfirm(true);
      // Resolve `false` so TabStrip's close is cancelled. The user
      // re-confirms via the dialog, which calls tabs.close directly.
      return false;
    }, [buffer.hasDirty]),
  );

  function discardAndClose() {
    buffer.clear();
    setShowDiscardConfirm(false);
    tabs.close(tabId);
  }

  // Keyboard shortcuts at the tab root.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Only respond when this tab's root has focus or contains the active
      // element. Otherwise typing in an inspector field triggers ⌘S.
      const root = rootRef.current;
      if (!root) return;
      if (!root.contains(document.activeElement)) return;
      // ⌘S → save (open preview)
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        onSave();
      }
      // ⌘Z → undo (only when buffer has entries; don't swallow text-edit undo
      // when the active element is an input/textarea/select).
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        const tag = (document.activeElement as HTMLElement | null)?.tagName ?? "";
        if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
          if (buffer.hasDirty) {
            e.preventDefault();
            buffer.undo();
          }
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSave, buffer]);

  function onAddRow() {
    if (isReadOnly) return;
    if (relationKind !== "table") return; // Views/mat-views: no insert.
    buffer.addInsertRow({});
    // Select the newly inserted row (it appears first).
    setSelectedRow(0);
  }

  return (
    <div className={styles.root} ref={rootRef} tabIndex={-1}>
      {showFirstError && (
        <div className={styles.errorBanner}>
          <span>{data.error?.message ?? "Failed to load table."}</span>
          <button
            type="button"
            className={styles.retryBtn}
            onClick={data.retryFirstPage}
          >
            Retry
          </button>
        </div>
      )}
      {saveError && (
        <div className={styles.errorBanner} role="alert">
          <span>{saveError.message}</span>
          <button
            type="button"
            className={styles.retryBtn}
            aria-label="Dismiss save error"
            onClick={() => setSaveError(null)}
          >
            <X size={11} strokeWidth={2.5} />
          </button>
        </div>
      )}
      <div className={styles.body}>
        <div className={styles.gridArea}>
          {isFirstLoad ? (
            <div className={styles.firstLoad}>
              <span className={styles.spinner}>
                <Loader2 size={14} />
              </span>
              {data.status === "loading-first-retrying"
                ? "Slow — retrying…"
                : "Loading table…"}
            </div>
          ) : (
            <DataGrid
              columns={data.columns}
              rows={unifiedRows}
              pageSize={pageSize}
              orderBy={orderBy}
              filters={filters}
              status={data.status}
              nextError={data.error}
              reachedEnd={data.reachedEnd}
              selectedRowIndex={selectedRow}
              isReadOnly={isReadOnly}
              pkColumns={pkColumns}
              enumValuesByColumn={enumValuesByColumn}
              buffer={buffer}
              onSelectRow={setSelectedRow}
              onSortChange={setOrderBy}
              onFiltersChange={setFilters}
              onLoadNextPage={data.loadNextPage}
              onRetryNextPage={data.retryNextPage}
            />
          )}
        </div>
        <button
          type="button"
          className={styles.handle}
          aria-label="Resize inspector"
          onMouseDown={onHandleMouseDown}
        />
        <div
          className={styles.inspector}
          style={{ width: inspectorWidth, flex: `0 0 ${inspectorWidth}px` }}
        >
          <Inspector
            columns={data.columns}
            row={selectedRowData}
            rowKey={selectedRowKey}
            isReadOnly={isReadOnly}
            pkColumns={pkColumns}
            enumValuesByColumn={enumValuesByColumn}
            buffer={buffer}
          />
        </div>
      </div>
      <BottomBar
        rowsLoaded={data.rows.length}
        highestLoadedPage={data.highestLoadedPage}
        pageSize={pageSize}
        pageSizeOptions={pageSizeOptions}
        totalRows={totalRows}
        countLoading={countLoading}
        countError={countError}
        queryMs={data.queryMs}
        filterCount={filters.length}
        reachedEnd={data.reachedEnd}
        editable={!isReadOnly && relationKind === "table"}
        canInsert={!isReadOnly && relationKind === "table"}
        readOnlyBanner={isReadOnly}
        noPkBanner={!isReadOnly && relationKind === "table" && pkColumns === null}
        dirtyCount={
          buffer.dirtyCounts.updates +
          buffer.dirtyCounts.inserts +
          buffer.dirtyCounts.deletes
        }
        onPageSizeChange={setPageSize}
        onCountRows={onCountRows}
        onClearFilters={() => setFilters([])}
        onAddRow={onAddRow}
        onSave={onSave}
      />
      {showDiscardConfirm && (
        <DiscardChangesDialog
          count={
            buffer.dirtyCounts.updates +
            buffer.dirtyCounts.inserts +
            buffer.dirtyCounts.deletes
          }
          onCancel={() => setShowDiscardConfirm(false)}
          onDiscard={discardAndClose}
        />
      )}
    </div>
  );
}

TabRegistry.register(POSTGRES_TABLE_DATA_KIND, TableViewerTab);
