/**
 * lockingCondition.ts — task 10.4
 *
 * Builds the optimistic-locking ConditionExpression fragment:
 *   `attribute_exists(#pkPlaceholder) AND #vPlaceholder = :prev`
 *
 * Returns null when locking is inactive (versionAttr is empty, or prevValue is undefined).
 */

import type { AttributeValue, AttributeMap } from "../types";

export interface LockingCondition {
  condition_expression: string;
  expression_attribute_names: Record<string, string>;
  expression_attribute_values: AttributeMap;
}

/**
 * Builds the optimistic-locking ConditionExpression fragment.
 * Returns null when locking is inactive (versionAttr is empty, or prevValue is undefined).
 */
export function buildLockingCondition(
  versionAttr: string,
  prevValue: AttributeValue | undefined,
  pkAttr: string,
  // existing caller-supplied names/values to avoid placeholder collisions
  callerNames?: Record<string, string> | null,
  callerValues?: AttributeMap | null,
): LockingCondition | null {
  if (!versionAttr || prevValue === undefined) return null;

  // allocate placeholders that don't collide with caller's keys
  const existingNameKeys = new Set(Object.keys(callerNames ?? {}));
  const existingValueKeys = new Set(Object.keys(callerValues ?? {}));

  const allocName = (base: string): string => {
    let i = 0;
    let candidate = `#${base}${i}`;
    while (existingNameKeys.has(candidate)) {
      i++;
      candidate = `#${base}${i}`;
    }
    existingNameKeys.add(candidate);
    return candidate;
  };

  const allocValue = (): string => {
    let i = 0;
    let candidate = `:lock${i}`;
    while (existingValueKeys.has(candidate)) {
      i++;
      candidate = `:lock${i}`;
    }
    existingValueKeys.add(candidate);
    return candidate;
  };

  const pkPlaceholder = allocName("pk");
  const vPlaceholder = allocName("v");
  const prevPlaceholder = allocValue();

  return {
    condition_expression: `attribute_exists(${pkPlaceholder}) AND ${vPlaceholder} = ${prevPlaceholder}`,
    expression_attribute_names: {
      ...(callerNames ?? {}),
      [pkPlaceholder]: pkAttr,
      [vPlaceholder]: versionAttr,
    },
    expression_attribute_values: {
      ...(callerValues ?? {}),
      [prevPlaceholder]: prevValue,
    },
  };
}

/**
 * Merges an existing condition expression with a locking fragment using AND.
 * If existing is null/empty, returns addition as-is.
 */
export function mergeConditionExpression(
  existing: string | null,
  addition: string,
): string {
  if (!existing) return addition;
  return `${existing} AND ${addition}`;
}
