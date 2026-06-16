import type { AttributeValue, AttributeMap } from "../types";

// ---------------------------------------------------------------------------
// §5.1  Tag-aware deep equality
// ---------------------------------------------------------------------------

const VALID_TAGS = new Set([
  "S",
  "N",
  "B",
  "BOOL",
  "NULL",
  "L",
  "M",
  "SS",
  "NS",
  "BS",
]);

/** Returns true iff `a` and `b` represent the same DynamoDB value. */
export function attrValueEquals(a: AttributeValue, b: AttributeValue): boolean {
  // Determine the tag of each value
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);

  if (aKeys.length !== 1 || bKeys.length !== 1) return false;

  // aKeys and bKeys each have exactly one element — non-null is guaranteed by the guard above
  const aTag = aKeys[0]! as keyof AttributeValue;
  const bTag = bKeys[0]! as keyof AttributeValue;

  if (aTag !== bTag) return false;

  const tag = aTag;

  switch (tag) {
    case "S":
      return (a as { S: string }).S === (b as { S: string }).S;
    case "N":
      return (a as { N: string }).N === (b as { N: string }).N;
    case "B":
      return (a as { B: string }).B === (b as { B: string }).B;
    case "BOOL":
      return (a as { BOOL: boolean }).BOOL === (b as { BOOL: boolean }).BOOL;
    case "NULL":
      // Both NULL: true
      return true;
    case "L": {
      const aL = (a as { L: AttributeValue[] }).L;
      const bL = (b as { L: AttributeValue[] }).L;
      if (aL.length !== bL.length) return false;
      // i is always in bounds because we checked equal lengths
      return aL.every((el, i) => attrValueEquals(el, bL[i]!));
    }
    case "M": {
      const aM = (a as { M: AttributeMap }).M;
      const bM = (b as { M: AttributeMap }).M;
      const aKs = Object.keys(aM);
      const bKs = Object.keys(bM);
      if (aKs.length !== bKs.length) return false;
      // k is always present in bM (checked by `k in bM`) and aM (from Object.keys)
      return aKs.every((k) => k in bM && attrValueEquals(aM[k]!, bM[k]!));
    }
    case "SS": {
      const aSet = [...new Set((a as { SS: string[] }).SS)].sort();
      const bSet = [...new Set((b as { SS: string[] }).SS)].sort();
      if (aSet.length !== bSet.length) return false;
      return aSet.every((el, i) => el === bSet[i]);
    }
    case "NS": {
      const aSet = [...new Set((a as { NS: string[] }).NS)].sort();
      const bSet = [...new Set((b as { NS: string[] }).NS)].sort();
      if (aSet.length !== bSet.length) return false;
      return aSet.every((el, i) => el === bSet[i]);
    }
    case "BS": {
      const aSet = [...new Set((a as { BS: string[] }).BS)].sort();
      const bSet = [...new Set((b as { BS: string[] }).BS)].sort();
      if (aSet.length !== bSet.length) return false;
      return aSet.every((el, i) => el === bSet[i]);
    }
    default: {
      // Exhaustiveness guard — unknown tag is never equal
      const _exhaustive: never = tag;
      void _exhaustive;
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// §5.2  Diff two AttributeMaps
// ---------------------------------------------------------------------------

/**
 * Computes the minimal diff between `original` and `edited`.
 *
 * Returns:
 *  - `set`    — attributes to create or update (inputs for `update_item.updates.set`)
 *  - `remove` — attribute names to delete     (inputs for `update_item.updates.remove`)
 */
export function diffAttributeMaps(
  original: AttributeMap,
  edited: AttributeMap,
): { set: AttributeMap; remove: string[] } {
  const set: AttributeMap = {};
  const remove: string[] = [];

  for (const k of Object.keys(edited)) {
    // k is always present in edited (from Object.keys); original[k] is guarded by `k in original`
    if (!(k in original) || !attrValueEquals(original[k]!, edited[k]!)) {
      set[k] = edited[k]!;
    }
  }

  for (const k of Object.keys(original)) {
    if (!(k in edited)) {
      remove.push(k);
    }
  }

  return { set, remove };
}

// ---------------------------------------------------------------------------
// §5.3  Validate that every value in a parsed JSON object is a tagged AV
// ---------------------------------------------------------------------------

/**
 * Validates that `parsed` is a plain object where every attribute value
 * (at every nesting depth) is a single-key object whose key is a recognised
 * DynamoDB type tag.
 *
 * Only validates the tag — does NOT type-check inner values.
 *
 * @returns `null` on success, or `{ path }` pointing to the first violation.
 */
export function validateTaggedItem(
  parsed: unknown,
): { path: string } | null {
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return { path: "" };
  }

  return validateAttributeMap(parsed as Record<string, unknown>, "");
}

// Internal helpers

function validateAttributeMap(
  obj: Record<string, unknown>,
  prefix: string,
): { path: string } | null {
  for (const key of Object.keys(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const result = validateAttributeValue(obj[key], fullPath);
    if (result !== null) return result;
  }
  return null;
}

function validateAttributeValue(
  value: unknown,
  path: string,
): { path: string } | null {
  // Must be a plain non-null, non-array object
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { path };
  }

  const keys = Object.keys(value as object);

  // Must have exactly one key
  if (keys.length !== 1) {
    return { path };
  }

  // keys has exactly one element — non-null is guaranteed by the guard above
  const tag = keys[0]!;

  // Tag must be recognised
  if (!VALID_TAGS.has(tag)) {
    return { path };
  }

  const inner = (value as Record<string, unknown>)[tag];

  // Recurse into L elements
  if (tag === "L") {
    if (!Array.isArray(inner)) return { path };
    for (let i = 0; i < (inner as unknown[]).length; i++) {
      const result = validateAttributeValue(
        (inner as unknown[])[i],
        `${path}[${i}]`,
      );
      if (result !== null) return result;
    }
  }

  // Recurse into M values
  if (tag === "M") {
    if (
      inner === null ||
      typeof inner !== "object" ||
      Array.isArray(inner)
    ) {
      return { path };
    }
    const result = validateAttributeMap(
      inner as Record<string, unknown>,
      path,
    );
    if (result !== null) return result;
  }

  return null;
}
