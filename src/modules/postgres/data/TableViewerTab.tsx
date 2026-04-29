import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { TabRegistry } from "@/platform/shell/tabs/TabRegistry";
import type { Tab } from "@/platform/shell/tabs/types";
import { AppError } from "@/platform/errors/AppError";
import { dataApi } from "./api";
import { BottomBar } from "./BottomBar";
import { DataGrid } from "./DataGrid";
import { Inspector } from "./Inspector";
import { useInspectorWidth } from "./useInspectorWidth";
import { usePageSize } from "./usePageSize";
import { useTableData } from "./useTableData";
import type { Filter, OrderBy, RelationKind } from "./types";
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
  const { connectionId, schema, relation } = tab.payload;
  return (
    <TableViewer
      connectionId={connectionId}
      schema={schema}
      relation={relation}
    />
  );
}

interface TableViewerProps {
  connectionId: string;
  schema: string;
  relation: string;
}

function TableViewer({ connectionId, schema, relation }: TableViewerProps) {
  const [orderBy, setOrderBy] = useState<OrderBy[]>([]);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);

  const { pageSize, setPageSize, options: pageSizeOptions } = usePageSize(
    connectionId,
    schema,
    relation,
  );
  const { width: inspectorWidth, setWidth, min, max } = useInspectorWidth();

  const data = useTableData({
    connectionId,
    schema,
    relation,
    pageSize,
    orderBy,
    filters,
  });

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
    return data.rows[selectedRow] ?? null;
  }, [selectedRow, data.rows]);

  const isFirstLoad =
    data.status === "loading-first" || data.status === "loading-first-retrying";
  const showFirstError = data.status === "error";

  return (
    <div className={styles.root}>
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
              rows={data.rows}
              pageSize={pageSize}
              orderBy={orderBy}
              filters={filters}
              status={data.status}
              nextError={data.error}
              reachedEnd={data.reachedEnd}
              selectedRowIndex={selectedRow}
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
          <Inspector columns={data.columns} row={selectedRowData} />
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
        onPageSizeChange={setPageSize}
        onCountRows={onCountRows}
        onClearFilters={() => setFilters([])}
      />
    </div>
  );
}

TabRegistry.register(POSTGRES_TABLE_DATA_KIND, TableViewerTab);
