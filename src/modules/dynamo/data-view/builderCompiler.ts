/**
 * Compiles a BuilderState into a ScanRequest or QueryRequest ready to pass to
 * the backend IPC commands.
 *
 * Placeholder naming conventions:
 *   - Filter attribute names:  #n0, #n1, …
 *   - Filter attribute values: :v0, :v1, …
 *   - Key condition names:     #k0, #k1
 *   - Key condition values:    :k0, :k1, :k1a, :k1b  (between uses a/b suffix)
 *
 * is_null / is_not_null decision:
 *   DynamoDB has no native "IS NULL" concept. The closest idiomatic expression
 *   for "this attribute holds a NULL value" is `attribute_type(#nN, :tN)` with
 *   `:tN = { "S": "NULL" }` — this matches only items where the attribute
 *   explicitly exists with type NULL. `is_not_null` compiles to the negation
 *   via `NOT attribute_type(#nN, :tN)`. We do NOT use
 *   `attribute_not_exists OR attribute = :null` because `attribute_not_exists`
 *   means the attribute is absent entirely, which is a different semantic.
 *
 * Error shape decision:
 *   `compile` returns a discriminated union `CompileResult` rather than
 *   throwing. Throwing forces callers to wrap every call in try/catch and
 *   makes it harder to compose with React render logic. The `{ kind: 'error' }`
 *   branch carries a `reason` string and an optional `field` pointer so the UI
 *   can surface inline validation hints.
 */

import type { TableDescription } from "@/modules/dynamo/tables/types";
import type {
  AttributeValue,
  BuilderState,
  FilterRow,
  QueryRequest,
  ScanRequest,
  TypedValue,
} from "./types";

// ---------------------------------------------------------------------------
// Public return type
// ---------------------------------------------------------------------------

export type CompileResult =
  | { kind: "scan"; request: ScanRequest }
  | { kind: "query"; request: QueryRequest }
  | { kind: "error"; reason: string; field?: string };

// ---------------------------------------------------------------------------
// Helpers: typed value → AttributeValue
// ---------------------------------------------------------------------------

function typedValueToAttr(tv: TypedValue): AttributeValue {
  switch (tv.type) {
    case "S":
      return { S: tv.value };
    case "N":
      return { N: tv.value };
    case "BOOL":
      return { BOOL: tv.value };
    case "NULL":
      return { NULL: true };
  }
}

function isTypedValue(v: TypedValue | { min: TypedValue; max: TypedValue }): v is TypedValue {
  return "type" in v;
}

// ---------------------------------------------------------------------------
// Filter-row compilation
// ---------------------------------------------------------------------------

interface FilterAccum {
  parts: string[];
  names: Record<string, string>;
  values: Record<string, AttributeValue>;
  nameIdx: number;
  valIdx: number;
}

function compileFilterRow(row: FilterRow, acc: FilterAccum): void {
  const n = acc.nameIdx++;
  const namePlaceholder = `#n${n}`;
  acc.names[namePlaceholder] = row.attribute;

  if (row.kind === "unary") {
    switch (row.op) {
      case "attribute_exists":
        acc.parts.push(`attribute_exists(${namePlaceholder})`);
        break;
      case "attribute_not_exists":
        acc.parts.push(`attribute_not_exists(${namePlaceholder})`);
        break;
      case "is_null": {
        // attribute_type(#nN, :tN) where :tN = { "S": "NULL" }
        // Matches items where the attribute is present and has DynamoDB type NULL.
        const valIdx = acc.valIdx++;
        const valPlaceholder = `:t${valIdx}`;
        acc.values[valPlaceholder] = { S: "NULL" };
        acc.parts.push(`attribute_type(${namePlaceholder}, ${valPlaceholder})`);
        break;
      }
      case "is_not_null": {
        const valIdx = acc.valIdx++;
        const valPlaceholder = `:t${valIdx}`;
        acc.values[valPlaceholder] = { S: "NULL" };
        acc.parts.push(`NOT attribute_type(${namePlaceholder}, ${valPlaceholder})`);
        break;
      }
    }
    return;
  }

  if (row.kind === "attribute_type") {
    const v = acc.valIdx++;
    const valPlaceholder = `:v${v}`;
    acc.values[valPlaceholder] = { S: row.type };
    acc.parts.push(`attribute_type(${namePlaceholder}, ${valPlaceholder})`);
    return;
  }

  // kind === 'compare'
  const { op, value } = row;

  if (op === "between") {
    const betweenValue = value;
    if (isTypedValue(betweenValue)) {
      // single TypedValue used as both bounds — should not happen in practice
      const va = acc.valIdx++;
      const vb = acc.valIdx++;
      acc.values[`:v${va}`] = typedValueToAttr(betweenValue);
      acc.values[`:v${vb}`] = typedValueToAttr(betweenValue);
      acc.parts.push(`${namePlaceholder} BETWEEN :v${va} AND :v${vb}`);
    } else {
      const va = acc.valIdx++;
      const vb = acc.valIdx++;
      acc.values[`:v${va}`] = typedValueToAttr(betweenValue.min);
      acc.values[`:v${vb}`] = typedValueToAttr(betweenValue.max);
      acc.parts.push(`${namePlaceholder} BETWEEN :v${va} AND :v${vb}`);
    }
    return;
  }

  if (op === "contains" || op === "begins_with") {
    if (!isTypedValue(value)) return;
    const v = acc.valIdx++;
    acc.values[`:v${v}`] = typedValueToAttr(value);
    acc.parts.push(`${op}(${namePlaceholder}, :v${v})`);
    return;
  }

  // binary comparison: = <> < <= > >=
  if (!isTypedValue(value)) return;
  const v = acc.valIdx++;
  acc.values[`:v${v}`] = typedValueToAttr(value);
  acc.parts.push(`${namePlaceholder} ${op} :v${v}`);
}

