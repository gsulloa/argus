import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { TabRegistry } from "@/platform/shell/tabs/TabRegistry";
import { useTabs } from "@/platform/shell/tabs/TabsContext";
import { useCloseConfirm } from "@/platform/shell/tabs/useCloseConfirm";
import { useDirtySummary } from "@/platform/shell/tabs/useDirtySummary";
import type { Tab } from "@/platform/shell/tabs/types";
import { AppError } from "@/platform/errors/AppError";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { useSaveShortcut } from "@/platform/shell/useSaveShortcut";
import { useContextObjects, useContextObject } from "@/modules/context/hooks";
import { DocsSubtab } from "@/modules/context/components/DocsSubtab";
import { useActiveConnections } from "../useActiveConnections";
import { openQueryTab } from "../sql/openQueryTab";
import { dataApi } from "./api";
import { BottomBar } from "./BottomBar";
import { DataGrid, type DataGridHandle } from "./DataGrid";
import { DiscardChangesDialog } from "./DiscardChangesDialog";
import { FilterBar } from "./filter-bar/FilterBar";
import { compilePrefilledSelect } from "./filter-bar/compileWhere";
import { Inspector } from "./Inspector";
import { useEditBuffer, buildRowKey } from "./useEditBuffer";
import { useInspectorWidth } from "./useInspectorWidth";
import { useFilterBarVisible } from "./useFilterBarVisible";
import { useFilterRootCombinator } from "./useFilterRootCombinator";
import { usePageSize } from "./usePageSize";
import { useTableData } from "./useTableData";
import { useTableFilter } from "./useTableFilter";
import { useTableOrderBy } from "./useTableOrderBy";
import { useTablePrimaryKey } from "./useTablePrimaryKey";
import { RawSubtab } from "../structure/RawSubtab";
import { StructureSubtab } from "../structure/StructureSubtab";
import {
  SubtabHeader,
  type Subtab,
} from "../structure/SubtabHeader";
import { useTableStructureCache } from "../structure/useTableStructureCache";
import {
  isCompleteRow,
  modelToPayload,
  type CellValue,
  type EditValue,
  type RelationKind,
} from "./types";
import type { FilterBarHandle } from "../../shared/filter-bar";
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

function TableViewerTab({ tab, active }: { tab: Tab; active: boolean }) {
  if (!isPayload(tab.payload)) {
    return <div className={styles.firstLoad}>Invalid table viewer payload.</div>;
  }
  const { connectionId, connectionName, schema, relation, relationKind } =
    tab.payload;
  return (
    <TableViewer
      tabId={tab.id}
      connectionId={connectionId}
      connectionName={connectionName}
      schema={schema}
      relation={relation}
      relationKind={relationKind}
      active={active}
    />
  );
}

export interface TableViewerProps {
  tabId: string;
  connectionId: string;
  connectionName: string;
  schema: string;
  relation: string;
  relationKind: RelationKind;
  active?: boolean;
}

