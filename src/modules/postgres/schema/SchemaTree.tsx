import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { Loader2, RotateCw } from "lucide-react";
import { useTabs } from "@/platform/shell/tabs";
import { SidebarTree, type TreeNode } from "@/platform/shell/SidebarTree";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { GroupIcon, LeafIcon, type GroupKind, type LeafKind } from "./objectIcons";
import { SchemaSearch } from "./SchemaSearch";
import { useSchemaTree } from "./useSchemaTree";
import { useVisibleSchemas } from "./useVisibleSchemas";
import { VisibleSchemasPicker } from "./VisibleSchemasPicker";
import { openObjectTab } from "./openObjectTab";
import { subscribeSchemaEvent } from "./events";
import type {
  IndexInfo,
  ObjectKind,
  SchemaObjects,
  TableInfo,
  TriggerInfo,
} from "./types";
import styles from "./SchemaTree.module.css";

interface Props {
  connectionId: string;
}

type SchemaState = "idle" | "loading" | "retrying" | "loaded" | "error";

interface LeafData {
  kind: "leaf";
  objectKind: ObjectKind;
  schema: string;
  name: string;
  signature?: string;
  /** Set when the table's relkind is `foreign` — drives the FDW badge. */
  fdw?: boolean;
  /** Set when the table's relkind is `partitioned` — drives the partitioned badge. */
  partitioned?: boolean;
}
interface GroupData {
  kind: "group";
  /** Schema-level state, only set on the schema's own group node. */
  schemaState?: SchemaState;
  /** Schema name when this group represents a schema (state-bearing) node. */
  schemaName?: string;
  /** Error message when the schema's state is `error`. */
  errorMessage?: string;
}
type NodeData = LeafData | GroupData;

const GROUP_LABEL: Record<GroupKind, string> = {
  data: "Data",
  structure: "Structure",
  indexes: "Indexes",
  triggers: "Triggers",
};

const OBJECT_TO_LEAF_ICON: Record<ObjectKind, LeafKind> = {
  table: "table",
  view: "view",
  materialized_view: "materialized_view",
  function: "function",
  type: "type",
  extension: "extension",
  index: "index",
  trigger: "trigger",
};

function caseInsensitiveCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

function buildIndexesNode(
  schema: string,
  indexes: IndexInfo[],
  tableNodeId: string,
): TreeNode | null {
  if (indexes.length === 0) return null;
  return {
    id: `${tableNodeId}/indexes`,
    label: GROUP_LABEL.indexes,
    level: 3,
    hasChildren: true,
    data: { kind: "group" } satisfies GroupData,
    children: indexes.map<TreeNode>((ix) => ({
      id: `${tableNodeId}/indexes/${ix.name}`,
      label: ix.name,
      level: 4,
      hasChildren: false,
      data: {
        kind: "leaf",
        objectKind: "index",
        schema,
        name: ix.name,
      } satisfies LeafData,
    })),
  };
}

function buildTriggersNode(
  schema: string,
  triggers: TriggerInfo[],
  tableNodeId: string,
): TreeNode | null {
  if (triggers.length === 0) return null;
  return {
    id: `${tableNodeId}/triggers`,
    label: GROUP_LABEL.triggers,
    level: 3,
    hasChildren: true,
    data: { kind: "group" } satisfies GroupData,
    children: triggers.map<TreeNode>((tg) => ({
      id: `${tableNodeId}/triggers/${tg.name}`,
      label: tg.name,
      level: 4,
      hasChildren: false,
      data: {
        kind: "leaf",
        objectKind: "trigger",
        schema,
        name: tg.name,
      } satisfies LeafData,
    })),
  };
}

function buildTableNode(schema: string, t: TableInfo, payload: SchemaObjects): TreeNode {
  const id = `schema:${schema}/data/${t.name}`;
  const indexes = payload.indexes.filter((ix) => ix.table === t.name);
  const triggers = payload.triggers.filter((tg) => tg.table === t.name);
  const indexesNode = buildIndexesNode(schema, indexes, id);
  const triggersNode = buildTriggersNode(schema, triggers, id);
  const children: TreeNode[] = [];
  if (indexesNode) children.push(indexesNode);
  if (triggersNode) children.push(triggersNode);
  const hasChildren = children.length > 0;
  return {
    id,
    label: t.name,
    level: 2,
    hasChildren,
    data: {
      kind: "leaf",
      objectKind: "table",
      schema,
      name: t.name,
      fdw: t.kind === "foreign",
      partitioned: t.kind === "partitioned",
    } satisfies LeafData,
    children: hasChildren ? children : undefined,
  };
}

