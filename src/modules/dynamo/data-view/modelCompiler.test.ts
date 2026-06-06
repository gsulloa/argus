import { describe, expect, it } from "vitest";
import { compileModel } from "./modelCompiler";
import { compile } from "./builderCompiler";
import type { AccessPattern, BuilderState } from "./types";
import type { TableDescription } from "@/modules/dynamo/tables/types";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Build a TableDescription with a primary key (and optional SK) plus optional
 * GSIs. All attribute types are configurable per test.
 */
function makeDescribe(opts: {
  pk: { name: string; type: "S" | "N" | "B" };
  sk?: { name: string; type: "S" | "N" | "B" };
  gsi?: Array<{
    index_name: string;
    pk: { name: string; type: "S" | "N" | "B" };
    sk?: { name: string; type: "S" | "N" | "B" };
  }>;
}): TableDescription {
  const attrDefs: TableDescription["attribute_definitions"] = [
    { attribute_name: opts.pk.name, attribute_type: opts.pk.type },
    ...(opts.sk ? [{ attribute_name: opts.sk.name, attribute_type: opts.sk.type }] : []),
    ...(opts.gsi ?? []).flatMap((g) => [
      { attribute_name: g.pk.name, attribute_type: g.pk.type },
      ...(g.sk ? [{ attribute_name: g.sk.name, attribute_type: g.sk.type }] : []),
    ]),
  ];

  // Deduplicate attribute_definitions (same attr name may appear in both
  // table and GSI — DynamoDB shares attribute_definitions globally)
  const seenAttrs = new Set<string>();
  const uniqueAttrDefs = attrDefs.filter((a) => {
    if (seenAttrs.has(a.attribute_name)) return false;
    seenAttrs.add(a.attribute_name);
    return true;
  });

  return {
    table_name: "AppTable",
    table_arn: "arn:aws:dynamodb:us-east-1:123:table/AppTable",
    table_status: "ACTIVE",
    item_count: 0,
    table_size_bytes: 0,
    billing_mode: "PAY_PER_REQUEST",
    key_schema: [
      { attribute_name: opts.pk.name, key_type: "HASH" },
      ...(opts.sk ? [{ attribute_name: opts.sk.name, key_type: "RANGE" as const }] : []),
    ],
    attribute_definitions: uniqueAttrDefs,
    global_secondary_indexes: (opts.gsi ?? []).map((g) => ({
      index_name: g.index_name,
      key_schema: [
        { attribute_name: g.pk.name, key_type: "HASH" as const },
        ...(g.sk ? [{ attribute_name: g.sk.name, key_type: "RANGE" as const }] : []),
      ],
      projection_type: "ALL",
      index_status: "ACTIVE",
    })),
    local_secondary_indexes: [],
  };
}

// Base table: PK=pk (S), SK=sk (S)
const DESC_BASE = makeDescribe({ pk: { name: "pk", type: "S" }, sk: { name: "sk", type: "S" } });

// Table with GSI1: GSI1PK (S), GSI1SK (S)
const DESC_WITH_GSI = makeDescribe({
  pk: { name: "pk", type: "S" },
  sk: { name: "sk", type: "S" },
  gsi: [
    {
      index_name: "GSI1",
      pk: { name: "GSI1PK", type: "S" },
      sk: { name: "GSI1SK", type: "S" },
    },
  ],
});

// Table with GSI that has a numeric sort key
const DESC_GSI_NUMERIC_SK = makeDescribe({
  pk: { name: "pk", type: "S" },
  sk: { name: "sk", type: "S" },
  gsi: [
    {
      index_name: "VersionIndex",
      pk: { name: "entityId", type: "S" },
      sk: { name: "version", type: "N" },
    },
  ],
});

// PK-only table (no sort key)
const DESC_PK_ONLY = makeDescribe({ pk: { name: "pk", type: "S" } });

