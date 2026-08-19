import {
  EMPTY_FILTER_MODEL,
  type FilterModel,
  type FilterRow,
  type Operator,
} from "../types";

/**
 * Validate and normalize a raw unknown value loaded from persistence into a
 * valid `FilterModel`. Drops any legacy shape silently (with a console.info)
 * to avoid crashes on first load after upgrade.
 *
 * Legacy shapes that are reset to empty:
 * - presence of `mode` field (old FilterModel = { mode, tree, raw })
 * - presence of `tree` field (legacy structured wrapper)
 * - any row whose `column` field has `kind === "or_group"` (shouldn't happen
 *   at row level, but we also guard against `rows` containing objects with
 *   a `kind: "or_group"` key anywhere)
 */
export function migrateLegacyFilterModel(raw: unknown): FilterModel {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return EMPTY_FILTER_MODEL;
  }

  const obj = raw as Record<string, unknown>;

  if ("mode" in obj || "tree" in obj) {
    console.info("[filter-bar] dropped legacy raw/structured filter model");
    return EMPTY_FILTER_MODEL;
  }

  if (!Array.isArray(obj["rows"])) {
    return EMPTY_FILTER_MODEL;
  }

  const rawRows = obj["rows"] as unknown[];

  for (const row of rawRows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return EMPTY_FILTER_MODEL;
    const r = row as Record<string, unknown>;
    // `op` may legitimately be absent/null — that is the "operator unset" state
    // written by the footer's `Unset` control. Only a missing column is corrupt.
    if (!r["column"]) return EMPTY_FILTER_MODEL;
    const col = r["column"] as Record<string, unknown>;
    if (col["kind"] === "or_group") {
      console.info("[filter-bar] dropped legacy raw/structured filter model");
      return EMPTY_FILTER_MODEL;
    }
  }

  const combinator = obj["combinator"];
  const resolvedCombinator: "AND" | "OR" =
    combinator === "OR" ? "OR" : "AND";

  const rows: FilterRow[] = rawRows.map((row) => {
    const r = row as Record<string, unknown>;
    // Backfill a client-only stable id for rows persisted before ids existed.
    const id = typeof r["id"] === "string" && r["id"] ? (r["id"] as string) : crypto.randomUUID();
    return {
      id,
      enabled: r["enabled"] !== false,
      column: r["column"] as FilterRow["column"],
      // Absent / null / non-string → the row rehydrates with its operator unset.
      op: typeof r["op"] === "string" ? (r["op"] as Operator) : null,
      value: r["value"] as FilterRow["value"],
    };
  });

  return { rows, combinator: resolvedCombinator };
}
