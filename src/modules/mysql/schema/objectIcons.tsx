import {
  Box,
  Boxes,
  Calendar,
  Database,
  Eye,
  FunctionSquare,
  KeyRound,
  Link2,
  ListTree,
  Puzzle,
  Zap,
  type LucideIcon,
} from "lucide-react";

/**
 * Group nodes in the MySQL schema tree. Two top-level groups (data, structure)
 * plus per-table sub-groups (indexes, triggers, foreign_keys).
 * MySQL has no materialized views — drops that case from Postgres.
 */
export type GroupKind = "data" | "structure" | "indexes" | "triggers" | "foreign_keys";

const GROUP: Record<GroupKind, LucideIcon> = {
  data: Boxes,
  structure: Puzzle,
  indexes: ListTree,
  triggers: Zap,
  foreign_keys: Link2,
};

export function GroupIcon({ kind, size = 13 }: { kind: GroupKind; size?: number }) {
  const Cmp = GROUP[kind];
  return <Cmp size={size} />;
}

/**
 * MySQL leaf object kinds. No materialized_view / type / extension / sequence.
 * Added: routine, event, foreign_key.
 */
export type LeafKind =
  | "schema"
  | "table"
  | "view"
  | "routine"
  | "index"
  | "trigger"
  | "event"
  | "foreign_key";

const LEAF: Record<LeafKind, LucideIcon> = {
  schema: Database,
  table: Box,
  view: Eye,
  routine: FunctionSquare,
  index: KeyRound,
  trigger: Zap,
  event: Calendar,
  foreign_key: Link2,
};

const LEAF_COLOR_VAR: Record<LeafKind, string | null> = {
  schema: null,
  table: null,
  view: "var(--schema-color-view)",
  routine: "var(--schema-color-function)",
  index: null,
  trigger: null,
  event: "var(--schema-color-event)",
  foreign_key: null,
};

export function LeafIcon({ kind, size = 13 }: { kind: LeafKind; size?: number }) {
  const Cmp = LEAF[kind];
  const color = LEAF_COLOR_VAR[kind];
  return <Cmp size={size} style={color ? { color } : undefined} />;
}
