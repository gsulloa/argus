/**
 * Athena schema tree: databases → tables/views → columns.
 *
 * D8: clicking a table/view opens a SQL editor pre-filled with
 *   SELECT * FROM "<database>"."<relation>" LIMIT 100
 * unexecuted (no data scan billed on click).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type MouseEvent,
} from "react";
import { Loader2, RotateCw, Terminal } from "lucide-react";
import { useTabs } from "@/platform/shell/tabs";
import { SidebarTree, type TreeNode } from "@/platform/shell/SidebarTree";
import { useSidebarScrollRef } from "@/platform/shell/sidebarScroll";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { ContextFolderBanner } from "@/modules/context/components/ContextFolderBanner";
import { SchemaSearch } from "@/modules/postgres/schema/SchemaSearch";
import { athenaApi } from "../api";
import { athenaSchemaCache } from "./globalSchemaCache";
import { athenaColumnsCache } from "../sql/columnsCache";
import { openAthenaQueryTab } from "../openAthenaQueryTab";
import type { AthenaDatabaseInfo, AthenaNamedQuerySummary, AthenaRelationInfo, AthenaColumnInfo } from "../types";
import styles from "@/modules/mysql/schema/SchemaTree.module.css";

interface Props {
  connectionId: string;
}

// ---------------------------------------------------------------------------
// Node data shapes
// ---------------------------------------------------------------------------

interface LeafData {
  kind: "leaf";
  objectKind: "table" | "view" | "column" | "named-query";
  database: string;
  relation?: string;
  name: string;
  namedQueryId?: string;
  description?: string | null;
}

interface GroupData {
  kind: "group";
  placeholder?: string;
  spinner?: boolean;
  retry?: { kind: "databases" } | { kind: "relations"; database: string } | { kind: "columns"; database: string; relation: string } | { kind: "named-queries" };
  countBadge?: number;
  isNamedQueriesBranch?: boolean;
  isWorkgroupGroup?: boolean;
}

type NodeData = LeafData | GroupData;

// ---------------------------------------------------------------------------
// Load state for async fetches
// ---------------------------------------------------------------------------

type LoadState = "idle" | "loading" | "loaded" | "error";

// ---------------------------------------------------------------------------
// Helper builders
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

function caseInsensitiveCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

function highlightLabel(label: string, query: string): ReactNode {
  if (!query) return label;
  const idx = label.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return label;
  return (
    <>
      {label.slice(0, idx)}
      <span className={styles.match}>{label.slice(idx, idx + query.length)}</span>
      {label.slice(idx + query.length)}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AthenaSchemaTree({ connectionId }: Props) {
  const tabs = useTabs();
  const { items: connections } = useConnections();
  const connection = connections.find((c) => c.id === connectionId);
  const connectionName = connection?.name ?? connectionId;
  const contextPath = connection?.context_path ?? null;
  const sidebarScrollRef = useSidebarScrollRef();
  const [query, setQuery] = useState("");

  // ---------------------------------------------------------------------------
  // Databases
  // ---------------------------------------------------------------------------
  const [dbState, setDbState] = useState<LoadState>("idle");
  const [dbError, setDbError] = useState<string | undefined>();

  const loadDatabases = useCallback(async () => {
    setDbState("loading");
    setDbError(undefined);
    try {
      const dbs = await athenaApi.listDatabases(connectionId);
      athenaSchemaCache.recordDatabases(connectionId, dbs);
      setDbState("loaded");
    } catch (e) {
      setDbError((e as Error).message ?? "Failed to load databases.");
      setDbState("error");
    }
  }, [connectionId]);

  useEffect(() => {
    void loadDatabases();
  }, [loadDatabases]);

  // Sync from cache
  const [databases, setDatabases] = useState<AthenaDatabaseInfo[]>(
    () => athenaSchemaCache.getDatabases(connectionId),
  );
  useEffect(() => {
    const unsub = athenaSchemaCache.subscribe(() => {
      setDatabases(athenaSchemaCache.getDatabases(connectionId));
    });
    return unsub;
  }, [connectionId]);

  // ---------------------------------------------------------------------------
  // Named Queries — lazy-load on first expand (task 4.2)
  // ---------------------------------------------------------------------------
  const [nqState, setNqState] = useState<LoadState>("idle");
  const [nqError, setNqError] = useState<string | undefined>();
  const [namedQueries, setNamedQueries] = useState<AthenaNamedQuerySummary[]>(
    () => athenaSchemaCache.getNamedQueries(connectionId) ?? [],
  );

  const loadNamedQueries = useCallback(async () => {
    setNqState("loading");
    setNqError(undefined);
    try {
      const queries = await athenaApi.listNamedQueries(connectionId);
      athenaSchemaCache.recordNamedQueries(connectionId, queries);
      setNamedQueries(queries);
      setNqState("loaded");
    } catch (e) {
      setNqError((e as Error).message ?? "Failed to load named queries.");
      setNqState("error");
    }
  }, [connectionId]);

  // Sync named queries from cache (e.g. after invalidation + reload)
  useEffect(() => {
    const unsub = athenaSchemaCache.subscribe(() => {
      const cached = athenaSchemaCache.getNamedQueries(connectionId);
      if (cached !== null) {
        setNamedQueries(cached);
      } else {
        // Cache was invalidated — reset to idle so next expand re-fetches
        setNamedQueries([]);
        setNqState("idle");
      }
    });
    return unsub;
  }, [connectionId]);

  // Listen for manual refresh — reset named-queries state to idle (task 4.7)
  useEffect(() => {
    function onRefresh(e: Event) {
      const ev = e as CustomEvent<string>;
      if (ev.detail === connectionId) {
        setNqState("idle");
        setNqError(undefined);
        setNamedQueries([]);
      }
    }
    window.addEventListener("athena:schema-refresh", onRefresh);
    return () => window.removeEventListener("athena:schema-refresh", onRefresh);
  }, [connectionId]);

  // ---------------------------------------------------------------------------
  // Relations per database
  // ---------------------------------------------------------------------------
  const [relState, setRelState] = useState<Map<string, LoadState>>(new Map());
  const [relError, setRelError] = useState<Map<string, string>>(new Map());
  const [relations, setRelations] = useState<Map<string, AthenaRelationInfo[]>>(new Map());

  const loadRelations = useCallback(
    async (database: string) => {
      setRelState((m) => new Map(m).set(database, "loading"));
      setRelError((m) => { const n = new Map(m); n.delete(database); return n; });
      try {
        const rels = await athenaApi.listRelations(connectionId, database);
        athenaSchemaCache.recordRelations(connectionId, database, rels);
        setRelations((m) => new Map(m).set(database, rels));
        setRelState((m) => new Map(m).set(database, "loaded"));
      } catch (e) {
        setRelError((m) => new Map(m).set(database, (e as Error).message ?? "Failed to load."));
        setRelState((m) => new Map(m).set(database, "error"));
      }
    },
    [connectionId],
  );

  // ---------------------------------------------------------------------------
  // Columns per (database, relation)
  // ---------------------------------------------------------------------------
  const [colState, setColState] = useState<Map<string, LoadState>>(new Map());
  const [colError, setColError] = useState<Map<string, string>>(new Map());
  const [columns, setColumns] = useState<Map<string, AthenaColumnInfo[]>>(new Map());

  const colKey = (database: string, relation: string) => `${database}\0${relation}`;

  const loadColumns = useCallback(
    async (database: string, relation: string) => {
      const key = colKey(database, relation);
      setColState((m) => new Map(m).set(key, "loading"));
      setColError((m) => { const n = new Map(m); n.delete(key); return n; });
      try {
        const cols = await athenaApi.listColumns(connectionId, database, relation);
        setColumns((m) => new Map(m).set(key, cols));
        setColState((m) => new Map(m).set(key, "loaded"));
        // Populate the columns cache for autocompletion
        athenaColumnsCache.setColumns(connectionId, database, relation, cols);
      } catch (e) {
        setColError((m) => new Map(m).set(key, (e as Error).message ?? "Failed to load."));
        setColState((m) => new Map(m).set(key, "error"));
      }
    },
    [connectionId],
  );

  // ---------------------------------------------------------------------------
  // Tree building
  // ---------------------------------------------------------------------------

  const builtNodes: TreeNode[] = useMemo(() => {
    // ---------------------------------------------------------------------------
    // Named Queries branch (task 4.1 — above databases)
    // ---------------------------------------------------------------------------
    const nqBranchId = `athena:${connectionId}/named-queries`;

    let nqChildren: TreeNode[];
    if (nqState === "idle") {
      nqChildren = [{ ...placeholderNode(nqBranchId, "idle", "(expand to load)"), level: 1 }];
    } else if (nqState === "loading") {
      nqChildren = [{ ...placeholderNode(nqBranchId, "loading", "Loading…", { spinner: true }), level: 1 }];
    } else if (nqState === "error") {
      nqChildren = [{
        ...placeholderNode(nqBranchId, "error", nqError ?? "Failed to load named queries.", { retry: { kind: "named-queries" } }),
        level: 1,
      }];
    } else if (namedQueries.length === 0) {
      nqChildren = [{ ...placeholderNode(nqBranchId, "empty", "Sin named queries en la cuenta"), level: 1 }];
    } else {
      // Group by work_group preserving (work_group, name) order from backend.
      // The array is pre-sorted by (work_group, name), so a stable sequential
      // group-by preserves that order without any re-sort.
      const groups = new Map<string, AthenaNamedQuerySummary[]>();
      for (const nq of namedQueries) {
        const bucket = groups.get(nq.work_group);
        if (bucket) {
          bucket.push(nq);
        } else {
          groups.set(nq.work_group, [nq]);
        }
      }

      nqChildren = Array.from(groups.entries()).map<TreeNode>(([workgroup, queries]) => {
        const wgId = `${nqBranchId}/wg/${workgroup}`;
        const queryLeaves = queries.map<TreeNode>((nq) => ({
          id: `${wgId}/${nq.named_query_id}`,
          label: nq.name,
          level: 2,
          hasChildren: false,
          data: {
            kind: "leaf",
            objectKind: "named-query",
            database: nq.database,
            name: nq.name,
            namedQueryId: nq.named_query_id,
            description: nq.description,
          } satisfies LeafData,
        }));

        return {
          id: wgId,
          label: workgroup,
          level: 1,
          hasChildren: true,
          data: {
            kind: "group",
            isWorkgroupGroup: true,
            countBadge: queries.length,
          } satisfies GroupData,
          children: queryLeaves,
        };
      });
    }

    const nqBranchNode: TreeNode = {
      id: nqBranchId,
      label: "Named Queries",
      level: 0,
      hasChildren: true,
      data: {
        kind: "group",
        spinner: nqState === "loading",
        isNamedQueriesBranch: true,
        countBadge: nqState === "loaded" && namedQueries.length > 0 ? namedQueries.length : undefined,
      } satisfies GroupData,
      children: nqChildren,
    };

    // ---------------------------------------------------------------------------
    // Database nodes
    // ---------------------------------------------------------------------------
    const dbNodes = databases.map((db) => {
      const dbId = `athena:${connectionId}/db/${db.name}`;
      const dbRelState = relState.get(db.name) ?? "idle";
      const dbRelError = relError.get(db.name);
      const dbRelations = relations.get(db.name);

      let relChildren: TreeNode[];
      if (dbRelState === "idle") {
        relChildren = [{ ...placeholderNode(dbId, "idle", "(expand to load)"), level: 1 }];
      } else if (dbRelState === "loading") {
        relChildren = [{ ...placeholderNode(dbId, "loading", "Loading…", { spinner: true }), level: 1 }];
      } else if (dbRelState === "error") {
        relChildren = [{
          ...placeholderNode(dbId, "error", dbRelError ?? "Failed to load.", { retry: { kind: "relations", database: db.name } }),
          level: 1,
        }];
      } else if (!dbRelations || dbRelations.length === 0) {
        relChildren = [{ ...placeholderNode(dbId, "empty", "(empty)"), level: 1 }];
      } else {
        const sorted = [...dbRelations].sort((a, b) => caseInsensitiveCompare(a.name, b.name));
        relChildren = sorted.map<TreeNode>((rel) => {
          const relId = `${dbId}/${rel.name}`;
          const key = colKey(db.name, rel.name);
          const cState = colState.get(key) ?? "idle";
          const cError = colError.get(key);
          const cols = columns.get(key);

          let colChildren: TreeNode[];
          if (cState === "idle") {
            colChildren = [{ ...placeholderNode(relId, "idle", "(expand to load)"), level: 2 }];
          } else if (cState === "loading") {
            colChildren = [{ ...placeholderNode(relId, "loading", "Loading…", { spinner: true }), level: 2 }];
          } else if (cState === "error") {
            colChildren = [{
              ...placeholderNode(relId, "error", cError ?? "Failed to load.", { retry: { kind: "columns", database: db.name, relation: rel.name } }),
              level: 2,
            }];
          } else if (!cols || cols.length === 0) {
            colChildren = [{ ...placeholderNode(relId, "empty", "(no columns)"), level: 2 }];
          } else {
            colChildren = cols.map<TreeNode>((col) => ({
              id: `${relId}/${col.name}`,
              label: col.name,
              level: 2,
              hasChildren: false,
              data: {
                kind: "leaf",
                objectKind: "column",
                database: db.name,
                relation: rel.name,
                name: col.name,
              } satisfies LeafData,
            }));
          }

          return {
            id: relId,
            label: rel.name,
            level: 1,
            hasChildren: true,
            data: {
              kind: "leaf",
              objectKind: rel.kind === "view" ? "view" : "table",
              database: db.name,
              name: rel.name,
            } satisfies LeafData,
            children: colChildren,
          };
        });
      }

      return {
        id: dbId,
        label: db.name,
        level: 0,
        hasChildren: true,
        data: {
          kind: "group",
          spinner: dbRelState === "loading",
          countBadge: dbRelations ? dbRelations.length : undefined,
        } satisfies GroupData,
        children: relChildren,
      };
    });

    return [nqBranchNode, ...dbNodes];
  }, [databases, connectionId, relState, relError, relations, colState, colError, columns, nqState, nqError, namedQueries]);

  // ---------------------------------------------------------------------------
  // Filter
  // ---------------------------------------------------------------------------

  const filtered = useMemo(() => {
    if (!query.trim()) return { nodes: builtNodes, forceExpanded: new Set<string>() };
    const needle = query.toLowerCase();
    const forceExpanded = new Set<string>();

    function walk(node: TreeNode): TreeNode | null {
      if (node.hasChildren && node.children) {
        const filteredChildren = node.children.map(walk).filter(Boolean) as TreeNode[];
        if (filteredChildren.length === 0) {
          const data = node.data as NodeData | undefined;
          if (data?.kind === "leaf" && node.label.toLowerCase().includes(needle)) {
            return { ...node, children: undefined, hasChildren: false };
          }
          return null;
        }
        forceExpanded.add(node.id);
        return { ...node, children: filteredChildren };
      }
      const data = node.data as NodeData | undefined;
      if (data?.kind === "leaf" && node.label.toLowerCase().includes(needle)) return node;
      return null;
    }

    const nodes: TreeNode[] = [];
    for (const n of builtNodes) {
      const fn = walk(n);
      if (fn) nodes.push(fn);
    }
    return { nodes, forceExpanded };
  }, [builtNodes, query]);

  // ---------------------------------------------------------------------------
  // Interactions
  // ---------------------------------------------------------------------------

  const onActivate = useCallback(
    (node: TreeNode) => {
      const data = node.data as NodeData | undefined;
      if (!data || data.kind !== "leaf") return;
      if (data.objectKind === "table" || data.objectKind === "view") {
        // D8: open SQL editor pre-filled with SELECT preview, unexecuted
        const sql = `SELECT * FROM "${data.database}"."${data.name}" LIMIT 100`;
        openAthenaQueryTab(tabs, {
          connectionId,
          connectionName,
          sql,
        });
        return;
      }
      if (data.objectKind === "named-query" && data.namedQueryId) {
        // Task 4.4: fetch query body then open in a new tab
        void athenaApi.getNamedQuery(connectionId, data.namedQueryId).then((detail) => {
          openAthenaQueryTab(tabs, {
            connectionId,
            connectionName,
            sql: detail.query_string,
          });
        });
      }
    },
    [tabs, connectionId, connectionName],
  );

  const onToggle = useCallback(
    (node: TreeNode, expanded: boolean) => {
      if (!expanded) return;
      const data = node.data as NodeData | undefined;
      if (!data) return;
      // Named Queries branch expanding → lazy-load on first expand (task 4.2)
      if (data.kind === "group" && data.isNamedQueriesBranch) {
        if (nqState === "idle") {
          void loadNamedQueries();
        }
        return;
      }
      // Database node expanding → load relations lazily
      if (data.kind === "group" && node.level === 0) {
        const dbName = node.label;
        if (!relState.get(dbName) || relState.get(dbName) === "idle") {
          void loadRelations(dbName);
        }
        return;
      }
      // Relation leaf (table/view) expanding → load columns lazily
      if (data.kind === "leaf" && (data.objectKind === "table" || data.objectKind === "view")) {
        const key = colKey(data.database, data.name);
        if (!colState.get(key) || colState.get(key) === "idle") {
          void loadColumns(data.database, data.name);
        }
      }
    },
    [nqState, relState, colState, loadNamedQueries, loadRelations, loadColumns],
  );

  const renderIcon = (n: TreeNode): ReactNode => {
    const data = n.data as NodeData | undefined;
    if (!data) return null;
    if (data.kind === "group") {
      if (data.isNamedQueriesBranch) {
        // Bookmark/star icon for Named Queries branch — hairline 1.5 stroke per DESIGN.md
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        );
      }
      if (data.isWorkgroupGroup) {
        // Workgroup sub-group: layers/stack icon — same hairline stroke as database icon
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polygon points="12 2 2 7 12 12 22 7 12 2" />
            <polyline points="2 17 12 22 22 17" />
            <polyline points="2 12 12 17 22 12" />
          </svg>
        );
      }
      if (n.level === 0) {
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M3 5v14a9 3 0 0 0 18 0V5" />
          </svg>
        );
      }
      return null;
    }
    if (data.objectKind === "table") {
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18" />
          <path d="M9 21V9" />
        </svg>
      );
    }
    if (data.objectKind === "view") {
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    }
    if (data.objectKind === "column") {
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      );
    }
    if (data.objectKind === "named-query") {
      // Small bookmark icon for individual named query leaves — hairline per DESIGN.md
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
      );
    }
    return null;
  };

  const renderBadge = (n: TreeNode): ReactNode => {
    const data = n.data as NodeData | undefined;
    if (!data) return null;
    if (data.kind === "group") {
      if (data.spinner) {
        return (
          <span className={styles.spinner} aria-label="Loading">
            <Loader2 size={12} />
          </span>
        );
      }
      if (data.retry) {
        const retry = data.retry;
        const onClick = (e: MouseEvent<HTMLButtonElement>) => {
          e.stopPropagation();
          if (retry.kind === "databases") void loadDatabases();
          else if (retry.kind === "named-queries") void loadNamedQueries();
          else if (retry.kind === "relations") void loadRelations(retry.database);
          else if (retry.kind === "columns") void loadColumns(retry.database, retry.relation);
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
      if (data.countBadge !== undefined) {
        return <span className={styles.itemCount}>{data.countBadge}</span>;
      }
    }
    return null;
  };

  const renderLabel = (n: TreeNode): ReactNode => {
    const data = n.data as NodeData | undefined;
    if (data?.kind === "group" && data.placeholder) {
      return <span className={styles.placeholderText}>{data.placeholder}</span>;
    }
    // Named query: surface description as tooltip (task 4.3)
    if (data?.kind === "leaf" && data.objectKind === "named-query" && data.description) {
      return (
        <span title={data.description}>
          {highlightLabel(n.label, query)}
        </span>
      );
    }
    return highlightLabel(n.label, query);
  };

  const totalLeaves = useMemo(() => {
    function count(nodes: TreeNode[]): number {
      let n = 0;
      for (const node of nodes) {
        if (node.hasChildren && node.children) n += count(node.children);
        else n += 1;
      }
      return n;
    }
    return count(filtered.nodes);
  }, [filtered.nodes]);

  // The tree always renders (named-queries branch is independent of db state).
  // A databases loading/error status line appears above the tree when relevant.
  const showEmpty = filtered.nodes.length === 0;
  const emptyMessage = query.length > 0 ? "No matches." : "No databases.";

  return (
    <div className={styles.root}>
      <ContextFolderBanner connectionId={connectionId} contextPath={contextPath} />
      <SchemaSearch
        value={query}
        onChange={setQuery}
        matches={totalLeaves}
        total={totalLeaves}
        placeholder="Search databases, tables…"
      />
      {dbState === "loading" && <div className={styles.status}>Loading databases…</div>}
      {dbError && (
        <div className={styles.error}>
          {dbError}
          <button
            type="button"
            className={styles.retryButton}
            style={{ marginLeft: 6 }}
            onClick={() => void loadDatabases()}
          >
            <RotateCw size={12} />
          </button>
        </div>
      )}
      <div className={styles.body}>
        <SidebarTree
          nodes={filtered.nodes}
          onActivate={onActivate}
          onToggle={onToggle}
          isActivatable={(n) => {
            const data = n.data as NodeData | undefined;
            return data?.kind === "leaf" && (data.objectKind === "table" || data.objectKind === "view" || data.objectKind === "named-query");
          }}
          renderIcon={renderIcon}
          renderBadge={renderBadge}
          renderLabel={renderLabel}
          forceExpanded={filtered.forceExpanded}
          ariaLabel={`Databases and Named Queries for ${connectionName}`}
          empty={showEmpty ? emptyMessage : undefined}
          scrollElementRef={sidebarScrollRef ?? undefined}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar components
// ---------------------------------------------------------------------------

interface ToolbarProps {
  connectionId: string;
}

/**
 * Primary action: "+ Query" button, opens a blank SQL editor tab.
 */
export function AthenaSchemaPrimaryActions({ connectionId }: ToolbarProps) {
  const tabs = useTabs();
  const { items: connections } = useConnections();
  const connectionName =
    connections.find((c) => c.id === connectionId)?.name ?? connectionId;

  return (
    <button
      type="button"
      aria-label="New SQL query"
      title="New SQL query · ⌘↩ runs"
      onClick={(e) => {
        e.stopPropagation();
        openAthenaQueryTab(tabs, {
          connectionId,
          connectionName,
          sql: "",
        });
      }}
      className={styles.toolbarBtn}
    >
      <Terminal size={13} />
    </button>
  );
}

/**
 * Secondary toolbar: refresh button.
 */
export function AthenaSchemaToolbar({ connectionId }: ToolbarProps) {
  return (
    <button
      type="button"
      aria-label="Refresh databases"
      title="Refresh databases"
      onClick={(e) => {
        e.stopPropagation();
        athenaSchemaCache.invalidate(connectionId);
        // Force reload by refreshing the component; parent ConnectionRow re-renders tree
        window.dispatchEvent(new CustomEvent("athena:schema-refresh", { detail: connectionId }));
      }}
      className={styles.toolbarBtn}
    >
      <RotateCw size={13} />
    </button>
  );
}
