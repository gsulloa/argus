/** Minimal shape shared by every engine's `OrderBy` (`{ column, direction }`). */
export interface OrderByLike {
  column: string;
  direction: "asc" | "desc";
}

/**
 * The table viewer's default order when the user has not selected one: every
 * primary-key column descending, in PK definition order (so a table opens
 * showing its newest / highest-key rows first).
 *
 * Returns `[]` (natural / backend-fallback order) when the relation has no
 * usable primary key — `pkColumns` is `null`/empty — or when `relationKind`
 * names a view variant (`view`, `materialized-view`, `indexed_view`, …), which
 * has no primary key to order by.
 *
 * The `OrderByLike[]` result is structurally assignable to each engine module's
 * own `OrderBy[]` type (identical `{ column, direction: "asc" | "desc" }` shape).
 */
export function deriveDefaultOrderBy(
  pkColumns: string[] | null | undefined,
  relationKind?: string,
): OrderByLike[] {
  if (relationKind && relationKind.includes("view")) return [];
  if (!pkColumns || pkColumns.length === 0) return [];
  return pkColumns.map((column) => ({ column, direction: "desc" as const }));
}
