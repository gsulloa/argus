/**
 * Shared, presentation-only sorting for SQL editor result grids.
 *
 * SQL editor results are an opaque, already-fetched `{ columns, rows }` payload
 * with no table/schema context to re-`ORDER BY` against (unlike the table
 * browser, which sorts server-side). So all four engines (Postgres, MySQL,
 * MSSQL, Athena) sort the loaded rows client-side via these helpers.
 *
 * The sort is stable, never mutates the input, and groups null/undefined cells
 * deterministically at one end regardless of direction. Comparison is
 * value-aware: numeric, temporal, boolean, then a lexical fallback for mixed
 * types so it never throws.
 */

/** A single-column sort directive. `direction` is lowercase to match `OrderBy`. */
export interface SortOrder {
  column: string;
  direction: "asc" | "desc";
}

/**
 * Three-state, single-column header-click cycle: unsorted → asc → desc →
 * unsorted. Clicking a different column replaces the sort with that column
 * ascending (v1 is single-column only).
 */
export function cycleColumnSort(
  column: string,
  current: readonly SortOrder[],
): SortOrder[] {
  const cur = current.find((o) => o.column === column);
  if (!cur) return [{ column, direction: "asc" }];
  if (cur.direction === "asc") return [{ column, direction: "desc" }];
  return [];
}

/**
 * Return a new array of rows sorted per `orderBy`. Stable for equal keys
 * (preserves the original relative order). The input array and its rows are
 * never mutated. When `orderBy` is empty the original order is returned
 * (as a shallow copy).
 *
 * Generic over the row shape: callers supply `getCell(row, columnIndex)` so the
 * helper works for both cell-array rows (Athena / Postgres ad-hoc grid) and the
 * `UnifiedRow` shape used by the MySQL/MSSQL DataGrid.
 */
export function sortResultRows<Row>(
  rows: readonly Row[],
  columnNames: readonly string[],
  orderBy: readonly SortOrder[],
  getCell: (row: Row, columnIndex: number) => unknown,
): Row[] {
  if (orderBy.length === 0) return rows.slice();

  // Resolve each sort key to a column index once; drop keys whose column is
  // no longer present in the result.
  const keys = orderBy
    .map((o) => ({
      index: columnNames.indexOf(o.column),
      sign: o.direction === "desc" ? -1 : 1,
    }))
    .filter((k) => k.index >= 0);

  if (keys.length === 0) return rows.slice();

  // Decorate with original index so the sort is stable across all engines
  // (Array.prototype.sort stability is spec-guaranteed in modern engines, but
  // the explicit tiebreaker keeps it robust and intention-revealing).
  return rows
    .map((row, originalIndex) => ({ row, originalIndex }))
    .sort((a, b) => {
      for (const key of keys) {
        const av = getCell(a.row, key.index);
        const bv = getCell(b.row, key.index);
        const aNull = av === null || av === undefined;
        const bNull = bv === null || bv === undefined;
        // Null grouping is direction-INDEPENDENT: nulls always sort last in
        // both asc and desc, so it is NOT multiplied by the direction sign.
        if (aNull || bNull) {
          if (aNull && bNull) continue;
          return aNull ? 1 : -1;
        }
        const cmp = compareCellValues(av, bv);
        if (cmp !== 0) return cmp * key.sign;
      }
      return a.originalIndex - b.originalIndex;
    })
    .map((d) => d.row);
}

/**
 * Ascending comparison of two cell values. Returns negative if `a < b`,
 * positive if `a > b`, 0 if equal. `null`/`undefined`/absent sort AFTER present
 * values in this ascending comparator; the {@link sortResultRows} wrapper pins
 * nulls last in BOTH directions (it never negates the null result by the sort
 * direction).
 */
export function compareCellValues(a: unknown, b: unknown): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;

  // Numeric (handles numbers and numeric-looking strings, e.g. Athena's
  // string-coerced result cells).
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== null && nb !== null) {
    return na < nb ? -1 : na > nb ? 1 : 0;
  }

  // Temporal (ISO-ish date/time strings or Date instances).
  const ta = toTime(a);
  const tb = toTime(b);
  if (ta !== null && tb !== null) {
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  }

  // Boolean (false < true).
  if (typeof a === "boolean" && typeof b === "boolean") {
    return (a ? 1 : 0) - (b ? 1 : 0);
  }

  // Lexical fallback for everything else, including genuinely mixed types.
  const sa = toComparableString(a);
  const sb = toComparableString(b);
  return sa.localeCompare(sb);
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Conservative temporal pattern: ISO date (YYYY-MM-DD) optionally with a time
// component, or a time-of-day. Avoids misreading bare integers as dates.
const TEMPORAL_RE =
  /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$|^\d{2}:\d{2}(:\d{2})?$/;

function toTime(v: unknown): number | null {
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof v === "string" && TEMPORAL_RE.test(v.trim())) {
    const t = Date.parse(v.trim());
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function toComparableString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return String(v);
  }
  if (v && typeof v === "object") {
    // Cell envelopes (binary/truncated) expose a `preview`; prefer it so two
    // envelopes order by their human-readable preview rather than JSON noise.
    const preview = (v as { preview?: unknown }).preview;
    if (typeof preview === "string") return preview;
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}
