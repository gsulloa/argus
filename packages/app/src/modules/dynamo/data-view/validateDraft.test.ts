import { describe, expect, it } from "vitest";
import { validateDraft } from "./validateDraft";
import type { ModelDraft } from "./types";
import type { TableDescription } from "@/modules/dynamo/tables/types";

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

/**
 * Table fixture:
 *   Primary key: pk (S) + sk (S)
 *   GSI1:        gsi1pk (S) + gsi1sk (N)  — numeric sort key to test N-typing
 */
const DESCRIBE: TableDescription = {
  table_name: "AppTable",
  table_arn: "arn:aws:dynamodb:us-east-1:123:table/AppTable",
  table_status: "ACTIVE",
  item_count: 0,
  table_size_bytes: 0,
  billing_mode: "PAY_PER_REQUEST",
  key_schema: [
    { attribute_name: "pk", key_type: "HASH" },
    { attribute_name: "sk", key_type: "RANGE" },
  ],
  attribute_definitions: [
    { attribute_name: "pk", attribute_type: "S" },
    { attribute_name: "sk", attribute_type: "S" },
    { attribute_name: "gsi1pk", attribute_type: "S" },
    { attribute_name: "gsi1sk", attribute_type: "N" },
  ],
  global_secondary_indexes: [
    {
      index_name: "GSI1",
      key_schema: [
        { attribute_name: "gsi1pk", key_type: "HASH" },
        { attribute_name: "gsi1sk", key_type: "RANGE" },
      ],
      projection_type: "ALL",
      index_status: "ACTIVE",
    },
  ],
  local_secondary_indexes: [],
};

// ---------------------------------------------------------------------------
// Test 1 — Unknown index rejected
// ---------------------------------------------------------------------------

describe("validateDraft — unknown index rejected", () => {
  it("access pattern referencing a nonexistent index → valid false, issue.index 0, field 'index'", () => {
    const draft: ModelDraft = {
      name: "MyEntity",
      access_patterns: [{ index: "NoSuchIndex", pk: "X" }],
    };
    const result = validateDraft(draft, DESCRIBE);
    expect(result.valid).toBe(false);
    expect(result.schemaChecksSkipped).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.index).toBe(0);
    expect(result.issues[0]?.field).toBe("index");
    expect(result.issues[0]?.reason).toMatch(/NoSuchIndex/);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Numeric (N) sort key: fully resolved sentinel-filled templates
//           compile structurally OK (equality on N is allowed)
// ---------------------------------------------------------------------------

describe("validateDraft — numeric N-typed sort key compiles OK when fully resolved", () => {
  it("GSI1 with fully-resolvable templates (sentinel-filled) → valid true", () => {
    const draft: ModelDraft = {
      name: "VersionedEntity",
      access_patterns: [{ index: "GSI1", pk: "${gsi1pkVal}", sk: "${version}" }],
    };
    const result = validateDraft(draft, DESCRIBE);
    // Sentinel fills both params → equality on N key, which is valid
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.schemaChecksSkipped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Malformed unterminated ${ rejected
// ---------------------------------------------------------------------------

describe("validateDraft — malformed template rejected", () => {
  it("pk with unterminated ${ → valid false (with describe)", () => {
    const draft: ModelDraft = {
      name: "MyEntity",
      access_patterns: [{ index: "table", pk: "USER#${oops" }],
    };
    const result = validateDraft(draft, DESCRIBE);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.index).toBe(0);
    expect(result.issues[0]?.reason).toMatch(/Unterminated/i);
  });

  it("pk with unterminated ${ → valid false (without describe, grammar-only)", () => {
    const draft: ModelDraft = {
      name: "MyEntity",
      access_patterns: [{ index: "table", pk: "USER#${oops" }],
    };
    const result = validateDraft(draft, null);
    expect(result.valid).toBe(false);
    expect(result.schemaChecksSkipped).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.index).toBe(0);
    expect(result.issues[0]?.field).toBe("pk");
    expect(result.issues[0]?.reason).toMatch(/Unterminated/i);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Valid draft passes with describe
// ---------------------------------------------------------------------------

describe("validateDraft — valid draft passes", () => {
  it("well-formed access pattern on table index → valid true, no issues, schemaChecksSkipped false", () => {
    const draft: ModelDraft = {
      name: "Order",
      access_patterns: [{ index: "table", pk: "USER#${userId}", sk: "ORDER#${orderId}" }],
    };
    const result = validateDraft(draft, DESCRIBE);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.schemaChecksSkipped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Offline (describe = null) with well-formed templates → valid true, schemaChecksSkipped true
// ---------------------------------------------------------------------------

describe("validateDraft — offline, well-formed templates", () => {
  it("no describe provided → valid true, schemaChecksSkipped true", () => {
    const draft: ModelDraft = {
      name: "Order",
      access_patterns: [{ index: "table", pk: "USER#${userId}", sk: "ORDER#${orderId}" }],
    };
    const result = validateDraft(draft, null);
    expect(result.valid).toBe(true);
    expect(result.schemaChecksSkipped).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("undefined describe → valid true, schemaChecksSkipped true", () => {
    const draft: ModelDraft = {
      name: "Order",
      access_patterns: [{ index: "table", pk: "USER#${userId}" }],
    };
    const result = validateDraft(draft, undefined);
    expect(result.valid).toBe(true);
    expect(result.schemaChecksSkipped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 6 — Empty name → valid false, index -1 issue
// ---------------------------------------------------------------------------

describe("validateDraft — empty name", () => {
  it("name empty string → valid false, issue at index -1", () => {
    const draft: ModelDraft = {
      name: "",
      access_patterns: [{ index: "table", pk: "USER#${userId}" }],
    };
    const result = validateDraft(draft, DESCRIBE);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.index).toBe(-1);
    expect(result.issues[0]?.reason).toMatch(/name.*required|required.*name/i);
  });

  it("name whitespace-only → valid false, issue at index -1", () => {
    const draft: ModelDraft = {
      name: "   ",
      access_patterns: [{ index: "table", pk: "USER#${userId}" }],
    };
    const result = validateDraft(draft, null);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.index).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Test 7 — Empty access_patterns → valid false, index -1 issue
// ---------------------------------------------------------------------------

describe("validateDraft — empty access_patterns", () => {
  it("no access patterns → valid false, issue at index -1", () => {
    const draft: ModelDraft = {
      name: "MyEntity",
      access_patterns: [],
    };
    const result = validateDraft(draft, DESCRIBE);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.index).toBe(-1);
    expect(result.issues[0]?.reason).toMatch(/access pattern/i);
  });

  it("no access patterns, no describe → valid false, issue at index -1", () => {
    const draft: ModelDraft = {
      name: "MyEntity",
      access_patterns: [],
    };
    const result = validateDraft(draft, null);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.index).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Bonus: sk with unterminated ${ in offline mode
// ---------------------------------------------------------------------------

describe("validateDraft — offline sk grammar check", () => {
  it("sk with unterminated ${ → valid false in offline mode", () => {
    const draft: ModelDraft = {
      name: "MyEntity",
      access_patterns: [{ index: "table", pk: "USER#${userId}", sk: "ORDER#${broken" }],
    };
    const result = validateDraft(draft, undefined);
    expect(result.valid).toBe(false);
    expect(result.schemaChecksSkipped).toBe(true);
    expect(result.issues[0]?.field).toBe("sk");
    expect(result.issues[0]?.reason).toMatch(/Unterminated/i);
  });
});