function buildDataGroup(schema: string, payload: SchemaObjects): TreeNode | null {
  const tableNodes = payload.tables.map((t) => buildTableNode(schema, t, payload));
  const viewNodes = payload.views.map<TreeNode>((v) => ({
    id: `schema:${schema}/data/${v.name}`,
    label: v.name,
    level: 2,
    hasChildren: false,
    data: {
      kind: "leaf",
      objectKind: "view",
      schema,
      name: v.name,
    } satisfies LeafData,
  }));
  const matViewNodes = payload.materialized_views.map<TreeNode>((v) => ({
    id: `schema:${schema}/data/${v.name}`,
    label: v.name,
    level: 2,
    hasChildren: false,
    data: {
      kind: "leaf",
      objectKind: "materialized_view",
      schema,
      name: v.name,
    } satisfies LeafData,
  }));
  const all = [...tableNodes, ...viewNodes, ...matViewNodes];
  if (all.length === 0) return null;
  all.sort((a, b) => caseInsensitiveCompare(a.label, b.label));
  return {
    id: `schema:${schema}/data`,
    label: GROUP_LABEL.data,
    level: 1,
    hasChildren: true,
    data: { kind: "group" } satisfies GroupData,
    children: all,
  };
}

function buildStructureGroup(schema: string, payload: SchemaObjects): TreeNode | null {
  const functionNodes = payload.functions.map<TreeNode>((f, i) => ({
    // Include `i` to keep ids unique when overload signatures aren't enough.
    id: `schema:${schema}/structure/${f.name}#${i}`,
    label: `${f.name}(${f.args_signature})`,
    level: 2,
    hasChildren: false,
    data: {
      kind: "leaf",
      objectKind: "function",
      schema,
      name: f.name,
      signature: f.args_signature,
    } satisfies LeafData,
  }));
  const typeNodes = payload.types.map<TreeNode>((t) => ({
    id: `schema:${schema}/structure/${t.name}`,
    label: t.name,
    level: 2,
    hasChildren: false,
    data: { kind: "leaf", objectKind: "type", schema, name: t.name } satisfies LeafData,
  }));
  const extensionNodes = payload.extensions.map<TreeNode>((e) => ({
    id: `schema:${schema}/structure/${e.name}`,
    label: `${e.name} ${e.version}`,
    level: 2,
    hasChildren: false,
    data: {
      kind: "leaf",
      objectKind: "extension",
      schema,
      name: e.name,
    } satisfies LeafData,
  }));
  const all = [...functionNodes, ...typeNodes, ...extensionNodes];
  if (all.length === 0) return null;
  all.sort((a, b) => caseInsensitiveCompare(a.label, b.label));
  return {
    id: `schema:${schema}/structure`,
    label: GROUP_LABEL.structure,
    level: 1,
    hasChildren: true,
    data: { kind: "group" } satisfies GroupData,
    children: all,
  };
}

function buildSchemaNode(
  schema: string,
  payload: SchemaObjects | null,
  state: SchemaState,
  errorMessage: string | undefined,
): TreeNode {
  const id = `schema:${schema}`;
  const dataState: GroupData = {
    kind: "group",
    schemaState: state,
    schemaName: schema,
    errorMessage,
  };

  if (!payload) {
    // No payload yet — show a single placeholder child with the right copy.
    let placeholderLabel: string;
    if (state === "error") placeholderLabel = errorMessage ?? "Failed to load.";
    else if (state === "loading") placeholderLabel = "Loading…";
    else if (state === "retrying") placeholderLabel = "Slow — retrying…";
    else placeholderLabel = "(expand to load)";
    return {
      id,
      label: schema,
      level: 0,
      hasChildren: true,
      data: dataState,
      children: [
        {
          id: `${id}/__placeholder`,
          label: placeholderLabel,
          level: 1,
          hasChildren: false,
          data: { kind: "group" } satisfies GroupData,
        },
      ],
    };
  }

  const groups: TreeNode[] = [];
  const dataGroup = buildDataGroup(schema, payload);
  if (dataGroup) groups.push(dataGroup);
  const structureGroup = buildStructureGroup(schema, payload);
  if (structureGroup) groups.push(structureGroup);

  return {
    id,
    label: schema,
    level: 0,
    hasChildren: groups.length > 0,
    data: dataState,
    children: groups.length > 0 ? groups : undefined,
  };
}