// ---------------------------------------------------------------------------
// Key condition compilation
// ---------------------------------------------------------------------------

interface KeyAccum {
  names: Record<string, string>;
  values: Record<string, AttributeValue>;
}

function compileKeyCondition(
  pkName: string,
  pkValue: TypedValue,
  skClause:
    | {
        name: string;
        op: "=" | "<" | "<=" | ">" | ">=" | "between" | "begins_with";
        value: TypedValue | { min: TypedValue; max: TypedValue };
      }
    | undefined,
  acc: KeyAccum,
): string {
  acc.names["#k0"] = pkName;
  acc.values[":k0"] = typedValueToAttr(pkValue);
  let expr = "#k0 = :k0";

  if (skClause) {
    acc.names["#k1"] = skClause.name;
    const { op, value } = skClause;

    if (op === "between") {
      if (isTypedValue(value)) {
        acc.values[":k1a"] = typedValueToAttr(value);
        acc.values[":k1b"] = typedValueToAttr(value);
      } else {
        acc.values[":k1a"] = typedValueToAttr(value.min);
        acc.values[":k1b"] = typedValueToAttr(value.max);
      }
      expr += " AND #k1 BETWEEN :k1a AND :k1b";
    } else if (op === "begins_with") {
      if (isTypedValue(value)) {
        acc.values[":k1"] = typedValueToAttr(value);
      } else {
        acc.values[":k1"] = typedValueToAttr(value.min);
      }
      expr += " AND begins_with(#k1, :k1)";
    } else {
      if (isTypedValue(value)) {
        acc.values[":k1"] = typedValueToAttr(value);
      } else {
        acc.values[":k1"] = typedValueToAttr(value.min);
      }
      expr += ` AND #k1 ${op} :k1`;
    }
  }

  return expr;
}

// ---------------------------------------------------------------------------
// Type validation helpers
// ---------------------------------------------------------------------------

type DynamoKeyType = "S" | "N" | "B";

function validateKeyType(
  tv: TypedValue,
  expectedKeyType: DynamoKeyType,
  fieldHint: string,
): { kind: "error"; reason: string; field?: string } | null {
  if (expectedKeyType === "S" && tv.type !== "S") {
    return {
      kind: "error",
      reason: `${fieldHint} must be of type S (string), got ${tv.type}`,
      field: fieldHint,
    };
  }
  if (expectedKeyType === "N") {
    if (tv.type !== "N") {
      return {
        kind: "error",
        reason: `${fieldHint} must be of type N (number), got ${tv.type}`,
        field: fieldHint,
      };
    }
    if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(tv.value)) {
      return {
        kind: "error",
        reason: `${fieldHint} value "${tv.value}" is not a valid numeric string`,
        field: fieldHint,
      };
    }
  }
  if (expectedKeyType === "B" && tv.type !== "S") {
    // Binary keys are input as base64 strings; we accept S-typed values
    // and pass them through as-is. The backend interprets the base64.
    return {
      kind: "error",
      reason: `${fieldHint} must be of type S (base64) for a B-typed key, got ${tv.type}`,
      field: fieldHint,
    };
  }
  return null;
}

function resolveKeyType(
  keyName: string,
  describe: TableDescription,
): DynamoKeyType | null {
  const def = describe.attribute_definitions.find(
    (d) => d.attribute_name === keyName,
  );
  return def ? def.attribute_type : null;
}

