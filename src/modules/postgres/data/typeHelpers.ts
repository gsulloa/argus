import type { Operator } from "./types";

/**
 * Loose Postgres type categorization. `data_type` comes from
 * `pg_catalog.format_type` (e.g. `integer`, `text`, `timestamp without time zone`,
 * `numeric(10,2)`). The category drives which filter operators are surfaced
 * and whether numeric/date cell rendering hints apply.
 */
export type ColumnCategory =
  | "numeric"
  | "boolean"
  | "date"
  | "text"
  | "binary"
  | "json"
  | "uuid"
  | "other";

export function categorize(dataType: string): ColumnCategory {
  const t = dataType.toLowerCase();
  if (t === "boolean") return "boolean";
  if (t === "bytea") return "binary";
  if (t === "uuid") return "uuid";
  if (t === "json" || t === "jsonb") return "json";
  if (
    t === "smallint" ||
    t === "integer" ||
    t === "bigint" ||
    t === "real" ||
    t === "double precision" ||
    t === "smallserial" ||
    t === "serial" ||
    t === "bigserial" ||
    t.startsWith("numeric") ||
    t.startsWith("decimal")
  ) {
    return "numeric";
  }
  if (
    t === "date" ||
    t.startsWith("timestamp") ||
    t.startsWith("time without") ||
    t.startsWith("time with") ||
    t === "time" ||
    t === "interval"
  ) {
    return "date";
  }
  if (
    t === "text" ||
    t.startsWith("character varying") ||
    t.startsWith("varchar") ||
    t.startsWith("character(") ||
    t === "character" ||
    t === "name" ||
    t === "citext"
  ) {
    return "text";
  }
  return "other";
}

/**
 * Legacy column-scoped operator suggester. Retained only as a fallback for
 * non-bar contexts — the primary surface is now `operatorsForColumn` in
 * `filter-bar/operatorRules.ts`, which handles the full operator set
 * including the Any-column case.
 */
export function operatorsFor(category: ColumnCategory, isNullable: boolean): Operator[] {
  const base: Operator[] = ["=", "!="];
  switch (category) {
    case "numeric":
    case "date":
      base.push("<", "<=", ">", ">=", "BETWEEN");
      break;
    case "text":
    case "uuid":
    case "json":
    case "binary":
    case "other":
      base.push("LIKE", "NOT LIKE");
      break;
    case "boolean":
      break;
  }
  if (isNullable) {
    base.push("IS NULL", "IS NOT NULL");
  }
  return base;
}

export function isMonoCategory(category: ColumnCategory): boolean {
  return category === "uuid" || category === "binary" || category === "numeric" || category === "date";
}
