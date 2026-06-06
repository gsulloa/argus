/**
 * modelCompiler.ts — compiles an access-pattern + params into a BuilderState.query.
 *
 * ============================================================================
 * PIPELINE DIAGRAM
 * ============================================================================
 *
 *   AccessPattern  +  params: Record<string,string>  +  TableDescription
 *          │
 *          ▼
 *   ┌─────────────────────────────┐
 *   │  1. parseTemplate(template) │  Split into Segment[]
 *   │     "USER#${userId}"        │  → [ Literal("USER#"), Param("userId") ]
 *   │     "${bare}"               │  → [ Param("bare") ]
 *   │     "LITERAL"               │  → [ Literal("LITERAL") ]
 *   └──────────────┬──────────────┘
 *                  │
 *          ▼ per PK / SK
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  2. resolveIndex(ap.index, describe)                         │
 *   │     "table" → describe.key_schema                            │
 *   │     "GSI1"  → describe.global_secondary_indexes[…].key_schema│
 *   │     unknown  → { kind:"error", reason:"unknown index …" }    │
 *   └──────────────┬───────────────────────────────────────────────┘
 *                  │
 *          ▼
 *   ┌───────────────────────────────────────────────────────────────┐
 *   │  3. resolveAttrType(attrName, attribute_definitions)          │
 *   │     → "S" | "N" | "B"  (or error if attribute not found)     │
 *   └──────────────┬────────────────────────────────────────────────┘
 *                  │
 *          ▼ for each key (PK then SK)
 *   ┌──────────────────────────────────────────────────────────────────────────┐
 *   │  4. applyFillRule(segments, params, keyAttrType, keyRole)                │
 *   │                                                                          │
 *   │   segments: [ Literal | Param … ]                                        │
 *   │   params filled left-to-right:                                           │
 *   │                                                                          │
 *   │   ALL filled ──────────────────────────────────▶  equality("full str")  │
 *   │                                                                          │
 *   │   trailing empty w/ literal prefix                                       │
 *   │     keyAttrType === "S" ──────────────────────▶  begins_with("prefix")  │
 *   │     keyAttrType !== "S" ──────────────────────▶  error (non-string key) │
 *   │                                                                          │
 *   │   trailing-empty BARE ${param} (no prefix)                               │
 *   │     OR  no sk template at all ────────────────▶  DROP (partition-only)  │
 *   │                                                                          │
 *   │   interior gap (empty before a filled param) ─▶  error (offending param)│
 *   │                                                                          │
 *   │   PK any empty ────────────────────────────────▶  error (PK mandatory)  │
 *   └──────────────┬───────────────────────────────────────────────────────────┘
 *                  │
 *          ▼
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  5. Emit ModelCompileResult                                  │
 *   │     { kind:"ok", query: BuilderState["query"], indexName }   │
 *   │     { kind:"error", reason, field? }                         │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * ============================================================================
 */

import type { TableDescription } from "@/modules/dynamo/tables/types";
import type { AccessPattern, BuilderState, TypedValue } from "./types";

// ---------------------------------------------------------------------------
// Public return type — mirrors builderCompiler's CompileResult error shape
// ---------------------------------------------------------------------------

export type ModelCompileResult =
  | {
      kind: "ok";
      /** Drop into BuilderState.query as-is. */
      query: NonNullable<BuilderState["query"]>;
      /** null → primary table index; otherwise GSI/LSI name. */
      indexName: string | null;
    }
  | { kind: "error"; reason: string; field?: string };

// ---------------------------------------------------------------------------
// Internal: template segment
// ---------------------------------------------------------------------------

type Segment = { kind: "literal"; text: string } | { kind: "param"; ident: string };

// ---------------------------------------------------------------------------
// §D9 — Template parser
//
// Grammar:
//   template   = segment*
//   segment    = placeholder | literal-char+
//   placeholder = "${" ident "}"
//   ident       = [A-Za-z_][A-Za-z0-9_]*
//   literal-char = any char except the start of a valid placeholder
//               (a bare "$" not followed by "{" is a literal char)
//
// Errors:
//   - Unterminated "${" (no closing "}") → error
// ---------------------------------------------------------------------------

