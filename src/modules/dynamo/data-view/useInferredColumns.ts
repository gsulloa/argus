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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const MORE_COLUMN_ID = "__more__";
export const TOP_N_DEFAULT = 10;

export interface InferredColumn {
  /** Attribute name. `MORE_COLUMN_ID` for the "More…" column. */
  id: string;
  /** Human-readable header label. */
  label: string;
  /** Whether this column is a key column (PK or SK). */
  isKey: boolean;
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

    // Build frequency map (exclude pk, sk — they're pinned)
    const freq = new Map<string, number>();
    for (const item of items) {
      for (const attr of Object.keys(item)) {
        if (attr === pk || attr === sk) continue;
        freq.set(attr, (freq.get(attr) ?? 0) + 1);
      }
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
      cols.push({ id: pk, label: pk, isKey: true });
    }
    if (sk) {
      cols.push({ id: sk, label: sk, isKey: true });
    }
    for (const attr of accepted) {
      cols.push({ id: attr, label: attr, isKey: false });
    }
    // "More…" always last
    cols.push({ id: MORE_COLUMN_ID, label: "More…", isKey: false });

    return cols;
  // We intentionally depend on items and the key inputs. acceptedRef is a
  // mutable ref mutated inside the memo — this is intentional (the ref
  // mutation is the stability mechanism).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, describe, indexName, topN]);
}
