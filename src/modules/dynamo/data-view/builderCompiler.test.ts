import { describe, expect, it } from "vitest";
import { compile } from "./builderCompiler";
import type { BuilderState, FilterRow, TypedValue } from "./types";
import type { TableDescription } from "@/modules/dynamo/tables/types";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const makeDescribe = (
  pk: { name: string; type: "S" | "N" | "B" },
  sk?: { name: string; type: "S" | "N" | "B" },
): TableDescription => ({
  table_name: "events",
  table_arn: "arn:aws:dynamodb:us-east-1:123:table/events",
  table_status: "ACTIVE",
  item_count: 0,
  table_size_bytes: 0,
  billing_mode: "PAY_PER_REQUEST",
  key_schema: [
    { attribute_name: pk.name, key_type: "HASH" },
    ...(sk ? [{ attribute_name: sk.name, key_type: "RANGE" as const }] : []),
  ],
  attribute_definitions: [
    { attribute_name: pk.name, attribute_type: pk.type },
    ...(sk ? [{ attribute_name: sk.name, attribute_type: sk.type }] : []),
  ],
  global_secondary_indexes: [],
  local_secondary_indexes: [],
});

const DESC_PK_S = makeDescribe({ name: "pk", type: "S" });
const DESC_PK_N = makeDescribe({ name: "pk", type: "N" });
const DESC_PK_SK = makeDescribe({ name: "pk", type: "S" }, { name: "sk", type: "S" });
const DESC_PK_N_SK_S = makeDescribe({ name: "pk", type: "N" }, { name: "sk", type: "S" });

const defaultScan = (): BuilderState => ({
  mode: "scan",
  indexName: null,
  pageSize: 100,
  consistentRead: false,
  scanIndexForward: true,
  filters: [],
});

const tv = (type: "S", value: string): TypedValue => ({ type, value });
const tvN = (value: string): TypedValue => ({ type: "N", value });

// ---------------------------------------------------------------------------
// Scan mode — basic
// ---------------------------------------------------------------------------