export function TableViewer({
  tabId,
  connectionId,
  connectionName,
  schema,
  relation,
  relationKind,
  active = true,
}: TableViewerProps) {
  const {
    draft,
    applied,
    isLoaded: filterLoaded,
    setDraft,
    setApplied,
    reset: resetFilter,
  } = useTableFilter(connectionId, schema, relation);

  // Persisted filter-bar visibility (hidden by default, per D1).
  const [filterBarVisible, setFilterBarVisible] = useFilterBarVisible(
    connectionId,
    schema,
    relation,
  );

  // Persisted root combinator (AND / OR, default AND, per D5).
  const [filterRootCombinator, setFilterRootCombinator] = useFilterRootCombinator(
    connectionId,
    schema,
    relation,
  );

  const {
    orderBy,
    isLoaded: orderByLoaded,
    setOrderBy,
  } = useTableOrderBy(connectionId, schema, relation);
  const [selection, setSelection] = useState<{ anchor: number | null; active: number | null }>({
    anchor: null,
    active: null,
  });
  const [activeCell, setActiveCell] = useState<{ row: number; col: number } | null>(null);
  const [activeSubtab, setActiveSubtab] = useState<Subtab>("data");
  // Monotonically-advancing token incremented on every Apply gesture so that
  // re-applying a structurally-identical filter model still triggers a refetch.
  const [applyToken, setApplyToken] = useState(0);

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

  // Full object doc — consumed by both DocsSubtab and column-notes decoration.
  // Only fetches when this specific object is documented.
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

  // Snap back to "data" when navigating to a relation that has no doc
  useEffect(() => {
    if (activeSubtab === "docs" && !docsAvailable) {
      setActiveSubtab("data");
    }
  }, [activeSubtab, docsAvailable]);

  const visibleTabs: Subtab[] = docsAvailable
    ? ["data", "structure", "raw", "docs"]
    : ["data", "structure", "raw"];
  const structureCache = useTableStructureCache(connectionId, schema, relation);

  const { pageSize, setPageSize, options: pageSizeOptions } = usePageSize(
    connectionId,
    schema,
    relation,
  );
  const { width: inspectorWidth, setWidth, min, max } = useInspectorWidth();

  const { getActive } = useActiveConnections();
  const isReadOnly = getActive(connectionId)?.read_only ?? false;

  // Seed draft.combinator from the persisted value once the filter is loaded.
  // This ensures the bar opens with the last-used combinator even if the
  // draft was persisted before the combinator setting existed.
  useEffect(() => {
    if (!filterLoaded) return;
    // Only seed if the draft combinator differs from persisted, to avoid
    // spurious writes when they already agree.
    if (draft.combinator !== filterRootCombinator) {
      setDraft({ ...draft, combinator: filterRootCombinator });
    }
    // Run only on initial load (filterLoaded transition) and relation change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterLoaded, connectionId, schema, relation]);

  // When draft.combinator changes (e.g. via Apply All chevron menu), persist it.
  useEffect(() => {
    if (!filterLoaded) return;
    if (draft.combinator !== filterRootCombinator) {
      setFilterRootCombinator(draft.combinator);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.combinator, filterLoaded]);

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
    applied,
    enabled: filterLoaded && orderByLoaded,
    applyToken,
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

  // Reset row selection and active cell whenever sort/filter/pageSize/relation changes.
  useEffect(() => {
    setSelection({ anchor: null, active: null });
    setActiveCell(null);
  }, [pageSize, orderBy, applied, connectionId, schema, relation]);

  // Count rows: lazy, on demand. Invalidates whenever filters change.
  const [totalRows, setTotalRows] = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);
  const [countError, setCountError] = useState<string | null>(null);
  useEffect(() => {
    setTotalRows(null);
    setCountError(null);
  }, [applied, connectionId, schema, relation]);

  const onCountRows = useCallback(() => {
    setCountLoading(true);
    setCountError(null);
    dataApi
      .countTable(connectionId, schema, relation, modelToPayload(applied), "user")
      .then((res) => {
        setTotalRows(res.count);
      })
      .catch((e) => {
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        setCountError(err.message);
      })
      .finally(() => setCountLoading(false));
  }, [connectionId, schema, relation, applied]);

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

  // Derive the array of selected rows (raw selection range, pre-filter).
  const selectedRows = useMemo(() => {
    if (selection.anchor === null) return [];
    const lo = Math.min(selection.anchor, selection.active ?? selection.anchor);
    const hi = Math.max(selection.anchor, selection.active ?? selection.anchor);
    const out: Array<{
      rowKey: string;
      row: CellValue[];
      pk: Record<string, EditValue>;
      source: "insert" | "server";
      isDeleted: boolean;
    }> = [];
    for (let i = lo; i <= hi; i++) {
      const r = unifiedRows[i];
      if (!r) continue;
      const pk: Record<string, EditValue> = {};
      if (pkColumns && r.source === "server") {
        for (const col of pkColumns) {
          const idx = data.columns.findIndex((c) => c.name === col);
          if (idx >= 0) pk[col] = (r.cells[idx] ?? null) as EditValue;
        }
      }
      out.push({
        rowKey: r.rowKey,
        row: r.cells,
        pk,
        source: r.source,
        isDeleted: r.rowKey ? buffer.isRowDeleted(r.rowKey) : false,
      });
    }
    return out;
  }, [selection, unifiedRows, pkColumns, data.columns, buffer]);

  // Count of eligible rows for bulk-edit (server, not deleted, has rowKey).
  const eligibleCount = useMemo(
    () =>
      selectedRows.filter(
        (r) => r.source === "server" && !r.isDeleted && r.rowKey,
      ).length,
    [selectedRows],
  );

  // Bulk-edit is active when >= 2 eligible server rows are selected and relation has a PK.
  const bulkEditActive = eligibleCount >= 2 && pkColumns !== null;

  // Whether bulk editing is structurally possible (writable + has PK).
  const bulkEditAvailable = !isReadOnly && pkColumns !== null;

  // Derived selection count for the BottomBar chip.
  const selectedCount =
    selection.anchor === null
      ? 0
      : Math.abs((selection.active ?? selection.anchor) - selection.anchor) + 1;

  // `idle` covers the brief window between mount and the first-page fetch
  // firing — including the case where we've deferred the fetch via
  // `enabled` until persisted filter/orderBy have loaded.
  const isFirstLoad =
    data.status === "idle" ||
    data.status === "loading-first" ||
    data.status === "loading-first-retrying";
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

  // Publish a dirty-summary entry while the buffer holds uncommitted edits, so
  // the disconnect-confirmation dialog can name what would be lost.
  useDirtySummary(
    tabId,
    buffer.hasDirty
      ? { connectionId, label: `${schema}.${relation}` }
      : null,
  );

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

  // Reload: bump applyToken to unconditionally refetch the current first page
  // while preserving the applied filter model, sort order, and page size.
  const onReload = useCallback(() => setApplyToken((t) => t + 1), []);

  // Keyboard shortcuts at the tab root. Only attach when this tab is active
  // so multiple mounted tabs don't double-fire window-level shortcuts.
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Ref to the FilterBar imperative handle for ⌘F keyboard shortcut.
  const filterBarRef = useRef<FilterBarHandle>(null);
  // Ref to the DataGrid imperative handle — used by `onAddRow` to scroll the
  // viewport to the top so the newly inserted row at index 0 is visible.
  const gridRef = useRef<DataGridHandle | null>(null);
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      // Only respond when this tab's root has focus or contains the active
      // element. Otherwise typing in an inspector field triggers ⌘S.
      const root = rootRef.current;
      if (!root) return;
      if (!root.contains(document.activeElement)) return;
      // ⌘1 / ⌘2 / ⌘3 / ⌘4 → sub-tab switching. Skip when focus is in an editable
      // surface (input/textarea/CodeMirror) so the user's typing isn't stolen.
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "1" || e.key === "2" || e.key === "3" || e.key === "4")
      ) {
        const focused = document.activeElement as HTMLElement | null;
        const tag = focused?.tagName ?? "";
        const isEditable =
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          (focused?.closest(".cm-editor") ?? null) !== null;
        if (!isEditable) {
          e.preventDefault();
          if (e.key === "1") {
            setActiveSubtab("data");
          } else if (e.key === "2") {
            setActiveSubtab("structure");
          } else if (e.key === "3") {
            setActiveSubtab("raw");
          } else if (e.key === "4" && docsAvailable) {
            setActiveSubtab("docs");
          }
        }
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
      // ⌘R / Ctrl+R → Reload the current table query (Data subtab only).
      // Skip when focus is inside a CodeMirror surface (editor action may be bound there).
      if ((e.metaKey || e.ctrlKey) && e.key === "r" && !e.shiftKey && !e.altKey) {
        if (document.activeElement?.closest(".cm-editor")) return;
        e.preventDefault();
        onReload();
      }
      // ⌘F / Ctrl+F → D2 state machine (Data subtab only).
      // hidden + focus outside → show + focus first row.
      // visible + focus outside → focus first row.
      // visible + focus inside → hide (preserve draft).
      // Skip when focus is inside a CodeMirror surface so its ⌘F search opens.
      if ((e.metaKey || e.ctrlKey) && e.key === "f" && !e.shiftKey && !e.altKey) {
        const focused = document.activeElement as HTMLElement | null;
        if (focused?.closest(".cm-editor")) return;
        if (activeSubtab !== "data") return;
        e.preventDefault();
        // Detect focus-inside-bar by checking if the active element is inside
        // the element with data-filter-bar-root (the FilterBar's root wrapper).
        const barRootEl = root.querySelector("[data-filter-bar-root]") as HTMLElement | null;
        const focusInsideBar = barRootEl
          ? barRootEl.contains(document.activeElement)
          : false;
        if (!filterBarVisible) {
          // hidden → show + focus
          setFilterBarVisible(true);
          requestAnimationFrame(() => filterBarRef.current?.focus());
        } else if (focusInsideBar) {
          // visible + focused inside → hide
          setFilterBarVisible(false);
        } else {
          // visible + focus outside → focus first row
          filterBarRef.current?.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, buffer, activeSubtab, filterBarVisible, setFilterBarVisible, onReload]);

  // ⌘S → save the dirty buffer regardless of focus position within the tab
  // (issue #88). Shared with the MySQL / MSSQL viewers.
  useSaveShortcut({ active, rootRef, onSave });

  function onAddRow() {
    if (isReadOnly) return;
    if (relationKind !== "table") return; // Views/mat-views: no insert.
    buffer.addInsertRow({});
    // Select the newly inserted row (it appears first); clear active cell.
    setSelection({ anchor: 0, active: 0 });
    setActiveCell(null);
    // Scroll the grid back to the top so the insert row is visible.
    gridRef.current?.scrollToTop();
  }

  const onApplyFilters = useCallback(() => {
    // Apply All: only enabled+complete rows.
    const enabledRows = draft.rows.filter((r) => r.enabled && isCompleteRow(r));
    setApplied({ rows: enabledRows, combinator: draft.combinator });
    setApplyToken((t) => t + 1);
  }, [draft, setApplied]);

  const onApplyOnlyRow = useCallback((index: number) => {
    const row = draft.rows[index];
    if (!row) return;
    setApplied({ rows: [row], combinator: draft.combinator });
    setApplyToken((t) => t + 1);
  }, [draft, setApplied]);

  const onResetFilters = useCallback(() => {
    resetFilter();
  }, [resetFilter]);

  const onClearFiltersFromBottomBar = useCallback(() => {
    onResetFilters();
  }, [onResetFilters]);

  const onOpenInSqlEditor = useCallback(() => {
    const sql = compilePrefilledSelect({
      schema,
      relation,
      model: applied,
      columns: data.columns,
      orderBy,
      limit: pageSize,
    });
    openQueryTab(tabs, { initialConnectionId: connectionId, initialConnectionName: connectionName, initialSql: sql });
  }, [
    schema,
    relation,
    applied,
    data.columns,
    orderBy,
    pageSize,
    tabs,
    connectionId,
    connectionName,
  ]);

  // Number of applied filter rows (used by BottomBar filter badge).
  const filterCount = useMemo(() => applied.rows.length, [applied]);

  return (
    <div className={styles.root} ref={rootRef} tabIndex={-1}>
      <SubtabHeader
        active={activeSubtab}
        onChange={setActiveSubtab}
        filterBarVisible={filterBarVisible}
        onFilterToggle={() => setFilterBarVisible(!filterBarVisible)}
        visibleTabs={visibleTabs}
        onReload={onReload}
        reloadDisabled={
          data.status === "loading-first" || data.status === "loading-first-retrying"
        }
        reloading={
          data.status === "loading-first" || data.status === "loading-first-retrying"
        }
      />
      {/* Data subtab: kept mounted so scroll/buffer/grid state survive subtab
          switches; visually hidden when inactive. Structure / Raw mount on
          first activation and unmount when switched away from (their state
          lives in the shared cache hook above). */}
      <div
        className={styles.dataSubtab}
        data-active={activeSubtab === "data"}
        aria-hidden={activeSubtab !== "data"}
      >
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
        {filterBarVisible && (
          <FilterBar
            ref={filterBarRef}
            draft={draft}
            applied={applied}
            columns={data.columns}
            onDraftChange={setDraft}
            onApplyAll={onApplyFilters}
            onApplyOnlyRow={onApplyOnlyRow}
            onSqlClick={onOpenInSqlEditor}
            onClose={() => setFilterBarVisible(false)}
          />
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
                ref={gridRef}
                columns={data.columns}
                rows={unifiedRows}
                pageSize={pageSize}
                orderBy={orderBy}
                status={data.status}
                nextError={data.error}
                reachedEnd={data.reachedEnd}
                selection={selection}
                activeCell={activeCell}
                bulkEditActive={bulkEditActive}
                isReadOnly={isReadOnly}
                pkColumns={pkColumns}
                enumValuesByColumn={enumValuesByColumn}
                buffer={buffer}
                connectionId={connectionId}
                schema={schema}
                relation={relation}
                onSelectionChange={setSelection}
                onActiveCellChange={setActiveCell}
                onSortChange={setOrderBy}
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
              selectedRows={selectedRows}
              bulkEditAvailable={bulkEditAvailable}
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
          filterCount={filterCount}
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
          selectedCount={selectedCount}
          onPageSizeChange={setPageSize}
          onCountRows={onCountRows}
          onClearFilters={onClearFiltersFromBottomBar}
          onAddRow={onAddRow}
          onSave={onSave}
          onClearSelection={() => setSelection({ anchor: null, active: null })}
        />
      </div>
      {activeSubtab === "structure" && (
        <StructureSubtab
          tabs={tabs}
          connectionId={connectionId}
          connectionName={connectionName}
          schema={schema}
          relation={relation}
          relkind={relationKind}
          cache={structureCache}
          columnNotes={columnNotes}
        />
      )}
      {activeSubtab === "raw" && (
        <RawSubtab
          schema={schema}
          relation={relation}
          cache={structureCache}
        />
      )}
      {activeSubtab === "docs" && docsAvailable && (
        <DocsSubtab
          connectionId={connectionId}
          contextPath={contextPath}
          identity={identity}
        />
      )}
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
