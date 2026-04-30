import {
  trimLeadingWhere,
  type ColumnRef,
  type Condition,
  type DataColumn,
  type FilterModel,
  type FilterNode,
  type FilterScalar,
  type FilterTree,
  type FilterValue,
  type Operator,
  type OrderBy,
} from "../types";

export type CompileResult =
  | { mode: "structured"; body: string }
  | { mode: "raw"; body: string };

/**
 * Compile a `FilterModel` to a SQL WHERE body. Display-only — used by the
 * "Open in SQL Editor" affordance and any in-bar previews. Literals are
 * inlined (single-quoted, with `'` doubled) since the result is meant for
 * a SQL editor, not a parametrized query. The backend has its own
 * parametrized compiler for execution.
 */
export function compileWhere(
  model: FilterModel,
  columns: DataColumn[] = [],
): CompileResult {
  if (model.mode === "raw") {
    return { mode: "raw", body: trimLeadingWhere(model.raw) };
  }
  return { mode: "structured", body: compileTree(model.tree, columns) };
}

function compileTree(tree: FilterTree, columns: DataColumn[]): string {
  if (tree.children.length === 0) return "";
  const parts: string[] = [];
  for (const node of tree.children) {
    if (node.kind === "condition") {
      parts.push(compileCondition(node, columns));
    } else {
      const inner: string[] = [];
      for (const c of node.children) {
        if (c.kind === "condition") {
          inner.push(compileCondition(c, columns));
        }
      }
      if (inner.length === 0) continue;
      parts.push(`(${inner.join(" OR ")})`);
    }
  }
  return parts.join(" AND ");
}

function compileCondition(c: Condition, columns: DataColumn[]): string {
  if (c.column.kind === "any_column") {
    return compileAnyColumn(c.op, c.value, columns);
  }
  return compileNamedPredicate(c.column.name, c.op, c.value, "");
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
 * Build the SQL string for "Open in SQL Editor": a `SELECT *` reflecting
 * the applied filter model, the active sort, and the current page size.
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

export type { ColumnRef, Condition, FilterNode };
