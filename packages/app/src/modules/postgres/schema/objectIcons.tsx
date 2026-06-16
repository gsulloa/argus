import {
  Box,
  Boxes,
  Database,
  Eye,
  FunctionSquare,
  KeyRound,
  Layers,
  ListTree,
  Package,
  Puzzle,
  Sigma,
  Zap,
  type LucideIcon,
} from "lucide-react";

/**
 * Group nodes in the schema tree. Two top-level groups (`data`, `structure`)
 * plus the per-table sub-groups (`indexes`, `triggers`).
 */
export type GroupKind = "data" | "structure" | "indexes" | "triggers";

const GROUP: Record<GroupKind, LucideIcon> = {
  data: Boxes,
  structure: Puzzle,
  indexes: ListTree,
  triggers: Zap,
};

export function GroupIcon({ kind, size = 13 }: { kind: GroupKind; size?: number }) {
  const Cmp = GROUP[kind];
  return <Cmp size={size} />;
}

export type LeafKind =
  | "schema"
  | "table"
  | "view"
  | "materialized_view"
  | "function"
  | "type"
  | "extension"
  | "index"
  | "trigger";

const LEAF: Record<LeafKind, LucideIcon> = {
  schema: Database,
  table: Box,
  view: Eye,
  materialized_view: Layers,
  function: FunctionSquare,
  type: Sigma,
  extension: Package,
  index: KeyRound,
  trigger: Zap,
};

/**
 * CSS variable name driving the icon color for each leaf kind. Defined in
 * `SchemaTree.module.css` so the values can be themed centrally.
 */
const LEAF_COLOR_VAR: Record<LeafKind, string | null> = {
  schema: null,
  table: null,
  view: "var(--schema-color-view)",
  materialized_view: "var(--schema-color-matview)",
  function: "var(--schema-color-function)",
  type: "var(--schema-color-type)",
  extension: "var(--schema-color-extension)",
  index: null,
  trigger: null,
};

export function LeafIcon({ kind, size = 13 }: { kind: LeafKind; size?: number }) {
  const Cmp = LEAF[kind];
  const color = LEAF_COLOR_VAR[kind];
  return <Cmp size={size} style={color ? { color } : undefined} />;
}
