import { describe, it, expect } from "vitest";
import { categorize } from "./typeHelpers";

// ---------------------------------------------------------------------------
// Spec: Postgres data type → category mapping
// ---------------------------------------------------------------------------

describe("categorize — numeric types", () => {
  it.each([
    "integer",
    "int",
    "int2",
    "int4",
    "int8",
    "smallint",
    "bigint",
    "real",
    "double precision",
    "float4",
    "float8",
    "numeric",
    "numeric(10,2)",
    "decimal",
    "decimal(18,4)",
    "smallserial",
    "serial",
    "bigserial",
  ])('categorize("%s") === "numeric"', (type) => {
    expect(categorize(type)).toBe("numeric");
  });
});

describe("categorize — boolean types", () => {
  it.each(["boolean", "bool"])('categorize("%s") === "boolean"', (type) => {
    expect(categorize(type)).toBe("boolean");
  });
});

describe("categorize — date/time types", () => {
  it.each([
    "date",
    "time",
    "timestamp",
    "timestamptz",
    "timetz",
    "interval",
    "timestamp with time zone",
    "timestamp without time zone",
    "time with time zone",
    "time without time zone",
  ])('categorize("%s") === "date"', (type) => {
    expect(categorize(type)).toBe("date");
  });
});

describe("categorize — text types", () => {
  it.each([
    "text",
    "varchar",
    "varchar(255)",
    "character varying",
    "character varying(100)",
    "char",
    "char(10)",
    "character",
    "character(20)",
    "name",
    "citext",
  ])('categorize("%s") === "text"', (type) => {
    expect(categorize(type)).toBe("text");
  });
});

describe("categorize — json types", () => {
  it.each(["json", "jsonb"])('categorize("%s") === "json"', (type) => {
    expect(categorize(type)).toBe("json");
  });
});

describe("categorize — binary types", () => {
  it('categorize("bytea") === "binary"', () => {
    expect(categorize("bytea")).toBe("binary");
  });
});

describe("categorize — uuid type", () => {
  it('categorize("uuid") === "uuid"', () => {
    expect(categorize("uuid")).toBe("uuid");
  });
});

describe("categorize — other / unknown types", () => {
  it.each(["tsvector", "tsquery", "hstore", "point", "inet", "cidr", "xml"])(
    'categorize("%s") === "other"',
    (type) => {
      expect(categorize(type)).toBe("other");
    },
  );
});

// ---------------------------------------------------------------------------
// Exact spec scenarios from column-width-preferences/spec.md
// ---------------------------------------------------------------------------

describe("categorize — spec scenario assertions", () => {
  it('categorize("integer") returns "numeric"', () => {
    expect(categorize("integer")).toBe("numeric");
  });

  it('categorize("timestamp with time zone") returns "date"', () => {
    expect(categorize("timestamp with time zone")).toBe("date");
  });

  it('categorize("jsonb") returns "json"', () => {
    expect(categorize("jsonb")).toBe("json");
  });

  it('categorize("tsvector") returns "other"', () => {
    expect(categorize("tsvector")).toBe("other");
  });

  it('categorize("int4") returns "numeric"', () => {
    expect(categorize("int4")).toBe("numeric");
  });

  it('categorize("float8") returns "numeric"', () => {
    expect(categorize("float8")).toBe("numeric");
  });

  it('categorize("timestamptz") returns "date"', () => {
    expect(categorize("timestamptz")).toBe("date");
  });

  it('categorize("citext") returns "text"', () => {
    expect(categorize("citext")).toBe("text");
  });

  it('categorize("varchar") returns "text"', () => {
    expect(categorize("varchar")).toBe("text");
  });

  it('categorize("char") returns "text"', () => {
    expect(categorize("char")).toBe("text");
  });

  it('categorize("bytea") returns "binary"', () => {
    expect(categorize("bytea")).toBe("binary");
  });

  it('categorize("uuid") returns "uuid"', () => {
    expect(categorize("uuid")).toBe("uuid");
  });

  it('categorize("boolean") returns "boolean"', () => {
    expect(categorize("boolean")).toBe("boolean");
  });
});
