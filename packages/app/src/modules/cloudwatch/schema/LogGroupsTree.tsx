/**
 * CloudWatch Logs groups tree: log groups → lazy log streams.
 *
 * Groups load paginated ("load more" at the bottom).
 * Streams load lazily per group, newest-first, paginated.
 * Activating a stream leaf opens the events tab.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type MouseEvent,
} from "react";
import { Loader2, RotateCw, Search } from "lucide-react";
import { useTabs } from "@/platform/shell/tabs";
import { SidebarTree, type TreeNode } from "@/platform/shell/SidebarTree";
import { useSidebarScrollRef } from "@/platform/shell/sidebarScroll";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { cloudwatchApi } from "../api";
import { openEventsTab } from "../events/openEventsTab";
import { openInsightsTab } from "../insights/openInsightsTab";
import type { LogGroupItem, LogStreamItem } from "../types";
import styles from "@/modules/mysql/schema/SchemaTree.module.css";

interface Props {
  connectionId: string;
}

// ---------------------------------------------------------------------------
// Primary action: "New Insights Query" button (rendered in the connection row)
// ---------------------------------------------------------------------------

/**
 * Visible toolbar button that opens a CloudWatch Logs Insights query tab.
 * Mirrors `AthenaSchemaPrimaryActions` so Insights is discoverable at parity
 * with the SQL engines' "New SQL query" button.
 */
