/**
 * dynamoSortHelpers — type-aware TanStack sorting functions for DynamoDB grids.
 *
 * `makeSortingFn(category)` returns a SortingFn<AttributeMap> that compares
 * two cells based on the column's inferred ColumnCategory. Each comparator
 * reads the actual AttributeValue tag at comparison time so mis-categorised
 * columns degrade gracefully rather than throwing.
 */

import type { Row, SortingFn } from "@tanstack/react-table";
import type { ColumnCategory } from "@/platform/table/columnWidths";
import type { AttributeMap, AttributeValue } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a numeric size for complex AttributeValue types (for ordering). */
function complexSize(av: AttributeValue): number {
  if ("L" in av) return av.L.length;
  if ("SS" in av) return av.SS.length;
  if ("NS" in av) return av.NS.length;
  if ("BS" in av) return av.BS.length;
  if ("M" in av) return Object.keys(av.M).length;
  return 0;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Returns a TanStack SortingFn for a DynamoDB column based on its inferred
 * category. Undefined cells are handled by the `sortUndefined: "last"` option
 * on the column def — the comparator only receives defined values.
 *
 * If both values are undefined (shouldn't happen with sortUndefined set) we
 * return 0 (equal).
 */
export function makeSortingFn(category: ColumnCategory): SortingFn<AttributeMap> {
  return (rowA: Row<AttributeMap>, rowB: Row<AttributeMap>, columnId: string): number => {
    const av = rowA.getValue<AttributeValue | undefined>(columnId);
    const bv = rowB.getValue<AttributeValue | undefined>(columnId);

    // Both undefined → equal
    if (av === undefined && bv === undefined) return 0;
    // One undefined → push to end (positive = row goes last in asc).
    // sortUndefined: "last" on the column def handles the main case, but
    // the comparator still guards here for safety.
    if (av === undefined) return 1;
    if (bv === undefined) return -1;

    switch (category) {
      case "numeric": {
        const an = parseFloat((av as { N?: string }).N ?? "NaN");
        const bn = parseFloat((bv as { N?: string }).N ?? "NaN");
        // NaN sorts after any finite number (push to end in asc)
        const aNan = isNaN(an);
        const bNan = isNaN(bn);
        if (aNan && bNan) return 0;
        if (aNan) return 1;
        if (bNan) return -1;
        return an - bn;
      }

      case "boolean": {
        const ab = Number((av as { BOOL?: boolean }).BOOL ?? false);
        const bb = Number((bv as { BOOL?: boolean }).BOOL ?? false);
        return ab - bb;
      }

      case "text":
      case "uuid": {
        const as = String((av as { S?: string; B?: string }).S ?? (av as { B?: string }).B ?? "");
        const bs = String((bv as { S?: string; B?: string }).S ?? (bv as { B?: string }).B ?? "");
        return as.localeCompare(bs, undefined, { numeric: true, sensitivity: "base" });
      }

      case "binary": {
        const ab64 = String((av as { B?: string }).B ?? "");
        const bb64 = String((bv as { B?: string }).B ?? "");
        return ab64.localeCompare(bb64);
      }

      case "json": {
        return complexSize(av) - complexSize(bv);
      }

      default: {
        // For "other", "date" categories fall back to string comparison
        const as = JSON.stringify(av);
        const bs = JSON.stringify(bv);
        return as.localeCompare(bs);
      }
    }
  };
}
