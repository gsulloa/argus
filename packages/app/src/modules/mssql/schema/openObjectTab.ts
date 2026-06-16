/**
 * Routes MSSQL tree-node activations to the appropriate tab kind.
 *
 * Tables/views (incl. indexed views) → `mssql-table-data` tab.
 * Procedures/functions/triggers/sequences/indexes/foreign-keys/
 * check-constraints/default-constraints → `mssql-object-placeholder`.
 * Group nodes → toggle expand only (caller handles, not this function).
 */

import type { useTabs } from "@/platform/shell/tabs";

// ---------------------------------------------------------------------------
// Tab kind constants
// ---------------------------------------------------------------------------

/** Tab kind for MSSQL table/view data viewer. */
export const MSSQL_TABLE_DATA_KIND = "mssql-table-data";

/** Tab kind for placeholder (procedures, functions, triggers, sequences, indexes, FKs, etc.). */
export const MSSQL_OBJECT_PLACEHOLDER_KIND = "mssql-object-placeholder";

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

export interface MssqlTableDataPayload {
  connectionId: string;
  connectionName: string;
  schema: string;
  relation: string;
  relationKind: "table" | "view";
}

export interface MssqlObjectPlaceholderPayload {
  connectionId: string;
  connectionName: string;
  schema: string;
  /** Object kind: procedure | function | trigger | sequence | index | foreign_key | check_constraint | default_constraint */
  kind: string;
  name: string;
  /** For procedures/functions: "procedure" | "function" */
  routineKind?: "procedure" | "function";
  /** For functions: the function sub-type (scalar_function, inline_tvf, tvf, clr_scalar, clr_tvf) */
  functionType?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const KIND_TITLE: Record<string, string> = {
  table: "Table",
  view: "View",
  procedure: "Procedure",
  function: "Function",
  trigger: "Trigger",
  sequence: "Sequence",
  index: "Index",
  foreign_key: "FK",
  check_constraint: "Check",
  default_constraint: "Default",
};

function dataTabId(p: MssqlTableDataPayload): string {
  return `mstbl:${p.connectionId}:${p.schema}:${p.relation}`;
}

function dataTabTitle(p: MssqlTableDataPayload): string {
  const kindLabel = KIND_TITLE[p.relationKind] ?? p.relationKind;
  return `${kindLabel}: ${p.schema}.${p.relation}`;
}

function placeholderTabId(p: MssqlObjectPlaceholderPayload): string {
  return `msobj:${p.connectionId}:${p.schema}:${p.kind}:${p.name}`;
}

function placeholderTabTitle(p: MssqlObjectPlaceholderPayload): string {
  const kindLabel = KIND_TITLE[p.kind] ?? p.kind;
  return `${kindLabel}: ${p.schema}.${p.name}`;
}

/** Object kinds that open the data viewer. */
const VIEWER_KINDS = new Set(["table", "view"]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface OpenObjectTabArgs {
  connectionId: string;
  connectionName: string;
  schema: string;
  /** Object kind string from the tree leaf. */
  kind: string;
  name: string;
  routineKind?: "procedure" | "function";
  functionType?: string;
}

export function openMssqlObjectTab(
  tabs: ReturnType<typeof useTabs>,
  args: OpenObjectTabArgs,
): string {
  if (VIEWER_KINDS.has(args.kind)) {
    const payload: MssqlTableDataPayload = {
      connectionId: args.connectionId,
      connectionName: args.connectionName,
      schema: args.schema,
      relation: args.name,
      relationKind: args.kind as "table" | "view",
    };
    return tabs.open({
      id: dataTabId(payload),
      kind: MSSQL_TABLE_DATA_KIND,
      title: dataTabTitle(payload),
      payload,
      closable: true,
    });
  }

  const payload: MssqlObjectPlaceholderPayload = {
    connectionId: args.connectionId,
    connectionName: args.connectionName,
    schema: args.schema,
    kind: args.kind,
    name: args.name,
    ...(args.routineKind ? { routineKind: args.routineKind } : {}),
    ...(args.functionType ? { functionType: args.functionType } : {}),
  };
  return tabs.open({
    id: placeholderTabId(payload),
    kind: MSSQL_OBJECT_PLACEHOLDER_KIND,
    title: placeholderTabTitle(payload),
    payload,
    closable: true,
  });
}
