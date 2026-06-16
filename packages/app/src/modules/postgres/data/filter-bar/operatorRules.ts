import { categorize, type ColumnCategory } from "../typeHelpers";
import type { ColumnRef, Operator } from "../types";

const ANY_COLUMN_OPERATORS: Operator[] = [
  "=",
  "!=",
  "LIKE",
  "NOT LIKE",
  "ILIKE",
  "NOT ILIKE",
  "Contains",
  "StartsWith",
  "EndsWith",
];

/**
 * Operator allow-list per the spec's per-column-type rules. Mirrors the
 * backend operator surface — the backend will reject anything else, so the
 * UI keeps the dropdown in sync with what's actually executable.
 */
export function operatorsForColumn(
  column: ColumnRef,
  dataType: string | null,
  isNullable: boolean,
): Operator[] {
  if (column.kind === "any_column") {
    return ANY_COLUMN_OPERATORS.slice();
  }
  const cat: ColumnCategory = categorize(dataType ?? "");
  const ops: Operator[] = [];
  switch (cat) {
    case "numeric":
    case "date":
      ops.push("=", "!=", "<", "<=", ">", ">=", "BETWEEN", "In", "NotIn");
      break;
    case "text":
      ops.push(
        "=",
        "!=",
        "LIKE",
        "NOT LIKE",
        "ILIKE",
        "NOT ILIKE",
        "Contains",
        "StartsWith",
        "EndsWith",
        "In",
        "NotIn",
      );
      break;
    case "boolean":
      ops.push("=", "!=");
      break;
    case "uuid":
    case "json":
    case "binary":
    case "other":
      ops.push("=", "!=", "In", "NotIn");
      break;
  }
  if (isNullable) ops.push("IS NULL", "IS NOT NULL");
  return ops;
}
