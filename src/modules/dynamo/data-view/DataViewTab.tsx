/**
 * DataViewTab — DynamoDB data view tab kind "dynamo-data-view".
 *
 * Orchestrates:
 *   - Toolbar (mode toggle, Run/Reset, page size, Count slot, Load more)
 *   - QueryBuilder (Scan vs Query, index picker, filter rows)
 *   - TabView / JsonView (virtualized results in Tabla or JSON mode)
 *   - MetadataView (reachable from toolbar "Metadata" button)
 *   - Inspector (resizable inspector dock)
 *   - BottomBar (items loaded, count result)
 *
 * Design decisions:
 *   (a) Does NOT auto-fetch on open — user must click Run. Rationale: the
 *       page size and mode are persisted, but the user may not have reviewed
 *       the metadata yet; surprising them with a Scan hitting AWS capacity is
 *       worse than requiring one click.
 *   (b) Metadata sub-view is toggled from a toolbar button ("Metadata") that
 *       replaces the results panel. It is NOT an overlay; it shares the same
 *       content area so the layout stays flat and predictable.
 *   (c) ⌘R/⌘⇧R uses useShortcuts with `whenInInput: true` so shortcuts fire
 *       from inside form controls. CodeMirror skipping: the hook's
 *       `isTypingTarget` already excludes `.cm-content` (contentEditable div)
 *       only when `whenInInput` is false. Since the shortcut fires from
 *       inputs, we need an explicit CodeMirror guard. We check whether the
 *       focused element is inside a `.cm-editor` container and bail out.
 *   (d) `needsCredentials` is derived from the persisted connection params
 *       (task 16.2): `connection.params.needs_credentials === true`. Controls
 *       (Run, Load more, Count, index, mode) are disabled while true. The
 *       Toolbar shows an inline "Connection waiting for credentials" notice.
 *   (e) `dynamo:credentials-refreshed:ui` auto-resume is handled by the
 *       `useDynamoItems` hook (task 16.1) — no extra logic needed here.
 *
 * Stable tab id: `dynamotbl:<connectionId>:<tableName>`
 * Tab kind: "dynamo-data-view"
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { TabRegistry } from "@/platform/shell/tabs/TabRegistry";
import { useShortcuts } from "@/platform/shell/useShortcuts";
import { useSetting } from "@/platform/settings/useSetting";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { DYNAMO_KIND } from "@/modules/dynamo/types";
import type { DynamoParams } from "@/modules/dynamo/types";
import { dynamoTablesApi } from "@/modules/dynamo/tables/api";
import type { TableDescription } from "@/modules/dynamo/tables/types";
import type { Tab } from "@/platform/shell/tabs/types";
import { useDynamoItems } from "./useDynamoItems";
import { useDynamoInspectorWidth } from "./useInspectorWidth";
import { useCount } from "./useCount";
import type { BuilderState, AttributeMap } from "./types";
import { Toolbar, type ViewMode } from "./Toolbar";
import { MetadataView } from "./MetadataView";
import { BottomBar } from "./BottomBar";
import { QueryBuilder } from "./QueryBuilder";
import { TabView } from "./TabView";
import { JsonView } from "./JsonView";
import { Inspector } from "./Inspector";
import styles from "./DataViewTab.module.css";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DYNAMO_DATA_VIEW_KIND = "dynamo-data-view";

// ---------------------------------------------------------------------------
// Payload type
// ---------------------------------------------------------------------------

export interface DynamoDataViewPayload {
  connectionId: string;
  connectionName: string;
  tableName: string;
  describe: TableDescription | null;
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isPayload(v: unknown): v is DynamoDataViewPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.connectionId === "string" &&
    typeof o.connectionName === "string" &&
    typeof o.tableName === "string" &&
    (o.describe === null || typeof o.describe === "object")
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if the focused element is inside a CodeMirror editor. */
function focusIsInCodeMirror(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  return el.closest(".cm-editor") !== null;
}

// ---------------------------------------------------------------------------
// DataViewRoot — registered renderer
// ---------------------------------------------------------------------------

function DataViewRoot({ tab, active }: { tab: Tab; active: boolean }) {
  if (!isPayload(tab.payload)) {
    return <div className={styles.invalid}>Invalid tab payload.</div>;
  }
  return <DataViewContent tab={tab} payload={tab.payload} active={active} />;
}

