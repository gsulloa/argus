/**
 * useInferredColumns — task 10.2
 *
 * Returns a stable, ordered column list for the Tabla view:
 *   1. PK attribute (always first) — from the active index's key_schema
 *   2. SK attribute (second, if the index has a range key)
 *   3. Top-N attributes (default N=10) by frequency in the loaded sample,
 *      alphabetical tie-break among equal-frequency attributes
 *   4. Fixed "More…" sentinel (always last)
 *
 * Stability contract (spec §10.2):
 *   - Once a column is in the accepted list it NEVER moves.
 *   - New attributes may APPEND (before "More…") when their frequency exceeds
 *     the frequency of the lowest-ranked accepted data column.
 *   - When items transitions from non-empty → empty (reset), the accepted
 *     list clears so the next run starts fresh.
 *   - When indexName changes, the accepted list also resets (new key schema).
 */

import { useMemo, useRef } from "react";
import type { AttributeMap } from "./types";
import type { TableDescription } from "@/modules/dynamo/tables/types";
import type { ColumnCategory } from "@/platform/table/columnWidths";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const MORE_COLUMN_ID = "__more__";
export const TOP_N_DEFAULT = 10;

/** All possible DynamoDB AttributeValue tags. */
export type DynamoTag =
  | "S"
  | "N"
  | "BOOL"
  | "NULL"
  | "L"
  | "M"
  | "B"
  | "SS"
  | "NS"
  | "BS";

/** UUID v4 regex (case-insensitive). */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Returns the DynamoDB tag present in the given AttributeValue, or null if
 * the value is empty / unrecognised.
 */
export function getTag(value: Record<string, unknown>): DynamoTag | null {
  const tags: DynamoTag[] = [
    "S", "N", "BOOL", "NULL", "L", "M", "B", "SS", "NS", "BS",
  ];
  for (const tag of tags) {
    if (tag in value) return tag;
  }
  return null;
}

/**
 * Maps a dominant DynamoDB AttributeValue tag to a ColumnCategory.
 * If the column is a key column with tag "S" and the sample has ≥80% UUID
 * values, the category is "uuid" instead of "text".
 */
export function tagToCategory(
  tag: DynamoTag,
  opts: { isKey: boolean; uuidFraction: number },
): ColumnCategory {
  switch (tag) {
    case "BOOL":
    case "NULL":
      return "boolean";
    case "N":
      return "numeric";
    case "B":
      return "binary";
    case "L":
    case "M":
    case "SS":
    case "NS":
    case "BS":
      return "json";
    case "S":
      if (opts.isKey && opts.uuidFraction >= 0.8) return "uuid";
      return "text";
    default:
      return "other";
  }
}

export interface InferredColumn {
  /** Attribute name. `MORE_COLUMN_ID` for the "More…" column. */
  id: string;
  /** Human-readable header label. */
  label: string;
  /** Whether this column is a key column (PK or SK). */
  isKey: boolean;
  /**
   * The most frequent AttributeValue tag in the loaded sample.
   * `null` for the "More…" column or when no sample data exists.
   */
  dominantTag: DynamoTag | null;
  /**
   * Semantic category derived from `dominantTag`, used for default column
   * widths via the column-width-preferences capability.
   */
  category: ColumnCategory;
}

// ---------------------------------------------------------------------------
// Helper: resolve key names from description + optional index
// ---------------------------------------------------------------------------