interface FilterOutcome {
  nodes: TreeNode[];
  matches: number;
  total: number;
  forceExpanded: Set<string>;
}

function countLeaves(nodes: TreeNode[]): number {
  let total = 0;
  for (const n of nodes) {
    if (n.hasChildren && n.children) {
      total += countLeaves(n.children);
    } else {
      total += 1;
    }
  }
  return total;
}

function filterTree(nodes: TreeNode[], q: string): FilterOutcome {
  const total = countLeaves(nodes);
  if (q.trim().length === 0) {
    return { nodes, matches: total, total, forceExpanded: new Set() };
  }
  const needle = q.toLowerCase();
  const forceExpanded = new Set<string>();
  let matches = 0;

  function walk(node: TreeNode): TreeNode | null {
    if (node.hasChildren && node.children) {
      const filteredChildren: TreeNode[] = [];
      for (const c of node.children) {
        const fc = walk(c);
        if (fc) filteredChildren.push(fc);
      }
      if (filteredChildren.length === 0) {
        const data = node.data as NodeData | undefined;
        if (data?.kind === "leaf" && node.label.toLowerCase().includes(needle)) {
          matches += 1;
          return { ...node, children: undefined, hasChildren: false };
        }
        return null;
      }
      forceExpanded.add(node.id);
      return { ...node, children: filteredChildren };
    }
    if (node.label.toLowerCase().includes(needle)) {
      matches += 1;
      return node;
    }
    return null;
  }

  const out: TreeNode[] = [];
  for (const n of nodes) {
    const fn = walk(n);
    if (fn) out.push(fn);
  }
  return { nodes: out, matches, total, forceExpanded };
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

export function SchemaTree({ connectionId }: Props) {
  const tree = useSchemaTree(connectionId);
  const visibility = useVisibleSchemas(connectionId, tree.schemas);
  const [query, setQuery] = useState("");
  const tabs = useTabs();
  const { items: connections } = useConnections();
  const connectionName =
    connections.find((c) => c.id === connectionId)?.name ?? connectionId;

  // Eagerly load objects for visible schemas the first time we see them. The
  // hook de-dupes loading state — this is idempotent.
  useEffect(() => {
    if (!connectionId) return;
    for (const name of visibility.visible) {
      tree.getObjects(name);
    }
  }, [connectionId, visibility.visible, tree]);

  const visibleSchemaList = useMemo(
    () => tree.schemas.filter((s) => visibility.visible.has(s.name)),
    [tree.schemas, visibility.visible],
  );

  const builtNodes: TreeNode[] = useMemo(() => {
    return visibleSchemaList.map((s) => {
      const payload = tree.getObjects(s.name);
      const state = tree.getObjectsState(s.name) as SchemaState;
      const err = tree.getObjectsError(s.name);
      return buildSchemaNode(s.name, payload, state, err?.message);
    });
  }, [visibleSchemaList, tree]);

  const filtered = useMemo(() => filterTree(builtNodes, query), [builtNodes, query]);

  const unloadedSchemaCount = useMemo(() => {
    let n = 0;
    for (const s of visibleSchemaList) {
      if (tree.getObjectsState(s.name) !== "loaded") n += 1;
    }
    return n;
  }, [visibleSchemaList, tree]);

  function onActivate(node: TreeNode) {
    const data = node.data as NodeData | undefined;
    if (!data || data.kind !== "leaf") return;
    openObjectTab(tabs, {
      connectionId,
      connectionName,
      schema: data.schema,
      kind: data.objectKind,
      name: data.name,
      signature: data.signature,
    });
  }

  const renderIcon = (n: TreeNode): ReactNode => {
    const data = n.data as NodeData | undefined;
    if (!data) return null;
    if (data.kind === "group") {
      // Schema-level node has level 0; group nodes have level 1 or 3.
      if (n.level === 0) return <LeafIcon kind="schema" />;
      const segs = n.id.split("/");
      const last = segs[segs.length - 1] as GroupKind | undefined;
      if (last && last in GROUP_LABEL) return <GroupIcon kind={last as GroupKind} />;
      return null;
    }
    return <LeafIcon kind={OBJECT_TO_LEAF_ICON[data.objectKind]} />;
  };

  const renderBadge = (n: TreeNode): ReactNode => {
    const data = n.data as NodeData | undefined;
    if (!data) return null;
    if (data.kind === "leaf") {
      // Tables share the same icon across regular/partitioned/foreign — disambiguate via badge.
      if (data.fdw) return <span className={styles.tableBadge}>FDW</span>;
      if (data.partitioned) return <span className={styles.tableBadge}>partitioned</span>;
      return null;
    }
    // Group node.
    // Schema-level row carries state-driven indicators.
    if (n.level === 0 && data.schemaState) {
      if (data.schemaState === "loading") {
        return (
          <span className={styles.spinner} aria-label="Loading">
            <Loader2 size={12} />
          </span>
        );
      }
      if (data.schemaState === "retrying") {
        return (
          <span className={styles.retryingPill} aria-label="Retrying">
            <Loader2 size={12} className={styles.spinnerInline} />
            retrying
          </span>
        );
      }
      if (data.schemaState === "error" && data.schemaName) {
        const name = data.schemaName;
        const onClick = (e: MouseEvent<HTMLButtonElement>) => {
          e.stopPropagation();
          tree.retrySchema(name);
        };
        return (
          <button
            type="button"
            className={styles.retryButton}
            aria-label="Retry"
            title={data.errorMessage ?? "Retry"}
            onClick={onClick}
          >
            <RotateCw size={12} />
          </button>
        );
      }
    }
    // Counts on inner group nodes.
    if (n.children) return n.children.length;
    return null;
  };

  const renderLabel = (n: TreeNode): ReactNode => {
    return highlightLabel(n.label, query);
  };

  const showEmpty =
    !tree.schemasLoading && !tree.schemasError && filtered.nodes.length === 0;

  let emptyMessage: ReactNode = "No matches.";
  if (query.length > 0 && unloadedSchemaCount > 0) {
    emptyMessage = (
      <>
        No matches in loaded schemas. {unloadedSchemaCount} schemas not yet loaded —
        expand a schema to include it in search.
      </>
    );
  } else if (query.length === 0 && tree.schemas.length === 0) {
    emptyMessage = "No schemas.";
  } else if (query.length === 0 && visibleSchemaList.length === 0) {
    emptyMessage = "No schemas visible — adjust the filter.";
  }

  return (
    <div className={styles.root}>
      <SchemaSearch
        value={query}
        onChange={setQuery}
        matches={filtered.matches}
        total={filtered.total}
        placeholder="Search…"
      />
      {tree.schemasLoading && <div className={styles.status}>Loading schemas…</div>}
      {tree.schemasError && (
        <div className={styles.error}>{tree.schemasError.message}</div>
      )}
      {!tree.schemasLoading && !tree.schemasError && (
        <div className={styles.body}>
          <SidebarTree
            nodes={filtered.nodes}
            onActivate={onActivate}
            renderIcon={renderIcon}
            renderBadge={renderBadge}
            renderLabel={renderLabel}
            forceExpanded={filtered.forceExpanded}
            ariaLabel={`Schemas for ${connectionName}`}
            empty={showEmpty ? emptyMessage : undefined}
          />
        </div>
      )}
    </div>
  );
}

interface ToolbarProps {
  connectionId: string;
}

/**
 * Renders the connection-row hover toolbar items (refresh + visibility picker).
 * Shipped here so the Sidebar doesn't have to know about the schema browser
 * internals.
 */
export function SchemaToolbar({ connectionId }: ToolbarProps) {
  const tree = useSchemaTree(connectionId);
  const visibility = useVisibleSchemas(connectionId, tree.schemas);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Open the picker when the palette dispatches `openPicker` for this id.
  useEffect(() => {
    return subscribeSchemaEvent((e) => {
      if (e.type === "openPicker" && e.connectionId === connectionId) {
        setPickerOpen(true);
      }
    });
  }, [connectionId]);

  return (
    <>
      <button
        type="button"
        aria-label="Refresh schemas"
        title="Refresh schemas"
        onClick={(e) => {
          e.stopPropagation();
          tree.invalidate();
        }}
        className={styles.toolbarBtn}
      >
        <RefreshIcon />
      </button>
      <VisibleSchemasPicker
        schemas={tree.schemas}
        visibility={visibility}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
      />
    </>
  );
}

function RefreshIcon() {
  // Inline icon — RotateCw from lucide.
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}
