import { describe, expect, it } from "vitest";
import { deriveDefaultOrderBy } from "./orderBy";

describe("deriveDefaultOrderBy", () => {
  it("maps a single PK column to one descending order entry", () => {
    expect(deriveDefaultOrderBy(["id"], "table")).toEqual([
      { column: "id", direction: "desc" },
    ]);
  });

  it("maps a composite PK to all columns descending, in definition order", () => {
    expect(deriveDefaultOrderBy(["tenant_id", "created_at"], "table")).toEqual([
      { column: "tenant_id", direction: "desc" },
      { column: "created_at", direction: "desc" },
    ]);
  });

  it("returns [] when there is no PK (null)", () => {
    expect(deriveDefaultOrderBy(null, "table")).toEqual([]);
  });

  it("returns [] for an empty PK column list", () => {
    expect(deriveDefaultOrderBy([], "table")).toEqual([]);
  });

  it("returns [] for a view even if PK columns are reported", () => {
    expect(deriveDefaultOrderBy(["id"], "view")).toEqual([]);
  });

  it("returns [] for a materialized view", () => {
    expect(deriveDefaultOrderBy(["id"], "materialized-view")).toEqual([]);
  });

  it("returns [] for an indexed view", () => {
    expect(deriveDefaultOrderBy(["id"], "indexed_view")).toEqual([]);
  });

  it("does not require relationKind (defaults to PK-derived order)", () => {
    expect(deriveDefaultOrderBy(["id"])).toEqual([{ column: "id", direction: "desc" }]);
  });
});