/** Helper to create a BuilderState with default non-query fields. */
function defaultBuilderBase(): Omit<BuilderState, "mode" | "query" | "indexName"> {
  return {
    pageSize: 100,
    consistentRead: false,
    scanIndexForward: true,
    filters: [],
  };
}

// ---------------------------------------------------------------------------
// Spec Scenario: Fully filled template compiles to equality
// ---------------------------------------------------------------------------

describe("modelCompiler — Scenario: Fully filled template compiles to equality", () => {
  it("both pk and sk fully filled → equality conditions on both keys", () => {
    const ap: AccessPattern = {
      index: "table",
      pk: "USER#${userId}",
      sk: "ORDER#${orderId}",
    };
    const result = compileModel(ap, { userId: "123", orderId: "456" }, DESC_BASE);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    expect(result.indexName).toBeNull();
    expect(result.query.partitionKey.name).toBe("pk");
    expect(result.query.partitionKey.value).toEqual({ type: "S", value: "USER#123" });
    expect(result.query.sortKey).toBeDefined();
    expect(result.query.sortKey?.name).toBe("sk");
    expect(result.query.sortKey?.op).toBe("=");
    expect(result.query.sortKey?.value).toEqual({ type: "S", value: "ORDER#456" });
  });

  it("pure-literal template compiles to equality with the literal value", () => {
    const ap: AccessPattern = { index: "table", pk: "HARDCODED", sk: "ITEM" };
    const result = compileModel(ap, {}, DESC_BASE);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.query.partitionKey.value).toEqual({ type: "S", value: "HARDCODED" });
    expect(result.query.sortKey?.value).toEqual({ type: "S", value: "ITEM" });
    expect(result.query.sortKey?.op).toBe("=");
  });
});

// ---------------------------------------------------------------------------
// Spec Scenario: Empty trailing sort-key parameter compiles to begins_with
// ---------------------------------------------------------------------------

describe("modelCompiler — Scenario: Empty trailing sort-key parameter compiles to begins_with", () => {
  it("sk trailing empty with literal prefix → begins_with on prefix", () => {
    const ap: AccessPattern = {
      index: "table",
      pk: "USER#${userId}",
      sk: "ORDER#${orderId}",
    };
    const result = compileModel(ap, { userId: "123", orderId: "" }, DESC_BASE);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    expect(result.query.partitionKey.value).toEqual({ type: "S", value: "USER#123" });
    expect(result.query.sortKey?.op).toBe("begins_with");
    expect(result.query.sortKey?.value).toEqual({ type: "S", value: "ORDER#" });
    expect(result.query.sortKey?.name).toBe("sk");
  });
});

// ---------------------------------------------------------------------------
// Spec Scenario: Bare empty sort-key template drops the condition
// ---------------------------------------------------------------------------

