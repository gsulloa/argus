import { describe, expect, it } from "vitest";
import {
  substituteDynamoParams,
  substituteMssqlParams,
  substitutePostgresParams,
} from "../substituteParams";

describe("substitutePostgresParams", () => {
  it("replaces_named_placeholder_with_string", () => {
    const result = substitutePostgresParams(
      "SELECT * FROM users WHERE name = :name",
      [{ name: "name", value: "Alice" }],
    );
    expect(result).toBe("SELECT * FROM users WHERE name = 'Alice'");
  });

  it("numeric_values_pass_through_unquoted", () => {
    const result = substitutePostgresParams(
      "SELECT * FROM orders LIMIT :limit",
      [{ name: "limit", value: "50" }],
    );
    expect(result).toBe("SELECT * FROM orders LIMIT 50");
  });

  it("boolean_and_null_pass_through_unquoted", () => {
    const body = "SELECT :active, :deleted, :flag";
    const result = substitutePostgresParams(body, [
      { name: "active", value: "true" },
      { name: "deleted", value: "FALSE" },
      { name: "flag", value: "NULL" },
    ]);
    expect(result).toBe("SELECT true, false, null");
  });

  it("single_quotes_in_string_are_doubled", () => {
    const result = substitutePostgresParams(
      "SELECT * FROM t WHERE note = :note",
      [{ name: "note", value: "it's fine" }],
    );
    expect(result).toBe("SELECT * FROM t WHERE note = 'it''s fine'");
  });

  it("does_not_replace_cast_operator", () => {
    // `::text` should NOT be replaced when `text` is not a param name;
    // more importantly the `::` before a param name placeholder is preserved.
    const result = substitutePostgresParams(
      "SELECT x::text WHERE y = :y",
      [{ name: "y", value: "5" }],
    );
    expect(result).toBe("SELECT x::text WHERE y = 5");
  });

  it("placeholder_inside_identifier_not_replaced", () => {
    // `:nameless` should NOT be replaced when the declared param is `name`
    const result = substitutePostgresParams(
      "SELECT :nameless FROM t WHERE id = :name",
      [{ name: "name", value: "Alice" }],
    );
    // `:nameless` is not affected; `:name` is replaced
    expect(result).toBe("SELECT :nameless FROM t WHERE id = 'Alice'");
  });
});

describe("substituteMssqlParams", () => {
  it("replaces_at_name_with_string_literal", () => {
    const result = substituteMssqlParams(
      "SELECT * FROM users WHERE name = @user",
      [{ name: "user", value: "alice" }],
    );
    expect(result).toBe("SELECT * FROM users WHERE name = 'alice'");
  });

  it("numeric_values_pass_through_unquoted", () => {
    const result = substituteMssqlParams(
      "SELECT TOP @id * FROM orders",
      [{ name: "id", value: "42" }],
    );
    expect(result).toBe("SELECT TOP 42 * FROM orders");
  });

  it("double_at_variable_is_not_replaced", () => {
    // @@variable is a T-SQL global variable and must never be touched
    const result = substituteMssqlParams(
      "SELECT @@version, @user",
      [{ name: "variable", value: "foo" }, { name: "user", value: "bob" }],
    );
    expect(result).toBe("SELECT @@version, 'bob'");
  });

  it("multiple_distinct_params_in_single_body", () => {
    const result = substituteMssqlParams(
      "WHERE schema = @schema AND table = @table",
      [
        { name: "schema", value: "dbo" },
        { name: "table", value: "orders" },
      ],
    );
    expect(result).toBe("WHERE schema = 'dbo' AND table = 'orders'");
  });

  it("identifier_boundary_prevents_partial_match", () => {
    // @foo should NOT be replaced when only foo_bar is declared, because
    // @foo in the body is followed by _bar making it @foo_bar (a \w char).
    const result = substituteMssqlParams(
      "SELECT @foo_bar, @foo",
      [{ name: "foo", value: "x" }],
    );
    // @foo_bar has \w after @foo so it is not matched; standalone @foo is replaced
    expect(result).toBe("SELECT @foo_bar, 'x'");
  });

  it("string_with_embedded_single_quote_is_escaped", () => {
    const result = substituteMssqlParams(
      "WHERE name = @name",
      [{ name: "name", value: "O'Brien" }],
    );
    expect(result).toBe("WHERE name = 'O''Brien'");
  });
});

describe("substituteDynamoParams", () => {
  it("replaces_dollar_name_with_string_literal", () => {
    const result = substituteDynamoParams(
      "SELECT * FROM users WHERE name = $username",
      [{ name: "username", value: "alice" }],
    );
    expect(result).toBe("SELECT * FROM users WHERE name = 'alice'");
  });

  it("numeric_values_pass_through_unquoted", () => {
    const result = substituteDynamoParams(
      "SELECT * FROM orders WHERE id = $id",
      [{ name: "id", value: "99" }],
    );
    expect(result).toBe("SELECT * FROM orders WHERE id = 99");
  });

  it("null_emits_uppercase_NULL", () => {
    const result = substituteDynamoParams(
      "WHERE deleted_at = $ts",
      [{ name: "ts", value: "null" }],
    );
    expect(result).toBe("WHERE deleted_at = NULL");
  });

  it("null_casing_is_normalised_to_uppercase", () => {
    const result = substituteDynamoParams(
      "WHERE x = $a AND y = $b",
      [{ name: "a", value: "NULL" }, { name: "b", value: "Null" }],
    );
    expect(result).toBe("WHERE x = NULL AND y = NULL");
  });

  it("boolean_values_pass_through_lowercase", () => {
    const result = substituteDynamoParams(
      "WHERE active = $active AND removed = $removed",
      [{ name: "active", value: "true" }, { name: "removed", value: "FALSE" }],
    );
    expect(result).toBe("WHERE active = true AND removed = false");
  });

  it("string_with_single_quote_is_escaped", () => {
    const result = substituteDynamoParams(
      "WHERE note = $note",
      [{ name: "note", value: "it's here" }],
    );
    expect(result).toBe("WHERE note = 'it''s here'");
  });

  it("double_dollar_prefix_is_not_replaced", () => {
    // $$name has a $ immediately before it — the negative lookbehind must block it
    const result = substituteDynamoParams(
      "SELECT $$name, $name",
      [{ name: "name", value: "val" }],
    );
    expect(result).toBe("SELECT $$name, 'val'");
  });
});
