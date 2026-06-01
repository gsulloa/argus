import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Loader2, RotateCw, Terminal } from "lucide-react";
import { useTabs } from "@/platform/shell/tabs";
import { SidebarTree, type TreeNode } from "@/platform/shell/SidebarTree";
import { useSidebarScrollRef } from "@/platform/shell/sidebarScroll";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { SchemaSearch } from "@/modules/postgres/schema/SchemaSearch";
import { GroupIcon, LeafIcon, type GroupKind, type LeafKind } from "./objectIcons";
import { useSchemaTree, type PublicGroupState } from "./useSchemaTree";
import { useVisibleSchemas } from "./useVisibleSchemas";
import { VisibleSchemasPicker } from "./VisibleSchemasPicker";
import { openMssqlObjectTab } from "./openObjectTab";
import { subscribeMssqlSchemaEvent } from "./events";
import { openMssqlQueryTab } from "../openMssqlQueryTab";
import type {
  CheckConstraintInfo,
  DefaultConstraintInfo,
  ForeignKeyInfo,
  IndexInfo,
  RelationInfo,
  StructureResult,
  TableExtrasResult,
  TriggerInfo,
} from "../types";
import styles from "./SchemaTree.module.css";

interface Props {
  connectionId: string;
}

// ---------------------------------------------------------------------------
// Node data shapes
// ---------------------------------------------------------------------------

interface LeafData {
  kind: "leaf";
  objectKind: string;
  schema: string;
  name: string;
  partitioned?: boolean;
  indexed?: boolean; // indexed views
  routineKind?: "procedure" | "function";
  functionType?: string; // scalar_function / inline_tvf / tvf / clr_scalar / clr_tvf
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
  placeholder?: string;
  retry?: RetryScope;
  spinner?: boolean;
  lazyTrigger?: LazyTrigger;
  countBadge?: number;
}

type NodeData = LeafData | GroupData;

// ---------------------------------------------------------------------------
// Label maps
// ---------------------------------------------------------------------------

const GROUP_LABEL: Record<GroupKind, string> = {
  data: "Data",
  structure: "Structure",
  indexes: "Indexes",
  triggers: "Triggers",
  foreign_keys: "Foreign Keys",
  check_constraints: "Check Constraints",
  default_constraints: "Default Constraints",
};

function caseInsensitiveCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

function placeholderNode(parentId: string, key: string, label: string): TreeNode {
  return {
    id: `${parentId}/__${key}`,
    label,
    level: -1,
    hasChildren: false,
    data: { kind: "group", placeholder: label } satisfies GroupData,
  };
}

function relativizeLevel(node: TreeNode, level: number): TreeNode {
  return { ...node, level };
}

// ---------------------------------------------------------------------------
// Table sub-group builders (Indexes, Triggers, Foreign Keys, Check Constraints, Default Constraints)
// ---------------------------------------------------------------------------

function buildIndexesNode(
  schema: string,
  relation: string,
  indexes: IndexInfo[] | null,
  tableNodeId: string,
  extras: TableExtrasResult,
): TreeNode | null {
  if (indexes === null) {
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
      data: { kind: "leaf", objectKind: "index", schema, name: ix.name } satisfies LeafData,
    })),
  };
}

function buildTableTriggersNode(
  schema: string,
  relation: string,
  triggers: TriggerInfo[] | null,
  tableNodeId: string,
  extras: TableExtrasResult,
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
      data: { kind: "leaf", objectKind: "trigger", schema, name: tg.name } satisfies LeafData,
    })),
  };
}