// ---------------------------------------------------------------------------
// Main compile function
// ---------------------------------------------------------------------------

export function compile(
  builder: BuilderState,
  describe: TableDescription,
): CompileResult {
  // Resolve the effective key schema (primary or GSI/LSI).
  let keySchema = describe.key_schema;
  if (builder.indexName !== null) {
    const gsi = describe.global_secondary_indexes.find(
      (g) => g.index_name === builder.indexName,
    );
    const lsi = describe.local_secondary_indexes.find(
      (l) => l.index_name === builder.indexName,
    );
    if (gsi) {
      keySchema = gsi.key_schema;
    } else if (lsi) {
      keySchema = lsi.key_schema;
    }
  }

  const pkDef = keySchema.find((k) => k.key_type === "HASH");
  const skDef = keySchema.find((k) => k.key_type === "RANGE");

  // Compile filter rows.
  const filterAccum: FilterAccum = {
    parts: [],
    names: {},
    values: {},
    nameIdx: 0,
    valIdx: 0,
  };
  for (const row of builder.filters) {
    compileFilterRow(row, filterAccum);
  }

  const filterExpression =
    filterAccum.parts.length > 0 ? filterAccum.parts.join(" AND ") : null;
  const mergedNames: Record<string, string> = { ...filterAccum.names };
  const mergedValues: Record<string, AttributeValue> = { ...filterAccum.values };

  // -------------------------------------------------------------------------
  // Scan mode
  // -------------------------------------------------------------------------
  if (builder.mode === "scan") {
    const req: ScanRequest = {
      connection_id: "",
      table_name: "",
      index_name: builder.indexName,
      limit: builder.pageSize,
      page: 1,
      exclusive_start_key: null,
      filter_expression: filterExpression,
      expression_attribute_names:
        Object.keys(mergedNames).length > 0 ? mergedNames : null,
      expression_attribute_values:
        Object.keys(mergedValues).length > 0 ? mergedValues : null,
      projection_expression: null,
      consistent_read: builder.consistentRead,
      select: null,
      origin: null,
    };
    return { kind: "scan", request: req };
  }

  // -------------------------------------------------------------------------
  // Query mode
  // -------------------------------------------------------------------------
  if (!builder.query) {
    return {
      kind: "error",
      reason: "Partition key value is required for Query mode",
      field: "partitionKey",
    };
  }

  const { partitionKey, sortKey } = builder.query;

  // Validate partition key type against attribute_definitions.
  const pkAttrType = pkDef
    ? resolveKeyType(pkDef.attribute_name, describe)
    : null;
  if (pkAttrType !== null) {
    const err = validateKeyType(partitionKey.value, pkAttrType, "partitionKey");
    if (err) return err;
  }

  // Validate sort key type.
  if (sortKey && skDef) {
    const skAttrType = resolveKeyType(skDef.attribute_name, describe);
    if (skAttrType !== null) {
      const skVal = isTypedValue(sortKey.value) ? sortKey.value : sortKey.value.min;
      const err = validateKeyType(skVal, skAttrType, "sortKey");
      if (err) return err;
      if (sortKey.op === "between" && !isTypedValue(sortKey.value)) {
        const err2 = validateKeyType(sortKey.value.max, skAttrType, "sortKey.max");
        if (err2) return err2;
      }
    }
  }

  const keyAccum: KeyAccum = { names: {}, values: {} };
  const pkName = partitionKey.name || pkDef?.attribute_name || "";
  const keyConditionExpression = compileKeyCondition(
    pkName,
    partitionKey.value,
    sortKey
      ? {
          name: sortKey.name || skDef?.attribute_name || "",
          op: sortKey.op,
          value: sortKey.value,
        }
      : undefined,
    keyAccum,
  );

  // Merge key condition names/values with filter names/values.
  const allNames = { ...keyAccum.names, ...mergedNames };
  const allValues = { ...keyAccum.values, ...mergedValues };

  const req: QueryRequest = {
    connection_id: "",
    table_name: "",
    index_name: builder.indexName,
    limit: builder.pageSize,
    page: 1,
    exclusive_start_key: null,
    key_condition_expression: keyConditionExpression,
    filter_expression: filterExpression,
    expression_attribute_names:
      Object.keys(allNames).length > 0 ? allNames : null,
    expression_attribute_values:
      Object.keys(allValues).length > 0 ? allValues : null,
    projection_expression: null,
    consistent_read: builder.consistentRead,
    select: null,
    scan_index_forward: builder.scanIndexForward,
    origin: null,
  };
  return { kind: "query", request: req };
}