describe("compile — scan mode", () => {
  it("returns { kind: 'scan' } with no expressions for empty filters", () => {
    const result = compile(defaultScan(), DESC_PK_S);
    expect(result.kind).toBe("scan");
    if (result.kind !== "scan") return;
    expect(result.request.filter_expression).toBeNull();
    expect(result.request.expression_attribute_names).toBeNull();
    expect(result.request.expression_attribute_values).toBeNull();
  });

  it("forwards pageSize as limit", () => {
    const b = { ...defaultScan(), pageSize: 250 };
    const result = compile(b, DESC_PK_S);
    if (result.kind !== "scan") throw new Error("expected scan");
    expect(result.request.limit).toBe(250);
  });

  it("forwards consistentRead", () => {
    const b = { ...defaultScan(), consistentRead: true };
    const result = compile(b, DESC_PK_S);
    if (result.kind !== "scan") throw new Error("expected scan");
    expect(result.request.consistent_read).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Filter operators
// ---------------------------------------------------------------------------

describe("compile — filter operators", () => {
  function singleFilter(row: FilterRow): ReturnType<typeof compile> {
    return compile({ ...defaultScan(), filters: [row] }, DESC_PK_S);
  }

  function expectFilter(
    row: FilterRow,
    expectedExpr: string,
    expectedNames: Record<string, string>,
    expectedValues: Record<string, unknown>,
  ) {
    const result = singleFilter(row);
    if (result.kind !== "scan") throw new Error(`expected scan, got ${result.kind}`);
    expect(result.request.filter_expression).toBe(expectedExpr);
    expect(result.request.expression_attribute_names).toEqual(expectedNames);
    expect(result.request.expression_attribute_values).toEqual(expectedValues);
  }

  it("= operator", () => {
    expectFilter(
      { kind: "compare", attribute: "status", op: "=", value: tv("S", "ok") },
      "#n0 = :v0",
      { "#n0": "status" },
      { ":v0": { S: "ok" } },
    );
  });

  it("<> operator", () => {
    expectFilter(
      { kind: "compare", attribute: "status", op: "<>", value: tv("S", "deleted") },
      "#n0 <> :v0",
      { "#n0": "status" },
      { ":v0": { S: "deleted" } },
    );
  });

  it("< operator", () => {
    expectFilter(
      { kind: "compare", attribute: "count", op: "<", value: tvN("10") },
      "#n0 < :v0",
      { "#n0": "count" },
      { ":v0": { N: "10" } },
    );
  });

  it("<= operator", () => {
    expectFilter(
      { kind: "compare", attribute: "count", op: "<=", value: tvN("5") },
      "#n0 <= :v0",
      { "#n0": "count" },
      { ":v0": { N: "5" } },
    );
  });

  it("> operator", () => {
    expectFilter(
      { kind: "compare", attribute: "count", op: ">", value: tvN("0") },
      "#n0 > :v0",
      { "#n0": "count" },
      { ":v0": { N: "0" } },
    );
  });

  it(">= operator", () => {
    expectFilter(
      { kind: "compare", attribute: "count", op: ">=", value: tvN("5") },
      "#n0 >= :v0",
      { "#n0": "count" },
      { ":v0": { N: "5" } },
    );
  });

  it("contains operator", () => {
    expectFilter(
      { kind: "compare", attribute: "name", op: "contains", value: tv("S", "alice") },
      "contains(#n0, :v0)",
      { "#n0": "name" },
      { ":v0": { S: "alice" } },
    );
  });

  it("begins_with operator", () => {
    expectFilter(
      { kind: "compare", attribute: "id", op: "begins_with", value: tv("S", "usr-") },
      "begins_with(#n0, :v0)",
      { "#n0": "id" },
      { ":v0": { S: "usr-" } },
    );
  });

  it("between operator uses two value placeholders", () => {
    expectFilter(
      {
        kind: "compare",
        attribute: "created_at",
        op: "between",
        value: { min: tv("S", "2025-01-01"), max: tv("S", "2025-12-31") },
      },
      "#n0 BETWEEN :v0 AND :v1",
      { "#n0": "created_at" },
      { ":v0": { S: "2025-01-01" }, ":v1": { S: "2025-12-31" } },
    );
  });

  it("attribute_exists — no ExpressionAttributeValues entry", () => {
    const result = singleFilter({ kind: "unary", attribute: "archived", op: "attribute_exists" });
    if (result.kind !== "scan") throw new Error("expected scan");
    expect(result.request.filter_expression).toBe("attribute_exists(#n0)");
    expect(result.request.expression_attribute_names).toEqual({ "#n0": "archived" });
    expect(result.request.expression_attribute_values).toBeNull();
  });

  it("attribute_not_exists — no ExpressionAttributeValues entry", () => {
    const result = singleFilter({ kind: "unary", attribute: "archived", op: "attribute_not_exists" });
    if (result.kind !== "scan") throw new Error("expected scan");
    expect(result.request.filter_expression).toBe("attribute_not_exists(#n0)");
    expect(result.request.expression_attribute_names).toEqual({ "#n0": "archived" });
    expect(result.request.expression_attribute_values).toBeNull();
  });

  it("is_null compiles to attribute_type(..., { S: 'NULL' })", () => {
    const result = singleFilter({ kind: "unary", attribute: "deleted_at", op: "is_null" });
    if (result.kind !== "scan") throw new Error("expected scan");
    expect(result.request.filter_expression).toBe("attribute_type(#n0, :t0)");
    expect(result.request.expression_attribute_names).toEqual({ "#n0": "deleted_at" });
    expect(result.request.expression_attribute_values).toEqual({ ":t0": { S: "NULL" } });
  });

  it("is_not_null compiles to NOT attribute_type(..., { S: 'NULL' })", () => {
    const result = singleFilter({ kind: "unary", attribute: "deleted_at", op: "is_not_null" });
    if (result.kind !== "scan") throw new Error("expected scan");
    expect(result.request.filter_expression).toBe("NOT attribute_type(#n0, :t0)");
    expect(result.request.expression_attribute_values).toEqual({ ":t0": { S: "NULL" } });
  });

  it("attribute_type operator", () => {
    expectFilter(
      { kind: "attribute_type", attribute: "payload", type: "M" },
      "attribute_type(#n0, :v0)",
      { "#n0": "payload" },
      { ":v0": { S: "M" } },
    );
  });
});

// ---------------------------------------------------------------------------
// Reserved-word attribute names round-trip via placeholders
// ---------------------------------------------------------------------------

describe("compile — reserved words via placeholders", () => {
  const reservedWords = ["name", "status", "count", "size", "type", "schema"];

  for (const word of reservedWords) {
    it(`attribute "${word}" is aliased via #n0`, () => {
      const result = compile(
        {
          ...defaultScan(),
          filters: [{ kind: "compare", attribute: word, op: "=", value: tv("S", "x") }],
        },
        DESC_PK_S,
      );
      if (result.kind !== "scan") throw new Error("expected scan");
      expect(result.request.filter_expression).toBe("#n0 = :v0");
      expect(result.request.expression_attribute_names).toEqual({ "#n0": word });
    });
  }
});

// ---------------------------------------------------------------------------
// Multi-row AND joining with sequential placeholders
// ---------------------------------------------------------------------------

describe("compile — multi-row filters", () => {
  it("AND-joins two rows with sequential placeholders", () => {
    const b: BuilderState = {
      ...defaultScan(),
      filters: [
        { kind: "compare", attribute: "status", op: "=", value: tv("S", "ok") },
        { kind: "compare", attribute: "count", op: ">=", value: tvN("5") },
      ],
    };
    const result = compile(b, DESC_PK_S);
    if (result.kind !== "scan") throw new Error("expected scan");
    expect(result.request.filter_expression).toBe("#n0 = :v0 AND #n1 >= :v1");
    expect(result.request.expression_attribute_names).toEqual({
      "#n0": "status",
      "#n1": "count",
    });
    expect(result.request.expression_attribute_values).toEqual({
      ":v0": { S: "ok" },
      ":v1": { N: "5" },
    });
  });

  it("Spec scenario: status = 'ok' AND count >= 5", () => {
    // From spec §'Filter compiles to placeholders'
    const b: BuilderState = {
      ...defaultScan(),
      filters: [
        { kind: "compare", attribute: "status", op: "=", value: tv("S", "ok") },
        { kind: "compare", attribute: "count", op: ">=", value: tvN("5") },
      ],
    };
    const result = compile(b, DESC_PK_S);
    if (result.kind !== "scan") throw new Error("expected scan");
    expect(result.request.filter_expression).toBe("#n0 = :v0 AND #n1 >= :v1");
    expect(result.request.expression_attribute_names).toEqual({
      "#n0": "status",
      "#n1": "count",
    });
    expect(result.request.expression_attribute_values).toEqual({
      ":v0": { S: "ok" },
      ":v1": { N: "5" },
    });
  });
});

// ---------------------------------------------------------------------------
// Query mode — key conditions
// ---------------------------------------------------------------------------

describe("compile — query mode key conditions", () => {
  function buildQuery(
    pkValue: TypedValue,
    skClause?: BuilderState["query"] extends infer Q
      ? Q extends { sortKey?: infer SK }
        ? SK
        : never
      : never,
  ): BuilderState {
    return {
      mode: "query",
      indexName: null,
      pageSize: 100,
      consistentRead: false,
      scanIndexForward: true,
      filters: [],
      query: {
        partitionKey: { name: "pk", value: pkValue },
        sortKey: skClause,
      },
    };
  }

  it("partition key only: #k0 = :k0", () => {
    const result = compile(buildQuery(tv("S", "user-1")), DESC_PK_S);
    if (result.kind !== "query") throw new Error(`expected query, got ${result.kind}`);
    expect(result.request.key_condition_expression).toBe("#k0 = :k0");
    expect(result.request.expression_attribute_names).toEqual({ "#k0": "pk" });
    expect(result.request.expression_attribute_values).toEqual({ ":k0": { S: "user-1" } });
  });

  it("sort key = operator", () => {
    const result = compile(
      buildQuery(tv("S", "user-1"), {
        name: "sk",
        op: "=",
        value: tv("S", "2025-01-01"),
      }),
      DESC_PK_SK,
    );
    if (result.kind !== "query") throw new Error("expected query");
    expect(result.request.key_condition_expression).toBe("#k0 = :k0 AND #k1 = :k1");
  });

  it("sort key < operator", () => {
    const result = compile(
      buildQuery(tv("S", "user-1"), { name: "sk", op: "<", value: tv("S", "2025-06-01") }),
      DESC_PK_SK,
    );
    if (result.kind !== "query") throw new Error("expected query");
    expect(result.request.key_condition_expression).toBe("#k0 = :k0 AND #k1 < :k1");
  });

  it("sort key <= operator", () => {
    const result = compile(
      buildQuery(tv("S", "user-1"), { name: "sk", op: "<=", value: tv("S", "2025-06-01") }),
      DESC_PK_SK,
    );
    if (result.kind !== "query") throw new Error("expected query");
    expect(result.request.key_condition_expression).toBe("#k0 = :k0 AND #k1 <= :k1");
  });

  it("sort key > operator", () => {
    const result = compile(
      buildQuery(tv("S", "user-1"), { name: "sk", op: ">", value: tv("S", "2025-01-01") }),
      DESC_PK_SK,
    );
    if (result.kind !== "query") throw new Error("expected query");
    expect(result.request.key_condition_expression).toBe("#k0 = :k0 AND #k1 > :k1");
  });

  it("sort key >= operator", () => {
    const result = compile(
      buildQuery(tv("S", "user-1"), { name: "sk", op: ">=", value: tv("S", "2025-01-01") }),
      DESC_PK_SK,
    );
    if (result.kind !== "query") throw new Error("expected query");
    expect(result.request.key_condition_expression).toBe("#k0 = :k0 AND #k1 >= :k1");
  });

  it("sort key begins_with", () => {
    const result = compile(
      buildQuery(tv("S", "user-1"), { name: "sk", op: "begins_with", value: tv("S", "2025-") }),
      DESC_PK_SK,
    );
    if (result.kind !== "query") throw new Error("expected query");
    expect(result.request.key_condition_expression).toBe("#k0 = :k0 AND begins_with(#k1, :k1)");
  });

  it("sort key between — spec scenario", () => {
    // From spec §'Sort key between compiles correctly':
    // pk = "user-1" AND sk between "2025-01-01" and "2025-12-31"
    // → KeyConditionExpression: #k0 = :k0 AND #k1 BETWEEN :k1a AND :k1b
    const result = compile(
      buildQuery(tv("S", "user-1"), {
        name: "sk",
        op: "between",
        value: { min: tv("S", "2025-01-01"), max: tv("S", "2025-12-31") },
      }),
      DESC_PK_SK,
    );
    if (result.kind !== "query") throw new Error("expected query");
    expect(result.request.key_condition_expression).toBe(
      "#k0 = :k0 AND #k1 BETWEEN :k1a AND :k1b",
    );
    expect(result.request.expression_attribute_values).toMatchObject({
      ":k0": { S: "user-1" },
      ":k1a": { S: "2025-01-01" },
      ":k1b": { S: "2025-12-31" },
    });
  });
});

// ---------------------------------------------------------------------------
// Type validation
// ---------------------------------------------------------------------------

describe("compile — type validation", () => {
  it("returns error when pk value type does not match schema (N key, S value)", () => {
    const b: BuilderState = {
      mode: "query",
      indexName: null,
      pageSize: 100,
      consistentRead: false,
      scanIndexForward: true,
      filters: [],
      query: {
        partitionKey: { name: "pk", value: tv("S", "not-a-number") },
      },
    };
    const result = compile(b, DESC_PK_N);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.field).toBe("partitionKey");
    }
  });

  it("returns error for non-numeric string in N-typed key", () => {
    const b: BuilderState = {
      mode: "query",
      indexName: null,
      pageSize: 100,
      consistentRead: false,
      scanIndexForward: true,
      filters: [],
      query: {
        partitionKey: { name: "pk", value: { type: "N", value: "abc" } },
      },
    };
    const result = compile(b, DESC_PK_N);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toMatch(/not a valid numeric string/);
    }
  });

  it("accepts valid numeric string for N-typed key", () => {
    const b: BuilderState = {
      mode: "query",
      indexName: null,
      pageSize: 100,
      consistentRead: false,
      scanIndexForward: true,
      filters: [],
      query: {
        partitionKey: { name: "pk", value: { type: "N", value: "42.5" } },
      },
    };
    const result = compile(b, DESC_PK_N);
    expect(result.kind).toBe("query");
  });

  it("accepts integer numeric string for N-typed key", () => {
    const b: BuilderState = {
      mode: "query",
      indexName: null,
      pageSize: 100,
      consistentRead: false,
      scanIndexForward: true,
      filters: [],
      query: {
        partitionKey: { name: "pk", value: { type: "N", value: "1234567890" } },
      },
    };
    const result = compile(b, DESC_PK_N);
    expect(result.kind).toBe("query");
  });

  it("returns error when query has no partitionKey value set", () => {
    const b: BuilderState = {
      mode: "query",
      indexName: null,
      pageSize: 100,
      consistentRead: false,
      scanIndexForward: true,
      filters: [],
    };
    const result = compile(b, DESC_PK_S);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.field).toBe("partitionKey");
    }
  });

  it("validates sort key type mismatch (S key, N value)", () => {
    const b: BuilderState = {
      mode: "query",
      indexName: null,
      pageSize: 100,
      consistentRead: false,
      scanIndexForward: true,
      filters: [],
      query: {
        partitionKey: { name: "pk", value: tvN("42") },
        sortKey: {
          name: "sk",
          op: "=",
          value: tvN("99"),
        },
      },
    };
    // DESC_PK_N_SK_S: pk is N, sk is S — sort key value type N is wrong for S
    const result = compile(b, DESC_PK_N_SK_S);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.field).toBe("sortKey");
    }
  });
});

