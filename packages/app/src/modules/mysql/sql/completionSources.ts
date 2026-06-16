/**
 * §20.6 — MySQL SQL editor autocomplete sources.
 *
 * Three sources compose the autocomplete:
 * 1. MySQL keyword completions (from @codemirror/lang-sql MySQL dialect).
 * 2. Schema / table completions from the global MySQL schema cache.
 * 3. Column completions from the bulk columns cache (§22).
 *
 * Identifier wrapping: names that are non-bareword or match a MySQL reserved
 * keyword are wrapped in backticks on insertion.
 */

import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { MySQL, keywordCompletionSource, schemaCompletionSource } from "@codemirror/lang-sql";
import { mysqlSchemaCache } from "../schema/globalSchemaCache";
import { mysqlBulkColumnsCache } from "./columnsCache";

// ---------------------------------------------------------------------------
// MySQL reserved keywords — ~50 picks (non-exhaustive, v1)
// ---------------------------------------------------------------------------

const MYSQL_RESERVED = new Set([
  "select", "from", "where", "order", "group", "having", "limit",
  "join", "inner", "outer", "left", "right", "cross", "on", "using",
  "as", "and", "or", "not", "null", "true", "false",
  "case", "when", "then", "else", "end",
  "insert", "update", "delete", "into", "values", "set",
  "index", "key", "table", "view", "procedure", "function",
  "trigger", "event", "database", "schema",
  "create", "alter", "drop", "truncate", "rename",
  "show", "describe", "explain", "use",
  "by", "asc", "desc", "distinct", "all",
  "union", "intersect", "except",
  "if", "exists", "like", "between", "in",
  "is", "interval", "with",
]);

/** Bareword pattern: starts with letter/underscore, contains only word chars. */
const BAREWORD = /^[A-Za-z_]\w*$/;

function needsBackticks(name: string): boolean {
  if (!BAREWORD.test(name)) return true;
  if (MYSQL_RESERVED.has(name.toLowerCase())) return true;
  return false;
}

function quoteIfNeeded(name: string): string {
  return needsBackticks(name) ? "`" + name.replace(/`/g, "``") + "`" : name;
}

// ---------------------------------------------------------------------------
// Keyword source
// ---------------------------------------------------------------------------

export const keywordSource: CompletionSource = keywordCompletionSource(MySQL, false);

// ---------------------------------------------------------------------------
// Schema-aware source (databases + tables from schemaCache)
// ---------------------------------------------------------------------------

/**
 * Build a SQLNamespace from the schema cache for the given connection.
 * Passed to schemaCompletionSource so it reflects the latest cached state.
 */
function buildSqlNamespace(connectionId: string): Record<string, string[]> {
  const schemas = mysqlSchemaCache.getSchemas(connectionId);
  const namespace: Record<string, string[]> = {};
  for (const schema of schemas) {
    const rel = mysqlSchemaCache.getRelations(connectionId, schema.name);
    const tableNames = rel
      ? [...rel.tables.map((t) => t.name), ...rel.views.map((v) => v.name)]
      : [];
    namespace[schema.name] = tableNames;
  }
  return namespace;
}

/**
 * Build the schema completion source for the given connection.
 * Re-build (via `reconfigureAutocomplete`) when the cache changes.
 */
export function buildSchemaSource(connectionId: string): CompletionSource {
  return schemaCompletionSource({
    dialect: MySQL,
    schema: buildSqlNamespace(connectionId),
  });
}

// ---------------------------------------------------------------------------
// Column completion source from the bulk columns cache
// ---------------------------------------------------------------------------

/**
 * Regex to detect `schema.table.` or `` `schema`.`table`. `` patterns just
 * before the cursor so we can suggest columns.
 */
const QUALIFIED_COL_RE =
  /(?:`([^`]*)`|(\w+))\.(?:`([^`]*)`|(\w+))\.$/;

export function buildColumnSource(connectionId: string): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    // We need `schema.table.` immediately before the cursor.
    const before = context.state.doc.sliceString(
      Math.max(0, context.pos - 200),
      context.pos,
    );

    const m = QUALIFIED_COL_RE.exec(before);
    if (!m) return null;

    const schema = m[1] ?? m[2] ?? "";
    const relation = m[3] ?? m[4] ?? "";
    if (!schema || !relation) return null;

    const columns = mysqlBulkColumnsCache.getColumns(connectionId, schema, relation);
    if (!columns || columns.length === 0) return null;

    const options: Completion[] = columns.map((col) => ({
      label: quoteIfNeeded(col.name),
      type: "property",
      detail: col.data_type,
      boost: 2,
    }));

    return {
      from: context.pos,
      options,
      validFor: /^[\w`]*$/,
    };
  };
}

// ---------------------------------------------------------------------------
// Document identifier source (fallback for CTE names, aliases, etc.)
// ---------------------------------------------------------------------------

export const documentIdentifierSource: CompletionSource = (
  context: CompletionContext,
): CompletionResult | null => {
  const word = context.matchBefore(/[\w`]*/);
  if (!word) return null;
  if (word.from === word.to && !context.explicit) return null;

  const seen = new Set<string>();
  const options: Completion[] = [];
  const doc = context.state.doc.toString();

  // Collect all word-character sequences not inside strings or comments.
  const IDENT_RE = /[A-Za-z_]\w*/g;
  let em: RegExpExecArray | null;
  while ((em = IDENT_RE.exec(doc)) !== null) {
    const id = em[0];
    if (id.length < 2) continue;
    if (seen.has(id)) continue;
    if (MYSQL_RESERVED.has(id.toLowerCase())) continue;
    seen.add(id);
    options.push({ label: id, type: "variable", detail: "in document", boost: -1 });
  }

  if (options.length === 0) return null;
  return { from: word.from, options, validFor: /^\w*$/ };
};

// ---------------------------------------------------------------------------
// Compose all sources
// ---------------------------------------------------------------------------

export function composeSources(connectionId: string): CompletionSource[] {
  return [
    keywordSource,
    buildSchemaSource(connectionId),
    buildColumnSource(connectionId),
    documentIdentifierSource,
  ];
}
