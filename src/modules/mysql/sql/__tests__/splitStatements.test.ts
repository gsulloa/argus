/**
 * §26.5 — Frontend tests for MySQL SQL statement splitter and validator.
 * Mirrors the backend split_statements logic in Rust.
 */

import { describe, expect, it } from "vitest";
import {
  splitStatements,
  validateBatch,
  getStatementUnderCursor,
} from "../splitStatements";

describe("splitStatements", () => {
  it("splits two simple semicolon-separated statements", () => {
    const stmts = splitStatements("SELECT 1; SELECT 2;");
    expect(stmts).toHaveLength(2);
    expect(stmts[0]!.sql).toBe("SELECT 1");
    expect(stmts[1]!.sql).toBe("SELECT 2");
  });

  it("returns single statement without trailing semicolon", () => {
    const stmts = splitStatements("SELECT 1");
    expect(stmts).toHaveLength(1);
    expect(stmts[0]!.sql).toBe("SELECT 1");
  });

  it("returns empty array for empty input", () => {
    expect(splitStatements("")).toHaveLength(0);
  });

  it("returns empty array for whitespace-only input", () => {
    expect(splitStatements("   \n\t  ")).toHaveLength(0);
  });

  it("does not split inside single-quoted string", () => {
    const stmts = splitStatements("SELECT ';'; SELECT 2;");
    expect(stmts).toHaveLength(2);
    expect(stmts[0]!.sql).toBe("SELECT ';'");
    expect(stmts[1]!.sql).toBe("SELECT 2");
  });

  it("does not split inside backtick-quoted identifier", () => {
    const stmts = splitStatements("SELECT `a;b`; SELECT 2;");
    expect(stmts).toHaveLength(2);
    expect(stmts[0]!.sql).toBe("SELECT `a;b`");
    expect(stmts[1]!.sql).toBe("SELECT 2");
  });

  it("does not split inside double-quoted string", () => {
    const stmts = splitStatements('SELECT "a;b"; SELECT 2;');
    expect(stmts).toHaveLength(2);
    expect(stmts[0]!.sql).toBe('SELECT "a;b"');
  });

  it("recognises # line comment and skips semicolons inside", () => {
    const stmts = splitStatements("SELECT 1; # comment with ; semicolon\nSELECT 2;");
    expect(stmts).toHaveLength(2);
  });

  it("recognises -- line comment and skips semicolons inside", () => {
    const stmts = splitStatements("SELECT 1; -- comment\nSELECT 2;");
    expect(stmts).toHaveLength(2);
    expect(stmts[0]!.sql).toBe("SELECT 1");
  });

  it("recognises /* */ block comment and skips semicolons inside", () => {
    const stmts = splitStatements("SELECT /* a ; b */ 1; SELECT 2;");
    expect(stmts).toHaveLength(2);
  });

  it("handles nested block comment markers (depth tracking)", () => {
    // /* /* inner */ outer */ — all treated as one block comment.
    const stmts = splitStatements("SELECT /* /* deep */ still-comment */ 1; SELECT 2;");
    expect(stmts).toHaveLength(2);
  });

  it("provides correct startOffset for each statement", () => {
    const input = "SELECT 1; SELECT 2;";
    const stmts = splitStatements(input);
    expect(stmts).toHaveLength(2);
    expect(input.slice(stmts[0]!.startOffset, stmts[0]!.endOffset)).toBe("SELECT 1");
    expect(input.slice(stmts[1]!.startOffset, stmts[1]!.endOffset)).toBe("SELECT 2");
  });

  it("handles escaped single-quote (doubled) inside string", () => {
    const stmts = splitStatements("SELECT 'it''s'; SELECT 2;");
    expect(stmts).toHaveLength(2);
    expect(stmts[0]!.sql).toContain("it''s");
  });

  it("handles escaped backtick (doubled) inside identifier", () => {
    const stmts = splitStatements("SELECT `a``b`; SELECT 2;");
    expect(stmts).toHaveLength(2);
  });

  it("handles trailing semicolon without extra empty statement", () => {
    const stmts = splitStatements("SELECT 1;");
    expect(stmts).toHaveLength(1);
  });
});

describe("validateBatch", () => {
  it("returns null for valid single statement", () => {
    const stmts = splitStatements("SELECT 1");
    expect(validateBatch(stmts)).toBeNull();
  });

  it("returns null for multiple non-routine statements", () => {
    const stmts = splitStatements("SELECT 1; SELECT 2; INSERT INTO t VALUES (1);");
    expect(validateBatch(stmts)).toBeNull();
  });

  it("returns error message for CREATE PROCEDURE in multi-statement batch", () => {
    const stmts = splitStatements(
      "CREATE PROCEDURE foo() BEGIN SELECT 1; END; SELECT 1;"
    );
    const err = validateBatch(stmts);
    expect(err).not.toBeNull();
    expect(err).toMatch(/PROCEDURE|DELIMITER|not supported/i);
  });

  it("returns error message for CREATE FUNCTION in multi-statement batch", () => {
    const stmts = splitStatements(
      "CREATE FUNCTION f() RETURNS INT BEGIN RETURN 1; END; SELECT 1;"
    );
    const err = validateBatch(stmts);
    expect(err).not.toBeNull();
    expect(err).toMatch(/FUNCTION|DELIMITER|not supported/i);
  });

  it("returns error message for CREATE TRIGGER in multi-statement batch", () => {
    const stmts = splitStatements(
      "CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET NEW.c = 1; SELECT 1;"
    );
    const err = validateBatch(stmts);
    expect(err).not.toBeNull();
  });

  it("returns error message for CREATE EVENT in multi-statement batch", () => {
    const stmts = splitStatements(
      "CREATE EVENT e ON SCHEDULE EVERY 1 HOUR DO SELECT 1; SELECT 1;"
    );
    const err = validateBatch(stmts);
    expect(err).not.toBeNull();
  });

  it("returns null for empty batch", () => {
    expect(validateBatch([])).toBeNull();
  });
});

describe("getStatementUnderCursor", () => {
  const sql = "SELECT 1; SELECT 2; SELECT 3;";

  it("returns first statement for cursor at start", () => {
    const stmt = getStatementUnderCursor(sql, 0);
    expect(stmt?.sql).toBe("SELECT 1");
  });

  it("returns second statement for cursor inside it", () => {
    // Cursor at position 12 — inside "SELECT 2".
    const stmt = getStatementUnderCursor(sql, 12);
    expect(stmt?.sql).toBe("SELECT 2");
  });

  it("returns last statement for cursor at end", () => {
    const stmt = getStatementUnderCursor(sql, sql.length);
    expect(stmt?.sql).toBe("SELECT 3");
  });

  it("returns null for empty document", () => {
    const stmt = getStatementUnderCursor("", 0);
    expect(stmt).toBeNull();
  });

  it("returns first statement for cursor before any statement", () => {
    const stmt = getStatementUnderCursor("   SELECT 1;", 0);
    expect(stmt?.sql).toBe("SELECT 1");
  });
});
