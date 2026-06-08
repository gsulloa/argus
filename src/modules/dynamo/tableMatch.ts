/**
 * Table-name normalization rule (mirrors the Rust `TableMatch` /
 * `context::normalize::normalize`). Folds a live physical DynamoDB table name
 * into a stable logical name so CDK-style names match shared context docs.
 *
 * Two mutually-exclusive authoring forms:
 *  - simple: optional `prefix` + optional regex `suffix_pattern`
 *  - advanced: a single `regex` with a named capture group `logical`
 *
 * Any absent/empty rule, a non-matching rule, or a non-compiling regex degrades
 * to the identity transform (the name is returned unchanged).
 */
export interface TableMatch {
  prefix?: string;
  suffix_pattern?: string;
  regex?: string;
}

/** True when no field carries a non-empty value (≡ identity transform). */
export function isTableMatchEmpty(tm: TableMatch | null | undefined): boolean {
  if (!tm) return true;
  return !tm.prefix && !tm.suffix_pattern && !tm.regex;
}

/** Fold `name` to its logical form using `tm`. See module docs. */
export function normalizeTableName(
  name: string,
  tm: TableMatch | null | undefined,
): string {
  if (isTableMatchEmpty(tm)) return name;
  const rule = tm as TableMatch;

  // Advanced form: capture regex with a `logical` group.
  if (rule.regex) {
    try {
      const re = new RegExp(rule.regex);
      const m = re.exec(name);
      const logical = m?.groups?.logical;
      return typeof logical === "string" ? logical : name;
    } catch {
      return name;
    }
  }

  // Simple form: prefix strip, then end-anchored suffix-pattern strip.
  let residue = name;
  if (rule.prefix && residue.startsWith(rule.prefix)) {
    residue = residue.slice(rule.prefix.length);
  }
  if (rule.suffix_pattern) {
    try {
      const re = new RegExp(rule.suffix_pattern);
      const m = re.exec(residue);
      if (m && m.index + m[0].length === residue.length) {
        residue = residue.slice(0, m.index);
      }
    } catch {
      // ignore — degrade to identity for the suffix step
    }
  }
  return residue;
}

/**
 * Client-side validation mirroring the backend. Returns an error message for
 * inline display, or `null` when valid. An empty rule is valid.
 */
export function validateTableMatch(tm: TableMatch | null | undefined): string | null {
  if (isTableMatchEmpty(tm)) return null;
  const rule = tm as TableMatch;

  const hasAdvanced = Boolean(rule.regex);
  const hasSimple = Boolean(rule.prefix) || Boolean(rule.suffix_pattern);
  if (hasAdvanced && hasSimple) {
    return "Use either prefix/suffix or a regex, not both.";
  }

  if (rule.regex) {
    let re: RegExp;
    try {
      re = new RegExp(rule.regex);
    } catch (e) {
      return `Regex does not compile: ${(e as Error).message}`;
    }
    // The pattern must contain a named capture group `logical`.
    if (!/\(\?<logical>/.test(re.source)) {
      return "Regex must contain a named capture group `logical`.";
    }
  }

  if (rule.suffix_pattern) {
    try {
      void new RegExp(rule.suffix_pattern);
    } catch (e) {
      return `Suffix pattern does not compile: ${(e as Error).message}`;
    }
  }

  return null;
}
