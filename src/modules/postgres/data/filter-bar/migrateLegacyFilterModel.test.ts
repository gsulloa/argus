import { describe, it, expect, vi } from "vitest";
import { migrateLegacyFilterModel } from "./migrateLegacyFilterModel";
import { EMPTY_FILTER_MODEL } from "../types";

describe("migrateLegacyFilterModel", () => {
  it("returns EMPTY_FILTER_MODEL for null", () => {
    expect(migrateLegacyFilterModel(null)).toEqual(EMPTY_FILTER_MODEL);
  });

  it("returns EMPTY_FILTER_MODEL for undefined", () => {
    expect(migrateLegacyFilterModel(undefined)).toEqual(EMPTY_FILTER_MODEL);
  });

  it("returns EMPTY_FILTER_MODEL for a non-object primitive", () => {
    expect(migrateLegacyFilterModel(42)).toEqual(EMPTY_FILTER_MODEL);
    expect(migrateLegacyFilterModel("string")).toEqual(EMPTY_FILTER_MODEL);
  });

  it("returns EMPTY_FILTER_MODEL for an array", () => {
    expect(migrateLegacyFilterModel([])).toEqual(EMPTY_FILTER_MODEL);
  });

  // ---------------------------------------------------------------------------
  // Legacy shape: { mode, tree, raw }
  // ---------------------------------------------------------------------------

  it("drops legacy { mode: 'structured', tree, raw } shape and logs", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const result = migrateLegacyFilterModel({
      mode: "structured",
      tree: { children: [], combinator: "AND" },
      raw: "",
    });
    expect(result).toEqual(EMPTY_FILTER_MODEL);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[filter-bar] dropped legacy"),
    );
    spy.mockRestore();
  });

  it("drops legacy { mode: 'raw', raw: '...' } shape and logs", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const result = migrateLegacyFilterModel({
      mode: "raw",
      tree: { children: [] },
      raw: "created_at > now()",
    });
    expect(result).toEqual(EMPTY_FILTER_MODEL);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("drops legacy { tree: ... } wrapper shape and logs", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const result = migrateLegacyFilterModel({
      tree: {
        children: [
          { kind: "condition", column: { kind: "named", name: "a" }, op: "=" , value: "1" },
        ],
        combinator: "AND",
      },
    });
    expect(result).toEqual(EMPTY_FILTER_MODEL);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Legacy shape: or_group child
  // ---------------------------------------------------------------------------

  it("drops a tree whose rows contain or_group kind and logs", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const result = migrateLegacyFilterModel({
      rows: [
        { kind: "or_group", column: { kind: "or_group" }, op: "=", value: "x" },
      ],
      combinator: "AND",
    });
    expect(result).toEqual(EMPTY_FILTER_MODEL);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Valid new-shape passthrough
  // ---------------------------------------------------------------------------

  it("passes through a valid new-shape model with combinator AND", () => {
    const input = {
      rows: [
        { enabled: true, column: { kind: "named", name: "status" }, op: "=", value: "ok" },
      ],
      combinator: "AND",
    };
    const result = migrateLegacyFilterModel(input);
    expect(result).toEqual({
      rows: [
        { enabled: true, column: { kind: "named", name: "status" }, op: "=", value: "ok" },
      ],
      combinator: "AND",
    });
  });

  it("passes through a valid new-shape model with combinator OR", () => {
    const input = {
      rows: [
        { enabled: false, column: { kind: "any_column" }, op: "Contains", value: "foo" },
      ],
      combinator: "OR",
    };
    const result = migrateLegacyFilterModel(input);
    expect(result.combinator).toBe("OR");
    expect(result.rows[0]?.enabled).toBe(false);
  });

  it("backfills missing combinator to AND", () => {
    const input = {
      rows: [
        { enabled: true, column: { kind: "named", name: "a" }, op: "=", value: "1" },
      ],
    };
    const result = migrateLegacyFilterModel(input);
    expect(result.combinator).toBe("AND");
  });

  it("defaults enabled to true when field is missing on a row", () => {
    const input = {
      rows: [
        { column: { kind: "named", name: "a" }, op: "=", value: "1" },
      ],
      combinator: "AND",
    };
    const result = migrateLegacyFilterModel(input);
    expect(result.rows[0]?.enabled).toBe(true);
  });

  it("returns EMPTY_FILTER_MODEL for totally invalid shape (missing rows)", () => {
    expect(migrateLegacyFilterModel({ combinator: "AND" })).toEqual(EMPTY_FILTER_MODEL);
  });

  it("returns EMPTY_FILTER_MODEL for a row missing column", () => {
    const input = {
      rows: [{ enabled: true, op: "=" }],
      combinator: "AND",
    };
    expect(migrateLegacyFilterModel(input)).toEqual(EMPTY_FILTER_MODEL);
  });

  it("returns EMPTY_FILTER_MODEL for a row missing op", () => {
    const input = {
      rows: [{ enabled: true, column: { kind: "named", name: "a" } }],
      combinator: "AND",
    };
    expect(migrateLegacyFilterModel(input)).toEqual(EMPTY_FILTER_MODEL);
  });
});
