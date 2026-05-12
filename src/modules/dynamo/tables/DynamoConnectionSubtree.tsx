/**
 * DynamoConnectionSubtree — sidebar subtree for a single active DynamoDB connection.
 *
 * Mounts under an active Dynamo connection row in ConnectionRow.tsx. The component:
 *   1. Subscribes to useDynamoTableCache(connectionId) — triggers initial listTables.
 *   2. Renders a search input (TableSearchInput) above the leaf list.
 *   3. Builds a flat TreeNode[] for SidebarTree (depth 1, no group nodes).
 *   4. Uses SidebarTree with virtualizationThreshold=500 and the shared sidebar scroll ref.
 *   5. Renders per-table badges via TableLeaf's renderLabel / renderBadge renderers.
 *   6. Renders the load-more affordance when tables.truncated === true (Task 8).
 *   7. Renders loading / error / ready states (Task 6.1).
 *   8. Drives the lazy describe pipeline: each rendered leaf calls requestDescribe
 *      on mount via TableLeaf's useEffect (Task 6.6).
 *   9. Wires leaf activation to open the dynamo-table-placeholder tab (Task 9.5).
 *  10. Per-leaf right-click context menu: Open, Copy table name, Copy ARN (Task 10).
 */

import * as ContextMenu from "@radix-ui/react-context-menu";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2, RotateCw } from "lucide-react";
import { SidebarTree, type TreeNode } from "@/platform/shell/SidebarTree";
import { useSidebarScrollRef } from "@/platform/shell/sidebarScroll";
import { useSetting } from "@/platform/settings/useSetting";
import { useTabs } from "@/platform/shell/tabs";
import { useActiveDynamoConnections } from "@/modules/dynamo/useActiveConnections";
import { useDynamoTableCache } from "./CacheProvider";
import type { DescribeSlot } from "./CacheProvider";
import { TableSearchInput } from "./TableSearchInput";
import { TableLeafLabel, TableLeafBadge } from "./TableLeaf";
import { openPlaceholderTab } from "./openPlaceholderTab";
import styles from "./DynamoConnectionSubtree.module.css";
import sidebarStyles from "@/platform/shell/Sidebar.module.css";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  connectionId: string;
  connectionName: string;
}

// ---------------------------------------------------------------------------
// Leaf node data payload
// ---------------------------------------------------------------------------

interface LeafData {
  tableName: string;
}

// ---------------------------------------------------------------------------
// Load-more state
// ---------------------------------------------------------------------------

type LoadMoreState = "idle" | "loading";

// ---------------------------------------------------------------------------
// DynamoConnectionSubtree
// ---------------------------------------------------------------------------

