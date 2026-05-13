import { describe, expect, it } from "vitest";
import { compilePrefilledSelect, compileWhere } from "./compileWhere";
import {
  EMPTY_FILTER_MODEL,
  type DataColumn,
  type FilterModel,
} from "../types";

const cols = (...specs: Array<[string, string]>): DataColumn[] =>
  specs.map(([name, data_type], i) => ({
    name,
    data_type,
    ordinal_position: i + 1,
    is_nullable: true,
  }));

const structured = (
  model: Pick<FilterModel, "tree">,
): FilterModel => ({
  mode: "structured",
  tree: model.tree,
  raw: "",
});

describe("compileWhere", () => {
  it("returns empty body for an empty model", () => {
    const r = compileWhere(EMPTY_FILTER_MODEL);
    expect(r).toEqual({ mode: "structured", body: "" });
  });

  it("compiles a single named condition with a string literal", () => {
    const r = compileWhere(
      structured({
        tree: {
          children: [
            {
              kind: "condition",
              column: { kind: "named", name: "country" },
              op: "=",
              value: "CL",
            },
          ],
        },
      }),
    );
    expect(r.body).toBe(`"country" = 'CL'`);
  });

  it("escapes single quotes in string literals", () => {
    const r = compileWhere(
      structured({
        tree: {
          children: [
            {
              kind: "condition",
              column: { kind: "named", name: "name" },
              op: "=",
              value: "O'Brien",
            },
          ],
        },
      }),
    );
    expect(r.body).toBe(`"name" = 'O''Brien'`);
  });

  it("ANDs multiple root conditions and parenthesizes OR groups", () => {
    const r = compileWhere(
      structured({
        tree: {
          children: [
            {
              kind: "condition",
              column: { kind: "named", name: "country" },
              op: "=",
              value: "CL",
            },
            {
              kind: "or_group",
              children: [
                {
                  kind: "condition",
                  column: { kind: "named", name: "status" },
                  op: "=",
                  value: "active",
                },
                {
                  kind: "condition",
                  column: { kind: "named", name: "status" },
                  op: "=",
                  value: "pending",
                },
              ],
            },
          ],
        },
      }),
    );
    expect(r.body).toBe(
      `"country" = 'CL' AND ("status" = 'active' OR "status" = 'pending')`,
    );
  });

  it("compiles BETWEEN with inlined min/max", () => {
    const r = compileWhere(
      structured({
        tree: {
          children: [
            {
              kind: "condition",
              column: { kind: "named", name: "created_at" },
              op: "BETWEEN",
              value: { min: "2026-01-01", max: "2026-04-30" },
            },
          ],
        },
      }),
    );
    expect(r.body).toBe(
      `"created_at" BETWEEN '2026-01-01' AND '2026-04-30'`,
    );
  });

  it("compiles In list with multiple literals", () => {
    const r = compileWhere(
      structured({
        tree: {
          children: [
            {
              kind: "condition",
              column: { kind: "named", name: "status" },
              op: "In",
              value: ["a", "b", "c"],
            },
          ],
        },
      }),
    );
    expect(r.body).toBe(`"status" IN ('a', 'b', 'c')`);
  });

  it("compiles Contains with ILIKE concat", () => {
    const r = compileWhere(
      structured({
        tree: {
          children: [
            {
              kind: "condition",
              column: { kind: "named", name: "name" },
              op: "Contains",
              value: "ana",
            },
          ],
        },
      }),
    );
    expect(r.body).toBe(`"name" ILIKE '%' || 'ana' || '%'`);
  });

  it("compiles IS NULL without a value", () => {
    const r = compileWhere(
      structured({
        tree: {
          children: [
            {
              kind: "condition",
              column: { kind: "named", name: "deleted_at" },
              op: "IS NULL",
            },
          ],
        },
      }),
    );
    expect(r.body).toBe(`"deleted_at" IS NULL`);
  });

  it("expands Any-column across text-castable columns and skips bytea", () => {
    const columns = cols(
      ["name", "text"],
      ["payload", "bytea"],
      ["notes", "text"],
    );
    const r = compileWhere(
      structured({
        tree: {
          children: [
            {
              kind: "condition",
              column: { kind: "any_column" },
              op: "Contains",
              value: "argus",
            },
          ],
        },
      }),
      columns,
    );
    expect(r.body).toBe(
      `("name"::text ILIKE '%' || 'argus' || '%' OR "notes"::text ILIKE '%' || 'argus' || '%')`,
    );
  });

  it("returns (FALSE) when Any-column has no castable columns", () => {
    const r = compileWhere(
      structured({
        tree: {
          children: [
            {
              kind: "condition",
              column: { kind: "any_column" },
              op: "=",
              value: "x",
            },
          ],
        },
      }),
      cols(["a", "bytea"], ["b", "bytea"]),
    );
    expect(r.body).toBe(`(FALSE)`);
  });

  it("ORs flat root conditions when combinator is OR", () => {
    const r = compileWhere(
      structured({
        tree: {
          children: [
            {
              kind: "condition",
              column: { kind: "named", name: "country" },
              op: "=",
              value: "CL",
            },
            {
              kind: "condition",
              column: { kind: "named", name: "country" },
              op: "=",
              value: "AR",
            },
            {
              kind: "condition",
              column: { kind: "named", name: "country" },
              op: "=",
              value: "BR",
            },
          ],
          combinator: "OR",
        },
      }),
    );
    expect(r.body).toBe(`"country" = 'CL' OR "country" = 'AR' OR "country" = 'BR'`);
  });

  it("OR-root with OR-group child: root uses OR, group still parenthesized", () => {
    const r = compileWhere(
      structured({
        tree: {
          children: [
            {
              kind: "condition",
              column: { kind: "named", name: "a" },
              op: "=",
              value: "x",
            },
            {
              kind: "or_group",
              children: [
                {
                  kind: "condition",
                  column: { kind: "named", name: "b" },
                  op: "=",
                  value: "y",
                },
                {
                  kind: "condition",
                  column: { kind: "named", name: "c" },
                  op: "=",
                  value: "z",
                },
              ],
            },
          ],
          combinator: "OR",
        },
      }),
    );
    expect(r.body).toBe(`"a" = 'x' OR ("b" = 'y' OR "c" = 'z')`);
  });

  it("empty tree emits no WHERE regardless of combinator", () => {
    const r = compileWhere(
      structured({
        tree: { children: [], combinator: "OR" },
      }),
    );
    expect(r.body).toBe("");
  });

  it("AND-root regression: multiple conditions join with AND", () => {
    const r = compileWhere(
      structured({
        tree: {
          children: [
            {
              kind: "condition",
              column: { kind: "named", name: "status" },
              op: "=",
              value: "active",
            },
            {
              kind: "condition",
              column: { kind: "named", name: "deleted_at" },
              op: "IS NULL",
            },
          ],
          combinator: "AND",
        },
      }),
    );
    expect(r.body).toBe(`"status" = 'active' AND "deleted_at" IS NULL`);
  });

  it("passes through raw mode verbatim and trims a leading WHERE", () => {
    const r = compileWhere({
      mode: "raw",
      tree: { children: [] },
      raw: "WHERE created_at > now()",
    });
    expect(r).toEqual({ mode: "raw", body: "created_at > now()" });
  });

  it("returns empty body for raw mode when input is just whitespace", () => {
    const r = compileWhere({ mode: "raw", tree: { children: [] }, raw: "   " });
    expect(r.body).toBe("");
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

  it("includes WHERE for structured filters", () => {
    const model: FilterModel = {
      mode: "structured",
      tree: {
        children: [
          {
            kind: "condition",
            column: { kind: "named", name: "country" },
            op: "=",
            value: "CL",
          },
        ],
      },
      raw: "",
    };
    const sql = compilePrefilledSelect({ ...baseArgs, model });
    expect(sql).toBe(
      `SELECT * FROM "public"."users"\nWHERE "country" = 'CL'\nLIMIT 200`,
    );
  });

  it("includes WHERE and ORDER BY", () => {
    const model: FilterModel = {
      mode: "structured",
      tree: {
        children: [
          {
            kind: "condition",
            column: { kind: "named", name: "country" },
            op: "=",
            value: "CL",
          },
        ],
      },
      raw: "",
    };
    const sql = compilePrefilledSelect({
      ...baseArgs,
      model,
      orderBy: [{ column: "created_at", direction: "desc" }],
    });
    expect(sql).toBe(
      `SELECT * FROM "public"."users"\nWHERE "country" = 'CL'\nORDER BY "created_at" DESC\nLIMIT 200`,
    );
  });

  it("emits raw_where verbatim", () => {
    const model: FilterModel = {
      mode: "raw",
      tree: { children: [] },
      raw: "created_at > now() - interval '7 days'",
    };
    const sql = compilePrefilledSelect({ ...baseArgs, model });
    expect(sql).toBe(
      `SELECT * FROM "public"."users"\nWHERE created_at > now() - interval '7 days'\nLIMIT 200`,
    );
  });
});
