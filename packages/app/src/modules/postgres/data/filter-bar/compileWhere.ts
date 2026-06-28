import {
  isCompleteRow,
  trimLeadingWhere,
  type ColumnRef,
  type Condition,
  type DataColumn,
  type FilterModel,
  type FilterRow,
  type FilterScalar,
  type FilterValue,
  type Operator,
  type OrderBy,
} from "../types";

export interface CompileResult {
  body: string;
}

/**
 * Compile a flat `FilterModel` (FilterTree) to a SQL WHERE body.
 * Display-only — used by the "SQL" footer affordance. Literals are inlined
 * (single-quoted, with `'` doubled) since the result is meant for a SQL
 * editor, not a parametrized query. The backend has its own parametrized
 * compiler for execution.
 *
 * Only `enabled && isCompleteRow` rows are included. An empty result → `""`.
 * Predicates are joined with `" AND "` or `" OR "` per `model.combinator`;
 * no outer parentheses are added.
 */
export function compileWhere(
  model: FilterModel,
  columns: DataColumn[] = [],
): CompileResult {
  const rows = model.rows.filter((r) => r.enabled && isCompleteRow(r));
  if (rows.length === 0) return { body: "" };
  const parts = rows.map((r) => compileRow(r, columns));
  const sep = model.combinator === "OR" ? " OR " : " AND ";
  return { body: parts.join(sep) };
}

function compileRow(row: FilterRow, columns: DataColumn[]): string {
  if (row.column.kind === "raw") {
    const expr = typeof row.value === "string" ? row.value.trim() : "";
    return `(${expr})`;
  }
  if (row.column.kind === "any_column") {
    return compileAnyColumn(row.op, row.value, columns);
  }
  return compileNamedPredicate(row.column.name, row.op, row.value, "");
}

function compileAnyColumn(
  op: Operator,
  value: FilterValue | undefined,
  columns: DataColumn[],
): string {
  const castable = columns.filter((c) => textCastable(c.data_type));
  if (castable.length === 0) return "(FALSE)";
  const parts = castable.map((c) =>
    compileNamedPredicate(c.name, op, value, "::text"),
  );
  return `(${parts.join(" OR ")})`;
}

function compileNamedPredicate(
  column: string,
  op: Operator,
  value: FilterValue | undefined,
  castSuffix: string,
): string {
  const ref = `${quoteIdent(column)}${castSuffix}`;
  switch (op) {
    case "IS NULL":
      return `${ref} IS NULL`;
    case "IS NOT NULL":
      return `${ref} IS NOT NULL`;
    case "BETWEEN": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return `${ref} BETWEEN ? AND ?`;
      }
      return `${ref} BETWEEN ${literal(value.min)} AND ${literal(value.max)}`;
    }
    case "In":
    case "NotIn": {
      const kw = op === "In" ? "IN" : "NOT IN";
      if (!Array.isArray(value) || value.length === 0) return `${ref} ${kw} ()`;
      const lits = value.map(literal).join(", ");
      return `${ref} ${kw} (${lits})`;
    }
    default: {
      const lit = scalarOrEmpty(value);
      return binaryOpSql(ref, op, lit);
    }
  }
}

function binaryOpSql(ref: string, op: Operator, lit: string): string {
  switch (op) {
    case "=":
      return `${ref} = ${lit}`;
    case "!=":
      return `${ref} <> ${lit}`;
    case "<":
      return `${ref} < ${lit}`;
    case "<=":
      return `${ref} <= ${lit}`;
    case ">":
      return `${ref} > ${lit}`;
    case ">=":
      return `${ref} >= ${lit}`;
    case "LIKE":
      return `${ref} LIKE ${lit}`;
    case "NOT LIKE":
      return `${ref} NOT LIKE ${lit}`;
    case "ILIKE":
      return `${ref} ILIKE ${lit}`;
    case "NOT ILIKE":
      return `${ref} NOT ILIKE ${lit}`;
    case "Contains":
      return `${ref} ILIKE '%' || ${lit} || '%'`;
    case "StartsWith":
      return `${ref} ILIKE ${lit} || '%'`;
    case "EndsWith":
      return `${ref} ILIKE '%' || ${lit}`;
    default:
      return `${ref} ${op} ${lit}`;
  }
}

function scalarOrEmpty(v: FilterValue | undefined): string {
  if (v === undefined) return "''";
  if (Array.isArray(v) || (typeof v === "object" && v !== null)) return "''";
  return literal(v);
}

/** Inline a scalar as a SQL literal (single-quoted strings, escaped `'`). */
function literal(v: FilterScalar): string {
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** Mirror of the backend `text_castable` allow-list. */
function textCastable(dataType: string): boolean {
  const t = dataType.trim().toLowerCase();
  const head = t.split("(")[0]?.trim() ?? t;
  if (head === "bytea") return false;
  if (head.includes(".") || head.includes('"')) return false;
  let base = head;
  if (base.endsWith("[]")) base = base.slice(0, -2).trim();
  const allow = new Set([
    "text",
    "character varying",
    "varchar",
    "character",
    "char",
    "bpchar",
    "name",
    "citext",
    "uuid",
    "json",
    "jsonb",
    "boolean",
    "bool",
    "smallint",
    "int2",
    "integer",
    "int4",
    "bigint",
    "int8",
    "real",
    "float4",
    "double precision",
    "float8",
    "numeric",
    "decimal",
    "money",
    "date",
    "time",
    "time without time zone",
    "time with time zone",
    "timetz",
    "timestamp",
    "timestamp without time zone",
    "timestamp with time zone",
    "timestamptz",
    "interval",
    "smallserial",
    "serial",
    "bigserial",
    "inet",
    "cidr",
    "macaddr",
    "macaddr8",
    "xml",
  ]);
  return allow.has(base);
}

export interface PrefilledSelectArgs {
  schema: string;
  relation: string;
  model: FilterModel;
  columns: DataColumn[];
  orderBy: OrderBy[];
  limit: number;
}

/**
 * Build the SQL string for the "SQL" footer button: a `SELECT *` reflecting
 * the applied filter model, the active sort, and the current page size.
 * Uses `applied` (not `draft`) — callers must pass the applied model.
 */
export function compilePrefilledSelect(args: PrefilledSelectArgs): string {
  const { schema, relation, model, columns, orderBy, limit } = args;
  const compiled = compileWhere(model, columns);
  const from = `${quoteIdent(schema)}.${quoteIdent(relation)}`;
  const lines: string[] = [`SELECT * FROM ${from}`];
  if (compiled.body.length > 0) {
    lines.push(`WHERE ${compiled.body}`);
  }
  if (orderBy.length > 0) {
    const parts = orderBy.map(
      (o) => `${quoteIdent(o.column)} ${o.direction === "desc" ? "DESC" : "ASC"}`,
    );
    lines.push(`ORDER BY ${parts.join(", ")}`);
  }
  lines.push(`LIMIT ${limit}`);
  return lines.join("\n");
}

export type { ColumnRef, Condition };

// trimLeadingWhere re-exported for any callers that import it from here
export { trimLeadingWhere };