// ---------------------------------------------------------------------------
// Query mode: filter + key condition names/values merge
// ---------------------------------------------------------------------------

describe("compile — query mode with filters", () => {
  it("merges key condition and filter names/values without collision", () => {
    const b: BuilderState = {
      mode: "query",
      indexName: null,
      pageSize: 100,
      consistentRead: false,
      scanIndexForward: true,
      filters: [
        { kind: "compare", attribute: "status", op: "=", value: tv("S", "active") },
      ],
      query: {
        partitionKey: { name: "pk", value: tv("S", "user-1") },
      },
    };
    const result = compile(b, DESC_PK_S);
    if (result.kind !== "query") throw new Error("expected query");
    expect(result.request.key_condition_expression).toBe("#k0 = :k0");
    expect(result.request.filter_expression).toBe("#n0 = :v0");
    expect(result.request.expression_attribute_names).toEqual({
      "#k0": "pk",
      "#n0": "status",
    });
    expect(result.request.expression_attribute_values).toEqual({
      ":k0": { S: "user-1" },
      ":v0": { S: "active" },
    });
  });
});

// ---------------------------------------------------------------------------
// filterCombinator — AND vs OR joining
// ---------------------------------------------------------------------------

describe("compile — filterCombinator", () => {
  it("AND (default): two filters joined with AND — regression", () => {
    const b: BuilderState = {
      ...defaultScan(),
      filters: [
        { kind: "compare", attribute: "status", op: "=", value: tv("S", "ok") },
        { kind: "compare", attribute: "count", op: ">=", value: tvN("5") },
      ],
    };
    const result = compile(b, DESC_PK_S);
    if (result.kind !== "scan") throw new Error("expected scan");
    expect(result.request.filter_expression).toBe("#n0 = :v0 AND #n1 >= :v1");
  });

  it("AND explicit: two filters joined with AND when filterCombinator is set to AND", () => {
    const b: BuilderState = {
      ...defaultScan(),
      filterCombinator: "AND",
      filters: [
        { kind: "compare", attribute: "status", op: "=", value: tv("S", "ok") },
        { kind: "compare", attribute: "count", op: ">=", value: tvN("5") },
      ],
    };
    const result = compile(b, DESC_PK_S);
    if (result.kind !== "scan") throw new Error("expected scan");
    expect(result.request.filter_expression).toBe("#n0 = :v0 AND #n1 >= :v1");
    expect(result.request.expression_attribute_names).toEqual({
      "#n0": "status",
      "#n1": "count",
    });
    expect(result.request.expression_attribute_values).toEqual({
      ":v0": { S: "ok" },
      ":v1": { N: "5" },
    });
  });

  it("OR: two filters joined with OR", () => {
    const b: BuilderState = {
      ...defaultScan(),
      filterCombinator: "OR",
      filters: [
        { kind: "compare", attribute: "status", op: "=", value: tv("S", "ok") },
        { kind: "compare", attribute: "count", op: ">=", value: tvN("5") },
      ],
    };
    const result = compile(b, DESC_PK_S);
    if (result.kind !== "scan") throw new Error("expected scan");
    expect(result.request.filter_expression).toBe("#n0 = :v0 OR #n1 >= :v1");
    expect(result.request.expression_attribute_names).toEqual({
      "#n0": "status",
      "#n1": "count",
    });
    expect(result.request.expression_attribute_values).toEqual({
      ":v0": { S: "ok" },
      ":v1": { N: "5" },
    });
  });

  it("single filter with filterCombinator OR — no separator emitted", () => {
    const b: BuilderState = {
      ...defaultScan(),
      filterCombinator: "OR",
      filters: [
        { kind: "compare", attribute: "status", op: "=", value: tv("S", "ok") },
      ],
    };
    const result = compile(b, DESC_PK_S);
    if (result.kind !== "scan") throw new Error("expected scan");
    // No OR separator — single item, same output as single-filter AND
    expect(result.request.filter_expression).toBe("#n0 = :v0");
  });

  it("single filter with filterCombinator AND — no separator emitted", () => {
    const b: BuilderState = {
      ...defaultScan(),
      filterCombinator: "AND",
      filters: [
        { kind: "compare", attribute: "status", op: "=", value: tv("S", "ok") },
      ],
    };
    const result = compile(b, DESC_PK_S);
    if (result.kind !== "scan") throw new Error("expected scan");
    expect(result.request.filter_expression).toBe("#n0 = :v0");
  });

  it("empty filters with filterCombinator OR — no FilterExpression emitted", () => {
    const b: BuilderState = {
      ...defaultScan(),
      filterCombinator: "OR",
      filters: [],
    };
    const result = compile(b, DESC_PK_S);
    if (result.kind !== "scan") throw new Error("expected scan");
    expect(result.request.filter_expression).toBeNull();
    expect(result.request.expression_attribute_names).toBeNull();
    expect(result.request.expression_attribute_values).toBeNull();
  });

  it("empty filters with filterCombinator AND — no FilterExpression emitted (regression)", () => {
    const b: BuilderState = {
      ...defaultScan(),
      filterCombinator: "AND",
      filters: [],
    };
    const result = compile(b, DESC_PK_S);
    if (result.kind !== "scan") throw new Error("expected scan");
    expect(result.request.filter_expression).toBeNull();
  });

  it("placeholder indices are sequential regardless of combinator", () => {
    // Verifies that placeholder allocation (#n0, #n1, :v0, :v1) is
    // unchanged when switching to OR.
    const b: BuilderState = {
      ...defaultScan(),
      filterCombinator: "OR",
      filters: [
        { kind: "compare", attribute: "a", op: "=", value: tv("S", "x") },
        { kind: "compare", attribute: "b", op: "=", value: tv("S", "y") },
        { kind: "compare", attribute: "c", op: "=", value: tv("S", "z") },
      ],
    };
    const result = compile(b, DESC_PK_S);
    if (result.kind !== "scan") throw new Error("expected scan");
    expect(result.request.filter_expression).toBe(
      "#n0 = :v0 OR #n1 = :v1 OR #n2 = :v2",
    );
    expect(result.request.expression_attribute_names).toEqual({
      "#n0": "a",
      "#n1": "b",
      "#n2": "c",
    });
    expect(result.request.expression_attribute_values).toEqual({
      ":v0": { S: "x" },
      ":v1": { S: "y" },
      ":v2": { S: "z" },
    });
  });
});

// ---------------------------------------------------------------------------
// scan_index_forward forwarded in query mode
// ---------------------------------------------------------------------------

describe("compile — scanIndexForward", () => {
  it("forwards scanIndexForward: false in query mode", () => {
    const b: BuilderState = {
      mode: "query",
      indexName: null,
      pageSize: 100,
      consistentRead: false,
      scanIndexForward: false,
      filters: [],
      query: { partitionKey: { name: "pk", value: tv("S", "u1") } },
    };
    const result = compile(b, DESC_PK_S);
    if (result.kind !== "query") throw new Error("expected query");
    expect(result.request.scan_index_forward).toBe(false);
  });
});