function resolveKeyNames(
  describe: TableDescription | null,
  indexName: string | null,
): { pk: string | null; sk: string | null } {
  if (!describe) return { pk: null, sk: null };

  // Pick the right key_schema: primary if indexName is null, else look up GSI/LSI
  let schema = describe.key_schema;

  if (indexName !== null) {
    const gsi = describe.global_secondary_indexes.find(
      (g) => g.index_name === indexName,
    );
    if (gsi) {
      schema = gsi.key_schema;
    } else {
      const lsi = describe.local_secondary_indexes.find(
        (l) => l.index_name === indexName,
      );
      if (lsi) {
        schema = lsi.key_schema;
      }
    }
  }

  const pk =
    schema.find((k) => k.key_type === "HASH")?.attribute_name ?? null;
  const sk =
    schema.find((k) => k.key_type === "RANGE")?.attribute_name ?? null;

  return { pk, sk };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useInferredColumns(
  items: AttributeMap[],
  describe: TableDescription | null,
  indexName: string | null,
  topN: number = TOP_N_DEFAULT,
): InferredColumn[] {
  // accepted: mutable ref — persists across renders, tracks the ordered list
  // of non-key, non-more columns already shown.  Reset when:
  //   (a) indexName changes (key schema changes), or
  //   (b) items transitions >0 → 0 (reset).
  const acceptedRef = useRef<string[]>([]);
  const prevIndexNameRef = useRef<string | null | undefined>(undefined); // undefined = uninitialized
  const prevItemsLengthRef = useRef<number>(0);

  // Reset on index change
  if (prevIndexNameRef.current !== undefined && prevIndexNameRef.current !== indexName) {
    acceptedRef.current = [];
  }
  prevIndexNameRef.current = indexName;

  // Reset on items going empty (run reset)
  if (prevItemsLengthRef.current > 0 && items.length === 0) {
    acceptedRef.current = [];
  }
  prevItemsLengthRef.current = items.length;

  return useMemo(() => {
    const { pk, sk } = resolveKeyNames(describe, indexName);

    // ── Tag frequency per attribute ────────────────────────────────────────
    // For each attribute, count occurrences of each DynamoDB tag so we can
    // determine the dominant tag and check UUID heuristic for key columns.
    const tagFreq = new Map<string, Map<DynamoTag, number>>();
    // Track S values per attribute for UUID heuristic
    const sValues = new Map<string, string[]>();

    // Build frequency map (exclude pk, sk — they're pinned)
    const freq = new Map<string, number>();
    for (const item of items) {
      for (const attr of Object.keys(item)) {
        const val = item[attr];
        if (val) {
          const tag = getTag(val as Record<string, unknown>);
          if (tag !== null) {
            if (!tagFreq.has(attr)) tagFreq.set(attr, new Map());
            const m = tagFreq.get(attr)!;
            m.set(tag, (m.get(tag) ?? 0) + 1);

            if (tag === "S" && typeof (val as { S?: unknown }).S === "string") {
              if (!sValues.has(attr)) sValues.set(attr, []);
              sValues.get(attr)!.push((val as { S: string }).S);
            }
          }
        }
        if (attr === pk || attr === sk) continue;
        freq.set(attr, (freq.get(attr) ?? 0) + 1);
      }
    }

    // Also track tag frequencies for key columns (pk/sk) — they are not in freq
    if (pk) {
      for (const item of items) {
        const val = item[pk];
        if (val) {
          const tag = getTag(val as Record<string, unknown>);
          if (tag !== null) {
            if (!tagFreq.has(pk)) tagFreq.set(pk, new Map());
            const m = tagFreq.get(pk)!;
            m.set(tag, (m.get(tag) ?? 0) + 1);
            if (tag === "S" && typeof (val as { S?: unknown }).S === "string") {
              if (!sValues.has(pk)) sValues.set(pk, []);
              sValues.get(pk)!.push((val as { S: string }).S);
            }
          }
        }
      }
    }
    if (sk) {
      for (const item of items) {
        const val = item[sk];
        if (val) {
          const tag = getTag(val as Record<string, unknown>);
          if (tag !== null) {
            if (!tagFreq.has(sk)) tagFreq.set(sk, new Map());
            const m = tagFreq.get(sk)!;
            m.set(tag, (m.get(tag) ?? 0) + 1);
            if (tag === "S" && typeof (val as { S?: unknown }).S === "string") {
              if (!sValues.has(sk)) sValues.set(sk, []);
              sValues.get(sk)!.push((val as { S: string }).S);
            }
          }
        }
      }
    }

    /**
     * Derives the dominant DynamoDB tag for an attribute from the sample.
     * Returns null if no data observed.
     */
    function getDominantTag(attr: string): DynamoTag | null {
      const m = tagFreq.get(attr);
      if (!m || m.size === 0) return null;
      let bestTag: DynamoTag | null = null;
      let bestCount = -1;
      for (const [tag, count] of m.entries()) {
        if (count > bestCount) {
          bestCount = count;
          bestTag = tag;
        }
      }
      return bestTag;
    }

    /**
     * Computes the fraction of sampled S values for an attribute that match
     * the UUID regex. Returns 0 if no S values were observed.
     */
    function getUuidFraction(attr: string): number {
      const vals = sValues.get(attr);
      if (!vals || vals.length === 0) return 0;
      const uuidCount = vals.filter((v) => UUID_REGEX.test(v)).length;
      return uuidCount / vals.length;
    }

    /**
     * Builds an InferredColumn for the given attribute id with category derived
     * from the dominant tag.
     */
    function buildCol(id: string, isKey: boolean): InferredColumn {
      const dominantTag = getDominantTag(id);
      const uuidFraction = dominantTag === "S" ? getUuidFraction(id) : 0;
      const category: ColumnCategory = dominantTag
        ? tagToCategory(dominantTag, { isKey, uuidFraction })
        : "other";
      return { id, label: id, isKey, dominantTag, category };
    }

    // Helper: frequency of an attr (0 if unknown)
    const getFreq = (attr: string) => freq.get(attr) ?? 0;

    const accepted = acceptedRef.current;

    // Find the lowest frequency among already-accepted columns (after pk/sk)
    // so we know if a new attribute qualifies for insertion.
    const minAcceptedFreq =
      accepted.length > 0
        ? Math.min(...accepted.map(getFreq))
        : -Infinity; // if accepted is empty, everything qualifies

    // Candidates: attributes not yet in accepted and not a key
    const candidates = [...freq.keys()].filter(
      (attr) => !accepted.includes(attr),
    );

    // Sort candidates by frequency desc, then alphabetically asc for ties
    candidates.sort((a, b) => {
      const diff = getFreq(b) - getFreq(a);
      if (diff !== 0) return diff;
      return a.localeCompare(b);
    });

    // How many slots are left for new columns?
    const remaining = topN - accepted.length;

    if (remaining > 0 && candidates.length > 0) {
      // Only accept candidates whose frequency beats the current lowest
      for (const cand of candidates) {
        if (accepted.length >= topN) break;
        if (getFreq(cand) > minAcceptedFreq || accepted.length < topN) {
          accepted.push(cand);
          if (accepted.length >= topN) break;
        }
      }
    }

    // Build final column list
    const cols: InferredColumn[] = [];

    if (pk) {
      cols.push(buildCol(pk, true));
    }
    if (sk) {
      cols.push(buildCol(sk, true));
    }
    for (const attr of accepted) {
      cols.push(buildCol(attr, false));
    }
    // "More…" always last — no tag, category "other"
    cols.push({
      id: MORE_COLUMN_ID,
      label: "More…",
      isKey: false,
      dominantTag: null,
      category: "other",
    });

    return cols;
  // We intentionally depend on items and the key inputs. acceptedRef is a
  // mutable ref mutated inside the memo — this is intentional (the ref
  // mutation is the stability mechanism).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, describe, indexName, topN]);
}