describe("modelCompiler — Scenario: Bare empty sort-key template drops the condition", () => {
  it("bare ${cursor} with cursor empty → partition-only Query (SK dropped)", () => {
    const ap: AccessPattern = {
      index: "table",
      pk: "USER#${userId}",
      sk: "${cursor}",
    };
    const result = compileModel(ap, { userId: "123", cursor: "" }, DESC_BASE);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    expect(result.query.partitionKey.value).toEqual({ type: "S", value: "USER#123" });
    expect(result.query.sortKey).toBeUndefined();
  });

  it("access pattern with no sk field → partition-only Query", () => {
    const ap: AccessPattern = {
      index: "table",
      pk: "USER#${userId}",
      // no sk
    };
    const result = compileModel(ap, { userId: "123" }, DESC_BASE);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    expect(result.query.partitionKey.value).toEqual({ type: "S", value: "USER#123" });
    expect(result.query.sortKey).toBeUndefined();
  });

  it("pk-only table with pk-only access pattern → partition-only Query", () => {
    const ap: AccessPattern = { index: "table", pk: "USER#${userId}" };
    const result = compileModel(ap, { userId: "123" }, DESC_PK_ONLY);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    expect(result.query.partitionKey.value).toEqual({ type: "S", value: "USER#123" });
    expect(result.query.sortKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Spec Scenario: Gap before a filled parameter is rejected
// ---------------------------------------------------------------------------

describe("modelCompiler — Scenario: Gap before a filled parameter is rejected", () => {
  it("interior gap in SK template (x empty, y filled) → error naming x", () => {
    const ap: AccessPattern = {
      index: "table",
      pk: "USER#${userId}",
      sk: "A#${x}#B#${y}",
    };
    const result = compileModel(ap, { userId: "123", x: "", y: "5" }, DESC_BASE);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.field).toBe("x");
    expect(result.reason).toMatch(/x/);
  });

  it("interior gap with multiple params — first empty before a filled is the offender", () => {
    const ap: AccessPattern = {
      index: "table",
      pk: "PK",
      sk: "${a}#${b}#${c}",
    };
    // a empty, b filled, c filled → a is the interior gap
    const result = compileModel(ap, { a: "", b: "B", c: "C" }, DESC_BASE);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.field).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// Spec Scenario: Unresolved partition key is rejected
// ---------------------------------------------------------------------------

describe("modelCompiler — Scenario: Unresolved partition key is rejected", () => {
  it("pk param empty → error (PK must fully resolve)", () => {
    const ap: AccessPattern = {
      index: "table",
      pk: "USER#${userId}",
      sk: "ORDER#${orderId}",
    };
    const result = compileModel(ap, { userId: "", orderId: "456" }, DESC_BASE);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.field).toBe("userId");
    expect(result.reason).toMatch(/userId/);
  });

  it("all pk params empty → error", () => {
    const ap: AccessPattern = { index: "table", pk: "USER#${userId}" };
    const result = compileModel(ap, { userId: "" }, DESC_BASE);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.reason).toMatch(/userId|required|PK/i);
  });

  it("PK trailing-empty (multi-param) → error (no begins_with on PK)", () => {
    const ap: AccessPattern = {
      index: "table",
      pk: "USER#${userId}#${suffix}",
    };
    // userId filled, suffix empty → trailing-empty PK
    const result = compileModel(ap, { userId: "123", suffix: "" }, DESC_BASE);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    // PK cannot degrade to begins_with
    expect(result.reason).toMatch(/suffix|required|PK|fully/i);
  });
});

// ---------------------------------------------------------------------------
// Spec Scenario: Numeric sort key emits an N-typed value
// ---------------------------------------------------------------------------

describe("modelCompiler — Scenario: Numeric sort key emits an N-typed value", () => {
  it("version N-typed sk → emits { type: 'N', value: '7' }", () => {
    const ap: AccessPattern = {
      index: "VersionIndex",
      pk: "${entityId}",
      sk: "${version}",
    };
    const result = compileModel(ap, { entityId: "entity-1", version: "7" }, DESC_GSI_NUMERIC_SK);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    expect(result.query.sortKey?.value).toEqual({ type: "N", value: "7" });
    expect(result.query.sortKey?.op).toBe("=");
    expect(result.indexName).toBe("VersionIndex");
  });

  it("numeric N-typed sk passes builderCompiler.validateKeyType (compose test)", () => {
    const ap: AccessPattern = {
      index: "VersionIndex",
      pk: "${entityId}",
      sk: "${version}",
    };
    const modelResult = compileModel(
      ap,
      { entityId: "entity-1", version: "42" },
      DESC_GSI_NUMERIC_SK,
    );
    expect(modelResult.kind).toBe("ok");
    if (modelResult.kind !== "ok") return;

    const builderState: BuilderState = {
      ...defaultBuilderBase(),
      mode: "query",
      indexName: modelResult.indexName,
      query: modelResult.query,
    };
    const compiled = compile(builderState, DESC_GSI_NUMERIC_SK);
    // Must NOT return an error — the N-typed value must pass key-type validation
    expect(compiled.kind).toBe("query");
  });
});

// ---------------------------------------------------------------------------
// Spec Scenario: begins_with rejected on a non-string key
// ---------------------------------------------------------------------------

describe("modelCompiler — Scenario: begins_with rejected on a non-string key", () => {
  it("N-typed sk with trailing-empty param → error (non-string key)", () => {
    const ap: AccessPattern = {
      index: "VersionIndex",
      pk: "${entityId}",
      sk: "V#${version}",
    };
    // version empty → would degrade to begins_with("V#") on an N key
    const result = compileModel(ap, { entityId: "entity-1", version: "" }, DESC_GSI_NUMERIC_SK);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.reason).toMatch(/N|non-string|begins_with/i);
  });
});

// ---------------------------------------------------------------------------
// Spec Scenario: Access pattern with no sort key → partition-only Query
// ---------------------------------------------------------------------------

describe("modelCompiler — Scenario: Access pattern with no sort key", () => {
  it("no sk in access pattern → sortKey undefined", () => {
    const ap: AccessPattern = { index: "table", pk: "USER#${userId}" };
    const result = compileModel(ap, { userId: "42" }, DESC_BASE);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.query.sortKey).toBeUndefined();
    expect(result.query.partitionKey.value).toEqual({ type: "S", value: "USER#42" });
  });
});

// ---------------------------------------------------------------------------
// Spec Scenario: Compiled request matches raw mode (parity test)
// ---------------------------------------------------------------------------

describe("modelCompiler — Scenario: Compiled request matches raw mode", () => {
  it("model output → builderCompiler.compile() equals equivalent hand-built raw BuilderState", () => {
    // Access pattern: GSI1, pk = "ORDER#${orderId}", sk = "STATUS#${status}"
    // params: orderId = "456", status = "" (trailing-empty → begins_with "STATUS#")
    const ap: AccessPattern = {
      index: "GSI1",
      pk: "ORDER#${orderId}",
      sk: "STATUS#${status}",
    };
    const modelResult = compileModel(ap, { orderId: "456", status: "" }, DESC_WITH_GSI);
    expect(modelResult.kind).toBe("ok");
    if (modelResult.kind !== "ok") return;

    // Build the request via model → builderCompiler
    const modelBuilderState: BuilderState = {
      ...defaultBuilderBase(),
      mode: "query",
      indexName: modelResult.indexName,
      query: modelResult.query,
    };
    const modelCompiled = compile(modelBuilderState, DESC_WITH_GSI);
    expect(modelCompiled.kind).toBe("query");
    if (modelCompiled.kind !== "query") return;

    // Build the equivalent request directly in raw mode
    const rawBuilderState: BuilderState = {
      ...defaultBuilderBase(),
      mode: "query",
      indexName: "GSI1",
      query: {
        partitionKey: { name: "GSI1PK", value: { type: "S", value: "ORDER#456" } },
        sortKey: {
          name: "GSI1SK",
          op: "begins_with",
          value: { type: "S", value: "STATUS#" },
        },
      },
    };
    const rawCompiled = compile(rawBuilderState, DESC_WITH_GSI);
    expect(rawCompiled.kind).toBe("query");
    if (rawCompiled.kind !== "query") return;

    // The key condition expressions and attribute maps must be identical
    expect(modelCompiled.request.key_condition_expression).toBe(
      rawCompiled.request.key_condition_expression,
    );
    expect(modelCompiled.request.index_name).toBe(rawCompiled.request.index_name);
    expect(modelCompiled.request.expression_attribute_names).toEqual(
      rawCompiled.request.expression_attribute_names,
    );
    expect(modelCompiled.request.expression_attribute_values).toEqual(
      rawCompiled.request.expression_attribute_values,
    );
  });

  it("fully-filled model output equals raw-mode equality query", () => {
    const ap: AccessPattern = {
      index: "table",
      pk: "USER#${userId}",
      sk: "ORDER#${orderId}",
    };
    const modelResult = compileModel(ap, { userId: "123", orderId: "456" }, DESC_BASE);
    expect(modelResult.kind).toBe("ok");
    if (modelResult.kind !== "ok") return;

    const modelBuilderState: BuilderState = {
      ...defaultBuilderBase(),
      mode: "query",
      indexName: null,
      query: modelResult.query,
    };
    const modelCompiled = compile(modelBuilderState, DESC_BASE);
    expect(modelCompiled.kind).toBe("query");
    if (modelCompiled.kind !== "query") return;

    const rawBuilderState: BuilderState = {
      ...defaultBuilderBase(),
      mode: "query",
      indexName: null,
      query: {
        partitionKey: { name: "pk", value: { type: "S", value: "USER#123" } },
        sortKey: { name: "sk", op: "=", value: { type: "S", value: "ORDER#456" } },
      },
    };
    const rawCompiled = compile(rawBuilderState, DESC_BASE);
    expect(rawCompiled.kind).toBe("query");
    if (rawCompiled.kind !== "query") return;

    expect(modelCompiled.request.key_condition_expression).toBe(
      rawCompiled.request.key_condition_expression,
    );
    expect(modelCompiled.request.expression_attribute_values).toEqual(
      rawCompiled.request.expression_attribute_values,
    );
  });
});

// ---------------------------------------------------------------------------
// Spec Scenario: Unknown index rejected
// ---------------------------------------------------------------------------

describe("modelCompiler — Scenario: Unknown index rejected", () => {
  it("access pattern referencing a nonexistent index → error naming the index", () => {
    const ap: AccessPattern = {
      index: "NoSuchIndex",
      pk: "USER#${userId}",
    };
    const result = compileModel(ap, { userId: "123" }, DESC_BASE);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.reason).toMatch(/NoSuchIndex/);
  });
});

// ---------------------------------------------------------------------------
// Extra: Template parser edge cases
// ---------------------------------------------------------------------------

describe("modelCompiler — template parser edge cases", () => {
  it("bare $ not followed by { is treated as a literal character", () => {
    const ap: AccessPattern = {
      index: "table",
      pk: "$USER#${userId}",
    };
    const result = compileModel(ap, { userId: "123" }, DESC_BASE);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.query.partitionKey.value).toEqual({ type: "S", value: "$USER#123" });
  });

  it("unterminated ${ → error", () => {
    const ap: AccessPattern = {
      index: "table",
      pk: "USER#${userId",
    };
    const result = compileModel(ap, { userId: "123" }, DESC_BASE);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.reason).toMatch(/Unterminated/);
  });

  it("multiple params all filled → fully substituted equality", () => {
    const ap: AccessPattern = {
      index: "table",
      pk: "${a}#${b}#${c}",
    };
    const result = compileModel(ap, { a: "A", b: "B", c: "C" }, DESC_BASE);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.query.partitionKey.value).toEqual({ type: "S", value: "A#B#C" });
  });

  it("sk with two trailing empty params → begins_with on prefix up to first empty", () => {
    const ap: AccessPattern = {
      index: "table",
      pk: "PK",
      sk: "PREFIX#${x}#${y}",
    };
    // x and y both empty → begins_with("PREFIX#")
    const result = compileModel(ap, { x: "", y: "" }, DESC_BASE);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.query.sortKey?.op).toBe("begins_with");
    expect(result.query.sortKey?.value).toEqual({ type: "S", value: "PREFIX#" });
  });

  it("sk with first param filled and second empty → begins_with includes first param value", () => {
    const ap: AccessPattern = {
      index: "table",
      pk: "PK",
      sk: "PREFIX#${x}#${y}",
    };
    // x filled, y empty → begins_with("PREFIX#X_VALUE#")
    const result = compileModel(ap, { x: "foo", y: "" }, DESC_BASE);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.query.sortKey?.op).toBe("begins_with");
    expect(result.query.sortKey?.value).toEqual({ type: "S", value: "PREFIX#foo#" });
  });

  it("GSI access pattern → indexName is the GSI name", () => {
    const ap: AccessPattern = {
      index: "GSI1",
      pk: "ORDER#${orderId}",
      sk: "STATUS#${status}",
    };
    const result = compileModel(ap, { orderId: "456", status: "ACTIVE" }, DESC_WITH_GSI);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.indexName).toBe("GSI1");
    expect(result.query.partitionKey.name).toBe("GSI1PK");
    expect(result.query.sortKey?.name).toBe("GSI1SK");
  });

  it("access pattern with named optional name field — compiles normally (name is UI-only)", () => {
    const ap: AccessPattern = {
      name: "Orders by user",
      index: "table",
      pk: "USER#${userId}",
      sk: "ORDER#${orderId}",
    };
    const result = compileModel(ap, { userId: "u1", orderId: "o1" }, DESC_BASE);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.query.partitionKey.value).toEqual({ type: "S", value: "USER#u1" });
  });
});

