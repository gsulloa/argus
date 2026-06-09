/**
 * Athena SQL editor autocomplete sources.
 *
 * Three sources:
 * 1. Presto/Athena keyword completions (MySQL dialect is close enough for core SQL).
 * 2. Schema / table completions from the global Athena schema cache.
 * 3. Column completions from the columns cache.
 *
 * Identifier wrapping: Athena uses double-quoted identifiers.
 */

import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { StandardSQL, keywordCompletionSource, schemaCompletionSource } from "@codemirror/lang-sql";
import { athenaSchemaCache } from "../schema/globalSchemaCache";
import { athenaColumnsCache } from "./columnsCache";

// ---------------------------------------------------------------------------
// Keyword source (Presto/Athena uses standard ANSI SQL keywords)
// ---------------------------------------------------------------------------

export const keywordSource: CompletionSource = keywordCompletionSource(StandardSQL, false);

// ---------------------------------------------------------------------------
// Schema-aware source (databases + tables from schemaCache)
// ---------------------------------------------------------------------------

function buildSqlNamespace(connectionId: string): Record<string, string[]> {
  const databases = athenaSchemaCache.getDatabases(connectionId);
  const namespace: Record<string, string[]> = {};
  for (const db of databases) {
    const rels = athenaSchemaCache.getRelations(connectionId, db.name);
    namespace[db.name] = rels ? rels.map((r) => r.name) : [];
  }
  return namespace;
}

export function buildSchemaSource(connectionId: string): CompletionSource {
  return schemaCompletionSource({
    dialect: StandardSQL,
    schema: buildSqlNamespace(connectionId),
  });
}

// ---------------------------------------------------------------------------
// Column completion source from the columns cache
// ---------------------------------------------------------------------------

/** Regex to detect `"database"."relation".` or `database.relation.` patterns. */
const QUALIFIED_COL_RE =
  /(?:"([^"]*)"|(\w+))\.(?:"([^"]*)"|(\w+))\.$/;

export function buildColumnSource(connectionId: string): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.state.doc.sliceString(
      Math.max(0, context.pos - 200),
      context.pos,
    );

    const m = QUALIFIED_COL_RE.exec(before);
    if (!m) return null;

    const database = m[1] ?? m[2] ?? "";
    const relation = m[3] ?? m[4] ?? "";
    if (!database || !relation) return null;

    const cols = athenaColumnsCache.getColumns(connectionId, database, relation);
    if (!cols || cols.length === 0) return null;

    const options: Completion[] = cols.map((col) => ({
      label: col.name,
      type: "property",
      detail: col.ty,
      boost: 2,
    }));

    return {
      from: context.pos,
      options,
      validFor: /^[\w"]*$/,
    };
  };
}

// ---------------------------------------------------------------------------
// Document identifier source (fallback)
// ---------------------------------------------------------------------------

export const documentIdentifierSource: CompletionSource = (
  context: CompletionContext,
): CompletionResult | null => {
  const word = context.matchBefore(/[\w"]*/);
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
