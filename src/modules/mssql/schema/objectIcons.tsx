import {
  Box,
  Boxes,
  Database,
  Eye,
  FunctionSquare,
  KeyRound,
  Link2,
  ListTree,
  Puzzle,
  ShieldCheck,
  ToggleLeft,
  Zap,
  type LucideIcon,
} from "lucide-react";

/**
 * Group nodes in the MSSQL schema tree.
 * Two top-level groups (data, structure) plus per-table sub-groups:
 * indexes, triggers, foreign_keys, check_constraints, default_constraints.
 */
export type GroupKind =
  | "data"
  | "structure"
  | "indexes"
  | "triggers"
  | "foreign_keys"
  | "check_constraints"
  | "default_constraints";

const GROUP: Record<GroupKind, LucideIcon> = {
  data: Boxes,
  structure: Puzzle,
  indexes: ListTree,
  triggers: Zap,
  foreign_keys: Link2,
  check_constraints: ShieldCheck,
  default_constraints: ToggleLeft,
};

export function GroupIcon({ kind, size = 13 }: { kind: GroupKind; size?: number }) {
  const Cmp = GROUP[kind];
  return <Cmp size={size} />;
}

/**
 * MSSQL leaf object kinds.
 * Separate procedure/function (vs MySQL combined "routine").
 * Added: check_constraint, default_constraint, sequence.
 */
export type LeafKind =
  | "schema"
  | "table"
  | "view"
  | "procedure"
  | "function"
  | "index"
  | "trigger"
  | "sequence"
  | "foreign_key"
  | "check_constraint"
  | "default_constraint";

const LEAF: Record<LeafKind, LucideIcon> = {
  schema: Database,
  table: Box,
  view: Eye,
  procedure: FunctionSquare,
  function: FunctionSquare,
  index: KeyRound,
  trigger: Zap,
  sequence: ListTree,
  foreign_key: Link2,
  check_constraint: ShieldCheck,
  default_constraint: ToggleLeft,
};

const LEAF_COLOR_VAR: Record<LeafKind, string | null> = {
  schema: null,
  table: null,
  view: "var(--schema-color-view)",
  procedure: "var(--schema-color-function)",
  function: "var(--schema-color-function)",
  index: null,
  trigger: null,
  sequence: "var(--schema-color-sequence)",
  foreign_key: null,
  check_constraint: null,
  default_constraint: null,
};

export function LeafIcon({ kind, size = 13 }: { kind: LeafKind; size?: number }) {
  const Cmp = LEAF[kind];
  const color = LEAF_COLOR_VAR[kind];
  return <Cmp size={size} style={color ? { color } : undefined} />;
}