export function DynamoConnectionSubtree({ connectionId, connectionName }: Props) {
  const { tables, describe, refresh, loadMore, requestDescribe, retryDescribe } =
    useDynamoTableCache(connectionId);

  const sidebarScrollRef = useSidebarScrollRef();
  const tabs = useTabs();
  const { getActive } = useActiveDynamoConnections();

  // Context-menu state: which tableName was right-clicked
  const contextMenuTableRef = useRef<string>("");

  // --------------------------------------------------------------------------
  // Search state — persisted best-effort via useSetting
  // --------------------------------------------------------------------------
  const settingKey = `dynamoTablesSearch:${connectionId}`;
  const [persistedQuery, setPersistedQuery, settingLoaded] = useSetting<string>(
    settingKey,
    "",
  );
  // Use a local state seeded from persisted query once loaded. Stays responsive
  // on every keystroke without waiting for the async setting write.
  const [query, setQueryLocal] = useState<string>(() => persistedQuery);

  // Sync persisted value into local state once the setting has loaded (one-time).
  // We use a ref guard so we only apply this once.
  const [didSyncSetting, setDidSyncSetting] = useState(false);
  if (settingLoaded && !didSyncSetting && persistedQuery !== "") {
    setDidSyncSetting(true);
    setQueryLocal(persistedQuery);
  }

  const handleQueryChange = useCallback(
    (next: string) => {
      setQueryLocal(next);
      setPersistedQuery(next);
    },
    [setPersistedQuery],
  );

  // --------------------------------------------------------------------------
  // Load-more state
  // --------------------------------------------------------------------------
  const [loadMoreState, setLoadMoreState] = useState<LoadMoreState>("idle");

  const handleLoadMore = useCallback(async () => {
    if (loadMoreState === "loading") return;
    setLoadMoreState("loading");
    try {
      await loadMore();
    } finally {
      setLoadMoreState("idle");
    }
  }, [loadMore, loadMoreState]);

  // --------------------------------------------------------------------------
  // Filter + build tree nodes
  // --------------------------------------------------------------------------
  const allNames = useMemo<string[]>(
    () => (tables.status === "ready" ? tables.names : []),
    [tables],
  );

  const filteredNames = useMemo(() => {
    if (!query.trim()) return allNames;
    const needle = query.toLowerCase();
    return allNames.filter((n) => n.toLowerCase().includes(needle));
  }, [allNames, query]);

  // Build SidebarTree nodes (depth 1 — all leaves)
  const treeNodes = useMemo<TreeNode[]>(
    () =>
      filteredNames.map((name) => ({
        id: `dynamo:${connectionId}:table:${name}`,
        label: name,
        level: 0,
        hasChildren: false,
        data: { tableName: name } satisfies LeafData,
      })),
    [filteredNames, connectionId],
  );

  // --------------------------------------------------------------------------
  // Open-or-focus placeholder tab helper
  // --------------------------------------------------------------------------
  const openTable = useCallback(
    (tableName: string) => {
      const descSlot = describe.get(tableName);
      const cachedDescribe =
        descSlot?.status === "ready" ? descSlot.value : null;
      openPlaceholderTab(tabs, {
        connectionId,
        connectionName,
        tableName,
        describe: cachedDescribe,
      });
    },
    [tabs, connectionId, connectionName, describe],
  );

  // --------------------------------------------------------------------------
  // Render helpers for SidebarTree
  // --------------------------------------------------------------------------

  // renderLabel: highlighted table name. Also triggers requestDescribe on mount
  // (the lazy describe pipeline runs because only virtualized-visible rows mount).
  const renderLabel = useCallback(
    (node: TreeNode): ReactNode => {
      const data = node.data as LeafData;
      return (
        <TableLeafLabel
          tableName={data.tableName}
          searchQuery={query}
          requestDescribe={requestDescribe}
        />
      );
    },
    [query, requestDescribe],
  );

  // renderBadge: shimmer → badges → retry, driven by describe slot state.
  const renderBadge = useCallback(
    (node: TreeNode): ReactNode => {
      const data = node.data as LeafData;
      const describeSlot: DescribeSlot | undefined = describe.get(data.tableName);
      return (
        <TableLeafBadge
          tableName={data.tableName}
          describeSlot={describeSlot}
          retryDescribe={retryDescribe}
        />
      );
    },
    [describe, retryDescribe],
  );

  // onActivate: open or focus placeholder tab.
  const onActivate = useCallback(
    (node: TreeNode) => {
      const data = node.data as LeafData;
      openTable(data.tableName);
    },
    [openTable],
  );

  // --------------------------------------------------------------------------
  // Context menu: capture which row was right-clicked
  // --------------------------------------------------------------------------
  const handleTreeContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Walk up from event target to find the treeitem row, then infer the
      // table name from the node's aria-label or the DOM title attribute.
      // The SidebarTree renders: <div role="treeitem" title={node.label} ...>
      const target = e.target as Element;
      let el: Element | null = target;
      while (el) {
        if (el.getAttribute("role") === "treeitem") {
          const title = el.getAttribute("title");
          if (title) {
            contextMenuTableRef.current = title;
          }
          break;
        }
        el = el.parentElement;
      }
    },
    [],
  );

  // Context menu actions
  const handleContextOpen = useCallback(() => {
    const name = contextMenuTableRef.current;
    if (name) openTable(name);
  }, [openTable]);

  const handleContextCopyName = useCallback(() => {
    const name = contextMenuTableRef.current;
    if (name) {
      void navigator.clipboard.writeText(name);
    }
  }, []);

  const handleContextCopyArn = useCallback(() => {
    const name = contextMenuTableRef.current;
    if (!name) return;

    // Prefer cached ARN if available.
    const descSlot = describe.get(name);
    if (descSlot?.status === "ready" && descSlot.value.table_arn) {
      void navigator.clipboard.writeText(descSlot.value.table_arn);
      return;
    }

    // Reconstruct from active connection envelope.
    const active = getActive(connectionId);
    if (!active) return;
    const arn = `arn:aws:dynamodb:${active.region}:${active.account_id}:table/${name}`;
    void navigator.clipboard.writeText(arn);
  }, [describe, getActive, connectionId]);

  // Is the ARN copy action available?
  // It's always enabled when the connection is active (can reconstruct).
  const arnCopyEnabled = getActive(connectionId) !== undefined;

  // --------------------------------------------------------------------------
  // Early-out states
  // --------------------------------------------------------------------------

  if (tables.status === "idle" || tables.status === "loading") {
    return (
      <div className={styles.root}>
        <div className={styles.loading} aria-label="Loading tables">
          <Loader2 size={12} className={styles.spinner} />
          <span>Loading tables…</span>
        </div>
      </div>
    );
  }

  if (tables.status === "error") {
    return (
      <div className={styles.root}>
        <div className={styles.error}>
          <span>{tables.error.message ?? "Failed to load tables"}</span>
          <button
            type="button"
            className={styles.retryBtn}
            onClick={() => refresh()}
            aria-label="Retry loading tables"
          >
            <RotateCw size={12} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  // tables.status === "ready"
  const showNoMatch = query.trim().length > 0 && filteredNames.length === 0;
  const showTruncated = tables.truncated;

  return (
    <div className={styles.root}>
      <TableSearchInput
        value={query}
        onChange={handleQueryChange}
        matches={filteredNames.length}
        total={allNames.length}
      />
      {showNoMatch ? (
        <div className={styles.noMatch}>No tables match</div>
      ) : (
        <ContextMenu.Root>
          <ContextMenu.Trigger asChild>
            <div onContextMenu={handleTreeContextMenu}>
              <SidebarTree
                nodes={treeNodes}
                onActivate={onActivate}
                renderLabel={renderLabel}
                renderBadge={renderBadge}
                virtualizationThreshold={500}
                scrollElementRef={sidebarScrollRef ?? undefined}
                ariaLabel={`Tables for DynamoDB connection ${connectionId}`}
                isActivatable={() => true}
                empty={
                  allNames.length === 0 ? (
                    <span className={styles.emptyHint}>No tables</span>
                  ) : undefined
                }
              />
            </div>
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content className={sidebarStyles.contextMenu}>
              <ContextMenu.Item
                className={sidebarStyles.contextItem}
                onSelect={handleContextOpen}
              >
                Open
              </ContextMenu.Item>
              <ContextMenu.Item
                className={sidebarStyles.contextItem}
                onSelect={handleContextCopyName}
              >
                Copy table name
              </ContextMenu.Item>
              <ContextMenu.Item
                className={sidebarStyles.contextItem}
                disabled={!arnCopyEnabled}
                onSelect={handleContextCopyArn}
              >
                Copy ARN
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      )}
      {showTruncated && (
        <div className={styles.loadMoreRow}>
          {loadMoreState === "loading" ? (
            <span className={styles.loadMoreLoading}>
              <Loader2 size={12} className={styles.spinner} />
              Loading more…
            </span>
          ) : (
            <button
              type="button"
              className={styles.loadMoreBtn}
              onClick={() => void handleLoadMore()}
              aria-label={`Load more tables. Showing first ${allNames.length}`}
            >
              Showing first {allNames.length} of more — Load more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
