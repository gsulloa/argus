import { describe, expect, it } from "vitest";
import { compilePrefilledSelect, compileWhere } from "./compileWhere";
import {
  EMPTY_FILTER_MODEL,
  type DataColumn,
  type FilterModel,
  type FilterRow,
} from "../types";

const cols = (...specs: Array<[string, string]>): DataColumn[] =>
  specs.map(([name, data_type], i) => ({
    name,
    data_type,
    ordinal_position: i + 1,
    is_nullable: true,
  }));

function row(overrides: Partial<FilterRow> = {}): FilterRow {
  return {
    enabled: true,
    column: { kind: "named", name: "col" },
    op: "=",
    value: "v",
    ...overrides,
  };
}

function model(rows: FilterRow[], combinator: "AND" | "OR" = "AND"): FilterModel {
  return { rows, combinator };
}

describe("compileWhere", () => {
  it("returns empty body for an empty model", () => {
    const r = compileWhere(EMPTY_FILTER_MODEL);
    expect(r).toEqual({ body: "" });
  });

  it("returns empty body for empty rows array", () => {
    const r = compileWhere(model([], "OR"));
    expect(r.body).toBe("");
  });

  // ---------------------------------------------------------------------------
  // Single row
  // ---------------------------------------------------------------------------

  it("single row compiles to a predicate without parens", () => {
    const r = compileWhere(
      model([row({ column: { kind: "named", name: "country" }, op: "=", value: "CL" })]),
    );
    expect(r.body).toBe(`"country" = 'CL'`);
  });

  it("single row with Contains", () => {
    const r = compileWhere(
      model([row({ column: { kind: "named", name: "name" }, op: "Contains", value: "ana" })]),
    );
    expect(r.body).toBe(`"name" ILIKE '%' || 'ana' || '%'`);
  });

  it("single row with IS NULL — no value needed", () => {
    const r = compileWhere(
      model([row({ column: { kind: "named", name: "deleted_at" }, op: "IS NULL", value: undefined })]),
    );
    expect(r.body).toBe(`"deleted_at" IS NULL`);
  });

  it("single row with BETWEEN inlines min/max", () => {
    const r = compileWhere(
      model([
        row({
          column: { kind: "named", name: "created_at" },
          op: "BETWEEN",
          value: { min: "2026-01-01", max: "2026-04-30" },
        }),
      ]),
    );
    expect(r.body).toBe(`"created_at" BETWEEN '2026-01-01' AND '2026-04-30'`);
  });

  it("single row with In list", () => {
    const r = compileWhere(
      model([row({ column: { kind: "named", name: "status" }, op: "In", value: ["a", "b", "c"] })]),
    );
    expect(r.body).toBe(`"status" IN ('a', 'b', 'c')`);
  });

  it("escapes single quotes in string literals", () => {
    const r = compileWhere(
      model([row({ column: { kind: "named", name: "name" }, op: "=", value: "O'Brien" })]),
    );
    expect(r.body).toBe(`"name" = 'O''Brien'`);
  });

  // ---------------------------------------------------------------------------
  // Flat AND — three rows, no outer parens
  // ---------------------------------------------------------------------------

  it("flat AND with three rows: p1 AND p2 AND p3 (no outer parens)", () => {
    const r = compileWhere(
      model(
        [
          row({ column: { kind: "named", name: "a" }, op: "=", value: "1" }),
          row({ column: { kind: "named", name: "b" }, op: "=", value: "2" }),
          row({ column: { kind: "named", name: "c" }, op: "=", value: "3" }),
        ],
        "AND",
      ),
    );
    expect(r.body).toBe(`"a" = '1' AND "b" = '2' AND "c" = '3'`);
  });

  it("AND-root regression: status=active AND deleted_at IS NULL", () => {
    const r = compileWhere(
      model(
        [
          row({ column: { kind: "named", name: "status" }, op: "=", value: "active" }),
          row({ column: { kind: "named", name: "deleted_at" }, op: "IS NULL", value: undefined }),
        ],
        "AND",
      ),
    );
    expect(r.body).toBe(`"status" = 'active' AND "deleted_at" IS NULL`);
  });

  // ---------------------------------------------------------------------------
  // Flat OR — three rows, no outer parens
  // ---------------------------------------------------------------------------

  it("flat OR with three rows: p1 OR p2 OR p3 (no outer parens)", () => {
    const r = compileWhere(
      model(
        [
          row({ column: { kind: "named", name: "country" }, op: "=", value: "CL" }),
          row({ column: { kind: "named", name: "country" }, op: "=", value: "AR" }),
          row({ column: { kind: "named", name: "country" }, op: "=", value: "BR" }),
        ],
        "OR",
      ),
    );
    expect(r.body).toBe(`"country" = 'CL' OR "country" = 'AR' OR "country" = 'BR'`);
  });

  // ---------------------------------------------------------------------------
  // Mixed enabled — only enabled+complete rows appear
  // ---------------------------------------------------------------------------

  it("disabled rows are excluded", () => {
    const r = compileWhere(
      model([
        row({ column: { kind: "named", name: "a" }, op: "=", value: "1", enabled: true }),
        row({ column: { kind: "named", name: "b" }, op: "=", value: "2", enabled: false }),
        row({ column: { kind: "named", name: "c" }, op: "=", value: "3", enabled: true }),
      ]),
    );
    expect(r.body).toBe(`"a" = '1' AND "c" = '3'`);
  });

  it("incomplete rows (empty value) are excluded", () => {
    const r = compileWhere(
      model([
        row({ column: { kind: "named", name: "a" }, op: "=", value: "1" }),
        row({ column: { kind: "named", name: "b" }, op: "=", value: "" }),
      ]),
    );
    expect(r.body).toBe(`"a" = '1'`);
  });

  it("all rows disabled → empty body", () => {
    const r = compileWhere(
      model([
        row({ enabled: false }),
        row({ enabled: false }),
      ]),
    );
    expect(r.body).toBe("");
  });

  // ---------------------------------------------------------------------------
  // Any-column expansion
  // ---------------------------------------------------------------------------

  it("expands Any-column across text-castable columns and skips bytea", () => {
    const columns = cols(
      ["name", "text"],
      ["payload", "bytea"],
      ["notes", "text"],
    );
    const r = compileWhere(
      model([
        row({ column: { kind: "any_column" }, op: "Contains", value: "argus" }),
      ]),
      columns,
    );
    expect(r.body).toBe(
      `("name"::text ILIKE '%' || 'argus' || '%' OR "notes"::text ILIKE '%' || 'argus' || '%')`,
    );
  });

  it("returns (FALSE) when Any-column has no castable columns", () => {
    const r = compileWhere(
      model([row({ column: { kind: "any_column" }, op: "=", value: "x" })]),
      cols(["a", "bytea"], ["b", "bytea"]),
    );
    expect(r.body).toBe(`(FALSE)`);
  });

  it("any_column IS NULL on no-castable-cols → (FALSE)", () => {
    const r = compileWhere(
      model([row({ column: { kind: "any_column" }, op: "IS NULL", value: undefined })]),
      cols(["a", "bytea"]),
    );
    expect(r.body).toBe(`(FALSE)`);
  });

  // ---------------------------------------------------------------------------
  // RAW rows
  // ---------------------------------------------------------------------------

  it("RAW row compiles to (<expr>)", () => {
    const r = compileWhere(
      model([row({ column: { kind: "raw" }, op: "RAW", value: "data->>'estado' = 'activo'" })]),
    );
    expect(r.body).toBe(`(data->>'estado' = 'activo')`);
  });

  it("RAW row trims leading/trailing whitespace in expr", () => {
    const r = compileWhere(
      model([row({ column: { kind: "raw" }, op: "RAW", value: "  id > 0  " })]),
    );
    expect(r.body).toBe(`(id > 0)`);
  });

  it("RAW row combined with a structured row under AND", () => {
    const r = compileWhere(
      model(
        [
          row({ column: { kind: "named", name: "status" }, op: "=", value: "active" }),
          row({ column: { kind: "raw" }, op: "RAW", value: "data->>'flag' = 'true'" }),
        ],
        "AND",
      ),
    );
    expect(r.body).toBe(`"status" = 'active' AND (data->>'flag' = 'true')`);
  });

  it("RAW row combined with a structured row under OR", () => {
    const r = compileWhere(
      model(
        [
          row({ column: { kind: "named", name: "status" }, op: "=", value: "active" }),
          row({ column: { kind: "raw" }, op: "RAW", value: "data->>'flag' = 'true'" }),
        ],
        "OR",
      ),
    );
    expect(r.body).toBe(`"status" = 'active' OR (data->>'flag' = 'true')`);
  });
});

