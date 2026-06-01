/**
 * §20.6 — MS SQL Server SQL editor autocomplete sources.
 *
 * Three sources compose the autocomplete:
 * 1. T-SQL keyword completions (from @codemirror/lang-sql MSSQL dialect).
 * 2. Schema / table completions from the global MSSQL schema cache.
 * 3. Column completions from the bulk columns cache (§22).
 *
 * Identifier wrapping (§22, spec): names that are non-bareword or match a
 * T-SQL reserved keyword are wrapped in [square brackets] on insertion.
 * SQL Server uses square brackets (not backticks) as the safe quote form.
 */

import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { MSSQL, keywordCompletionSource, schemaCompletionSource } from "@codemirror/lang-sql";
import { mssqlSchemaCache } from "../schema/globalSchemaCache";
import { mssqlBulkColumnsCache } from "../columns/columnsCache";

// ---------------------------------------------------------------------------
// T-SQL reserved words that require bracket-quoting when used as identifiers.
// This is a representative set covering common conflicts.
// ---------------------------------------------------------------------------

const TSQL_RESERVED = new Set([
  "add", "all", "alter", "and", "any", "as", "asc",
  "authorization", "backup", "begin", "between", "break", "browse", "bulk",
  "by", "cascade", "case", "check", "checkpoint", "close", "clustered",
  "coalesce", "collate", "column", "commit", "compute", "constraint",
  "contains", "containstable", "continue", "convert", "create", "cross",
  "current", "current_date", "current_time", "current_timestamp", "current_user",
  "cursor", "database", "dbcc", "deallocate", "declare", "default", "delete",
  "deny", "desc", "disk", "distinct", "distributed", "double", "drop",
  "dump", "else", "end", "errlvl", "escape", "except", "exec", "execute",
  "exists", "exit", "external", "fetch", "file", "fillfactor", "for",
  "foreign", "freetext", "freetexttable", "from", "full", "function",
  "goto", "grant", "group", "having", "holdlock", "identity", "identitycol",
  "identity_insert", "if", "in", "index", "inner", "insert", "intersect",
  "into", "is", "join", "key", "kill", "left", "like", "lineno", "load",
  "merge", "national", "nocheck", "nonclustered", "not", "null", "nullif",
  "of", "off", "offsets", "on", "open", "opendatasource", "openquery",
  "openrowset", "openxml", "option", "or", "order", "outer", "over",
  "percent", "pivot", "plan", "precision", "primary", "print", "proc",
  "procedure", "public", "raiserror", "read", "readtext", "reconfigure",
  "references", "replication", "restore", "restrict", "return", "revert",
  "revoke", "right", "rollback", "rowcount", "rowguidcol", "rule", "save",
  "schema", "securityaudit", "select", "semantickeyphrasetable",
  "semanticsimilaritydetailstable", "semanticsimilaritytable", "session_user",
  "set", "setuser", "shutdown", "some", "statistics", "system_user", "table",
  "tablesample", "textsize", "then", "to", "top", "tran", "transaction",
  "trigger", "truncate", "try_convert", "tsequal", "union", "unique",
  "unpivot", "update", "updatetext", "use", "user", "values", "varying",
  "view", "waitfor", "when", "where", "while", "with", "within", "writetext",
  // Common identifiers that collide
  "order", "user", "database", "index", "table", "key", "plan", "group",
  "type", "value", "name", "status", "count",
]);

/** Bareword pattern: starts with letter/underscore, contains only word chars. */
const BAREWORD = /^[A-Za-z_]\w*$/;

function needsBrackets(name: string): boolean {
  if (!BAREWORD.test(name)) return true;
  if (TSQL_RESERVED.has(name.toLowerCase())) return true;
  return false;
}

function quoteIfNeeded(name: string): string {
  if (needsBrackets(name)) {
    // Escape embedded ] by doubling it
    return `[${name.replace(/\]/g, "]]")}]`;
  }
  return name;
}

// ---------------------------------------------------------------------------
// Keyword source
// ---------------------------------------------------------------------------

export const keywordSource: CompletionSource = keywordCompletionSource(MSSQL, false);

// ---------------------------------------------------------------------------
// Schema-aware source (schemas + tables from schemaCache)
// ---------------------------------------------------------------------------

function buildSqlNamespace(connectionId: string): Record<string, string[]> {
  const schemas = mssqlSchemaCache.getSchemas(connectionId);
  const namespace: Record<string, string[]> = {};
  for (const schema of schemas) {
    const rel = mssqlSchemaCache.getRelations(connectionId, schema.name);
    const tableNames = rel
      ? [...rel.tables.map((t) => t.name), ...rel.views.map((v) => v.name)]
      : [];
    namespace[schema.name] = tableNames;
  }
  return namespace;
}

export function buildSchemaSource(connectionId: string): CompletionSource {
  return schemaCompletionSource({
    dialect: MSSQL,
    schema: buildSqlNamespace(connectionId),
  });
}

// ---------------------------------------------------------------------------
// Column completion source from the bulk columns cache
// ---------------------------------------------------------------------------

/**
 * Regex to detect `schema.table.` or `[schema].[table].` patterns just
 * before the cursor so we can suggest columns.
 */
const QUALIFIED_COL_RE =
  /(?:\[([^\]]*)\]|(\w+))\.(?:\[([^\]]*)\]|(\w+))\.$/;

export function buildColumnSource(connectionId: string): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.state.doc.sliceString(
      Math.max(0, context.pos - 200),
      context.pos,
    );

    const m = QUALIFIED_COL_RE.exec(before);
    if (!m) return null;

    const schema = m[1] ?? m[2] ?? "";
    const relation = m[3] ?? m[4] ?? "";
    if (!schema || !relation) return null;

    const columns = mssqlBulkColumnsCache.getColumns(connectionId, schema, relation);
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
      validFor: /^[\w\[\]]*$/,
    };
  };
}

// ---------------------------------------------------------------------------
// Document identifier source (fallback for CTE names, aliases, etc.)
// ---------------------------------------------------------------------------

export const documentIdentifierSource: CompletionSource = (
  context: CompletionContext,
): CompletionResult | null => {
  const word = context.matchBefore(/[\w\[\]]*/);
  if (!word) return null;
  if (word.from === word.to && !context.explicit) return null;

  const seen = new Set<string>();
  const options: Completion[] = [];
  const doc = context.state.doc.toString();

  const IDENT_RE = /[A-Za-z_]\w*/g;
  let em: RegExpExecArray | null;
  while ((em = IDENT_RE.exec(doc)) !== null) {
    const id = em[0];
    if (id.length < 2) continue;
    if (seen.has(id)) continue;
    if (TSQL_RESERVED.has(id.toLowerCase())) continue;
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
