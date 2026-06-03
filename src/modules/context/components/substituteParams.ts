export interface ParamValue {
  name: string;
  value: string;
}

/**
 * Replace `:name` placeholders in a Postgres SQL body with client-side
 * escaped literals. Numeric values are inserted as-is when parseable;
 * strings are wrapped in single quotes with embedded single-quotes doubled
 * (the standard Postgres rule). Boolean literals "true"/"false" pass through.
 *
 * This is a stop-gap until a server-side named-bindings command exists.
 * It is safe for ad-hoc context queries authored by trusted folder owners
 * but should never be used on untrusted input.
 */
export function substitutePostgresParams(body: string, values: ParamValue[]): string {
  let result = body;
  for (const { name, value } of values) {
    // Match `:name` that is NOT preceded by `:` or a word char (avoids `::` cast)
    // and NOT followed by a word char (avoids matching `:nameless` when `name` is param).
    const pattern = new RegExp(`(?<![:\\w]):${escapeRegex(name)}(?!\\w)`, "g");
    const escaped = escapeLiteral(value);
    result = result.replace(pattern, escaped);
  }
  return result;
}

/** Escape a regex string so it can be placed inside a RegExp constructor. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Escape a user-supplied value into a SQL literal:
 * - If it parses as a finite number (and is not blank), emit raw digits.
 * - If it equals "true" or "false" (case-insensitive), emit the lowercase keyword.
 * - If it equals "null" (case-insensitive), emit `nullKeyword` (caller decides case).
 * - Otherwise wrap in single quotes, doubling any embedded single-quotes.
 */
function escapeLiteralWith(value: string, nullKeyword: string): string {
  const trimmed = value.trim();

  // Numeric: parseable as finite number and not just whitespace
  if (trimmed.length > 0 && Number.isFinite(Number(trimmed))) {
    return trimmed;
  }

  // Boolean / null keywords
  const lower = trimmed.toLowerCase();
  if (lower === "true" || lower === "false") {
    return lower;
  }
  if (lower === "null") {
    return nullKeyword;
  }

  // String: wrap in single quotes, escape internal single quotes by doubling
  return "'" + value.replace(/'/g, "''") + "'";
}

function escapeLiteral(value: string): string {
  return escapeLiteralWith(value, "null");
}

/**
 * Replace `@name` placeholders in a T-SQL body with client-side escaped
 * literals. Uses the same escaping rules as Postgres. The pattern uses a
 * negative lookbehind `(?<!@)` so that T-SQL global variables (`@@version`,
 * `@@rowcount`, etc.) are never touched.
 *
 * Safe for trusted context-query authors only — not for untrusted input.
 */
export function substituteMssqlParams(body: string, values: ParamValue[]): string {
  let result = body;
  for (const { name, value } of values) {
    // Negative lookbehind on `@` prevents matching `@@variable`.
    // Negative lookahead on `\w` prevents matching `@foo` inside `@foobar`.
    const pattern = new RegExp(`(?<!@)@${escapeRegex(name)}(?!\\w)`, "g");
    const escaped = escapeLiteral(value);
    result = result.replace(pattern, escaped);
  }
  return result;
}

/**
 * Replace `$name` placeholders in a PartiQL body with client-side escaped
 * literals. `null` emits `NULL` (uppercase, per PartiQL convention).
 * Booleans and numbers pass through unquoted; strings are single-quoted.
 *
 * The pattern uses a negative lookbehind on `[\w$]` so `$$name` (or any
 * `$`-prefixed sigil) is not matched.
 *
 * Safe for trusted context-query authors only — not for untrusted input.
 */
export function substituteDynamoParams(body: string, values: ParamValue[]): string {
  let result = body;
  for (const { name, value } of values) {
    // `$` is a regex special char — escape it via escapeRegex on the full name.
    // Negative lookbehind on `[\w$]` avoids matching `$$name`.
    // Negative lookahead on `\w` prevents partial matches.
    const pattern = new RegExp(`(?<![\\w$])\\$${escapeRegex(name)}(?!\\w)`, "g");
    const escaped = escapeLiteralWith(value, "NULL");
    result = result.replace(pattern, escaped);
  }
  return result;
}
