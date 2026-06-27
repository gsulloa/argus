import type {
  FilterRow,
  FilterTree,
  FilterValue,
  Operator,
} from "../types";
import { EMPTY_FILTER_ROW } from "../types";

export function addRow(
  tree: FilterTree,
  atIndex?: number,
  row?: FilterRow,
): FilterTree {
  const newRow = row ?? EMPTY_FILTER_ROW;
  const rows = tree.rows.slice();
  if (atIndex === undefined) {
    rows.push(newRow);
  } else {
    rows.splice(atIndex, 0, newRow);
  }
  return { ...tree, rows };
}

export function removeRow(tree: FilterTree, index: number): FilterTree {
  if (tree.rows.length === 1) {
    return { ...tree, rows: [EMPTY_FILTER_ROW] };
  }
  const rows = tree.rows.filter((_, i) => i !== index);
  return { ...tree, rows };
}

export function setRow(tree: FilterTree, index: number, row: FilterRow): FilterTree {
  const rows = tree.rows.slice();
  rows[index] = row;
  return { ...tree, rows };
}

export function setEnabled(tree: FilterTree, index: number, enabled: boolean): FilterTree {
  const row = tree.rows[index];
  if (!row) return tree;
  return setRow(tree, index, { ...row, enabled });
}

export function setCombinator(tree: FilterTree, combinator: "AND" | "OR"): FilterTree {
  return { ...tree, combinator };
}

export function clearAllRows(tree: FilterTree): FilterTree {
  return { ...tree, rows: [EMPTY_FILTER_ROW] };
}

/**
 * When the operator changes, the value shape may need to flip
 * (scalar ↔ array ↔ {min,max} ↔ absent). Coerce the existing value to the
 * new shape: keep what we can, drop what doesn't fit.
 */
export function coerceValueForOperator(
  prev: FilterValue | undefined,
  op: Operator,
): FilterValue | undefined {
  if (op === "IS NULL" || op === "IS NOT NULL") return undefined;
  if (op === "RAW") return typeof prev === "string" ? prev : "";
  if (op === "BETWEEN") {
    if (prev && typeof prev === "object" && !Array.isArray(prev)) return prev;
    return { min: "", max: "" };
  }
  if (op === "In" || op === "NotIn") {
    if (Array.isArray(prev)) return prev;
    return [];
  }
  // Single-bound binary op.
  if (prev === undefined) return "";
  if (Array.isArray(prev)) return prev[0] ?? "";
  if (typeof prev === "object") return "";
  return prev;
}
