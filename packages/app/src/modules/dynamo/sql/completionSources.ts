/**
 * DynamoDB PartiQL editor autocomplete sources.
 *
 * Sources:
 * 1. PartiQL / SQL keyword completions via StandardSQL dialect.
 * 2. Table names from a per-connection cache populated by the QueryTab.
 * 3. Index names from cached DescribeTable results.
 * 4. PK / SK attribute names from cached DescribeTable results.
 * 5. Document identifier source (fallback, in-editor identifiers).
 *
 * NOTE: No data sampling — we NEVER issue a scan/ExecuteStatement to
 * discover attribute names. Only data from DescribeTable (key schema +
 * attribute_definitions) and any pre-populated table names are used.
 */

import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { StandardSQL, keywordCompletionSource } from "@codemirror/lang-sql";
import type { TableDescription } from "../tables/types";

// ---------------------------------------------------------------------------
// Module-level cache — populated by QueryTab via registerTableCache()
// ---------------------------------------------------------------------------

interface ConnectionCache {
  tableNames: string[];
  /** tableName → TableDescription */
  descriptions: Map<string, TableDescription>;
}

const cacheByConnection = new Map<string, ConnectionCache>();

/**
 * Called by QueryTab (and useDynamoTableCache subscriber) to feed
 * table names and descriptions into the completion source.
 * This avoids importing a React context into a non-React module.
 */
export function registerTableCache(
  connectionId: string,
  tableNames: string[],
  descriptions: Map<string, TableDescription>,
): void {
  cacheByConnection.set(connectionId, { tableNames, descriptions });
}

function getCache(connectionId: string): ConnectionCache {
  return cacheByConnection.get(connectionId) ?? { tableNames: [], descriptions: new Map() };
}

// ---------------------------------------------------------------------------
// Keyword source
// ---------------------------------------------------------------------------

export const keywordSource: CompletionSource = keywordCompletionSource(StandardSQL, false);

// ---------------------------------------------------------------------------
// Table name + index name source
// ---------------------------------------------------------------------------

export function buildTableSource(connectionId: string): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[\w"]*/) ;
    if (!word) return null;
    if (word.from === word.to && !context.explicit) return null;

    const { tableNames, descriptions } = getCache(connectionId);
    const options: Completion[] = [];

    for (const name of tableNames) {
      options.push({
        label: `"${name}"`,
        type: "class",
        detail: "table",
        boost: 2,
      });
    }

    // Also add index names from all known descriptions
    for (const desc of descriptions.values()) {
      for (const gsi of desc.global_secondary_indexes) {
        options.push({
          label: `"${gsi.index_name}"`,
          type: "class",
          detail: "GSI",
          boost: 1,
        });
      }
      for (const lsi of desc.local_secondary_indexes) {
        options.push({
          label: `"${lsi.index_name}"`,
          type: "class",
          detail: "LSI",
          boost: 1,
        });
      }
    }

    if (options.length === 0) return null;
    return { from: word.from, options, validFor: /^[\w"]*$/ };
  };
}

// ---------------------------------------------------------------------------
// Key attribute source (PK / SK names from DescribeTable)
// ---------------------------------------------------------------------------

export function buildKeyAttributeSource(connectionId: string): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/\w*/);
    if (!word) return null;
    if (word.from === word.to && !context.explicit) return null;

    const { descriptions } = getCache(connectionId);
    const seen = new Set<string>();
    const options: Completion[] = [];

    for (const desc of descriptions.values()) {
      // Primary key attributes
      for (const key of desc.key_schema) {
        if (!seen.has(key.attribute_name)) {
          seen.add(key.attribute_name);
          options.push({
            label: key.attribute_name,
            type: "property",
            detail: key.key_type === "HASH" ? "PK" : "SK",
            boost: 3,
          });
        }
      }
      // attribute_definitions (all indexed attributes)
      for (const attrDef of desc.attribute_definitions) {
        if (!seen.has(attrDef.attribute_name)) {
          seen.add(attrDef.attribute_name);
          options.push({
            label: attrDef.attribute_name,
            type: "property",
            detail: attrDef.attribute_type,
            boost: 1,
          });
        }
      }
      // GSI key schemas
      for (const gsi of desc.global_secondary_indexes) {
        for (const key of gsi.key_schema) {
          if (!seen.has(key.attribute_name)) {
            seen.add(key.attribute_name);
            options.push({
              label: key.attribute_name,
              type: "property",
              detail: `GSI ${key.key_type === "HASH" ? "PK" : "SK"}`,
              boost: 1,
            });
          }
        }
      }
    }

    if (options.length === 0) return null;
    return { from: word.from, options, validFor: /^\w*$/ };
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
    buildTableSource(connectionId),
    buildKeyAttributeSource(connectionId),
    documentIdentifierSource,
  ];
}
