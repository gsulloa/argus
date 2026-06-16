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
  // boolean — also accept the short alias "bool"
  if (t === "boolean" || t === "bool") return "boolean";
  if (t === "bytea") return "binary";
  if (t === "uuid") return "uuid";
  if (t === "json" || t === "jsonb") return "json";
  if (
    // standard SQL names
    t === "smallint" ||
    t === "integer" ||
    t === "int" ||
    t === "bigint" ||
    t === "real" ||
    t === "double precision" ||
    t === "smallserial" ||
    t === "serial" ||
    t === "bigserial" ||
    // internal / catalog aliases
    t === "int2" ||
    t === "int4" ||
    t === "int8" ||
    t === "float4" ||
    t === "float8" ||
    // parameterized forms: numeric(p,s), decimal(p,s)
    t.startsWith("numeric") ||
    t.startsWith("decimal")
  ) {
    return "numeric";
  }
  if (
    t === "date" ||
    t === "interval" ||
    t === "timetz" ||
    t === "timestamptz" ||
    // startsWith covers:
    //   "timestamp", "timestamp with time zone", "timestamp without time zone"
    //   "time", "time with time zone", "time without time zone"
    t.startsWith("timestamp") ||
    t.startsWith("time without") ||
    t.startsWith("time with") ||
    t === "time"
  ) {
    return "date";
  }
  if (
    t === "text" ||
    t.startsWith("character varying") ||
    t.startsWith("varchar") ||
    // bare "char" as well as "character(n)" and "character"
    t === "char" ||
    t.startsWith("char(") ||
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