// ---------------------------------------------------------------------------
// DataViewContent — the actual tab body
// ---------------------------------------------------------------------------

interface DataViewContentProps {
  tab: Tab;
  payload: DynamoDataViewPayload;
  active: boolean;
}

function DataViewContent({ payload, active }: DataViewContentProps) {
  const { connectionId, connectionName: _connName, tableName } = payload;

  // ── Connection params — for needs_credentials (task 16.2) ─────────────────
  // Read from the persisted connection list so the flag is available even when
  // the active-connection envelope (listActive) doesn't expose it.
  const { items: allConnections } = useConnections();
  const needsCredentials = useMemo(() => {
    const conn = allConnections.find(
      (c) => c.id === connectionId && c.kind === DYNAMO_KIND,
    );
    if (!conn) return false;
    return (conn.params as unknown as DynamoParams).needs_credentials === true;
  }, [allConnections, connectionId]);

  // ── Describe state ─────────────────────────────────────────────────────────
  const [describe, setDescribe] = useState<TableDescription | null>(
    payload.describe,
  );
  const [describeLoading, setDescribeLoading] = useState(false);
  const [describeError, setDescribeError] = useState<string | null>(null);

  // Fetch describe on mount if not provided in the payload.
  const hasFetchedDescribe = useRef(false);
  useEffect(() => {
    if (hasFetchedDescribe.current) return;
    hasFetchedDescribe.current = true;
    if (payload.describe === null) {
      setDescribeLoading(true);
      dynamoTablesApi
        .describeTable({ connectionId, tableName, origin: "auto" })
        .then((val) => {
          setDescribe(val);
          setDescribeLoading(false);
        })
        .catch((e: unknown) => {
          const msg =
            e && typeof e === "object" && "message" in e
              ? String((e as { message: unknown }).message)
              : "Failed to load metadata";
          setDescribeError(msg);
          setDescribeLoading(false);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Settings — view mode (tabla/json) ──────────────────────────────────────
  const viewModeKey = `dynamoView:${connectionId}:${tableName}`;
  const [viewMode, setViewMode] = useSetting<ViewMode>(viewModeKey, "tabla");

  // ── Settings — page size ──────────────────────────────────────────────────
  const pageSizeKey = `dynamoLimit:${connectionId}:${tableName}`;
  const [pageSize, setPageSize] = useSetting<number>(pageSizeKey, 100);

  // ── Builder state ──────────────────────────────────────────────────────────
  const [builder, setBuilder] = useState<BuilderState>(() => ({
    mode: "scan",
    indexName: null,
    pageSize,
    consistentRead: false,
    scanIndexForward: true,
    filters: [],
  }));

  // ── Builder validity (used to disable Run in Toolbar) ─────────────────────
  // Scan mode is always valid; Query mode becomes invalid until PK is filled.
  const [builderValid, setBuilderValid] = useState(true);
  const [builderInvalidReason, setBuilderInvalidReason] = useState<string | undefined>();

  const handleValidityChange = useCallback((isValid: boolean, reason?: string) => {
    setBuilderValid(isValid);
    setBuilderInvalidReason(isValid ? undefined : reason);
  }, []);

  // Keep builder.pageSize in sync when the persisted setting loads.
  useEffect(() => {
    setBuilder((prev) => ({ ...prev, pageSize }));
  }, [pageSize]);

  // ── Inspector width ────────────────────────────────────────────────────────
  const { width: inspectorWidth, setWidth: setInspectorWidth, min: inspMin } =
    useDynamoInspectorWidth(connectionId, tableName);

  // ── Inspector selection ────────────────────────────────────────────────────
  // selectedRowIndex: index into items[] (stable across loadMore since items only grow)
  // selectedAttribute: attribute name to focus in inspector (null = full item)
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [_selectedAttribute, setSelectedAttribute] = useState<string | undefined>(undefined);

  const handleSelectRow = useCallback(
    (rowIndex: number, attribute?: string) => {
      setSelectedRowIndex(rowIndex);
      setSelectedAttribute(attribute);
    },
    [],
  );

  // ── Count state — owned by useCount (task 13.1–13.3) ────────────────────
  const {
    countLoading,
    countResult,
    triggerCount,
    clearCount,
  } = useCount(connectionId, tableName, builder, describe);

  // ── useDynamoItems ─────────────────────────────────────────────────────────
  // Hook requires a non-null describe. We defer the hook's actual invocation
  // by using a dummy describe until the real one loads. The hook is always
  // mounted (Rules of Hooks) but won't be called by the user until describe is
  // available (run button is only accessible once the tab is visible).
  const DUMMY_DESCRIBE: TableDescription = {
    table_name: tableName,
    table_arn: "",
    table_status: "ACTIVE",
    item_count: 0,
    table_size_bytes: 0,
    billing_mode: "PAY_PER_REQUEST",
    key_schema: [],
    attribute_definitions: [],
    global_secondary_indexes: [],
    local_secondary_indexes: [],
  };

  const {
    items,
    lastEvaluatedKey,
    count,
    status,
    error,
    run,
    loadMore,
    triggerAutoLoadMore,
    reset,
    autoScrollDisabled,
  } = useDynamoItems({
    connectionId,
    tableName,
    builder,
    describe: describe ?? DUMMY_DESCRIBE,
  });

  // Derived: selected item for the inspector (items only grows, index stable)
  const selectedItem: AttributeMap | null =
    selectedRowIndex !== null ? (items[selectedRowIndex] ?? null) : null;

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleRun = useCallback(() => {
    void run("user");
  }, [run]);

  const handleReset = useCallback(() => {
    setBuilder({
      mode: "scan",
      indexName: null,
      pageSize,
      consistentRead: false,
      scanIndexForward: true,
      filters: [],
    });
    reset();
    clearCount();
    // Reset selection when items are wiped.
    setSelectedRowIndex(null);
  }, [reset, pageSize, clearCount]);

  const handleLoadMore = useCallback(() => {
    void loadMore("user");
  }, [loadMore]);

  // Count is now fully owned by the useCount hook (task 13.1).
  // triggerCount has its own in-flight guard; we just pass it through.
  const handleCount = useCallback(() => {
    triggerCount();
  }, [triggerCount]);

  const handlePageSizeChange = useCallback(
    (next: number) => {
      setPageSize(next);
      setBuilder((prev) => ({ ...prev, pageSize: next }));
    },
    [setPageSize],
  );

  const handleBuilderChange = useCallback(
    (next: BuilderState) => {
      setBuilder(next);
      // Count auto-clear (task 13.3) is handled inside useCount via snapshot
      // comparison. No explicit clear needed here.
    },
    [],
  );

  // ── Resize handle for inspector ────────────────────────────────────────────

  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handleHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: inspectorWidth };
      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const delta = dragRef.current.startX - ev.clientX;
        setInspectorWidth(dragRef.current.startWidth + delta);
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [inspectorWidth, setInspectorWidth],
  );

  // ── Keyboard shortcuts — ⌘R / ⌘⇧R ─────────────────────────────────────────
  // Only fire when this tab is active, and NOT when focus is inside CodeMirror.
  // We use `whenInInput: true` so the shortcut fires from query-builder inputs.
  // The CodeMirror guard is an explicit check in the handler.

  useShortcuts(
    active
      ? [
          {
            key: "r",
            mod: true,
            shift: false,
            whenInInput: true,
            handler: () => {
              if (focusIsInCodeMirror()) return;
              handleRun();
            },
          },
          {
            key: "r",
            mod: true,
            shift: true,
            whenInInput: true,
            handler: () => {
              if (focusIsInCodeMirror()) return;
              handleReset();
            },
          },
        ]
      : [],
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  // Show loading spinner while describe is being fetched on mount.
  if (describeLoading && describe === null) {
    return (
      <div className={styles.root}>
        <div className={styles.loadingDescribe}>
          <Loader2 size={14} className={styles.spinner} />
          Loading table metadata…
        </div>
      </div>
    );
  }

  const isMetadataMode = viewMode === "metadata";

  return (
    <div className={styles.root}>
      <Toolbar
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        builder={builder}
        onBuilderChange={handleBuilderChange}
        status={status}
        lastEvaluatedKey={lastEvaluatedKey}
        onRun={handleRun}
        onReset={handleReset}
        onLoadMore={handleLoadMore}
        countLoading={countLoading}
        countResult={countResult}
        onCount={handleCount}
        needsCredentials={needsCredentials}
        pageSize={pageSize}
        onPageSizeChange={handlePageSizeChange}
        runDisabled={!builderValid}
        runDisabledReason={builderInvalidReason}
      />

      {describeError && (
        <div
          style={{
            padding: "8px 14px",
            fontSize: 11,
            color: "var(--danger)",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          Failed to load metadata: {describeError}
          <button
            type="button"
            style={{
              padding: "2px 7px",
              border: "1px solid var(--border-strong)",
              borderRadius: 3,
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 11,
              fontFamily: "inherit",
            }}
            onClick={() => {
              setDescribeLoading(true);
              setDescribeError(null);
              dynamoTablesApi
                .describeTable({ connectionId, tableName, origin: "user" })
                .then((val) => {
                  setDescribe(val);
                  setDescribeLoading(false);
                })
                .catch((e: unknown) => {
                  const msg =
                    e && typeof e === "object" && "message" in e
                      ? String((e as { message: unknown }).message)
                      : "Failed to load metadata";
                  setDescribeError(msg);
                  setDescribeLoading(false);
                });
            }}
          >
            Retry
          </button>
        </div>
      )}

      {isMetadataMode ? (
        <MetadataView
          connectionId={connectionId}
          tableName={tableName}
          initialDescribe={describe}
          describe={describe}
          onDescribeUpdated={setDescribe}
        />
      ) : (
        <div className={styles.body}>
          <div className={styles.mainArea}>
            {/* QueryBuilder */}
            {describe && (
              <QueryBuilder
                builder={builder}
                describe={describe}
                onBuilderChange={handleBuilderChange}
                onValidityChange={handleValidityChange}
                disabled={needsCredentials}
              />
            )}

            {/* Results panel — Tabla view / JSON view */}
            {viewMode === "tabla" ? (
              <TabView
                items={items}
                describe={describe}
                indexName={builder.indexName}
                selectedRowIndex={selectedRowIndex}
                onSelect={handleSelectRow}
                onLoadMore={triggerAutoLoadMore}
                hasMore={lastEvaluatedKey !== null}
                status={status}
                autoScrollDisabled={autoScrollDisabled}
              />
            ) : (
              <JsonView
                items={items}
                selectedRowIndex={selectedRowIndex}
                onSelect={(rowIndex) => handleSelectRow(rowIndex)}
                onLoadMore={triggerAutoLoadMore}
                hasMore={lastEvaluatedKey !== null}
                status={status}
                autoScrollDisabled={autoScrollDisabled}
                describe={describe}
                indexName={builder.indexName}
              />
            )}
          </div>

          {/* Inspector dock */}
          {inspectorWidth > inspMin && (
            <>
              <div
                className={styles.handle}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize inspector"
                onMouseDown={handleHandleMouseDown}
              />
              <div
                className={styles.inspectorDock}
                style={{ width: inspectorWidth }}
              >
                <Inspector
                  item={selectedItem}
                  describe={describe}
                  indexName={builder.indexName}
                  onClearSelection={() => setSelectedRowIndex(null)}
                />
              </div>
            </>
          )}
        </div>
      )}

      <BottomBar
        itemsLoaded={count}
        status={status}
        error={error}
        countResult={countResult}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper: open data view tab
// ---------------------------------------------------------------------------

import type { useTabs } from "@/platform/shell/tabs";

export function openDataViewTab(
  tabs: ReturnType<typeof useTabs>,
  opts: {
    connectionId: string;
    connectionName: string;
    tableName: string;
    describe: TableDescription | null;
  },
): string {
  const { connectionId, connectionName, tableName, describe } = opts;

  const payload: DynamoDataViewPayload = {
    connectionId,
    connectionName,
    tableName,
    describe,
  };

  return tabs.open({
    id: `dynamotbl:${connectionId}:${tableName}`,
    kind: DYNAMO_DATA_VIEW_KIND,
    title: tableName,
    payload,
    closable: true,
  });
}

// ---------------------------------------------------------------------------
// Side-effect: register tab kind with TabRegistry at module import time.
// The "dynamo-table-placeholder" kind was retired in Phase 9 (task 14.2);
// persisted records are migrated via migratePlaceholderTabs in migrateTabKinds.ts.
// ---------------------------------------------------------------------------

TabRegistry.register(DYNAMO_DATA_VIEW_KIND, DataViewRoot);