function parseTemplate(template: string): Segment[] | { error: string } {
  const segments: Segment[] = [];
  let i = 0;
  let currentLiteral = "";

  while (i < template.length) {
    if (template[i] === "$" && template[i + 1] === "{") {
      // Flush any accumulated literal
      if (currentLiteral.length > 0) {
        segments.push({ kind: "literal", text: currentLiteral });
        currentLiteral = "";
      }

      // Find the closing "}"
      const closeIdx = template.indexOf("}", i + 2);
      if (closeIdx === -1) {
        return { error: `Unterminated "\${" in template: ${JSON.stringify(template)}` };
      }

      const ident = template.slice(i + 2, closeIdx);
      // Validate ident: [A-Za-z_][A-Za-z0-9_]*
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
        return {
          error: `Invalid placeholder identifier "${ident}" in template: ${JSON.stringify(template)}`,
        };
      }

      segments.push({ kind: "param", ident });
      i = closeIdx + 1;
    } else {
      // Literal character (including a bare "$" not followed by "{")
      currentLiteral += template[i];
      i++;
    }
  }

  if (currentLiteral.length > 0) {
    segments.push({ kind: "literal", text: currentLiteral });
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Index resolution
// ---------------------------------------------------------------------------

function resolveKeySchema(
  index: string,
  describe: TableDescription,
): TableDescription["key_schema"] | { error: string } {
  if (index === "table") {
    return describe.key_schema;
  }

  const gsi = describe.global_secondary_indexes.find((g) => g.index_name === index);
  if (gsi) return gsi.key_schema;

  const lsi = describe.local_secondary_indexes.find((l) => l.index_name === index);
  if (lsi) return lsi.key_schema;

  return { error: `Unknown index "${index}" — not found in table description` };
}

// ---------------------------------------------------------------------------
// Attribute type resolution
// ---------------------------------------------------------------------------

type DynamoKeyAttrType = "S" | "N" | "B";

function resolveAttrType(
  attrName: string,
  describe: TableDescription,
): DynamoKeyAttrType | { error: string } {
  const def = describe.attribute_definitions.find((d) => d.attribute_name === attrName);
  if (!def) {
    return { error: `Attribute "${attrName}" not found in attribute_definitions` };
  }
  return def.attribute_type as DynamoKeyAttrType;
}

// ---------------------------------------------------------------------------
// §D5 / §D5-bis — Fill rule
//
// Returns one of:
//   { kind: "equality", value: string }
//   { kind: "begins_with", prefix: string }
//   { kind: "drop" }          — partition-only (SK context only)
//   { kind: "error", reason, field? }
// ---------------------------------------------------------------------------

type FillRuleResult =
  | { kind: "equality"; value: string }
  | { kind: "begins_with"; prefix: string }
  | { kind: "drop" }
  | { kind: "error"; reason: string; field?: string };

function applyFillRule(
  segments: Segment[],
  params: Record<string, string>,
  keyAttrType: DynamoKeyAttrType,
  keyRole: "pk" | "sk",
): FillRuleResult {
  // Build an ordered list of (value | empty) for each position in the template
  // while tracking whether each param is filled.
  // We process segments left to right.

  // First: detect interior gaps — an empty param that appears before a filled param.
  // Scan the param segments in order, collecting their fill status.
  const paramSegments = segments.filter((s): s is Extract<Segment, { kind: "param" }> =>
    s.kind === "param",
  );

  if (paramSegments.length === 0) {
    // Pure literal template — always equality with that literal
    const literal = segments
      .filter((s): s is Extract<Segment, { kind: "literal" }> => s.kind === "literal")
      .map((s) => s.text)
      .join("");
    return { kind: "equality", value: literal };
  }

  // Check fill status
  const fillStatuses = paramSegments.map((p) => ({
    ident: p.ident,
    filled: (params[p.ident] ?? "").length > 0,
  }));

  // Find the index of the last filled param
  let lastFilledIdx = -1;
  for (let i = 0; i < fillStatuses.length; i++) {
    const entry = fillStatuses[i];
    if (entry !== undefined && entry.filled) lastFilledIdx = i;
  }

  // Check for interior gaps: an empty param before a filled param
  const lastFilledEntry = lastFilledIdx >= 0 ? fillStatuses[lastFilledIdx] : undefined;
  for (let i = 0; i < lastFilledIdx; i++) {
    const entry = fillStatuses[i];
    if (entry !== undefined && !entry.filled) {
      return {
        kind: "error",
        reason: `Parameter "${entry.ident}" is empty but "${lastFilledEntry?.ident ?? "unknown"}" (after it) is filled — interior gap is not allowed`,
        field: entry.ident,
      };
    }
  }

  // If PK has any empty param → error (PK must fully resolve)
  if (keyRole === "pk" && lastFilledIdx < fillStatuses.length - 1) {
    const emptyIdent = fillStatuses.find((s) => !s.filled)?.ident ?? "unknown";
    return {
      kind: "error",
      reason: `Partition-key parameter "${emptyIdent}" is required — PK must fully resolve to an equality condition`,
      field: emptyIdent,
    };
  }

  if (keyRole === "pk" && fillStatuses.every((s) => !s.filled)) {
    // All params empty in PK — error
    const emptyIdent = fillStatuses[0]?.ident ?? "pk";
    return {
      kind: "error",
      reason: `Partition-key parameter "${emptyIdent}" is required — PK must fully resolve to an equality condition`,
      field: emptyIdent,
    };
  }

  // All params filled → equality
  if (fillStatuses.every((s) => s.filled)) {
    // Build the fully substituted string by walking segments
    let result = "";
    for (const seg of segments) {
      if (seg.kind === "literal") {
        result += seg.text;
      } else {
        result += params[seg.ident] ?? "";
      }
    }
    return { kind: "equality", value: result };
  }

  // SK with trailing empty params — figure out the prefix up to the first empty param
  // (only valid for SK, and PK case was handled above)

  // Collect all segments up to (but not including) the first empty param
  let prefix = "";
  for (const seg of segments) {
    if (seg.kind === "literal") {
      prefix += seg.text;
    } else {
      // This is a param segment — is it filled?
      const val = params[seg.ident] ?? "";
      if (val.length === 0) {
        // First empty param — stop here
        break;
      }
      prefix += val;
    }
  }

  // Bare ${param} with no prefix at all → DROP (partition-only)
  if (prefix.length === 0) {
    return { kind: "drop" };
  }

  // begins_with is string-only (§D5-bis)
  if (keyAttrType !== "S") {
    return {
      kind: "error",
      reason: `Sort key "${keyRole}" is of type ${keyAttrType}, which does not support begins_with — a partially-filled template is not allowed on a non-string key`,
      field: keyRole,
    };
  }

  return { kind: "begins_with", prefix };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Compile an access pattern + filled params into a BuilderState.query.
 *
 * @param accessPattern  The chosen access pattern from a DynamoModel.
 * @param params         User-filled parameter values; missing keys treated as "".
 * @param describe       The TableDescription for the physical table.
 * @returns ModelCompileResult — either `{ kind: "ok", query, indexName }` or
 *          `{ kind: "error", reason, field? }`.
 *
 * The returned `query` is consumed unchanged by `builderCompiler.compile()`.
 * The returned `indexName` should be set on `BuilderState.indexName`.
 */
export function compileModel(
  accessPattern: AccessPattern,
  params: Record<string, string>,
  describe: TableDescription,
): ModelCompileResult {
  // 1. Resolve index → key schema
  const keySchemaOrError = resolveKeySchema(accessPattern.index, describe);
  if ("error" in keySchemaOrError) {
    return { kind: "error", reason: keySchemaOrError.error, field: "index" };
  }
  const keySchema = keySchemaOrError;

  const pkDef = keySchema.find((k) => k.key_type === "HASH");
  const skDef = keySchema.find((k) => k.key_type === "RANGE");

  if (!pkDef) {
    return {
      kind: "error",
      reason: `Index "${accessPattern.index}" has no HASH key in its key schema`,
      field: "index",
    };
  }

  // 2. Resolve PK attribute type
  const pkAttrTypeOrError = resolveAttrType(pkDef.attribute_name, describe);
  if (typeof pkAttrTypeOrError === "object" && "error" in pkAttrTypeOrError) {
    return { kind: "error", reason: pkAttrTypeOrError.error, field: "pk" };
  }
  const pkAttrType = pkAttrTypeOrError;

  // 3. Parse PK template
  const pkSegmentsOrError = parseTemplate(accessPattern.pk);
  if ("error" in pkSegmentsOrError) {
    return { kind: "error", reason: pkSegmentsOrError.error, field: "pk" };
  }
  const pkSegments = pkSegmentsOrError;

  // 4. Apply PK fill rule
  const pkFill = applyFillRule(pkSegments, params, pkAttrType, "pk");
  if (pkFill.kind === "error") return pkFill;
  if (pkFill.kind === "drop") {
    // Should not happen (PK never drops), but guard anyway
    return {
      kind: "error",
      reason: "Partition key cannot be empty",
      field: "pk",
    };
  }
  if (pkFill.kind === "begins_with") {
    // PK cannot degrade to begins_with (DynamoDB requires equality PK)
    return {
      kind: "error",
      reason: "Partition key must be fully specified — begins_with is not valid on a PK",
      field: "pk",
    };
  }

  // PK equality value
  const pkTypedValue: TypedValue =
    pkAttrType === "N"
      ? { type: "N", value: pkFill.value }
      : { type: "S", value: pkFill.value };

  // 5. Build the partitionKey clause
  const partitionKey: NonNullable<BuilderState["query"]>["partitionKey"] = {
    name: pkDef.attribute_name,
    value: pkTypedValue,
  };

  // 6. Handle SK (optional)
  let sortKey: NonNullable<BuilderState["query"]>["sortKey"] | undefined;

  if (accessPattern.sk !== undefined && skDef) {
    // Resolve SK attribute type
    const skAttrTypeOrError = resolveAttrType(skDef.attribute_name, describe);
    if (typeof skAttrTypeOrError === "object" && "error" in skAttrTypeOrError) {
      return { kind: "error", reason: skAttrTypeOrError.error, field: "sk" };
    }
    const skAttrType = skAttrTypeOrError;

    // Parse SK template
    const skSegmentsOrError = parseTemplate(accessPattern.sk);
    if ("error" in skSegmentsOrError) {
      return { kind: "error", reason: skSegmentsOrError.error, field: "sk" };
    }
    const skSegments = skSegmentsOrError;

    // Apply SK fill rule
    const skFill = applyFillRule(skSegments, params, skAttrType, "sk");
    if (skFill.kind === "error") return skFill;

    if (skFill.kind === "drop") {
      // Drop SK → partition-only query
      sortKey = undefined;
    } else if (skFill.kind === "begins_with") {
      sortKey = {
        name: skDef.attribute_name,
        op: "begins_with",
        value: { type: "S", value: skFill.prefix },
      };
    } else {
      // equality
      const skTypedValue: TypedValue =
        skAttrType === "N"
          ? { type: "N", value: skFill.value }
          : { type: "S", value: skFill.value };
      sortKey = {
        name: skDef.attribute_name,
        op: "=",
        value: skTypedValue,
      };
    }
  }
  // If accessPattern.sk is undefined or skDef is missing → partition-only (sortKey stays undefined)

  // 7. Determine index name for BuilderState.indexName
  const indexName: string | null = accessPattern.index === "table" ? null : accessPattern.index;

  return {
    kind: "ok",
    query: { partitionKey, sortKey },
    indexName,
  };
}
