import { useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { Loader2, RotateCw, Terminal } from "lucide-react";
import { useTabs } from "@/platform/shell/tabs";
import { SidebarTree, type TreeNode } from "@/platform/shell/SidebarTree";
import { useSidebarScrollRef } from "@/platform/shell/sidebarScroll";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { openQueryTab } from "../sql";
import { GroupIcon, LeafIcon, type GroupKind, type LeafKind } from "./objectIcons";
import { SchemaSearch } from "./SchemaSearch";
import { useSchemaTree, type PublicGroupState } from "./useSchemaTree";
import { useVisibleSchemas } from "./useVisibleSchemas";
import { VisibleSchemasPicker } from "./VisibleSchemasPicker";
import { openObjectTab } from "./openObjectTab";
import { subscribeSchemaEvent } from "./events";
import type {
  ExtensionInfo,
  FunctionInfo,
  IndexInfo,
  ObjectKind,
  RelationsResult,
  StructureResult,
  TableExtrasResult,
  TableInfo,
  TriggerInfo,
  TypeInfo,
} from "./types";
import styles from "./SchemaTree.module.css";

interface Props {
  connectionId: string;
}

interface LeafData {
  kind: "leaf";
  objectKind: ObjectKind;
  schema: string;
  name: string;
  /** Function OID (only for `objectKind === "function"`). Used to disambiguate overloads. */
  oid?: number;
  /** Set when the table's relkind is `foreign` — drives the FDW badge. */
  fdw?: boolean;
  /** Set when the table's relkind is `partitioned` — drives the partitioned badge. */
  partitioned?: boolean;
  /** Display index for an overloaded function (`#1`, `#2`, …). Omitted when there's only one. */
  overloadIndex?: number;
}

type RetryScope =
  | { kind: "relations"; schema: string }
  | { kind: "structure"; schema: string }
  | { kind: "table-extras"; schema: string; relation: string };

type LazyTrigger =
  | { kind: "structure"; schema: string }
  | { kind: "table-extras"; schema: string; relation: string };

interface GroupData {
  kind: "group";
  /** Italic placeholder copy ("Loading…", "(expand to load)", "Failed", "(empty)"). */
  placeholder?: string;
  /** Inline retry button context. When set, a retry icon is rendered as the row's badge. */
  retry?: RetryScope;
  /** Render an inline spinner as the row's badge. */
  spinner?: boolean;
  /** When this group is first expanded, fire the lazy load. */
  lazyTrigger?: LazyTrigger;
  /** Counts shown on group-summary nodes. */
  countBadge?: number;
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

function placeholderNode(parentId: string, key: string, label: string): TreeNode {
  return {
    id: `${parentId}/__${key}`,
    label,
    level: -1, // overridden by caller
    hasChildren: false,
    data: { kind: "group", placeholder: label } satisfies GroupData,
  };
}

function relativizeLevel(node: TreeNode, level: number): TreeNode {
  return { ...node, level };
}

/**
 * Build the children of a table node based on its `tableExtras` cache slot.
 * Always returns at least one placeholder so the table node remains expandable
 * during the lazy fetch.
 */
function buildTableChildren(
  schema: string,
  relation: string,
  tableNodeId: string,
  state: PublicGroupState,
  extras: TableExtrasResult | null,
  errorMessage: string | undefined,
): TreeNode[] {
  if (state === "idle" || state === "loading") {
    return [
      relativizeLevel(
        placeholderNode(tableNodeId, "loading", state === "loading" ? "Loading…" : "(loading…)"),
        3,
      ),
    ];
  }
  if (state === "error") {
    return [
      {
        ...placeholderNode(tableNodeId, "error", errorMessage ?? "Failed to load."),
        level: 3,
        data: {
          kind: "group",
          placeholder: errorMessage ?? "Failed to load.",
          retry: { kind: "table-extras", schema, relation },
        } satisfies GroupData,
      },
    ];
  }
  // loaded — render Indexes/Triggers sub-groups
  if (!extras) return [];
  const out: TreeNode[] = [];
  const indexesNode = buildIndexesNode(schema, extras.indexes, tableNodeId, extras, relation);
  if (indexesNode) out.push(indexesNode);
  const triggersNode = buildTriggersNode(schema, extras.triggers, tableNodeId, extras, relation);
  if (triggersNode) out.push(triggersNode);
  if (out.length === 0) {
    out.push(
      relativizeLevel(placeholderNode(tableNodeId, "empty", "(no indexes or triggers)"), 3),
    );
  }
  return out;
}

function buildIndexesNode(
  schema: string,
  indexes: IndexInfo[] | null,
  tableNodeId: string,
  extras: TableExtrasResult,
  relation: string,
): TreeNode | null {
  if (indexes === null) {
    // Sub-query failed inside the partial-degradation envelope.
    const failure = extras.failures.find((f) => f.kind === "indexes");
    return {
      id: `${tableNodeId}/indexes`,
      label: GROUP_LABEL.indexes,
      level: 3,
      hasChildren: true,
      data: { kind: "group" } satisfies GroupData,
      children: [
        {
          id: `${tableNodeId}/indexes/__failed`,
          label: failure?.message ?? "Failed to load.",
          level: 4,
          hasChildren: false,
          data: {
            kind: "group",
            placeholder: failure?.message ?? "Failed to load.",
            retry: { kind: "table-extras", schema, relation },
          } satisfies GroupData,
        },
      ],
    };
  }
  if (indexes.length === 0) return null;
  return {
    id: `${tableNodeId}/indexes`,
    label: GROUP_LABEL.indexes,
    level: 3,
    hasChildren: true,
    data: { kind: "group", countBadge: indexes.length } satisfies GroupData,
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
  triggers: TriggerInfo[] | null,
  tableNodeId: string,
  extras: TableExtrasResult,
  relation: string,
): TreeNode | null {
  if (triggers === null) {
    const failure = extras.failures.find((f) => f.kind === "triggers");
    return {
      id: `${tableNodeId}/triggers`,
      label: GROUP_LABEL.triggers,
      level: 3,
      hasChildren: true,
      data: { kind: "group" } satisfies GroupData,
      children: [
        {
          id: `${tableNodeId}/triggers/__failed`,
          label: failure?.message ?? "Failed to load.",
          level: 4,
          hasChildren: false,
          data: {
            kind: "group",
            placeholder: failure?.message ?? "Failed to load.",
            retry: { kind: "table-extras", schema, relation },
          } satisfies GroupData,
        },
      ],
    };
  }
  if (triggers.length === 0) return null;
  return {
    id: `${tableNodeId}/triggers`,
    label: GROUP_LABEL.triggers,
    level: 3,
    hasChildren: true,
    data: { kind: "group", countBadge: triggers.length } satisfies GroupData,
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

function buildTableNode(
  schema: string,
  t: TableInfo,
  extrasState: PublicGroupState,
  extras: TableExtrasResult | null,
  extrasErrorMessage: string | undefined,
): TreeNode {
  const id = `schema:${schema}/data/${t.name}`;
  return {
    id,
    label: t.name,
    level: 2,
    hasChildren: true,
    data: {
      kind: "leaf",
      objectKind: "table",
      schema,
      name: t.name,
      fdw: t.kind === "foreign",
      partitioned: t.kind === "partitioned",
    } satisfies LeafData,
    children: buildTableChildren(schema, t.name, id, extrasState, extras, extrasErrorMessage),
  };
}

function buildDataGroup(
  schema: string,
  state: PublicGroupState,
  payload: RelationsResult | null,
  errorMessage: string | undefined,
  getTableExtras: (relation: string) => TableExtrasResult | null,
  getTableExtrasState: (relation: string) => PublicGroupState,
  getTableExtrasError: (relation: string) => string | undefined,
): TreeNode | null {
  const groupId = `schema:${schema}/data`;
  const baseGroupData: GroupData = { kind: "group" };

  if (state === "idle" || state === "loading") {
    return {
      id: groupId,
      label: GROUP_LABEL.data,
      level: 1,
      hasChildren: true,
      data: { ...baseGroupData, spinner: state === "loading" },
      children: [
        relativizeLevel(
          placeholderNode(groupId, "loading", state === "loading" ? "Loading…" : "(loading…)"),
          2,
        ),
      ],
    };
  }
  if (state === "retrying") {
    // Retrying — show a retrying indicator but keep stale payload children if any.
    const stale = payload;
    if (!stale) {
      return {
        id: groupId,
        label: GROUP_LABEL.data,
        level: 1,
        hasChildren: true,
        data: { ...baseGroupData, spinner: true },
        children: [
          relativizeLevel(placeholderNode(groupId, "retrying", "Slow — retrying…"), 2),
        ],
      };
    }
  }
  if (state === "error") {
    return {
      id: groupId,
      label: GROUP_LABEL.data,
      level: 1,
      hasChildren: true,
      data: { ...baseGroupData, retry: { kind: "relations", schema } },
      children: [
        {
          id: `${groupId}/__error`,
          label: errorMessage ?? "Failed to load.",
          level: 2,
          hasChildren: false,
          data: {
            kind: "group",
            placeholder: errorMessage ?? "Failed to load.",
          } satisfies GroupData,
        },
      ],
    };
  }
  // loaded (or retrying-with-stale)
  if (!payload) return null;
  const tableNodes = payload.tables.map((t) =>
    buildTableNode(
      schema,
      t,
      getTableExtrasState(t.name),
      getTableExtras(t.name),
      getTableExtrasError(t.name),
    ),
  );
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
  if (all.length === 0) {
    return {
      id: groupId,
      label: GROUP_LABEL.data,
      level: 1,
      hasChildren: true,
      data: baseGroupData,
      children: [relativizeLevel(placeholderNode(groupId, "empty", "(empty)"), 2)],
    };
  }
  all.sort((a, b) => caseInsensitiveCompare(a.label, b.label));
  return {
    id: groupId,
    label: GROUP_LABEL.data,
    level: 1,
    hasChildren: true,
    data: { ...baseGroupData, countBadge: all.length },
    children: all,
  };
}

function buildFunctionNodes(schema: string, functions: FunctionInfo[]): TreeNode[] {
  // Pre-compute overload counts so we know whether to render an index badge.
  const counts = new Map<string, number>();
  for (const f of functions) counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return functions.map<TreeNode>((f) => {
    const i = (seen.get(f.name) ?? 0) + 1;
    seen.set(f.name, i);
    const total = counts.get(f.name) ?? 1;
    const overloadIndex = total > 1 ? i : undefined;
    return {
      id: `schema:${schema}/structure/function/${f.oid}`,
      label: f.name,
      level: 2,
      hasChildren: false,
      data: {
        kind: "leaf",
        objectKind: "function",
        schema,
        name: f.name,
        oid: f.oid,
        overloadIndex,
      } satisfies LeafData,
    };
  });
}

function buildStructureGroup(
  schema: string,
  state: PublicGroupState,
  payload: StructureResult | null,
  errorMessage: string | undefined,
): TreeNode {
  const groupId = `schema:${schema}/structure`;
  const lazyTrigger: LazyTrigger = { kind: "structure", schema };

  if (state === "idle") {
    return {
      id: groupId,
      label: GROUP_LABEL.structure,
      level: 1,
      hasChildren: true,
      data: { kind: "group", lazyTrigger },
      children: [
        relativizeLevel(placeholderNode(groupId, "idle", "(expand to load)"), 2),
      ],
    };
  }
  if (state === "loading") {
    return {
      id: groupId,
      label: GROUP_LABEL.structure,
      level: 1,
      hasChildren: true,
      data: { kind: "group", spinner: true },
      children: [relativizeLevel(placeholderNode(groupId, "loading", "Loading…"), 2)],
    };
  }
  if (state === "error") {
    return {
      id: groupId,
      label: GROUP_LABEL.structure,
      level: 1,
      hasChildren: true,
      data: { kind: "group", retry: { kind: "structure", schema } },
      children: [
        {
          id: `${groupId}/__error`,
          label: errorMessage ?? "Failed to load.",
          level: 2,
          hasChildren: false,
          data: {
            kind: "group",
            placeholder: errorMessage ?? "Failed to load.",
          } satisfies GroupData,
        },
      ],
    };
  }
  // loaded — possibly with partial failures
  if (!payload) return { id: groupId, label: GROUP_LABEL.structure, level: 1, hasChildren: false, data: { kind: "group" } };

  const allItems: TreeNode[] = [];
  if (payload.functions !== null) {
    allItems.push(...buildFunctionNodes(schema, payload.functions));
  }
  if (payload.types !== null) {
    allItems.push(
      ...payload.types.map<TreeNode>((t: TypeInfo) => ({
        id: `schema:${schema}/structure/type/${t.name}`,
        label: t.name,
        level: 2,
        hasChildren: false,
        data: { kind: "leaf", objectKind: "type", schema, name: t.name } satisfies LeafData,
      })),
    );
  }
  if (payload.extensions !== null) {
    allItems.push(
      ...payload.extensions.map<TreeNode>((e: ExtensionInfo) => ({
        id: `schema:${schema}/structure/extension/${e.name}`,
        label: e.name,
        level: 2,
        hasChildren: false,
        data: { kind: "leaf", objectKind: "extension", schema, name: e.name } satisfies LeafData,
      })),
    );
  }
  allItems.sort((a, b) => caseInsensitiveCompare(a.label, b.label));

  // Append per-kind failure placeholders so the user can retry just the failed
  // sub-query (the retry re-runs the whole `listStructure` — that's fine, it's
  // the smallest unit available).
  const failureNodes: TreeNode[] = payload.failures.map((f) => ({
    id: `${groupId}/__failed_${f.kind}`,
    label: `${capitalize(f.kind)} failed: ${f.message}`,
    level: 2,
    hasChildren: false,
    data: {
      kind: "group",
      placeholder: `${capitalize(f.kind)} failed: ${f.message}`,
      retry: { kind: "structure", schema },
    } satisfies GroupData,
  }));

  const children = [...allItems, ...failureNodes];
  if (children.length === 0) {
    return {
      id: groupId,
      label: GROUP_LABEL.structure,
      level: 1,
      hasChildren: true,
      data: { kind: "group" },
      children: [relativizeLevel(placeholderNode(groupId, "empty", "(empty)"), 2)],
    };
  }
  return {
    id: groupId,
    label: GROUP_LABEL.structure,
    level: 1,
    hasChildren: true,
    data: { kind: "group", countBadge: allItems.length },
    children,
  };
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
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
    // Only count real leaves toward matches — placeholder rows (group nodes with
    // no children, identifiable by their `data.kind === "group"`) shouldn't
    // count even if their text happens to contain the needle.
    const data = node.data as NodeData | undefined;
    if (data?.kind === "leaf" && node.label.toLowerCase().includes(needle)) {
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
  const sidebarScrollRef = useSidebarScrollRef();

  // Eager `relations` fetch for visible schemas. The hook de-dupes loading
  // state — this is idempotent and only the cheap query fires.
  useEffect(() => {
    if (!connectionId) return;
    for (const name of visibility.visible) {
      tree.getRelations(name);
    }
  }, [connectionId, visibility.visible, tree]);

  const visibleSchemaList = useMemo(
    () => tree.schemas.filter((s) => visibility.visible.has(s.name)),
    [tree.schemas, visibility.visible],
  );

  const builtNodes: TreeNode[] = useMemo(() => {
    return visibleSchemaList.map((s) => {
      const relationsState = tree.getRelationsState(s.name);
      const relations = tree.getRelations(s.name);
      const relationsErr = tree.getRelationsError(s.name);
      const structureState = tree.getStructureState(s.name);
      const structure = tree.getStructure(s.name);
      const structureErr = tree.getStructureError(s.name);

      const dataGroup = buildDataGroup(
        s.name,
        relationsState,
        relations,
        relationsErr?.message,
        (rel) => tree.getTableExtras(s.name, rel),
        (rel) => tree.getTableExtrasState(s.name, rel),
        (rel) => tree.getTableExtrasError(s.name, rel)?.message,
      );
      const structureGroup = buildStructureGroup(
        s.name,
        structureState,
        structure,
        structureErr?.message,
      );

      const groups: TreeNode[] = [];
      if (dataGroup) groups.push(dataGroup);
      groups.push(structureGroup);

      return {
        id: `schema:${s.name}`,
        label: s.name,
        level: 0,
        hasChildren: groups.length > 0,
        data: {
          kind: "group",
          spinner: relationsState === "loading" || relationsState === "retrying",
        } satisfies GroupData,
        children: groups,
      };
    });
  }, [visibleSchemaList, tree]);

  const filtered = useMemo(() => filterTree(builtNodes, query), [builtNodes, query]);

  const unloadedSchemaCount = useMemo(() => {
    let n = 0;
    for (const s of visibleSchemaList) {
      if (tree.getRelationsState(s.name) !== "loaded") n += 1;
    }
    return n;
  }, [visibleSchemaList, tree]);

  const unloadedStructureCount = useMemo(() => {
    let n = 0;
    for (const s of visibleSchemaList) {
      if (tree.getStructureState(s.name) === "idle") n += 1;
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
      // For function leaves, persist the OID so the placeholder tab can
      // resolve the signature on demand. The legacy `signature` field is
      // unused now (firma is fetched lazy).
      ...(data.objectKind === "function" && data.oid !== undefined
        ? { oid: data.oid }
        : {}),
    });
  }

  const onToggle = useCallback(
    (node: TreeNode, expanded: boolean) => {
      if (!expanded) return;
      const data = node.data as NodeData | undefined;
      if (!data) return;
      // Group nodes with a `lazyTrigger` field auto-fire their fetch on
      // first expand. The hook itself de-dupes (loading/loaded slot is a
      // no-op).
      if (data.kind === "group" && data.lazyTrigger) {
        const t = data.lazyTrigger;
        if (t.kind === "structure") tree.loadStructure(t.schema);
        return;
      }
      // Tables (leaf with hasChildren) trigger their per-table extras fetch.
      if (data.kind === "leaf" && data.objectKind === "table") {
        tree.loadTableExtras(data.schema, data.name);
      }
    },
    [tree],
  );

  const renderIcon = (n: TreeNode): ReactNode => {
    const data = n.data as NodeData | undefined;
    if (!data) return null;
    if (data.kind === "group") {
      // Schema-level node has level 0; placeholder rows have level >= 1.
      if (n.level === 0) return <LeafIcon kind="schema" />;
      // Group nodes carry an icon based on the last id segment.
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
      if (data.objectKind === "function" && data.overloadIndex !== undefined) {
        return <span className={styles.overloadBadge}>#{data.overloadIndex}</span>;
      }
      return null;
    }
    // Group node — spinner / retry / count, in priority order.
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
        if (retry.kind === "relations") tree.retryRelations(retry.schema);
        else if (retry.kind === "structure") tree.loadStructure(retry.schema);
        else if (retry.kind === "table-extras")
          tree.loadTableExtras(retry.schema, retry.relation);
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
    if (n.children) return null;
    return null;
  };

  const renderLabel = (n: TreeNode): ReactNode => {
    const data = n.data as NodeData | undefined;
    if (data?.kind === "group" && data.placeholder) {
      return <span className={styles.placeholderText}>{data.placeholder}</span>;
    }
    return highlightLabel(n.label, query);
  };

  const showEmpty =
    !tree.schemasLoading && !tree.schemasError && filtered.nodes.length === 0;

  let emptyMessage: ReactNode = "No matches.";
  if (query.length > 0 && (unloadedSchemaCount > 0 || unloadedStructureCount > 0)) {
    const parts: string[] = [];
    if (unloadedSchemaCount > 0) parts.push(`${unloadedSchemaCount} schemas not yet loaded`);
    if (unloadedStructureCount > 0)
      parts.push(`${unloadedStructureCount} Structure groups not yet expanded`);
    emptyMessage = (
      <>
        No matches in loaded results. {parts.join("; ")} — expand to include in search.
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
            onToggle={onToggle}
            isActivatable={(n) => (n.data as NodeData | undefined)?.kind === "leaf"}
            renderIcon={renderIcon}
            renderBadge={renderBadge}
            renderLabel={renderLabel}
            forceExpanded={filtered.forceExpanded}
            ariaLabel={`Schemas for ${connectionName}`}
            empty={showEmpty ? emptyMessage : undefined}
            scrollElementRef={sidebarScrollRef ?? undefined}
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
 * Primary actions for an active connection — currently the "+ Query" button
 * that opens a new SQL editor tab. Rendered in a dedicated always-visible
 * slot in the sidebar (not behind hover) since this is the most common
 * action for a connected database.
 */
export function SchemaPrimaryActions({ connectionId }: ToolbarProps) {
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
        openQueryTab(tabs, { initialConnectionId: connectionId, initialConnectionName: connectionName, initialSql: "" });
      }}
      className={styles.toolbarBtn}
    >
      <Terminal size={13} />
    </button>
  );
}

/**
 * Secondary toolbar items for an active connection (refresh + visibility
 * picker). Rendered in the hover-only slot of the sidebar since these are
 * maintenance actions that don't need to compete for visual attention.
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