export function CloudwatchInsightsPrimaryAction({ connectionId }: Props) {
  const tabs = useTabs();
  const { items: connections } = useConnections();
  const connectionName =
    connections.find((c) => c.id === connectionId)?.name ?? connectionId;

  return (
    <button
      type="button"
      aria-label="New Insights query"
      title="New Logs Insights query · ⌘↩ runs"
      onClick={(e) => {
        e.stopPropagation();
        openInsightsTab(tabs, { connectionId, connectionName });
      }}
      className={styles.toolbarBtn}
    >
      <Search size={13} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Node data shapes
// ---------------------------------------------------------------------------

interface GroupData {
  kind: "group";
  placeholder?: string;
  spinner?: boolean;
  retry?: { kind: "load-more-groups" } | { kind: "streams"; groupName: string } | { kind: "load-more-streams"; groupName: string };
  isLoadMore?: boolean;
  loadMoreGroupsNextToken?: string;
  loadMoreStreamsNextToken?: string;
  loadMoreGroupName?: string;
}

interface StreamLeafData {
  kind: "stream-leaf";
  groupName: string;
  streamName: string;
}

type NodeData = GroupData | StreamLeafData;

type LoadState = "idle" | "loading" | "loaded" | "error";

// ---------------------------------------------------------------------------
// Timestamp formatting helper
// ---------------------------------------------------------------------------

function formatTs(tsMs: number | null | undefined): string {
  if (!tsMs) return "";
  return new Date(tsMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Placeholder node builder
// ---------------------------------------------------------------------------

function placeholderNode(parentId: string, key: string, label: string, data?: Partial<GroupData>): TreeNode {
  return {
    id: `${parentId}/__${key}`,
    label,
    level: -1,
    hasChildren: false,
    data: { kind: "group", placeholder: label, ...data } satisfies GroupData,
  };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function LogGroupsTree({ connectionId }: Props) {
  const tabs = useTabs();
  const { items: connections } = useConnections();
  const connection = connections.find((c) => c.id === connectionId);
  const connectionName = connection?.name ?? connectionId;
  const sidebarScrollRef = useSidebarScrollRef();

  // ---------------------------------------------------------------------------
  // Log groups state
  // ---------------------------------------------------------------------------
  const [groupsState, setGroupsState] = useState<LoadState>("idle");
  const [groupsError, setGroupsError] = useState<string | undefined>();
  const [groups, setGroups] = useState<LogGroupItem[]>([]);
  const [groupsNextToken, setGroupsNextToken] = useState<string | null>(null);
  const [groupsLoadingMore, setGroupsLoadingMore] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  // Latest search term, readable inside loadGroups / load-more without stale
  // closures; and a sequence guard so a superseded in-flight load never
  // overwrites a newer one.
  const searchTermRef = useRef("");
  searchTermRef.current = searchTerm;
  const loadSeqRef = useRef(0);

  const loadGroups = useCallback(async (nextToken?: string) => {
    const seq = ++loadSeqRef.current;
    if (nextToken) {
      setGroupsLoadingMore(true);
    } else {
      setGroupsState("loading");
      setGroupsError(undefined);
      setGroups([]);
      setGroupsNextToken(null);
    }
    try {
      const pattern = searchTermRef.current.trim() || undefined;
      const resp = await cloudwatchApi.listLogGroups(connectionId, nextToken, undefined, pattern);
      if (seq !== loadSeqRef.current) return; // superseded by a newer load
      if (nextToken) {
        setGroups((prev) => [...prev, ...resp.groups]);
      } else {
        setGroups(resp.groups);
      }
      setGroupsNextToken(resp.next_token ?? null);
      setGroupsState("loaded");
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      setGroupsError((e as Error).message ?? "Failed to load log groups.");
      if (!nextToken) setGroupsState("error");
    } finally {
      if (seq === loadSeqRef.current) setGroupsLoadingMore(false);
    }
  }, [connectionId]);

  // Load on mount and whenever the search term changes (debounced). Empty term
  // loads immediately (first page); typed terms debounce ~250 ms.
  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      if (!cancelled) void loadGroups();
    }, searchTerm ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [connectionId, searchTerm, loadGroups]);

  // ---------------------------------------------------------------------------
  // Streams state (per group)
  // ---------------------------------------------------------------------------
  const [streamState, setStreamState] = useState<Map<string, LoadState>>(new Map());
  const [streamError, setStreamError] = useState<Map<string, string>>(new Map());
  const [streams, setStreams] = useState<Map<string, LogStreamItem[]>>(new Map());
  const [streamsNextToken, setStreamsNextToken] = useState<Map<string, string | null>>(new Map());
  const [streamsLoadingMore, setStreamsLoadingMore] = useState<Set<string>>(new Set());

  const loadStreams = useCallback(
    async (groupName: string, nextToken?: string) => {
      if (nextToken) {
        setStreamsLoadingMore((prev) => new Set(prev).add(groupName));
      } else {
        setStreamState((m) => new Map(m).set(groupName, "loading"));
        setStreamError((m) => { const n = new Map(m); n.delete(groupName); return n; });
      }
      try {
        const resp = await cloudwatchApi.listLogStreams(connectionId, groupName, nextToken);
        if (nextToken) {
          setStreams((m) => new Map(m).set(groupName, [...(m.get(groupName) ?? []), ...resp.streams]));
        } else {
          setStreams((m) => new Map(m).set(groupName, resp.streams));
        }
        setStreamsNextToken((m) => new Map(m).set(groupName, resp.next_token ?? null));
        setStreamState((m) => new Map(m).set(groupName, "loaded"));
      } catch (e) {
        setStreamError((m) => new Map(m).set(groupName, (e as Error).message ?? "Failed to load."));
        if (!nextToken) setStreamState((m) => new Map(m).set(groupName, "error"));
      } finally {
        setStreamsLoadingMore((prev) => { const n = new Set(prev); n.delete(groupName); return n; });
      }
    },
    [connectionId],
  );

  // ---------------------------------------------------------------------------
  // Tree building
  // ---------------------------------------------------------------------------

  const nodes: TreeNode[] = useMemo(() => {
    if (groupsState === "loading") {
      return [{ ...placeholderNode("root", "loading", "Loading log groups…", { spinner: true }), level: 0 }];
    }
    if (groupsState === "error") {
      return [{
        ...placeholderNode("root", "error", groupsError ?? "Failed to load log groups.", { retry: { kind: "load-more-groups" } }),
        level: 0,
      }];
    }
    if (groups.length === 0 && groupsState === "loaded") {
      const msg = searchTerm.trim()
        ? `No log groups match "${searchTerm.trim()}".`
        : "No log groups found.";
      return [{ ...placeholderNode("root", "empty", msg), level: 0 }];
    }

    const groupNodes: TreeNode[] = groups.map((g) => {
      const gId = `cloudwatch:${connectionId}/group/${g.name}`;
      const gState = streamState.get(g.name) ?? "idle";
      const gError = streamError.get(g.name);
      const gStreams = streams.get(g.name);
      const gNextToken = streamsNextToken.get(g.name) ?? null;
      const loadingMore = streamsLoadingMore.has(g.name);

      let children: TreeNode[];
      if (gState === "idle") {
        children = [{ ...placeholderNode(gId, "idle", "(expand to load streams)"), level: 1 }];
      } else if (gState === "loading") {
        children = [{ ...placeholderNode(gId, "loading", "Loading…", { spinner: true }), level: 1 }];
      } else if (gState === "error") {
        children = [{
          ...placeholderNode(gId, "error", gError ?? "Failed to load.", { retry: { kind: "streams", groupName: g.name } }),
          level: 1,
        }];
      } else if (!gStreams || gStreams.length === 0) {
        children = [{ ...placeholderNode(gId, "empty", "(no streams)"), level: 1 }];
      } else {
        const streamLeaves: TreeNode[] = gStreams.map<TreeNode>((s) => {
          const lastTs = formatTs(s.last_event_ts);
          return {
            id: `${gId}/stream/${s.name}`,
            label: s.name,
            level: 1,
            hasChildren: false,
            data: {
              kind: "stream-leaf",
              groupName: g.name,
              streamName: s.name,
            } satisfies StreamLeafData,
            // Surface last event time as a hint via the badge
            _lastTs: lastTs,
          } as TreeNode & { _lastTs: string };
        });

        if (gNextToken) {
          const loadMoreId = `${gId}/__load-more-streams`;
          streamLeaves.push({
            id: loadMoreId,
            label: loadingMore ? "Loading…" : "Load more streams…",
            level: 1,
            hasChildren: false,
            data: {
              kind: "group",
              placeholder: loadingMore ? "Loading…" : "Load more streams…",
              isLoadMore: true,
              retry: { kind: "load-more-streams", groupName: g.name },
              loadMoreStreamsNextToken: gNextToken,
              loadMoreGroupName: g.name,
              spinner: loadingMore,
            } satisfies GroupData,
          });
        }

        children = streamLeaves;
      }

      return {
        id: gId,
        label: g.name,
        level: 0,
        hasChildren: true,
        data: { kind: "group", spinner: gState === "loading" } satisfies GroupData,
        children,
      };
    });

    // "Load more groups" node at the bottom
    if (groupsNextToken) {
      groupNodes.push({
        id: `cloudwatch:${connectionId}/__load-more-groups`,
        label: groupsLoadingMore ? "Loading…" : "Load more groups…",
        level: 0,
        hasChildren: false,
        data: {
          kind: "group",
          placeholder: groupsLoadingMore ? "Loading…" : "Load more groups…",
          isLoadMore: true,
          loadMoreGroupsNextToken: groupsNextToken,
          spinner: groupsLoadingMore,
        } satisfies GroupData,
      });
    }

    return groupNodes;
  }, [
    connectionId,
    groupsState,
    groupsError,
    groups,
    groupsNextToken,
    groupsLoadingMore,
    searchTerm,
    streamState,
    streamError,
    streams,
    streamsNextToken,
    streamsLoadingMore,
  ]);

  // ---------------------------------------------------------------------------
  // Interactions
  // ---------------------------------------------------------------------------

  const onActivate = useCallback(
    (node: TreeNode) => {
      const data = node.data as NodeData | undefined;
      if (!data) return;
      if (data.kind === "stream-leaf") {
        openEventsTab(tabs, {
          connectionId,
          connectionName,
          groupName: data.groupName,
          streamName: data.streamName,
        });
        return;
      }
      // "Load more groups" click
      if (data.kind === "group" && data.isLoadMore && data.loadMoreGroupsNextToken) {
        void loadGroups(data.loadMoreGroupsNextToken);
        return;
      }
      // "Load more streams" click
      if (data.kind === "group" && data.isLoadMore && data.loadMoreGroupName && data.loadMoreStreamsNextToken) {
        void loadStreams(data.loadMoreGroupName, data.loadMoreStreamsNextToken);
      }
    },
    [tabs, connectionId, connectionName, loadGroups, loadStreams],
  );

  const onToggle = useCallback(
    (node: TreeNode, expanded: boolean) => {
      if (!expanded) return;
      const data = node.data as NodeData | undefined;
      if (!data || data.kind !== "group") return;
      // Group node expanding → load streams lazily
      if (node.level === 0 && !data.isLoadMore) {
        const groupName = node.label;
        const st = streamState.get(groupName);
        if (!st || st === "idle") {
          void loadStreams(groupName);
        }
      }
    },
    [streamState, loadStreams],
  );

  const renderIcon = (n: TreeNode): ReactNode => {
    const data = n.data as NodeData | undefined;
    if (!data) return null;
    if (data.kind === "group") {
      if (data.isLoadMore) return null;
      if (n.level === 0) {
        // Log group icon: folder-like layers
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 6h16M4 10h16M4 14h10" />
          </svg>
        );
      }
      return null;
    }
    if (data.kind === "stream-leaf") {
      // Stream icon: small scroll / log entry
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="12" y2="17" />
        </svg>
      );
    }
    return null;
  };

  const renderBadge = (n: TreeNode): ReactNode => {
    const data = n.data as NodeData | undefined;
    if (!data || data.kind !== "group") return null;
    if (data.spinner) {
      return (
        <span className={styles.spinner} aria-label="Loading">
          <Loader2 size={12} />
        </span>
      );
    }
    if (data.retry && !data.isLoadMore) {
      const retryData = data.retry;
      const onClick = (e: MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        if (retryData.kind === "load-more-groups") void loadGroups();
        else if (retryData.kind === "streams") void loadStreams(retryData.groupName);
        else if (retryData.kind === "load-more-streams") void loadStreams(retryData.groupName, data.loadMoreStreamsNextToken ?? undefined);
      };
      return (
        <button
          type="button"
          className={styles.retryButton}
          aria-label="Retry"
          title="Retry"
          onClick={onClick}
        >
          <RotateCw size={12} />
        </button>
      );
    }
    return null;
  };

  const renderLabel = (n: TreeNode): ReactNode => {
    const data = n.data as NodeData | undefined;
    if (data?.kind === "group" && data.placeholder) {
      return <span className={styles.placeholderText}>{data.placeholder}</span>;
    }
    return n.label;
  };

  const showEmpty = nodes.length === 0;

  return (
    <div className={styles.root}>
      {/* Server-side search over all account log groups (DESIGN.md tokens). */}
      <div style={{ padding: "6px 8px", flexShrink: 0 }}>
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search log groups…"
          spellCheck={false}
          aria-label="Search log groups"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "6px 10px",
            fontSize: 12,
            color: "var(--text)",
            background: "var(--surface)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius-md, 5px)",
            outline: "none",
          }}
        />
      </div>
      {groupsState === "loading" && groups.length === 0 && (
        <div className={styles.status}>Loading log groups…</div>
      )}
      {groupsError && groupsState === "error" && (
        <div className={styles.error}>
          {groupsError}
          <button
            type="button"
            className={styles.retryButton}
            style={{ marginLeft: 6 }}
            onClick={() => void loadGroups()}
          >
            <RotateCw size={12} />
          </button>
        </div>
      )}
      <div className={styles.body}>
        <SidebarTree
          nodes={nodes}
          onActivate={onActivate}
          onToggle={onToggle}
          isActivatable={(n) => {
            const data = n.data as NodeData | undefined;
            return data?.kind === "stream-leaf" || (data?.kind === "group" && (data.isLoadMore ?? false));
          }}
          renderIcon={renderIcon}
          renderBadge={renderBadge}
          renderLabel={renderLabel}
          ariaLabel={`Log groups for ${connectionName}`}
          empty={showEmpty ? "No log groups." : undefined}
          scrollElementRef={sidebarScrollRef ?? undefined}
        />
      </div>
    </div>
  );
}