function buildForeignKeysNode(
  schema: string,
  relation: string,
  foreignKeys: ForeignKeyInfo[] | null,
  tableNodeId: string,
  extras: TableExtrasResult,
): TreeNode | null {
  if (foreignKeys === null) {
    const failure = extras.failures.find((f) => f.kind === "foreign_keys");
    return {
      id: `${tableNodeId}/foreign_keys`,
      label: GROUP_LABEL.foreign_keys,
      level: 3,
      hasChildren: true,
      data: { kind: "group" } satisfies GroupData,
      children: [
        {
          id: `${tableNodeId}/foreign_keys/__failed`,
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
  if (foreignKeys.length === 0) return null;
  return {
    id: `${tableNodeId}/foreign_keys`,
    label: GROUP_LABEL.foreign_keys,
    level: 3,
    hasChildren: true,
    data: { kind: "group", countBadge: foreignKeys.length } satisfies GroupData,
    children: foreignKeys.map<TreeNode>((fk) => ({
      id: `${tableNodeId}/foreign_keys/${fk.name}`,
      label: fk.name,
      level: 4,
      hasChildren: false,
      data: { kind: "leaf", objectKind: "foreign_key", schema, name: fk.name } satisfies LeafData,
    })),
  };
}

function buildCheckConstraintsNode(
  schema: string,
  relation: string,
  checks: CheckConstraintInfo[] | null,
  tableNodeId: string,
  extras: TableExtrasResult,
): TreeNode | null {
  if (checks === null) {
    const failure = extras.failures.find((f) => f.kind === "check_constraints");
    return {
      id: `${tableNodeId}/check_constraints`,
      label: GROUP_LABEL.check_constraints,
      level: 3,
      hasChildren: true,
      data: { kind: "group" } satisfies GroupData,
      children: [
        {
          id: `${tableNodeId}/check_constraints/__failed`,
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
  if (checks.length === 0) return null;
  return {
    id: `${tableNodeId}/check_constraints`,
    label: GROUP_LABEL.check_constraints,
    level: 3,
    hasChildren: true,
    data: { kind: "group", countBadge: checks.length } satisfies GroupData,
    children: checks.map<TreeNode>((c) => ({
      id: `${tableNodeId}/check_constraints/${c.name}`,
      label: c.name,
      level: 4,
      hasChildren: false,
      data: { kind: "leaf", objectKind: "check_constraint", schema, name: c.name } satisfies LeafData,
    })),
  };
}

function buildDefaultConstraintsNode(
  schema: string,
  relation: string,
  defaults: DefaultConstraintInfo[] | null,
  tableNodeId: string,
  extras: TableExtrasResult,
): TreeNode | null {
  if (defaults === null) {
    const failure = extras.failures.find((f) => f.kind === "default_constraints");
    return {
      id: `${tableNodeId}/default_constraints`,
      label: GROUP_LABEL.default_constraints,
      level: 3,
      hasChildren: true,
      data: { kind: "group" } satisfies GroupData,
      children: [
        {
          id: `${tableNodeId}/default_constraints/__failed`,
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
  if (defaults.length === 0) return null;
  return {
    id: `${tableNodeId}/default_constraints`,
    label: GROUP_LABEL.default_constraints,
    level: 3,
    hasChildren: true,
    data: { kind: "group", countBadge: defaults.length } satisfies GroupData,
    children: defaults.map<TreeNode>((d) => ({
      id: `${tableNodeId}/default_constraints/${d.name}`,
      label: d.name,
      level: 4,
      hasChildren: false,
      data: { kind: "leaf", objectKind: "default_constraint", schema, name: d.name } satisfies LeafData,
    })),
  };
}

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
  if (!extras) return [];
  const out: TreeNode[] = [];
  const indexesNode = buildIndexesNode(schema, relation, extras.indexes, tableNodeId, extras);
  if (indexesNode) out.push(indexesNode);
  const triggersNode = buildTableTriggersNode(schema, relation, extras.triggers, tableNodeId, extras);
  if (triggersNode) out.push(triggersNode);
  const fkNode = buildForeignKeysNode(schema, relation, extras.foreign_keys, tableNodeId, extras);
  if (fkNode) out.push(fkNode);
  const checkNode = buildCheckConstraintsNode(schema, relation, extras.check_constraints, tableNodeId, extras);
  if (checkNode) out.push(checkNode);
  const defaultNode = buildDefaultConstraintsNode(schema, relation, extras.default_constraints, tableNodeId, extras);
  if (defaultNode) out.push(defaultNode);
  if (out.length === 0) {
    out.push(relativizeLevel(placeholderNode(tableNodeId, "empty", "(no indexes, triggers, or constraints)"), 3));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Data group builder (tables + views, including indexed views)
// ---------------------------------------------------------------------------

function buildTableNode(
  schema: string,
  t: RelationInfo,
  extrasState: PublicGroupState,
  extras: TableExtrasResult | null,
  extrasErrorMessage: string | undefined,
): TreeNode {
  const id = `schema:${schema}/data/${t.name}`;
  const isPartitioned = t.kind === "partitioned";
  const isIndexedView = t.kind === "indexed_view";
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
      partitioned: isPartitioned,
      indexed: isIndexedView,
    } satisfies LeafData,
    children: buildTableChildren(schema, t.name, id, extrasState, extras, extrasErrorMessage),
  };
}

function buildDataGroup(
  schema: string,
  state: PublicGroupState,
  payload: { tables: RelationInfo[]; views: RelationInfo[] } | null,
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
    if (!payload) {
      return {
        id: groupId,
        label: GROUP_LABEL.data,
        level: 1,
        hasChildren: true,
        data: { ...baseGroupData, spinner: true },
        children: [relativizeLevel(placeholderNode(groupId, "retrying", "Slow — retrying…"), 2)],
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
      indexed: v.kind === "indexed_view",
    } satisfies LeafData,
  }));

  const all = [...tableNodes, ...viewNodes];
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

// ---------------------------------------------------------------------------
// Structure group builder
// MSSQL has FOUR separate buckets: procedures / functions / triggers / sequences
// (vs MySQL's combined routines/triggers/events)
// ---------------------------------------------------------------------------

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
      children: [relativizeLevel(placeholderNode(groupId, "idle", "(expand to load)"), 2)],
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
  if (!payload) {
    return {
      id: groupId,
      label: GROUP_LABEL.structure,
      level: 1,
      hasChildren: false,
      data: { kind: "group" },
    };
  }

  const allItems: TreeNode[] = [];

  // Procedures (separate bucket from functions)
  if (payload.procedures !== null) {
    for (const r of payload.procedures) {
      allItems.push({
        id: `schema:${schema}/structure/procedure/${r.name}`,
        label: r.name,
        level: 2,
        hasChildren: false,
        data: {
          kind: "leaf",
          objectKind: "procedure",
          schema,
          name: r.name,
          routineKind: "procedure",
        } satisfies LeafData,
      });
    }
  }

  // Functions (separate bucket with kind badge)
  if (payload.functions !== null) {
    for (const f of payload.functions) {
      allItems.push({
        id: `schema:${schema}/structure/function/${f.name}`,
        label: f.name,
        level: 2,
        hasChildren: false,
        data: {
          kind: "leaf",
          objectKind: "function",
          schema,
          name: f.name,
          routineKind: "function",
          functionType: f.function_type ?? undefined,
        } satisfies LeafData,
      });
    }
  }

  // Triggers (schema-level)
  if (payload.triggers !== null) {
    for (const tg of payload.triggers) {
      allItems.push({
        id: `schema:${schema}/structure/trigger/${tg.name}`,
        label: tg.name,
        level: 2,
        hasChildren: false,
        data: {
          kind: "leaf",
          objectKind: "trigger",
          schema,
          name: tg.name,
        } satisfies LeafData,
      });
    }
  }

  // Sequences
  if (payload.sequences !== null) {
    for (const seq of payload.sequences) {
      allItems.push({
        id: `schema:${schema}/structure/sequence/${seq.name}`,
        label: seq.name,
        level: 2,
        hasChildren: false,
        data: {
          kind: "leaf",
          objectKind: "sequence",
          schema,
          name: seq.name,
        } satisfies LeafData,
      });
    }
  }

  allItems.sort((a, b) => caseInsensitiveCompare(a.label, b.label));

  // Per-kind failure placeholders
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

// ---------------------------------------------------------------------------
// Function type badge labels
// ---------------------------------------------------------------------------
const FUNCTION_TYPE_BADGE: Record<string, string> = {
  scalar_function: "SCALAR",
  inline_tvf: "INLINE-TVF",
  tvf: "TVF",
  clr_scalar: "CLR-SCALAR",
  clr_tvf: "CLR-TVF",
  fn: "SCALAR",
  if: "INLINE-TVF",
  tf: "TVF",
  fs: "CLR-SCALAR",
  ft: "CLR-TVF",
};

// ---------------------------------------------------------------------------
// Search / filter
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function MssqlSchemaTree({ connectionId }: Props) {
  const tree = useSchemaTree(connectionId);
  const visibility = useVisibleSchemas(connectionId, tree.schemas);
  const [query, setQuery] = useState("");
  const tabs = useTabs();
  const { items: connections } = useConnections();
  const connectionName =
    connections.find((c) => c.id === connectionId)?.name ?? connectionId;
  const sidebarScrollRef = useSidebarScrollRef();

  // Eager `relations` fetch for visible schemas.
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
        // D8: MSSQL label is "Schemas"
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
    openMssqlObjectTab(tabs, {
      connectionId,
      connectionName,
      schema: data.schema,
      kind: data.objectKind,
      name: data.name,
      ...(data.routineKind ? { routineKind: data.routineKind } : {}),
      ...(data.functionType ? { functionType: data.functionType } : {}),
    });
  }

  const onToggle = useCallback(
    (node: TreeNode, expanded: boolean) => {
      if (!expanded) return;
      const data = node.data as NodeData | undefined;
      if (!data) return;
      if (data.kind === "group" && data.lazyTrigger) {
        const t = data.lazyTrigger;
        if (t.kind === "structure") tree.loadStructure(t.schema);
        return;
      }
      // Table leaf nodes (which have children) trigger the per-table extras fetch.
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
      // Schema-level node (level 0) → database icon
      if (n.level === 0) return <LeafIcon kind="schema" />;
      // Group nodes carry an icon based on the last id segment.
      const segs = n.id.split("/");
      const last = segs[segs.length - 1] as GroupKind | undefined;
      if (last && last in GROUP_LABEL) return <GroupIcon kind={last as GroupKind} />;
      return null;
    }
    const leafKindMap: Record<string, LeafKind> = {
      table: "table",
      view: "view",
      procedure: "procedure",
      function: "function",
      index: "index",
      trigger: "trigger",
      sequence: "sequence",
      foreign_key: "foreign_key",
      check_constraint: "check_constraint",
      default_constraint: "default_constraint",
    };
    const leafKind = leafKindMap[data.objectKind];
    if (!leafKind) return null;
    return <LeafIcon kind={leafKind} />;
  };

  const renderBadge = (n: TreeNode): ReactNode => {
    const data = n.data as NodeData | undefined;
    if (!data) return null;
    if (data.kind === "leaf") {
      if (data.partitioned) return <span className={styles.tableBadge}>partitioned</span>;
      if (data.indexed) return <span className={styles.indexedBadge}>INDEXED</span>;
      // Function kind badge (SCALAR / INLINE-TVF / TVF / CLR-SCALAR / CLR-TVF)
      if (data.objectKind === "function" && data.functionType) {
        const badge = FUNCTION_TYPE_BADGE[data.functionType.toLowerCase()] ?? data.functionType.toUpperCase();
        return <span className={styles.routineBadge}>{badge}</span>;
      }
      // Procedure/function generic badge
      if (data.objectKind === "procedure") {
        return <span className={styles.routineBadge}>PROC</span>;
      }
      return null;
    }
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

// ---------------------------------------------------------------------------
// Toolbar components
// ---------------------------------------------------------------------------

interface ToolbarProps {
  connectionId: string;
}

/**
 * Primary actions: "+ Query" button, always visible on connected MSSQL rows.
 */
export function MssqlSchemaPrimaryActions({ connectionId }: ToolbarProps) {
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
        openMssqlQueryTab(tabs, {
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
 * Secondary toolbar: refresh + visibility picker (hover-only slot).
 */
export function MssqlSchemaToolbar({ connectionId }: ToolbarProps) {
  const tree = useSchemaTree(connectionId);
  const visibility = useVisibleSchemas(connectionId, tree.schemas);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    return subscribeMssqlSchemaEvent((e) => {
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
