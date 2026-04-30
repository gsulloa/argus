import type {
  ColumnRef,
  Condition,
  FilterNode,
  FilterTree,
  FilterValue,
  Operator,
} from "../types";

/** Empty Condition leaf with sensible defaults. */
export function emptyCondition(column?: ColumnRef): Condition {
  return {
    column: column ?? { kind: "any_column" },
    op: "=",
    value: undefined,
  };
}

export function emptyTree(): FilterTree {
  return { children: [] };
}

export function addRootCondition(
  tree: FilterTree,
  cond: Condition = emptyCondition(),
): FilterTree {
  return {
    children: [
      ...tree.children,
      { kind: "condition", ...cond },
    ],
  };
}

export function addRootOrGroup(
  tree: FilterTree,
  seed: Condition = emptyCondition(),
): FilterTree {
  return {
    children: [
      ...tree.children,
      {
        kind: "or_group",
        children: [{ kind: "condition", ...seed }],
      },
    ],
  };
}

export function setRootChild(
  tree: FilterTree,
  index: number,
  next: FilterNode,
): FilterTree {
  const children = tree.children.slice();
  children[index] = next;
  return { children };
}

export function removeRootChild(tree: FilterTree, index: number): FilterTree {
  return { children: tree.children.filter((_, i) => i !== index) };
}

export function setOrChild(
  tree: FilterTree,
  groupIndex: number,
  childIndex: number,
  next: FilterNode,
): FilterTree {
  const node = tree.children[groupIndex];
  if (!node || node.kind !== "or_group") return tree;
  const orChildren = node.children.slice();
  orChildren[childIndex] = next;
  const children = tree.children.slice();
  children[groupIndex] = { ...node, children: orChildren };
  return { children };
}

/**
 * Remove a single condition from an OR group. If the group ends up empty
 * the group itself collapses out of the tree (per spec: "removing the last
 * condition from an OR group MUST collapse the group node out of the tree").
 */
export function removeOrChild(
  tree: FilterTree,
  groupIndex: number,
  childIndex: number,
): FilterTree {
  const node = tree.children[groupIndex];
  if (!node || node.kind !== "or_group") return tree;
  const orChildren = node.children.filter((_, i) => i !== childIndex);
  const children = tree.children.slice();
  if (orChildren.length === 0) {
    children.splice(groupIndex, 1);
    return { children };
  }
  children[groupIndex] = { ...node, children: orChildren };
  return { children };
}

export function addOrChildCondition(
  tree: FilterTree,
  groupIndex: number,
  cond: Condition = emptyCondition(),
): FilterTree {
  const node = tree.children[groupIndex];
  if (!node || node.kind !== "or_group") return tree;
  const orChildren = [
    ...node.children,
    { kind: "condition" as const, ...cond },
  ];
  const children = tree.children.slice();
  children[groupIndex] = { ...node, children: orChildren };
  return { children };
}

export function updateConditionField<K extends keyof Condition>(
  cond: Condition,
  field: K,
  value: Condition[K],
): Condition {
  return { ...cond, [field]: value };
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