describe("compilePrefilledSelect", () => {
  const baseArgs = {
    schema: "public",
    relation: "users",
    columns: cols(["id", "int4"], ["name", "text"]),
    orderBy: [],
    limit: 200,
  };

  it("emits SELECT * with no WHERE for an empty model", () => {
    const sql = compilePrefilledSelect({
      ...baseArgs,
      model: EMPTY_FILTER_MODEL,
    });
    expect(sql).toBe(`SELECT * FROM "public"."users"\nLIMIT 200`);
  });

  it("includes WHERE for applied filters", () => {
    const m = model([
      row({ column: { kind: "named", name: "country" }, op: "=", value: "CL" }),
    ]);
    const sql = compilePrefilledSelect({ ...baseArgs, model: m });
    expect(sql).toBe(
      `SELECT * FROM "public"."users"\nWHERE "country" = 'CL'\nLIMIT 200`,
    );
  });

  it("includes WHERE and ORDER BY", () => {
    const m = model([
      row({ column: { kind: "named", name: "country" }, op: "=", value: "CL" }),
    ]);
    const sql = compilePrefilledSelect({
      ...baseArgs,
      model: m,
      orderBy: [{ column: "created_at", direction: "desc" }],
    });
    expect(sql).toBe(
      `SELECT * FROM "public"."users"\nWHERE "country" = 'CL'\nORDER BY "created_at" DESC\nLIMIT 200`,
    );
  });

  it("emits no WHERE when all rows are disabled", () => {
    const m = model([row({ enabled: false })]);
    const sql = compilePrefilledSelect({ ...baseArgs, model: m });
    expect(sql).toBe(`SELECT * FROM "public"."users"\nLIMIT 200`);
  });

  it("flat AND: WHERE p1 AND p2 AND p3", () => {
    const m = model(
      [
        row({ column: { kind: "named", name: "a" }, op: "=", value: "1" }),
        row({ column: { kind: "named", name: "b" }, op: "=", value: "2" }),
        row({ column: { kind: "named", name: "c" }, op: "=", value: "3" }),
      ],
      "AND",
    );
    const sql = compilePrefilledSelect({ ...baseArgs, model: m });
    expect(sql).toBe(
      `SELECT * FROM "public"."users"\nWHERE "a" = '1' AND "b" = '2' AND "c" = '3'\nLIMIT 200`,
    );
  });

  it("flat OR: WHERE p1 OR p2 OR p3", () => {
    const m = model(
      [
        row({ column: { kind: "named", name: "x" }, op: "=", value: "1" }),
        row({ column: { kind: "named", name: "x" }, op: "=", value: "2" }),
        row({ column: { kind: "named", name: "x" }, op: "=", value: "3" }),
      ],
      "OR",
    );
    const sql = compilePrefilledSelect({ ...baseArgs, model: m });
    expect(sql).toBe(
      `SELECT * FROM "public"."users"\nWHERE "x" = '1' OR "x" = '2' OR "x" = '3'\nLIMIT 200`,
    );
  });
});