// ---------------------------------------------------------------------------
// Compose: modelCompiler → builderCompiler end-to-end for various scenarios
// ---------------------------------------------------------------------------

describe("modelCompiler → builderCompiler compose", () => {
  it("partition-only query (no sk) compiles without error", () => {
    const ap: AccessPattern = { index: "table", pk: "USER#${userId}" };
    const modelResult = compileModel(ap, { userId: "42" }, DESC_BASE);
    expect(modelResult.kind).toBe("ok");
    if (modelResult.kind !== "ok") return;

    const bs: BuilderState = {
      ...defaultBuilderBase(),
      mode: "query",
      indexName: null,
      query: modelResult.query,
    };
    const compiled = compile(bs, DESC_BASE);
    expect(compiled.kind).toBe("query");
    if (compiled.kind !== "query") return;
    expect(compiled.request.key_condition_expression).toBe("#k0 = :k0");
    expect(compiled.request.expression_attribute_values).toEqual({ ":k0": { S: "USER#42" } });
  });

  it("begins_with sk query compiles correctly", () => {
    const ap: AccessPattern = {
      index: "table",
      pk: "USER#${userId}",
      sk: "ORDER#${orderId}",
    };
    const modelResult = compileModel(ap, { userId: "123", orderId: "" }, DESC_BASE);
    expect(modelResult.kind).toBe("ok");
    if (modelResult.kind !== "ok") return;

    const bs: BuilderState = {
      ...defaultBuilderBase(),
      mode: "query",
      indexName: null,
      query: modelResult.query,
    };
    const compiled = compile(bs, DESC_BASE);
    expect(compiled.kind).toBe("query");
    if (compiled.kind !== "query") return;
    expect(compiled.request.key_condition_expression).toBe(
      "#k0 = :k0 AND begins_with(#k1, :k1)",
    );
    expect(compiled.request.expression_attribute_values).toEqual({
      ":k0": { S: "USER#123" },
      ":k1": { S: "ORDER#" },
    });
  });

  it("N-typed sk equality compiles without type validation error", () => {
    const ap: AccessPattern = {
      index: "VersionIndex",
      pk: "${entityId}",
      sk: "${version}",
    };
    const modelResult = compileModel(
      ap,
      { entityId: "entity-99", version: "7" },
      DESC_GSI_NUMERIC_SK,
    );
    expect(modelResult.kind).toBe("ok");
    if (modelResult.kind !== "ok") return;

    const bs: BuilderState = {
      ...defaultBuilderBase(),
      mode: "query",
      indexName: modelResult.indexName,
      query: modelResult.query,
    };
    const compiled = compile(bs, DESC_GSI_NUMERIC_SK);
    expect(compiled.kind).toBe("query");
    if (compiled.kind !== "query") return;
    expect(compiled.request.expression_attribute_values).toMatchObject({
      ":k1": { N: "7" },
    });
  });
});
