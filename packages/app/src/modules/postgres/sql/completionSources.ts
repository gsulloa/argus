import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import {
  keywordCompletionSource,
  PostgreSQL,
  schemaCompletionSource,
} from "@codemirror/lang-sql";
import { globalSchemaCache } from "../schema/globalSchemaCache";

/** Keyword source — always available, regardless of cache state. */
export const keywordSource: CompletionSource = keywordCompletionSource(
  PostgreSQL,
  /* upperCase = */ true,
);

/**
 * Build the schema-aware completion source bound to the current namespace.
 * Reads `globalSchemaCache.getNamespace(connectionId)` at the moment the
 * source is built. Re-build (and re-configure the autocomplete compartment)
 * when the cache changes — see `QueryTab`'s subscriber.
 *
 * `schemaCompletionSource` from `@codemirror/lang-sql` is the canonical
 * implementation: handles `<schema>.<partial>` qualified names, FROM-aware
 * column scoping (`SELECT u. FROM users u` → only users' columns), and
 * CTE introspection. Replacing our regex-based custom source with this
 * fixes the "one suggestion at a time" bug, identifiers-with-digits, and
 * adds alias awareness for free.
 */
export function buildSchemaSource(connectionId: string): CompletionSource {
  return schemaCompletionSource({
    dialect: PostgreSQL,
    schema: globalSchemaCache.getNamespace(connectionId),
  });
}

/**
 * Document identifier source. Walks the editor's syntax tree (via
 * `syntaxTree(state)`) and collects every `Identifier` / `QuotedIdentifier`
 * declared in the buffer. Useful for:
 *
 * - CTE names (`WITH recent AS (...)`) — `schemaCompletionSource` knows about
 *   them inside the same statement, but this source surfaces them globally
 *   in the doc so cross-statement references work.
 * - Aliases the user has typed (`SELECT u.… FROM users u`) — duplicates of
 *   what `schemaCompletionSource` provides, but with no risk of being lost
 *   if the parse tree is incomplete during typing.
 * - Any identifier that hasn't reached the schema cache yet (in-flight
 *   bulk fetch, or freshly created relation).
 *
 * Strictly AST-driven — strings, comments, dollar-quoted bodies are
 * automatically excluded because the parser puts them in different nodes.
 */
export const documentIdentifierSource: CompletionSource = (
  context: CompletionContext,
): CompletionResult | null => {
  const word = context.matchBefore(/[\w]*/);
  if (!word) return null;
  if (word.from === word.to && !context.explicit) return null;

  const tree = syntaxTree(context.state);
  const seen = new Set<string>();
  const options: Completion[] = [];
  const cursor = tree.cursor();

  // Track whether we just saw a "with" keyword at the statement level so we
  // can label the next identifier as a CTE. Reset on statement boundaries.
  let lastKeyword: string | null = null;
  let inWithIntro = false;

  do {
    const node = cursor.node;
    const name = node.type.name;
    if (name === "Statement") {
      // New statement begins — clear the with-introduction flag.
      inWithIntro = false;
      lastKeyword = null;
      continue;
    }
    if (name === "Keyword") {
      const text = context.state.doc
        .sliceString(node.from, node.to)
        .toLowerCase();
      if (text === "with") {
        inWithIntro = true;
      } else if (text === "as" || text === "select") {
        // Stop CTE-introduction window once we hit the body.
        inWithIntro = false;
      }
      lastKeyword = text;
      continue;
    }
    if (name === "Identifier" || name === "QuotedIdentifier") {
      const raw = context.state.doc.sliceString(node.from, node.to);
      const ident =
        name === "QuotedIdentifier" && raw.startsWith('"') && raw.endsWith('"')
          ? raw.slice(1, -1).replace(/""/g, '"')
          : raw;
      if (ident.length < 2) continue; // skip 1-char tokens — too noisy
      if (seen.has(ident)) continue;
      seen.add(ident);
      const isCte = inWithIntro && lastKeyword === "with";
      options.push({
        label: ident,
        type: isCte ? "class" : "variable",
        detail: isCte ? "CTE" : "in document",
        // Slight negative boost so the schema source's richer entries
        // outrank loose document idents when both match.
        boost: isCte ? 1 : -1,
      });
      continue;
    }
  } while (cursor.next());

  if (options.length === 0) return null;
  return {
    from: word.from,
    options,
    validFor: /^\w*$/,
  };
};

/**
 * The three-source list passed to `autocompletion({ override: ... })`.
 * Order matters only for ranking ties; CodeMirror dedupes by label across
 * sources, so it's safe for sources to overlap.
 */
export function composeSources(connectionId: string): CompletionSource[] {
  return [keywordSource, buildSchemaSource(connectionId), documentIdentifierSource];
}
